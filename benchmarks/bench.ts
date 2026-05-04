import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Bench } from "tinybench";
import { transform } from "esbuild";

type BaselineKind = "main" | "npm";
type VariantName =
  | "singleOp.rawAsync"
  | "singleOp.opRun"
  | "all.promiseAll"
  | "all.opAll"
  | "retry.handRolled"
  | "retry.opWithRetry"
  | "timeout.promiseRace"
  | "timeout.opWithTimeout";

type BenchmarkRecord = {
  hz: number;
  latencyMs: number;
};

type RuntimeReport = Record<VariantName, BenchmarkRecord>;

type SizeReport = {
  minBytes: number;
  gzipBytes: number;
};

type TargetInstall = {
  label: string;
  workspaceDir: string;
  packageDir: string;
  packageVersion: string;
};

const REPO = "trvswgnr/op";
const MAIN_REF = "refs/heads/main";
const MAIN_REMOTE_URL = `https://github.com/${REPO}.git`;
const OP_PACKAGE = "@prodkit/op";
const ENTRY_FALLBACK = "./dist/index.mjs";
const CONCURRENCY_CHILDREN = 8;
const RETRY_ATTEMPTS = 3;
const TIMEOUT_BUDGET_MS = 250;
const logger = console;

function readPackageJsonIfPresent(dir: string): unknown {
  const packageJsonPath = path.join(dir, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return undefined;
  }
}

function readOwnObjectField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  if (!Object.hasOwn(value, key)) return undefined;
  return Reflect.get(value, key);
}

function readPackageNameIfPresent(dir: string): string | undefined {
  const parsed = readPackageJsonIfPresent(dir);
  const name = readOwnObjectField(parsed, "name");
  return typeof name === "string" ? name : undefined;
}

function getRepoRoot(): string {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    const name = readPackageNameIfPresent(currentDir);
    if (name === "@prodkit/op") {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error('Unable to locate repo root with package name "@prodkit/op"');
    }
    currentDir = parentDir;
  }
}

function parseBaselineArg(argv: readonly string[]): BaselineKind {
  const arg = argv.find((item) => item.startsWith("--baseline="));
  if (!arg) return "main";
  const value = arg.slice("--baseline=".length);
  if (value === "main" || value === "npm") return value;
  throw new Error(`Invalid baseline "${value}". Expected "main" or "npm".`);
}

function parseLsRemoteSha(output: string): string | undefined {
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const [sha, resolvedRef] = line.split(/\s+/, 2);
    if (resolvedRef !== MAIN_REF) continue;
    if (sha?.match(/^[0-9a-f]{40}$/i)) return sha.toLowerCase();
  }
  return undefined;
}

function parsePackFilename(packOutput: string): string {
  const parsed = JSON.parse(packOutput) as Array<{ filename?: string }>;
  const filename = parsed[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("Could not parse npm pack output filename.");
  }
  return filename;
}

function relativeSafePath(pkgRoot: string, candidate: string): string {
  const absolute = path.resolve(pkgRoot, candidate);
  const relative = path.relative(pkgRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Resolved entry path escaped package root: ${candidate}`);
  }
  return absolute;
}

function readRuntimeEntryFromExports(exportsField: unknown): string | undefined {
  if (typeof exportsField === "string") return exportsField;
  if (typeof exportsField !== "object" || exportsField === null) return undefined;

  const entry = (exportsField as Record<string, unknown>)["."];
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return undefined;

  const runtimeEntry = (entry as Record<string, unknown>).import;
  if (typeof runtimeEntry === "string") return runtimeEntry;

  const defaultEntry = (entry as Record<string, unknown>).default;
  if (typeof defaultEntry === "string") return defaultEntry;
  return undefined;
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  capture: boolean = false,
): Promise<string> {
  const invocation = `${command} ${args.join(" ")}`;
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    if (capture && child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }
    if (capture && child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (status, signal) => {
      if (status === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${invocation} failed with status=${String(status)} signal=${String(signal)}\n${stderr}`.trim(),
        ),
      );
    });
  });
}

