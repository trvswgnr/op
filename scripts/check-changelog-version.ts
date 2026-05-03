import { readFile } from "node:fs/promises";
import process from "node:process";

type PackageJson = {
  version?: unknown;
};

async function readUtf8(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

async function getVersion(): Promise<string> {
  const raw = await readUtf8("../package.json");
  const parsed = JSON.parse(raw) as PackageJson;

  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json is missing a valid version string");
  }

  return parsed.version;
}

function hasVersionHeading(changelog: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## \\[${escaped}\\](?:\\s|$)`, "m");
  return heading.test(changelog);
}

async function main(): Promise<void> {
  const version = await getVersion();
  const changelog = await readUtf8("../CHANGELOG.md");

  if (!hasVersionHeading(changelog, version)) {
    throw new Error(
      `CHANGELOG.md is missing a section heading for version ${version}. ` +
        `Add a heading like "## [${version}] - YYYY-MM-DD" before publishing.`,
    );
  }

  process.stdout.write(`changelog contains version heading for ${version}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
