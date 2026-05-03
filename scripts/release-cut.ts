import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

type BumpKind = "patch" | "minor" | "major";

type PackageJson = {
  version?: unknown;
};

const NO_ENTRIES_PLACEHOLDER = "- No entries yet.";
const UNRELEASED_HEADING = "## [Unreleased]";

async function readUtf8(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

async function writeUtf8(path: string, content: string): Promise<void> {
  return writeFile(new URL(path, import.meta.url), content, "utf8");
}

function parseBumpKind(): BumpKind {
  const arg = process.argv[2];
  if (arg === "patch" || arg === "minor" || arg === "major") {
    return arg;
  }

  throw new Error("usage: node ./scripts/release-cut.ts <patch|minor|major>");
}

function parseVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`unsupported version format: "${value}"`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function bumpVersion(current: string, kind: BumpKind): string {
  const [major, minor, patch] = parseVersion(current);
  if (kind === "major") {
    return `${major + 1}.0.0`;
  }

  if (kind === "minor") {
    return `${major}.${minor + 1}.0`;
  }

  return `${major}.${minor}.${patch + 1}`;
}

async function getCurrentVersion(): Promise<string> {
  const raw = await readUtf8("../package.json");
  const parsed = JSON.parse(raw) as PackageJson;
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json is missing a valid version string");
  }

  return parsed.version;
}

function getReleaseDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function promoteUnreleased(changelog: string, nextVersion: string, releaseDate: string): string {
  const unreleasedStart = changelog.indexOf(UNRELEASED_HEADING);
  if (unreleasedStart === -1) {
    throw new Error('CHANGELOG.md is missing "## [Unreleased]"');
  }

  const nextHeadingStart = changelog.indexOf("\n## [", unreleasedStart + UNRELEASED_HEADING.length);
  if (nextHeadingStart === -1) {
    throw new Error('CHANGELOG.md must include at least one released section after "Unreleased"');
  }

  const preamble = changelog.slice(0, unreleasedStart).trimEnd();
  const unreleasedBodyRaw = changelog
    .slice(unreleasedStart + UNRELEASED_HEADING.length, nextHeadingStart)
    .trim();
  const releasedSections = changelog.slice(nextHeadingStart).trimStart();

  const unreleasedBody = unreleasedBodyRaw.replace(NO_ENTRIES_PLACEHOLDER, "").trim();
  const releaseBody = /- /m.test(unreleasedBody)
    ? unreleasedBody
    : "### Changed\n\n- No user-facing changes in this release.";

  const newUnreleased = `${UNRELEASED_HEADING}\n\n### Added\n\n${NO_ENTRIES_PLACEHOLDER}`;
  const newReleaseSection = `## [${nextVersion}] - ${releaseDate}\n\n${releaseBody}`;

  return `${preamble}\n\n${newUnreleased}\n\n${newReleaseSection}\n\n${releasedSections}\n`;
}

function run(command: string): void {
  execSync(command, {
    stdio: "inherit",
  });
}

async function main(): Promise<void> {
  const bumpKind = parseBumpKind();
  const currentVersion = await getCurrentVersion();
  const nextVersion = bumpVersion(currentVersion, bumpKind);
  const releaseDate = getReleaseDate();

  const changelog = await readUtf8("../CHANGELOG.md");
  const updatedChangelog = promoteUnreleased(changelog, nextVersion, releaseDate);
  await writeUtf8("../CHANGELOG.md", updatedChangelog);

  run(`npm version ${bumpKind} --no-git-tag-version`);
  run("npm run fmt");
  run("npm run release:prepare");
  run("git add CHANGELOG.md package.json package-lock.json");
  run(`git commit -m "${nextVersion}"`);
  run(`git tag v${nextVersion}`);

  process.stdout.write(`release cut complete: v${nextVersion}\n`);
  process.stdout.write("next step: npm run release:push\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