async function resolveMainCommitSha(repoRoot: string): Promise<string> {
  const output = await runCommand(
    "git",
    ["ls-remote", "--refs", MAIN_REMOTE_URL, MAIN_REF],
    repoRoot,
    true,
  );
  const sha = parseLsRemoteSha(output);
  if (!sha) {
    throw new Error(`Unable to resolve latest main commit via ${MAIN_REMOTE_URL} ${MAIN_REF}.`);
  }
  return sha;
}

async function resolveCurrentFingerprint(
  repoRoot: string,
): Promise<{ headSha: string; dirty: boolean }> {
  const headOutput = await runCommand("git", ["rev-parse", "HEAD"], repoRoot, true);
  const headSha = headOutput.trim().toLowerCase();
  if (!headSha.match(/^[0-9a-f]{40}$/)) {
    throw new Error(`Unable to resolve local HEAD SHA: ${headOutput}`);
  }
  const statusOutput = await runCommand("git", ["status", "--porcelain"], repoRoot, true);
  return { headSha, dirty: statusOutput.trim().length > 0 };
}

async function installTarget(label: string, spec: string): Promise<TargetInstall> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "op-bench-"));
  let installSpec = spec;
  if (existsSync(spec)) {
    const localTarballName = `${label}.tgz`;
    const localTarballPath = path.join(workspaceDir, localTarballName);
    await copyFile(spec, localTarballPath);
    installSpec = `./${localTarballName}`;
  }

  const packageJson = {
    name: "op-bench-target",
    private: true,
    type: "module",
    dependencies: {},
  };

  await writeFile(
    path.join(workspaceDir, "package.json"),
    JSON.stringify(packageJson, null, 2) + "\n",
  );
  await runCommand(
    "npm",
    [
      "install",
      "--no-package-lock",
      "--install-strategy=hoisted",
      "--install-links=false",
      installSpec,
    ],
    workspaceDir,
  );

  const packageDirCandidates = [
    path.join(workspaceDir, "node_modules", "@prodkit", "op"),
    path.join(workspaceDir, "node_modules", "op"),
  ];
  const packageDir = packageDirCandidates.find((candidate) => existsSync(candidate));
  if (!packageDir) {
    throw new Error(`Install succeeded but ${OP_PACKAGE} was not found in ${workspaceDir}.`);
  }

  const packageJsonRaw = await readFile(path.join(packageDir, "package.json"), "utf8");
  const parsed = JSON.parse(packageJsonRaw) as { version?: string };
  const packageVersion = parsed.version ?? "unknown";

  return { label, workspaceDir, packageDir, packageVersion };
}

async function resolveCurrentTarball(repoRoot: string): Promise<string> {
  logger.info(`Building current package in ${repoRoot}`);
  await runCommand("npm", ["run", "build"], repoRoot);
  logger.info(`Built current package in ${repoRoot}`);
  const packOutput = await runCommand(
    "npm",
    ["pack", "--json", "--ignore-scripts"],
    repoRoot,
    true,
  );
  logger.info(`Packed current package in ${repoRoot}`);
  const filename = parsePackFilename(packOutput);
  logger.info(`Parsed pack filename: ${filename}`);
  return path.resolve(repoRoot, filename);
}

