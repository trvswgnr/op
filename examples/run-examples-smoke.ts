import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";

function getRepoRoot(maxDepth = 5) {
  let currentDir = path.dirname(new URL(import.meta.url).pathname);
  let depth = 0;

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");

    if (
      existsSync(packageJsonPath) &&
      JSON.parse(readFileSync(packageJsonPath, "utf8")).name === "@prodkit/op"
    ) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error('Unable to locate repo root with package name "@prodkit/op"');
    }

    currentDir = parentDir;
    if (depth++ >= maxDepth) {
      throw new Error(
        `Depth limit (${maxDepth}) exceeded before finding repo root with package name "@prodkit/op"
Current directory: ${currentDir}`,
      );
    }
  }
}

const repoRoot = getRepoRoot();
const examplesDir = path.join(repoRoot, "examples");
const installedPkgDir = path.join(examplesDir, "node_modules", "@prodkit", "op");
const installedEntryPath = path.join(installedPkgDir, "dist", "index.mjs");

const mode = process.argv[2] ?? "pack";
const validModes = new Set(["pack", "github", "npm"]);

if (!validModes.has(mode)) {
  const choices = [...validModes].join(", ");
  throw new Error(`Unknown mode "${mode}". Expected one of: ${choices}`);
}

const run = (command: string, args: string[], cwd = repoRoot, capture = false) => {
  if (capture) {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  }

  execFileSync(command, args, { cwd, stdio: "inherit" });
  return "";
};

const resetExamplesInstall = () => {
  const nodeModulesPath = path.join(examplesDir, "node_modules");
  const packageLockPath = path.join(examplesDir, "package-lock.json");

  if (existsSync(nodeModulesPath)) rmSync(nodeModulesPath, { recursive: true, force: true });
  if (existsSync(packageLockPath)) rmSync(packageLockPath, { force: true });
};

const ensureInstalledPackageReady = ({
  sourceLabel,
  allowBuildFallback,
}: {
  sourceLabel: string;
  allowBuildFallback: boolean;
}) => {
  if (existsSync(installedEntryPath)) return;

  if (allowBuildFallback && existsSync(installedPkgDir)) {
    run("npm", ["install"], installedPkgDir);
    run("npm", ["run", "build", "--", "--config-loader", "unrun"], installedPkgDir);
  }

  if (!existsSync(installedEntryPath)) {
    throw new Error(
      `Installed package from ${sourceLabel} is missing dist/index.mjs. This usually means the dependency was installed from source without prebuilt artifacts.`,
    );
  }
};

const installFromPack = () => {
  run("npm", ["run", "build"]);

  // --ignore-scripts: we just built above, and letting `prepare` run tsdown
  // again would pollute stdout (including ANSI escapes) and corrupt --json.
  const packOutput = run("npm", ["pack", "--json", "--ignore-scripts"], repoRoot, true);
  const jsonMatch = packOutput.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!jsonMatch) {
    throw new Error(`Unable to parse npm pack output:\n${packOutput}`);
  }

  const [{ filename }] = JSON.parse(jsonMatch[0]);
  const tarballPath = path.join(repoRoot, filename);

  try {
    run("npm", ["install", "--no-save", tarballPath], examplesDir);
    ensureInstalledPackageReady({ sourceLabel: "npm pack tarball", allowBuildFallback: false });
    run("npm", ["run", "smoke"], examplesDir);
  } finally {
    if (existsSync(tarballPath)) rmSync(tarballPath, { force: true });
  }
};

const installFromGithub = () => {
  run(
    "npm",
    [
      "install",
      "--no-save",
      "@prodkit/op@https://codeload.github.com/trvswgnr/op/tar.gz/refs/heads/main",
    ],
    examplesDir,
  );
  ensureInstalledPackageReady({ sourceLabel: "GitHub dependency", allowBuildFallback: true });
  run("npm", ["run", "smoke"], examplesDir);
};

const installFromNpm = () => {
  run("npm", ["install", "--no-save", "@prodkit/op@latest"], examplesDir);
  ensureInstalledPackageReady({ sourceLabel: "npm registry", allowBuildFallback: false });
  run("npm", ["run", "smoke"], examplesDir);
};

resetExamplesInstall();

switch (mode) {
  case "pack":
    installFromPack();
    break;
  case "github":
    installFromGithub();
    break;
  case "npm":
    installFromNpm();
    break;
  default:
    throw new Error(`Unhandled mode "${mode}"`);
}
