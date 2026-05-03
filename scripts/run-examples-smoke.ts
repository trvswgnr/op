import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Op, TaggedError, matchError } from "@prodkit/op";

const logger = console;

/** Overrides {@link DEFAULT_SMOKE_TIMEOUT_MS}; must be a positive integer if set (milliseconds). */
const SMOKE_TIMEOUT_MS_ENV = "OP_SMOKE_TIMEOUT_MS";

/**
 * Controls whether examples/node_modules and examples/package-lock.json are deleted before install
 * Leaving this unset keeps lockfile-driven installs reproducible
 */
const SMOKE_RESET_EXAMPLES_ENV = "OP_SMOKE_RESET_EXAMPLES";

/** Wall-clock budget for the full smoke pipeline (covers cold npm/GitHub installs on CI). */
const DEFAULT_SMOKE_TIMEOUT_MS = 45 * 60_000;

const PACK_OUTPUT_PREVIEW = 4000;
const UPSTREAM_REPO_URL = "https://github.com/trvswgnr/op.git";
const UPSTREAM_MAIN_REF = "refs/heads/main";

const VALID_MODES = ["pack", "github", "npm"] as const;
type Mode = (typeof VALID_MODES)[number];
const VALID_MODE_SET = new Set<string>(VALID_MODES);

class SmokeRepoRootError extends TaggedError("SmokeRepoRootError")<{ message: string }>() {}

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

class SmokeSetupError extends TaggedError("SmokeSetupError")<{ message: string }>() {}

class SmokeGithubRefResolveError extends TaggedError("SmokeGithubRefResolveError")<{
  message: string;
}>() {}

class SmokeCommandExitError extends TaggedError("SmokeCommandExitError")<{
  message: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr?: string;
}>() {}

class SmokeAbortedError extends TaggedError("SmokeAbortedError")<{ message: string }>() {}

function readOwnObjectField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  if (!Object.hasOwn(value, key)) return undefined;
  return Reflect.get(value, key);
}

function readPackageJsonIfPresent(dir: string): unknown {
  const packageJsonPath = path.join(dir, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    return JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return undefined;
  }
}

function readPackageNameIfPresent(dir: string): string | undefined {
  const parsed = readPackageJsonIfPresent(dir);
  const name = readOwnObjectField(parsed, "name");
  return typeof name === "string" ? name : undefined;
}

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
  const typeField = readOwnObjectField(value, "types");
  const defaultField = readOwnObjectField(value, "default");
  const importField = readOwnObjectField(value, "import");
  const requireField = readOwnObjectField(value, "require");
  const nodeField = readOwnObjectField(value, "node");
  const browserField = readOwnObjectField(value, "browser");

  let sawRuntimeCondition = false;
  for (const runtimeCondition of [
    defaultField,
    importField,
    requireField,
    nodeField,
    browserField,
  ]) {
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

function parseNpmPackFilename(packJsonChunk: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packJsonChunk);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length < 1) return undefined;
  const filename = readOwnObjectField(parsed[0], "filename");
  return typeof filename === "string" && filename.length > 0 ? filename : undefined;
}

function collectJsonArrayChunks(text: string): string[] {
  const chunks: string[] = [];
  let inString = false;
  let escapeNext = false;
  let depth = 0;
  let startIndex = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) continue;

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (char === "\\") {
        escapeNext = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "[") {
      if (depth === 0) startIndex = index;
      depth += 1;
      continue;
    }

    if (char === "]" && depth > 0) {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        chunks.push(text.slice(startIndex, index + 1));
        startIndex = -1;
      }
    }
  }

  return chunks;
}

function parseNpmPackFilenameFromOutput(packOutput: string): string | undefined {
  const chunks = collectJsonArrayChunks(packOutput);
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    if (chunk === undefined) continue;
    const parsed = parseNpmPackFilename(chunk);
    if (parsed) return parsed;
  }
  return undefined;
}

function formatSmokeExecInvocation(command: string, args: readonly string[]): string {
  return [command, ...args].map((word) => JSON.stringify(word)).join(" ");
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
    const code = readOwnObjectField(cause, "code");
    const signal = readOwnObjectField(cause, "signal");
    const status = readOwnObjectField(cause, "status");
    const stdout = readOwnObjectField(cause, "stdout");
    const stderr = readOwnObjectField(cause, "stderr");
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

function resolveSmokeTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_SMOKE_TIMEOUT_MS;
  const parsedTimeoutMs = Number(raw);
  if (
    !Number.isFinite(parsedTimeoutMs) ||
    parsedTimeoutMs <= 0 ||
    !Number.isInteger(parsedTimeoutMs)
  ) {
    logger.warn(
      `${SMOKE_TIMEOUT_MS_ENV}="${raw}" ignored; using default ${DEFAULT_SMOKE_TIMEOUT_MS}ms`,
    );
    return DEFAULT_SMOKE_TIMEOUT_MS;
  }
  return parsedTimeoutMs;
}