async function resolveMainTarball(repoRoot: string, sha: string): Promise<string> {
  const worktreeDir = await mkdtemp(path.join(os.tmpdir(), "op-bench-main-"));
  let createdTarballPath: string | undefined;
  let failure: unknown;

  await runCommand("git", ["worktree", "add", "--detach", worktreeDir, sha], repoRoot);
  try {
    await runCommand("npm", ["ci"], worktreeDir);
    await runCommand("npm", ["run", "build"], worktreeDir);
    const packOutput = await runCommand(
      "npm",
      ["pack", "--json", "--ignore-scripts"],
      worktreeDir,
      true,
    );
    const filename = parsePackFilename(packOutput);
    const packedTarball = path.resolve(worktreeDir, filename);
    const copiedTarball = path.resolve(repoRoot, `main-${sha.slice(0, 12)}.tgz`);
    await copyFile(packedTarball, copiedTarball);
    createdTarballPath = copiedTarball;
  } catch (error) {
    failure = error;
  }

  await runCommand("git", ["worktree", "remove", "--force", worktreeDir], repoRoot).catch(
    () => undefined,
  );

  if (failure !== undefined) throw failure;
  if (!createdTarballPath) {
    throw new Error(`Failed to create benchmark tarball for main@${sha}`);
  }
  return createdTarballPath;
}

async function importOpFactory(packageDir: string): Promise<{ Op: unknown }> {
  const modulePath = await resolveBundleEntry(packageDir);
  if (!existsSync(modulePath)) {
    throw new Error(`Resolved runtime entry does not exist: ${modulePath}`);
  }
  const mod = (await import(pathToFileURL(modulePath).href)) as { Op?: unknown };
  if (!mod.Op) {
    throw new Error(`Unable to import Op factory from ${modulePath}.`);
  }
  return { Op: mod.Op };
}

function assertOpFactory(input: unknown): {
  of: (value: unknown) => {
    run: () => Promise<{ isOk: () => boolean }>;
    withTimeout: (timeoutMs: number) => { run: () => Promise<{ isOk: () => boolean }> };
  };
  try: (f: () => unknown) => {
    withRetry: (policy: {
      maxAttempts: number;
      shouldRetry: (cause: unknown) => boolean;
      getDelay: (attempt: number, cause: unknown) => number;
    }) => { run: () => Promise<{ isOk: () => boolean }> };
    withTimeout: (timeoutMs: number) => { run: () => Promise<{ isOk: () => boolean }> };
  };
  all: (ops: unknown[]) => { run: () => Promise<{ isOk: () => boolean }> };
} {
  if (typeof input !== "function" && (typeof input !== "object" || input === null)) {
    throw new Error("Imported Op value is invalid.");
  }
  const op = input as {
    of?: unknown;
    try?: unknown;
    all?: unknown;
  };
  if (typeof op.of !== "function" || typeof op.try !== "function" || typeof op.all !== "function") {
    throw new Error("Imported Op is missing required methods (of/try/all).");
  }
  return op as unknown as ReturnType<typeof assertOpFactory>;
}

async function runVariant(name: string, fn: () => Promise<unknown>): Promise<BenchmarkRecord> {
  const bench = new Bench({
    name,
    time: 300,
    warmupTime: 150,
    warmupIterations: 5,
  });
  bench.add(name, fn);
  await bench.run();

  const task = bench.tasks[0];
  const hz = task?.result?.hz ?? 0;
  const latencyMs = task?.result?.mean ?? 0;
  return { hz, latencyMs };
}

