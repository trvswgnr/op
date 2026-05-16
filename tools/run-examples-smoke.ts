import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import {
  cp,
  mkdtemp,
  readFile as readFileFs,
  rm,
  writeFile as writeFileFs,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Op } from "@prodkit/op";
import * as v from "valibot";
import { TaggedError, matchErrorPartial } from "better-result";
import {
  createLogger,
  fromRepoRoot,
  parse,
  parseJson,
  getOwnPropertyValue,
  readPackageJson,
} from "./utils.ts";

const logger = createLogger();

/** Overrides {@link DEFAULT_SMOKE_TIMEOUT_MS}; must be a positive integer if set (milliseconds). */
const SMOKE_TIMEOUT_MS_ENV = "OP_SMOKE_TIMEOUT_MS";

/**
 * Legacy toggle retained for compatibility. The smoke runner now always uses
 * isolated temp workspaces and ignores this setting.
 */
const SMOKE_RESET_EXAMPLES_ENV = "OP_SMOKE_RESET_EXAMPLES";

/** Wall-clock budget for the full smoke pipeline (covers cold installs on CI). */
const DEFAULT_SMOKE_TIMEOUT_MS = 30_000; // 30 seconds

const PACK_OUTPUT_PREVIEW = 4000;
const UPSTREAM_REPO_URL = "https://github.com/trvswgnr/prodkit.git";
const UPSTREAM_MAIN_REF = "refs/heads/main";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Temp workspace layout: `pnpm-workspace.yaml` + this folder (copied from `examples/`). */
const EXAMPLES_CONSUMER_DIR = "examples-consumer";
const EXAMPLES_PACKAGE_NAME = "@prodkit/examples";
const EXAMPLES_SMOKE_STATE_DIR = path.join(REPO_ROOT, "var", "examples-smoke");
const PNPM_STORE_DIR = path.join(EXAMPLES_SMOKE_STATE_DIR, "store");

const Mode = v.enum({ pack: "pack", github: "github", npm: "npm" });
type Mode = v.InferOutput<typeof Mode>;

const PropertyKey = v.union([v.string(), v.number(), v.symbol()]);
// @ts-expect-error - PropertyKey is a union of string, number, and symbol. this is correct, valibot is wrong.
const Record = v.record(PropertyKey, v.unknown());
const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  v.safeParse(Record, value).success;

class SmokeExecError extends TaggedError("SmokeExecError")<{
  command: string;
  args: readonly string[];
  cwd: string;
  cause: {
    message: string;
    name?: string;
    code?: string;
    signal?: string;
    status?: number;
    stdout?: string;
    stderr?: string;
  };
}>() {}

class SmokePackOutputError extends TaggedError("SmokePackOutputError")<{ message: string }>() {}

class SmokeMissingDistError extends TaggedError("SmokeMissingDistError")<{ message: string }>() {}

class SmokeGithubRefResolveError extends TaggedError("SmokeGithubRefResolveError")<{
  message: string;
}>() {}

class SmokeWorkspaceError extends TaggedError("SmokeWorkspaceError")<{
  message: string;
  cause?: unknown;
}>() {}

class SmokeCommandExitError extends TaggedError("SmokeCommandExitError")<{
  message: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr?: string;
}>() {}

class OperationAbortedError extends TaggedError("OperationAbortedError")<{ message: string }>() {}

