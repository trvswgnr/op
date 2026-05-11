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
  NonEmptyArray,
  NonEmptyString,
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

/** Wall-clock budget for the full smoke pipeline (covers cold npm/GitHub installs on CI). */
const DEFAULT_SMOKE_TIMEOUT_MS = 45 * 60_000;

const PACK_OUTPUT_PREVIEW = 4000;
const UPSTREAM_REPO_URL = "https://github.com/trvswgnr/prodkit.git";
const UPSTREAM_MAIN_REF = "refs/heads/main";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NPM_SANDBOX_STATE_DIR = path.join(REPO_ROOT, "var", "npm-smoke");
const NPM_SANDBOX_CACHE_DIR = path.join(NPM_SANDBOX_STATE_DIR, "cache");
const NPM_SANDBOX_LOGS_DIR = path.join(NPM_SANDBOX_STATE_DIR, "logs");

// const VALID_MODES = ["pack", "github", "npm"] as const;
// type Mode = (typeof VALID_MODES)[number];
// const VALID_MODE_SET = new Set<string>(VALID_MODES);

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

const parseNpmPackFilename = Op(function* (packJsonChunk: string) {
  const parsedJson = yield* parseJson(packJsonChunk);
  const [head] = yield* parse(NonEmptyArray(v.object({ filename: NonEmptyString })), parsedJson);
  const filename: NonEmptyString = head.filename;
  return filename;
});

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

const parseNpmPackFilenameFromOutput = Op(function* (packOutput: string) {
  const chunks = collectJsonArrayChunks(packOutput);
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    if (chunk === undefined) continue;
    const parsed = yield* parseNpmPackFilename(chunk);
    if (parsed) return parsed;
  }
  return undefined;
});

function formatSmokeExecInvocation(command: string, args: readonly string[]): string {
  return [command, ...args].map((word) => JSON.stringify(word)).join(" ");
}

function buildCommandEnv(): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(nextEnv)) {
    if (!key.toLowerCase().startsWith("npm_config_")) continue;
    delete nextEnv[key];
  }
  // Keep npm writable state inside the repo so sandboxed runs never need ~/.npm.
  mkdirSync(NPM_SANDBOX_CACHE_DIR, { recursive: true });
  mkdirSync(NPM_SANDBOX_LOGS_DIR, { recursive: true });
  nextEnv["npm_config_cache"] = NPM_SANDBOX_CACHE_DIR;
  nextEnv["npm_config_logs_dir"] = NPM_SANDBOX_LOGS_DIR;
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

function parseSmokeTimeoutMs(raw: string | number | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsedTimeoutMs = Number(raw);
  if (
    !Number.isFinite(parsedTimeoutMs) ||
    parsedTimeoutMs <= 0 ||
    !Number.isInteger(parsedTimeoutMs)
  ) {
    throw new Error(`Invalid timeout value: ${raw}`);
  }
  return parsedTimeoutMs;
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

const ensureInstalledPackageReady = Op(function* (examplesDir: string, sourceLabel: string) {
  const installedPkgDir = path.join(examplesDir, "node_modules", "@prodkit", "op");
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

  if (entryPaths.some((entryPath) => existsSync(entryPath))) return;

  return yield* new SmokeMissingDistError({
    message: `Installed package from ${sourceLabel} is missing expected entry artifacts (${Array.from(entryCandidates).join(", ")}). This usually means the dependency was installed from source without prebuilt artifacts.`,
  });
});

const createTempExamplesWorkspace = Op(function* (examplesDir: string, opInstallTarget: string) {
  const tempDir = yield* Op.try(
    () => mkdtemp(path.join(os.tmpdir(), "op-examples-smoke-")),
    (cause) =>
      new SmokeWorkspaceError({ message: "Failed to create temporary examples workspace", cause }),
  );
  yield* Op.defer(() => rm(tempDir, { recursive: true, force: true }));

  yield* Op.try(
    () =>
      cp(examplesDir, tempDir, {
        recursive: true,
        force: true,
        filter: (sourcePath) => path.basename(sourcePath) !== "node_modules",
      }),
    (cause) => new SmokeWorkspaceError({ message: "Failed to copy examples files", cause }),
  );

  const packageJsonPath = path.join(tempDir, "package.json");
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
  nextDependencies["@prodkit/op"] = opInstallTarget;

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

  return tempDir;
});

const installAndSmoke = Op(function* (
  examplesDir: string,
  installTarget: string,
  sourceLabel: string,
) {
  const smokeWorkspaceDir = yield* createTempExamplesWorkspace(examplesDir, installTarget);
  yield* execOp("npm", ["install"], smokeWorkspaceDir);
  yield* ensureInstalledPackageReady(smokeWorkspaceDir, sourceLabel);
  yield* execOp("npm", ["run", "smoke"], smokeWorkspaceDir);
});

async function cleanupPackOutput(tarballPath: string) {
  logger.info(`pack - cleaning up tarball: ${tarballPath}`);
  await rm(tarballPath, { force: true });
}

const installFromPack = Op(function* () {
  const repoRoot = yield* fromRepoRoot(".");
  const packageDir = yield* fromRepoRoot("packages/op");
  const examplesDir = yield* fromRepoRoot("examples/op");
  yield* execOp("npm", ["run", "build"], packageDir);

  // --ignore-scripts: we just built above, and letting `prepare` run tsdown
  // again would pollute stdout (including ANSI escapes) and corrupt --json
  const packOutput = yield* execOp(
    "npm",
    ["pack", "--json", "--ignore-scripts", "./packages/op"],
    repoRoot,
    true,
  );
  const filename = yield* parseNpmPackFilenameFromOutput(packOutput);

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
      message: `npm pack filename resolves outside the repository root: ${filename}`,
    });
  }

  yield* installAndSmoke(examplesDir, tarballPath, "npm pack tarball");
});

const installFromGithub = Op(function* () {
  const repoRoot = yield* fromRepoRoot(".");
  const examplesDir = yield* fromRepoRoot("examples/op");
  const commitSha = yield* resolveUpstreamMainCommitSha(repoRoot);
  logger.info(`github - resolved ${UPSTREAM_MAIN_REF} to ${commitSha}`);
  yield* installAndSmoke(
    examplesDir,
    `@prodkit/op@https://codeload.github.com/trvswgnr/prodkit/tar.gz/${commitSha}`,
    `GitHub dependency (${UPSTREAM_MAIN_REF}@${commitSha})`,
  );
});

const installFromNpm = Op(function* (examplesDir: string) {
  yield* installAndSmoke(examplesDir, "@prodkit/op@latest", "npm registry");
});

const smoke = Op(function* (rawMode: string | undefined) {
  const examplesDir = yield* fromRepoRoot("examples/op");

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

  const smokeResult = await smoke
    .withTimeout(parseSmokeTimeoutMs(process.env[SMOKE_TIMEOUT_MS_ENV], DEFAULT_SMOKE_TIMEOUT_MS))
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