async function runRuntimeBenchmarks(opFactoryInput: unknown): Promise<RuntimeReport> {
  const Op = assertOpFactory(opFactoryInput);
  const report: Partial<RuntimeReport> = {};

  report["singleOp.rawAsync"] = await runVariant("singleOp.rawAsync", async () => {
    await Promise.resolve(42);
  });

  report["singleOp.opRun"] = await runVariant("singleOp.opRun", async () => {
    const result = await Op.of(42).run();
    if (!result.isOk()) throw new Error("singleOp.opRun failed unexpectedly.");
  });

  report["all.promiseAll"] = await runVariant("all.promiseAll", async () => {
    await Promise.all(
      Array.from({ length: CONCURRENCY_CHILDREN }, (_, index) => Promise.resolve(index)),
    );
  });

  report["all.opAll"] = await runVariant("all.opAll", async () => {
    const ops = Array.from({ length: CONCURRENCY_CHILDREN }, (_, index) => Op.of(index));
    const result = await Op.all(ops).run();
    if (!result.isOk()) throw new Error("all.opAll failed unexpectedly.");
  });

  report["retry.handRolled"] = await runVariant("retry.handRolled", async () => {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        if (attempt < RETRY_ATTEMPTS) throw new Error("retry");
        break;
      } catch {
        if (attempt >= RETRY_ATTEMPTS) throw new Error("retry.handRolled exhausted unexpectedly.");
      }
    }
  });

  report["retry.opWithRetry"] = await runVariant("retry.opWithRetry", async () => {
    let attempt = 0;
    const result = await Op.try(() => {
      attempt += 1;
      if (attempt < RETRY_ATTEMPTS) throw new Error("retry");
      return 1;
    })
      .withRetry({
        maxAttempts: RETRY_ATTEMPTS,
        shouldRetry: () => true,
        getDelay: () => 0,
      })
      .run();
    if (!result.isOk()) throw new Error("retry.opWithRetry failed unexpectedly.");
  });

  report["timeout.promiseRace"] = await runVariant("timeout.promiseRace", async () => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        reject(new Error("timeout should not fire"));
      }, TIMEOUT_BUDGET_MS);
    });
    await Promise.race([Promise.resolve(7), timer]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });

  report["timeout.opWithTimeout"] = await runVariant("timeout.opWithTimeout", async () => {
    const result = await Op.of(7).withTimeout(TIMEOUT_BUDGET_MS).run();
    if (!result.isOk()) throw new Error("timeout.opWithTimeout failed unexpectedly.");
  });

  return report as RuntimeReport;
}

async function resolveBundleEntry(packageDir: string): Promise<string> {
  const packageJsonPath = path.join(packageDir, "package.json");
  const packageJsonRaw = await readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonRaw) as {
    exports?: unknown;
    module?: string;
    main?: string;
  };

  const exportEntry = readRuntimeEntryFromExports(packageJson.exports);
  const moduleEntry = typeof packageJson.module === "string" ? packageJson.module : undefined;
  const mainEntry = typeof packageJson.main === "string" ? packageJson.main : undefined;
  const candidate = exportEntry ?? moduleEntry ?? mainEntry ?? ENTRY_FALLBACK;
  return relativeSafePath(packageDir, candidate);
}

async function measureBundleSize(packageDir: string): Promise<SizeReport> {
  const entryPath = await resolveBundleEntry(packageDir);
  const source = await readFile(entryPath, "utf8");
  const transformed = await transform(source, {
    loader: "js",
    format: "esm",
    minify: true,
    target: "es2022",
  });
  const minBytes = Buffer.byteLength(transformed.code, "utf8");
  const gzipBytes = gzipSync(Buffer.from(transformed.code, "utf8")).byteLength;
  return { minBytes, gzipBytes };
}

