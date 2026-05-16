import process from "node:process";
import { Op } from "@prodkit/op";
import { TaggedError } from "better-result";
import * as v from "valibot";
import {
  createLogger,
  fromRepoRoot,
  NonEmptyString,
  parse,
  readPackageJson,
  readFile,
} from "./utils.ts";

const logger = createLogger();

function hasVersionHeading(changelog: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## \\[${escaped}\\](?:\\s|$)`, "m");
  return heading.test(changelog);
}

class MissingVersionHeadingError extends TaggedError("MissingVersionHeadingError")<{
  version: string;
  message: string;
}>() {
  constructor(version: string) {
    const message = `CHANGELOG.md is missing a section heading for version ${version}.
Add a heading like "## [${version}] - YYYY-MM-DD" before publishing.`;
    super({ version, message });
  }
}

const main = Op(function* () {
  const packageJsonPath = yield* fromRepoRoot("packages/op/package.json");
  const packageJson = yield* readPackageJson(packageJsonPath);
  const { version } = yield* parse(v.object({ version: NonEmptyString }), packageJson);

  const changelogPath = yield* fromRepoRoot("packages/op/CHANGELOG.md");
  const changelog = yield* readFile(changelogPath);

  if (!hasVersionHeading(changelog, version)) {
    return yield* new MissingVersionHeadingError(version);
  }

  return version;
});

main.run().then((result) => {
  result.match({
    ok: (version) => {
      logger.info(`changelog version check passed for version ${version}`);
      process.exit(0);
    },
    err: (error) => {
      logger.error(error);
      process.exit(1);
    },
  });
});