function collectRuntimeEntryLeaves(value: unknown, target: Set<string>): void {
  if (typeof value === "string") {
    if (value.length > 0) target.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRuntimeEntryLeaves(item, target);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  // types entries are non-runtime metadata and should not satisfy runtime artifact checks
  const typeField = getOwnPropertyValue(value, "types");
  const defaultField = getOwnPropertyValue(value, "default");
  const importField = getOwnPropertyValue(value, "import");
  const requireField = getOwnPropertyValue(value, "require");
  const nodeField = getOwnPropertyValue(value, "node");
  const browserField = getOwnPropertyValue(value, "browser");

  let sawRuntimeCondition = false;
  const runtimeConditions = [defaultField, importField, requireField, nodeField, browserField];
  for (const runtimeCondition of runtimeConditions) {
    if (runtimeCondition === undefined) continue;
    sawRuntimeCondition = true;
    collectRuntimeEntryLeaves(runtimeCondition, target);
  }

  if (sawRuntimeCondition) return;
  if (typeField !== undefined && !sawRuntimeCondition && Object.keys(value).length === 1) return;

  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "types") continue;
    collectRuntimeEntryLeaves(nestedValue, target);
  }
}

function extractCatalogSection(workspaceYaml: string): string {
  const lines = workspaceYaml.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => /^\s*catalog:\s*$/.test(line));
  if (startIdx === -1) {
    throw new Error(
      'Repository pnpm-workspace.yaml must define a top-level "catalog:" block (required for isolated smoke workspaces).',
    );
  }
  const block: string[] = [];
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    if (i === startIdx) {
      block.push(line);
      continue;
    }
    if (line === "" || /^  /.test(line)) {
      block.push(line);
      continue;
    }
    break;
  }
  return block.join("\n").trimEnd();
}

function parsePnpmPackFilename(packOutput: string): string | undefined {
  try {
    const parsed = JSON.parse(packOutput.trim()) as { filename?: unknown };
    if (typeof parsed.filename === "string" && parsed.filename.length > 0) return parsed.filename;
  } catch {
    // handled below
  }
  return undefined;
}

function formatSmokeExecInvocation(command: string, args: readonly string[]): string {
  return [command, ...args].map((word) => JSON.stringify(word)).join(" ");
}

function buildCommandEnv(): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(nextEnv)) {
    if (!key.toLowerCase().startsWith("npm_config_")) continue;
    delete nextEnv[key];
  }
  mkdirSync(PNPM_STORE_DIR, { recursive: true });
  return nextEnv;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  capture: boolean,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      signal,
      env: buildCommandEnv(),
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
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
        process.stderr.write(chunk);
      });
    }

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (status, closeSignal) => {
      if (status === 0) {
        resolve(stdout);
        return;
      }

      reject(
        new SmokeCommandExitError({
          message: closeSignal
            ? `Command terminated by signal ${closeSignal}`
            : `Command exited with code ${String(status)}`,
          status,
          signal: closeSignal,
          stdout,
          stderr,
        }),
      );
    });
  });
}

function toTextOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}

function normalizeExecCause(cause: unknown): {
  message: string;
  name?: string;
  code?: string;
  signal?: string;
  status?: number;
  stdout?: string;
  stderr?: string;
} {
  if (SmokeCommandExitError.is(cause)) {
    return {
      message: cause.message,
      name: "SmokeCommandExitError",
      signal: cause.signal ?? undefined,
      status: cause.status ?? undefined,
      stdout: cause.stdout,
      stderr: cause.stderr,
    };
  }

  if (cause instanceof Error) {
    const code = getOwnPropertyValue(cause, "code");
    const signal = getOwnPropertyValue(cause, "signal");
    const status = getOwnPropertyValue(cause, "status");
    const stdout = getOwnPropertyValue(cause, "stdout");
    const stderr = getOwnPropertyValue(cause, "stderr");
    return {
      message: cause.message,
      name: cause.name,
      code: typeof code === "string" ? code : undefined,
      signal: typeof signal === "string" ? signal : undefined,
      status: typeof status === "number" ? status : undefined,
      stdout: toTextOutput(stdout),
      stderr: toTextOutput(stderr),
    };
  }
  return { message: String(cause) };
}

function parseGitLsRemoteSha(output: string, ref: string): string | undefined {
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    const [sha, resolvedRef] = line.split(/\s+/, 2);
    if (resolvedRef !== ref) continue;
    if (sha?.match(/^[0-9a-f]{40}$/i)) return sha.toLowerCase();
  }
  return undefined;
}