function formatNumber(value: number): string {
  return Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatPercentDelta(current: number, baseline: number): string {
  if (baseline === 0) return "n/a";
  const pct = ((current - baseline) / baseline) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function printRuntimeComparison(current: RuntimeReport, baseline: RuntimeReport): void {
  const variants: VariantName[] = [
    "singleOp.rawAsync",
    "singleOp.opRun",
    "all.promiseAll",
    "all.opAll",
    "retry.handRolled",
    "retry.opWithRetry",
    "timeout.promiseRace",
    "timeout.opWithTimeout",
  ];

  logger.info("Runtime benchmarks (ops/sec, higher is better):");
  for (const name of variants) {
    const currentHz = current[name].hz;
    const baselineHz = baseline[name].hz;
    const delta = formatPercentDelta(currentHz, baselineHz);
    logger.info(
      `- ${name}: current=${formatNumber(currentHz)} baseline=${formatNumber(baselineHz)} delta=${delta}`,
    );
  }
}

function printBundleComparison(current: SizeReport, baseline: SizeReport): void {
  logger.info("Bundle size benchmarks (lower is better):");
  logger.info(
    `- minified bytes: current=${formatNumber(current.minBytes)} baseline=${formatNumber(
      baseline.minBytes,
    )} delta=${formatPercentDelta(current.minBytes, baseline.minBytes)}`,
  );
  logger.info(
    `- gzip bytes: current=${formatNumber(current.gzipBytes)} baseline=${formatNumber(
      baseline.gzipBytes,
    )} delta=${formatPercentDelta(current.gzipBytes, baseline.gzipBytes)}`,
  );
}

async function runCleanup(cleanups: Array<() => Promise<void>>): Promise<void> {
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    const cleanup = cleanups[index];
    if (!cleanup) continue;
    await cleanup();
  }
}

async function main(): Promise<void> {
  const repoRoot = getRepoRoot();
  const baselineKind = parseBaselineArg(process.argv.slice(2));
  const cleanups: Array<() => Promise<void>> = [];
  let failure: unknown;

  logger.info(
    `Benchmark environment: node=${process.version} platform=${process.platform} arch=${process.arch}`,
  );
  logger.info(`Benchmark baseline mode: ${baselineKind}`);

  try {
    const currentFingerprint = await resolveCurrentFingerprint(repoRoot);
    const currentLabel = `local@${currentFingerprint.headSha.slice(0, 12)}${currentFingerprint.dirty ? "+dirty" : "+clean"}`;

    logger.info(`Resolving current tarball in ${repoRoot}`);
    const currentTarball = await resolveCurrentTarball(repoRoot);
    logger.info(`Resolved current tarball: ${currentTarball}`);
    cleanups.push(async () => {
      if (existsSync(currentTarball)) await rm(currentTarball, { force: true });
    });

    const currentTarget = await installTarget("current", currentTarball);
    cleanups.push(async () => {
      if (existsSync(currentTarget.workspaceDir)) {
        await rm(currentTarget.workspaceDir, { recursive: true, force: true });
      }
    });

    let baselineSpec = `${OP_PACKAGE}@latest`;
    let baselineLabel = "npm@latest";
    if (baselineKind === "main") {
      const sha = await resolveMainCommitSha(repoRoot);
      const mainTarball = await resolveMainTarball(repoRoot, sha);
      cleanups.push(async () => {
        if (existsSync(mainTarball)) await rm(mainTarball, { force: true });
      });
      baselineSpec = mainTarball;
      baselineLabel = `main@${sha.slice(0, 12)}`;
    }

    const baselineTarget = await installTarget("baseline", baselineSpec);
    cleanups.push(async () => {
      if (existsSync(baselineTarget.workspaceDir)) {
        await rm(baselineTarget.workspaceDir, { recursive: true, force: true });
      }
    });

    logger.info(
      `\nInstalled targets:\n- current (${currentLabel}): ${currentTarget.packageVersion} (${currentTarget.packageDir})\n- baseline (${baselineLabel}): ${baselineTarget.packageVersion} (${baselineTarget.packageDir})`,
    );

    const currentModule = await importOpFactory(currentTarget.packageDir);
    const baselineModule = await importOpFactory(baselineTarget.packageDir);

    const currentRuntime = await runRuntimeBenchmarks(currentModule.Op);
    const baselineRuntime = await runRuntimeBenchmarks(baselineModule.Op);
    const currentSize = await measureBundleSize(currentTarget.packageDir);
    const baselineSize = await measureBundleSize(baselineTarget.packageDir);

    printRuntimeComparison(currentRuntime, baselineRuntime);
    printBundleComparison(currentSize, baselineSize);
  } catch (error) {
    failure = error;
  }
  await runCleanup(cleanups);
  if (failure !== undefined) throw failure;
}

main().catch(async (error) => {
  logger.error(error);
  process.exitCode = 1;
});