function defaultResetExamplesInstall(): boolean {
  return false;
}

function resolveResetExamplesInstall(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return defaultResetExamplesInstall();
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  const fallback = defaultResetExamplesInstall();
  logger.warn(
    `${SMOKE_RESET_EXAMPLES_ENV}="${raw}" ignored; using default ${fallback ? "true" : "false"}`,
  );
  return fallback;
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

const getRepoRoot = Op(function* () {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    const name = readPackageNameIfPresent(currentDir);
    if (name === "@prodkit/op") {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return yield* new SmokeRepoRootError({
        message: 'Unable to locate repo root with package name "@prodkit/op"',
      });
    }

    currentDir = parentDir;
  }
});

class InvalidModeError extends TaggedError("InvalidModeError")<{ message: string }>() {
  constructor(mode: string | undefined) {
    const message = mode
      ? `Unknown mode "${mode}". Expected one of: ${VALID_MODES.join(", ")}`
      : "No mode provided";
    super({ message });
  }
}

const parseMode = Op(function* (mode: string | undefined) {
  if (mode !== undefined && VALID_MODE_SET.has(mode)) return mode as Mode;
  return yield* new InvalidModeError(mode);
});

const execOp = Op(function* (
  command: string,
  args: string[],
  cwd: string,
  capture: boolean = false,
) {
  return yield* Op.try(
    (signal) => runCommand(command, args, cwd, capture, signal),
    (cause) => {
      if (readOwnObjectField(cause, "name") === "AbortError") {
        return new SmokeAbortedError({ message: "Operation aborted" });
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

const ensureInstalledPackageReady = Op(function* (examplesDir: string, sourceLabel: string) {
  const installedPkgDir = path.join(examplesDir, "node_modules", "@prodkit", "op");
  const packageJson = readPackageJsonIfPresent(installedPkgDir);
  const entryCandidates = new Set<string>(["./dist/index.mjs"]);

  const mainField = readOwnObjectField(packageJson, "main");
  if (typeof mainField === "string" && mainField.length > 0) entryCandidates.add(mainField);

  const moduleField = readOwnObjectField(packageJson, "module");
  if (typeof moduleField === "string" && moduleField.length > 0) entryCandidates.add(moduleField);

  const exportsField = readOwnObjectField(packageJson, "exports");
  if (readOwnObjectField(exportsField, ".") !== undefined) {
    collectRuntimeEntryLeaves(readOwnObjectField(exportsField, "."), entryCandidates);
  } else {
    collectRuntimeEntryLeaves(exportsField, entryCandidates);
  }

  const entryPaths = Array.from(entryCandidates)
    .map((candidate) => candidate.replace(/^\.\/+/, ""))
    .map((candidate) => path.resolve(installedPkgDir, candidate))
    .filter((candidatePath) => {
      const relative = path.relative(installedPkgDir, candidatePath);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });

  if (entryPaths.some((entryPath) => existsSync(entryPath))) return;

  return yield* new SmokeMissingDistError({
    message: `Installed package from ${sourceLabel} is missing expected entry artifacts (${Array.from(entryCandidates).join(", ")}). This usually means the dependency was installed from source without prebuilt artifacts.`,
  });
});

const prepareExamplesDependencies = Op(function* (examplesDir: string) {
  const packageLockPath = path.join(examplesDir, "package-lock.json");
  if (existsSync(packageLockPath)) {
    yield* execOp("npm", ["ci"], examplesDir);
    return;
  }
  yield* execOp("npm", ["install"], examplesDir);
});

const installAndSmoke = Op(function* (
  examplesDir: string,
  installTarget: string,
  sourceLabel: string,
) {
  yield* execOp(
    "npm",
    ["install", "--no-save", "--package-lock=false", installTarget],
    examplesDir,
  );
  yield* ensureInstalledPackageReady(examplesDir, sourceLabel);
  yield* execOp("npm", ["run", "smoke"], examplesDir);
});

async function cleanupPackOutput(tarballPath: string) {
  logger.info(`[smoke pack] cleaning up tarball: ${tarballPath}`);
  await rm(tarballPath, { force: true });
}

const installFromPack = Op(function* (repoRoot: string) {
  const examplesDir = path.join(repoRoot, "examples");
  yield* execOp("npm", ["run", "build"], repoRoot);

  // --ignore-scripts: we just built above, and letting `prepare` run tsdown
  // again would pollute stdout (including ANSI escapes) and corrupt --json
  const packOutput = yield* execOp("npm", ["pack", "--json", "--ignore-scripts"], repoRoot, true);
  const filename = parseNpmPackFilenameFromOutput(packOutput);

  const preview =
    packOutput.length > PACK_OUTPUT_PREVIEW
      ? `${packOutput.slice(0, PACK_OUTPUT_PREVIEW)}...`
      : packOutput;

  if (!filename) {
    return yield* new SmokePackOutputError({
      message: `Unable to read tarball filename from npm pack JSON (preview):\n${preview}`,
    });
  }

  const tarballPath = path.resolve(repoRoot, filename);
  yield* Op.defer(() => cleanupPackOutput(tarballPath));

  const relativeToRepoRoot = path.relative(path.resolve(repoRoot), tarballPath);
  if (relativeToRepoRoot.startsWith("..") || path.isAbsolute(relativeToRepoRoot)) {
    return yield* new SmokePackOutputError({
      message: `npm pack filename resolves outside the repo root: ${filename}`,
    });
  }

  yield* installAndSmoke(examplesDir, tarballPath, "npm pack tarball");
});

const installFromGithub = Op(function* (repoRoot: string, examplesDir: string) {
  const commitSha = yield* resolveUpstreamMainCommitSha(repoRoot);
  logger.info(`[smoke github] resolved ${UPSTREAM_MAIN_REF} to ${commitSha}`);
  yield* installAndSmoke(
    examplesDir,
    `@prodkit/op@https://codeload.github.com/trvswgnr/op/tar.gz/${commitSha}`,
    `GitHub dependency (${UPSTREAM_MAIN_REF}@${commitSha})`,
  );
});

const installFromNpm = Op(function* (examplesDir: string) {
  yield* installAndSmoke(examplesDir, "@prodkit/op@latest", "npm registry");
});

const resetExamplesInstall = Op(function* (examplesDir: string) {
  const nodeModulesPath = path.join(examplesDir, "node_modules");
  const packageLockPath = path.join(examplesDir, "package-lock.json");

  if (existsSync(nodeModulesPath)) rmSync(nodeModulesPath, { recursive: true, force: true });
  if (existsSync(packageLockPath)) rmSync(packageLockPath, { force: true });
});

const smoke = Op(function* (rawMode: string | undefined) {
  const repoRoot = yield* getRepoRoot();
  const examplesDir = path.join(repoRoot, "examples");
  if (!existsSync(examplesDir)) {
    return yield* new SmokeSetupError({ message: `examples directory not found: ${examplesDir}` });
  }

  const mode = yield* parseMode(rawMode);

  if (resolveResetExamplesInstall(process.env[SMOKE_RESET_EXAMPLES_ENV])) {
    yield* resetExamplesInstall(examplesDir);
  } else {
    logger.info(
      `[smoke setup] preserving examples lockfile. Set ${SMOKE_RESET_EXAMPLES_ENV}=1 to force cleanup.`,
    );
  }

  yield* prepareExamplesDependencies(examplesDir);

  switch (mode) {
    case "pack":
      yield* installFromPack(repoRoot);
      break;
    case "github":
      yield* installFromGithub(repoRoot, examplesDir);
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
    logger.warn(`[smoke] Process exiting with code ${code}`);
    for (const [sig, handler] of handlers) {
      process.off(sig, handler);
    }
  });

  const smokeResult = await smoke
    .withTimeout(resolveSmokeTimeoutMs(process.env[SMOKE_TIMEOUT_MS_ENV]))
    .withSignal(controller.signal)
    .run(process.argv[2]);

  smokeResult.match({
    ok: () => logger.info("Smoke test completed successfully"),
    err: (error) => {
      matchError(error, {
        SmokeAbortedError: () => {
          logger.warn("[smoke] Operation aborted");
        },
        SmokeExecError: (e) => {
          logger.error(
            `[smoke exec] ${formatSmokeExecInvocation(e.command, e.args)} (cwd: ${e.cwd})`,
          );
          logger.error(
            {
              message: e.cause.message,
              name: e.cause.name,
              code: e.cause.code,
              signal: e.cause.signal,
              status: e.cause.status,
            },
            "Command failed",
          );
        },
        SmokeRepoRootError: (e) => logger.error(`[smoke] ${e.message}`),
        SmokePackOutputError: (e) => logger.error(`[smoke] ${e.message}`),
        SmokeMissingDistError: (e) => logger.error(`[smoke] ${e.message}`),
        SmokeSetupError: (e) => logger.error(`[smoke] ${e.message}`),
        SmokeGithubRefResolveError: (e) => logger.error(`[smoke] ${e.message}`),
        InvalidModeError: (e) => logger.error(`[smoke] ${e.message}`),
        TimeoutError: (e) => logger.error(`[smoke] ${e.message}`),
        UnhandledException: (e) => logger.error(e),
      });
      process.exit(process.exitCode);
    },
  });
}

main();