const execOp = Op(function* (
  command: string,
  args: string[],
  cwd: string,
  capture: boolean = false,
) {
  return yield* Op.try(
    (signal) => runCommand(command, args, cwd, capture, signal),
    async (cause) => {
      const name = getOwnPropertyValue(cause, "name");
      if (name === "AbortError") {
        return new OperationAbortedError({ message: "Operation aborted" });
      }
      return new SmokeExecError({ command, args, cwd, cause: normalizeExecCause(cause) });
    },
  );
});

const resolveUpstreamMainCommitSha = Op(function* (repoRoot: string) {
  const output = yield* execOp(
    "git",
    ["ls-remote", "--refs", UPSTREAM_REPO_URL, UPSTREAM_MAIN_REF],
    repoRoot,
    true,
  );
  const sha = parseGitLsRemoteSha(output, UPSTREAM_MAIN_REF);
  if (!sha) {
    return yield* new SmokeGithubRefResolveError({
      message: `Unable to parse commit SHA from: git ls-remote --refs ${UPSTREAM_REPO_URL} ${UPSTREAM_MAIN_REF}`,
    });
  }
  return sha;
});

function resolveInstalledProdkitPackageDir(workspaceRoot: string, packageBaseName: string): string {
  const nested = path.join(
    workspaceRoot,
    EXAMPLES_CONSUMER_DIR,
    "node_modules",
    "@prodkit",
    packageBaseName,
  );
  const hoisted = path.join(workspaceRoot, "node_modules", "@prodkit", packageBaseName);
  if (existsSync(path.join(nested, "package.json"))) return nested;
  return hoisted;
}

const EXAMPLES_DIST_CHECK_PACKAGES = ["op", "std"] as const;

const ensureInstalledPackagesReady = Op(function* (workspaceRoot: string, sourceLabel: string) {
  for (const pkg of EXAMPLES_DIST_CHECK_PACKAGES) {
    const installedPkgDir = resolveInstalledProdkitPackageDir(workspaceRoot, pkg);
    const packageJson = yield* readPackageJson(path.join(installedPkgDir, "package.json"));
    const entryCandidates = new Set<string>(["./dist/index.mjs"]);

    const mainField = getOwnPropertyValue(packageJson, "main");
    if (typeof mainField === "string" && mainField.length > 0) entryCandidates.add(mainField);

    const moduleField = getOwnPropertyValue(packageJson, "module");
    if (typeof moduleField === "string" && moduleField.length > 0) entryCandidates.add(moduleField);

    const exportsField = getOwnPropertyValue(packageJson, "exports");
    if (getOwnPropertyValue(exportsField, ".") !== undefined) {
      collectRuntimeEntryLeaves(getOwnPropertyValue(exportsField, "."), entryCandidates);
    } else {
      collectRuntimeEntryLeaves(exportsField, entryCandidates);
    }

    const entryPaths = Array.from(entryCandidates)
      .map((candidate) => path.resolve(installedPkgDir, candidate.replace(/^\.\/+/, "")))
      .filter((candidatePath) => {
        const relative = path.relative(installedPkgDir, candidatePath);
        return !relative.startsWith("..") && !path.isAbsolute(relative);
      });

    if (entryPaths.some((entryPath) => existsSync(entryPath))) continue;

    return yield* new SmokeMissingDistError({
      message: `Installed @prodkit/${pkg} from ${sourceLabel} is missing expected entry artifacts (${Array.from(entryCandidates).join(", ")}). This usually means the dependency was installed from source without prebuilt artifacts.`,
    });
  }
});

