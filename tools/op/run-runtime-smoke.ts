import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { createLogger } from "./utils.ts";

type Runtime = "bun" | "deno" | "edge";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_DIR = path.join(REPO_ROOT, "packages", "op");
const NPM_SANDBOX_STATE_DIR = path.join(REPO_ROOT, "var", "runtime-smoke");
const NPM_SANDBOX_CACHE_DIR = path.join(NPM_SANDBOX_STATE_DIR, "cache");
const NPM_SANDBOX_LOGS_DIR = path.join(NPM_SANDBOX_STATE_DIR, "logs");
const PACK_OUTPUT_PREVIEW = 4000;
const logger = createLogger(import.meta.url);

function commandEnv(): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(nextEnv)) {
    if (key.toLowerCase().startsWith("npm_config_")) delete nextEnv[key];
  }
  mkdirSync(NPM_SANDBOX_CACHE_DIR, { recursive: true });
  mkdirSync(NPM_SANDBOX_LOGS_DIR, { recursive: true });
  nextEnv["npm_config_cache"] = NPM_SANDBOX_CACHE_DIR;
  nextEnv["npm_config_logs_dir"] = NPM_SANDBOX_LOGS_DIR;
  return nextEnv;
}

function run(command: string, args: readonly string[], cwd: string, capture = false) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: commandEnv(),
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (status === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed in ${cwd} with ${signal ?? `exit ${String(status)}`}\n${stderr}`,
        ),
      );
    });
  });
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
      if (char === '"') inString = false;
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

function parsePackFilename(packOutput: string): string {
  for (const chunk of collectJsonArrayChunks(packOutput).reverse()) {
    const parsed = JSON.parse(chunk) as unknown;
    if (!Array.isArray(parsed)) continue;
    const head = parsed[0] as unknown;
    if (typeof head !== "object" || head === null) continue;
    const filename = Reflect.get(head, "filename");
    if (typeof filename === "string" && filename.length > 0) return filename;
  }

  const preview =
    packOutput.length > PACK_OUTPUT_PREVIEW
      ? `${packOutput.slice(0, PACK_OUTPUT_PREVIEW)}...`
      : packOutput;
  throw new Error(`Unable to read tarball filename from npm pack JSON:\n${preview}`);
}

async function createPackTarball(): Promise<string> {
  await run("npm", ["run", "build"], PACKAGE_DIR);
  const packOutput = await run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "./packages/op"],
    REPO_ROOT,
    true,
  );
  const tarballPath = path.resolve(REPO_ROOT, parsePackFilename(packOutput));
  const relative = path.relative(REPO_ROOT, tarballPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`npm pack filename resolved outside the repository root: ${tarballPath}`);
  }
  return tarballPath;
}

function smokeSource(opImport: string, resultImport: string): string {
  return `import { Op, TimeoutError } from ${JSON.stringify(opImport)};
import { TaggedError, UnhandledException } from ${JSON.stringify(resultImport)};

class AssertionError extends Error {
  name = "AssertionError";
}

function assert(condition, message) {
  if (!condition) throw new AssertionError(message);
}

class TooSmallError extends TaggedError("TooSmallError")() {}

async function runRuntimeSmoke() {
  const divide = Op(function* (a, b) {
    if (b === 0) return yield* new TooSmallError();
    return a / b;
  });

  const program = Op(function* () {
    const quotient = yield* divide(18, 3);
    const doubled = yield* Op.of(quotient * 2);
    return doubled;
  });

  const result = await program.run();
  assert(result.isOk() && result.value === 12, "composition failed");

  const divideError = await divide.run(1, 0);
  assert(divideError.isErr() && divideError.error instanceof TooSmallError, "typed failure failed");

  const timeoutResult = await Op.try(
    (signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("aborted"));
        }, { once: true });
      }),
  )
    .withTimeout(1)
    .run();
  assert(timeoutResult.isErr() && timeoutResult.error instanceof TimeoutError, "timeout failed");

  const unexpectedResult = await Op.try(() => {
    throw new Error("boom");
  }).run();
  assert(
    unexpectedResult.isErr() && unexpectedResult.error instanceof UnhandledException,
    "unexpected exception wrapping failed",
  );
}
`;
}

async function createRuntimeWorkspace(tarballPath: string) {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "op-runtime-smoke-"));
  await writeFile(
    path.join(workspaceDir, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@prodkit/op": `file:${tarballPath}`,
          "better-result": "2.9.0",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await run("npm", ["install", "--ignore-scripts"], workspaceDir);
  return workspaceDir;
}

async function smokeBun(workspaceDir: string) {
  await writeFile(
    path.join(workspaceDir, "runtime-smoke.mjs"),
    `${smokeSource("@prodkit/op", "better-result")}\nawait runRuntimeSmoke();\n`,
    "utf8",
  );
  await run("bun", ["./runtime-smoke.mjs"], workspaceDir);
}

async function smokeDeno(workspaceDir: string) {
  await writeFile(
    path.join(workspaceDir, "runtime-smoke.mjs"),
    `${smokeSource("@prodkit/op", "better-result")}\nawait runRuntimeSmoke();\n`,
    "utf8",
  );
  await writeFile(
    path.join(workspaceDir, "import-map.json"),
    `${JSON.stringify(
      {
        imports: {
          "@prodkit/op": "./node_modules/@prodkit/op/dist/index.mjs",
          "better-result": "./node_modules/better-result/dist/index.mjs",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await run(
    "deno",
    ["run", "--quiet", "--import-map", "./import-map.json", "./runtime-smoke.mjs"],
    workspaceDir,
  );
}

async function smokeEdge(workspaceDir: string) {
  const edgeDir = path.join(workspaceDir, "edge");
  mkdirSync(edgeDir);

  const opEntryPath = path.join(
    workspaceDir,
    "node_modules",
    "@prodkit",
    "op",
    "dist",
    "index.mjs",
  );
  const resultEntryPath = path.join(
    workspaceDir,
    "node_modules",
    "better-result",
    "dist",
    "index.mjs",
  );
  if (!existsSync(opEntryPath)) throw new Error(`Missing packed @prodkit/op entry: ${opEntryPath}`);
  if (!existsSync(resultEntryPath))
    throw new Error(`Missing better-result entry: ${resultEntryPath}`);

  const opEntry = await readFile(opEntryPath, "utf8");
  await writeFile(
    path.join(edgeDir, "prodkit-op.mjs"),
    opEntry.replaceAll(/(from\s*["'])better-result(["'])/g, "$1./better-result.mjs$2"),
    "utf8",
  );
  await cp(resultEntryPath, path.join(edgeDir, "better-result.mjs"));
  await writeFile(
    path.join(edgeDir, "worker.mjs"),
    `${smokeSource("./prodkit-op.mjs", "./better-result.mjs")}

export default {
  async fetch() {
    await runRuntimeSmoke();
    return new Response("ok");
  },
};
`,
    "utf8",
  );

  const mf = new Miniflare({
    scriptPath: path.join(edgeDir, "worker.mjs"),
    modules: true,
    modulesRoot: edgeDir,
  });
  try {
    const response = await mf.dispatchFetch("https://runtime-smoke.test/");
    const body = await response.text();
    if (!response.ok || body !== "ok") {
      throw new Error(`Miniflare smoke failed with ${response.status}: ${body}`);
    }
  } finally {
    await mf.dispose();
  }
}

function parseRuntime(rawRuntime: string | undefined): Runtime[] {
  if (rawRuntime === undefined || rawRuntime === "all") return ["bun", "deno", "edge"];
  if (rawRuntime === "bun" || rawRuntime === "deno" || rawRuntime === "edge") return [rawRuntime];
  throw new Error(`Unknown runtime smoke target: ${rawRuntime}`);
}

async function main() {
  const runtimes = parseRuntime(process.argv[2]);
  const tarballPath = await createPackTarball();
  try {
    for (const runtime of runtimes) {
      const workspaceDir = await createRuntimeWorkspace(tarballPath);
      try {
        if (runtime === "bun") await smokeBun(workspaceDir);
        if (runtime === "deno") await smokeDeno(workspaceDir);
        if (runtime === "edge") await smokeEdge(workspaceDir);
        logger.info(`${runtime} completed successfully`);
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(tarballPath, { force: true });
  }
}

main().catch((error: unknown) => {
  logger.error(error);
  process.exit(1);
});