const createTempExamplesWorkspace = Op(function* (
  examplesDir: string,
  dependencyOverrides: Record<string, string>,
) {
  const tempRoot = yield* Op.try(
    () => mkdtemp(path.join(os.tmpdir(), "prodkit-examples-smoke-")),
    (cause) =>
      new SmokeWorkspaceError({ message: "Failed to create temporary examples workspace", cause }),
  );
  yield* Op.defer(() => rm(tempRoot, { recursive: true, force: true }));

  const workspaceYamlRaw = yield* Op.try(
    () => readFileFs(path.join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8"),
    (cause) =>
      new SmokeWorkspaceError({
        message: "Failed reading repository pnpm-workspace.yaml",
        cause,
      }),
  );

  let catalogSection: string;
  try {
    catalogSection = extractCatalogSection(workspaceYamlRaw);
  } catch (cause) {
    return yield* new SmokeWorkspaceError({
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const workspaceYamlBody = `packages:\n  - ${JSON.stringify(EXAMPLES_CONSUMER_DIR)}\n\n${catalogSection}\n`;
  yield* Op.try(
    () => writeFileFs(path.join(tempRoot, "pnpm-workspace.yaml"), workspaceYamlBody, "utf8"),
    (cause) =>
      new SmokeWorkspaceError({
        message: "Failed writing pnpm-workspace.yaml in temp workspace",
        cause,
      }),
  );

  const rootPackageJsonRaw = yield* Op.try(
    () => readFileFs(path.join(REPO_ROOT, "package.json"), "utf8"),
    (cause) =>
      new SmokeWorkspaceError({ message: "Failed reading repository package.json", cause }),
  );
  const rootPackageParsed = yield* parseJson(rootPackageJsonRaw);
  const packageManager = isRecord(rootPackageParsed)
    ? getOwnPropertyValue(rootPackageParsed, "packageManager")
    : undefined;
  const smokeRootPackage: Record<string, unknown> = {
    name: "@prodkit/examples-smoke-root",
    private: true,
  };
  if (typeof packageManager === "string") smokeRootPackage["packageManager"] = packageManager;

  yield* Op.try(
    () =>
      writeFileFs(
        path.join(tempRoot, "package.json"),
        `${JSON.stringify(smokeRootPackage, null, 2)}\n`,
        "utf8",
      ),
    (cause) =>
      new SmokeWorkspaceError({
        message: "Failed writing root package.json in temp workspace",
        cause,
      }),
  );

  const consumerDir = path.join(tempRoot, EXAMPLES_CONSUMER_DIR);
  yield* Op.try(
    () =>
      cp(examplesDir, consumerDir, {
        recursive: true,
        force: true,
        filter: (sourcePath) => path.basename(sourcePath) !== "node_modules",
      }),
    (cause) => new SmokeWorkspaceError({ message: "Failed to copy examples files", cause }),
  );

  const packageJsonPath = path.join(consumerDir, "package.json");
  const packageJsonRaw = yield* Op.try(
    () => readFileFs(packageJsonPath, "utf8"),
    (cause) =>
      new SmokeWorkspaceError({
        message: `Failed reading ${packageJsonPath} in temp workspace`,
        cause,
      }),
  );

  const parsedPackageJson = yield* parseJson(packageJsonRaw);
  if (!isRecord(parsedPackageJson)) {
    return yield* new SmokeWorkspaceError({
      message: "Examples package.json did not parse as an object",
    });
  }

  const currentDependencies = getOwnPropertyValue(parsedPackageJson, "dependencies");
  const nextDependencies = isRecord(currentDependencies) ? { ...currentDependencies } : {};
  for (const [depName, depSpec] of Object.entries(dependencyOverrides)) {
    nextDependencies[depName] = depSpec;
  }

  const nextPackageJson: Record<string, unknown> = {
    ...parsedPackageJson,
    dependencies: nextDependencies,
  };

  yield* Op.try(
    () => writeFileFs(packageJsonPath, `${JSON.stringify(nextPackageJson, null, 2)}\n`, "utf8"),
    (cause) =>
      new SmokeWorkspaceError({
        message: `Failed writing ${packageJsonPath} in temp workspace`,
        cause,
      }),
  );

  return tempRoot;
});

const installAndSmoke = Op(function* (
  examplesDir: string,
  dependencyOverrides: Record<string, string>,
  sourceLabel: string,
) {
  const smokeWorkspaceDir = yield* createTempExamplesWorkspace(examplesDir, dependencyOverrides);
  yield* execOp("pnpm", ["install", `--store-dir=${PNPM_STORE_DIR}`], smokeWorkspaceDir);
  yield* ensureInstalledPackagesReady(smokeWorkspaceDir, sourceLabel);
  yield* execOp("pnpm", ["--filter", EXAMPLES_PACKAGE_NAME, "run", "smoke"], smokeWorkspaceDir);
});

async function cleanupPackOutput(tarballPath: string) {
  logger.info(`pack - cleaning up tarball: ${tarballPath}`);
  await rm(tarballPath, { force: true });
}

const installFromPack = Op(function* () {
  const repoRoot = yield* fromRepoRoot(".");
  const examplesDir = yield* fromRepoRoot("examples");
  yield* execOp("pnpm", ["--filter", "@prodkit/op", "run", "build"], repoRoot);
  yield* execOp("pnpm", ["--filter", "@prodkit/std", "run", "build"], repoRoot);

  const packOpOutput = yield* execOp(
    "pnpm",
    ["--filter", "@prodkit/op", "pack", "--json"],
    repoRoot,
    true,
  );
  const opFilename = parsePnpmPackFilename(packOpOutput);

  const opPreview =
    packOpOutput.length > PACK_OUTPUT_PREVIEW
      ? `${packOpOutput.slice(0, PACK_OUTPUT_PREVIEW)}...`
      : packOpOutput;

  if (!opFilename) {
    return yield* new SmokePackOutputError({
      message: `Unable to read @prodkit/op tarball filename from pnpm pack --json (preview):\n${opPreview}`,
    });
  }

  const opTarballPath = path.isAbsolute(opFilename)
    ? opFilename
    : path.resolve(repoRoot, opFilename);
  yield* Op.defer(() => cleanupPackOutput(opTarballPath));

  const opRelativeToRepoRoot = path.relative(path.resolve(repoRoot), opTarballPath);
  if (opRelativeToRepoRoot.startsWith("..") || path.isAbsolute(opRelativeToRepoRoot)) {
    return yield* new SmokePackOutputError({
      message: `pnpm pack filename resolves outside the repository root: ${opFilename}`,
    });
  }

  const packStdOutput = yield* execOp(
    "pnpm",
    ["--filter", "@prodkit/std", "pack", "--json"],
    repoRoot,
    true,
  );
  const stdFilename = parsePnpmPackFilename(packStdOutput);

  const stdPreview =
    packStdOutput.length > PACK_OUTPUT_PREVIEW
      ? `${packStdOutput.slice(0, PACK_OUTPUT_PREVIEW)}...`
      : packStdOutput;

  if (!stdFilename) {
    return yield* new SmokePackOutputError({
      message: `Unable to read @prodkit/std tarball filename from pnpm pack --json (preview):\n${stdPreview}`,
    });
  }

  const stdTarballPath = path.isAbsolute(stdFilename)
    ? stdFilename
    : path.resolve(repoRoot, stdFilename);
  yield* Op.defer(() => cleanupPackOutput(stdTarballPath));

  const stdRelativeToRepoRoot = path.relative(path.resolve(repoRoot), stdTarballPath);
  if (stdRelativeToRepoRoot.startsWith("..") || path.isAbsolute(stdRelativeToRepoRoot)) {
    return yield* new SmokePackOutputError({
      message: `pnpm pack filename resolves outside the repository root: ${stdFilename}`,
    });
  }

  yield* installAndSmoke(
    examplesDir,
    {
      "@prodkit/op": opTarballPath,
      "@prodkit/std": stdTarballPath,
    },
    "pnpm pack tarballs",
  );
});

const installFromGithub = Op(function* () {
  const repoRoot = yield* fromRepoRoot(".");
  const examplesDir = yield* fromRepoRoot("examples");
  const commitSha = yield* resolveUpstreamMainCommitSha(repoRoot);
  logger.info(`github - resolved ${UPSTREAM_MAIN_REF} to ${commitSha}`);
  const tarballUrl = `https://codeload.github.com/trvswgnr/prodkit/tar.gz/${commitSha}`;
  yield* installAndSmoke(
    examplesDir,
    {
      "@prodkit/op": `@prodkit/op@${tarballUrl}`,
      "@prodkit/std": `@prodkit/std@${tarballUrl}`,
    },
    `GitHub dependency (${UPSTREAM_MAIN_REF}@${commitSha})`,
  );
});

const installFromNpm = Op(function* (examplesDir: string) {
  yield* installAndSmoke(
    examplesDir,
    {
      "@prodkit/op": "@prodkit/op@latest",
      "@prodkit/std": "@prodkit/std@latest",
    },
    "npm registry",
  );
});

const smoke = Op(function* (rawMode: string | undefined) {
  const examplesDir = yield* fromRepoRoot("examples");

  const mode = yield* parse(Mode, rawMode);
  if (process.env[SMOKE_RESET_EXAMPLES_ENV] !== undefined) {
    logger.warn(
      `${SMOKE_RESET_EXAMPLES_ENV} is ignored; smoke runs now use isolated temp workspaces.`,
    );
  }

  switch (mode) {
    case "pack":
      yield* installFromPack();
      break;
    case "github":
      yield* installFromGithub();
      break;
    case "npm":
      yield* installFromNpm(examplesDir);
      break;
  }
});

async function main() {
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

  let shuttingDown = false;
  const handlers = new Map<NodeJS.Signals, (signalName: NodeJS.Signals) => Promise<void>>();
  for (const sig of signals) {
    const handler = async (signalName: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      controller.abort();
      process.exitCode = signalName === "SIGINT" ? 130 : 143;
      logger.warn(`Received ${sig}; cancelling in-flight command(s)`);
    };
    process.on(sig, handler);

    handlers.set(sig, handler);
  }

  process.on("exit", (code) => {
    const method = code === 0 ? "info" : "warn";
    logger[method](`Process exiting with code ${code}`);
    for (const [sig, handler] of handlers) {
      process.off(sig, handler);
    }
  });

  const getEnvInt = (key: string, defaultValue?: number): number => {
    if (defaultValue !== undefined) {
      const schema = v.pipe(
        v.optional(v.string()),
        v.transform((value) => (value === undefined ? defaultValue : Number(value))),
        v.integer(),
      );
      return v.parse(schema, process.env[key]);
    }
    const schema = v.pipe(v.string(), v.toNumber(), v.integer());
    return v.parse(schema, process.env[key]);
  };

  const smokeResult = await smoke
    .withTimeout(getEnvInt(SMOKE_TIMEOUT_MS_ENV, DEFAULT_SMOKE_TIMEOUT_MS))
    .withSignal(controller.signal)
    .run(process.argv[2]);

  smokeResult.match({
    ok: () => logger.info("Smoke test completed successfully"),
    err: (error) => {
      matchErrorPartial(
        error,
        {
          SmokeExecError: (e) => {
            logger.error(`exec - ${formatSmokeExecInvocation(e.command, e.args)} (cwd: ${e.cwd})`);
            logger.error("Command failed", {
              message: e.cause.message,
              name: e.cause.name,
              code: e.cause.code,
              signal: e.cause.signal,
              status: e.cause.status,
            });
          },
        },
        logger.error,
      );
      process.exit(process.exitCode || 1);
    },
  });
}

main();
