import { execSync } from "node:child_process";
import process from "node:process";
import { Op } from "@prodkit/op";
import * as v from "valibot";
import { TaggedError } from "better-result";
import {
  createLogger,
  fromRepoRoot,
  NonEmptyString,
  parse,
  ParseError,
  parseJson,
  readFile,
  writeFile,
} from "./utils.ts";

const logger = createLogger();

const DRY_RUN_PREFIX = "[dry-run]";

const NO_ENTRIES_PLACEHOLDER = "- No entries yet.";
const NO_CHANGES_SECTION = "### Changed\n\n- No user-facing changes in this release.";
const UNRELEASED_HEADING = "## [Unreleased]";

const BumpKind = v.union([v.literal("patch"), v.literal("minor"), v.literal("major")]);
type BumpKind = v.InferOutput<typeof BumpKind>;

class ChangelogError extends TaggedError("ChangelogError")<{ message: string }>() {}

class CommandError extends TaggedError("CommandError")<{ cause: unknown; command: string }>() {}

const main = Op(function* (dryRun: boolean) {
  const repoRoot = yield* fromRepoRoot(".");

  const writeUtf8 = Op(function* (filepath: string, content: string) {
    if (dryRun) {
      logger.info(`${DRY_RUN_PREFIX} would write ${filepath}`);
      return;
    }
    return yield* writeFile({
      filepath: new URL(filepath, import.meta.url),
      content,
      encoding: "utf8",
    });
  });
  const parseBumpKind = Op(function* (arg: string | undefined) {
    const result = v.safeParse(BumpKind, arg);
    if (!result.success) {
      return yield* new ParseError({
        message: "usage: node ./tools/scripts/release-cut.ts <patch|minor|major>",
        issues: result.issues,
        input: arg,
      });
    }
    return result.output;
  });

  const parseVersion = Op(function* (value: string) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) {
      return yield* new ParseError({
        message: `unsupported version format: "${value}"`,
        issues: [],
        input: value,
      });
    }

    return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  });

  const bumpVersion = Op(function* (current: string, kind: BumpKind) {
    const [major, minor, patch] = yield* parseVersion(current);
    if (kind === "major") {
      return `${major + 1}.0.0`;
    }

    if (kind === "minor") {
      return `${major}.${minor + 1}.0`;
    }

    return `${major}.${minor}.${patch + 1}`;
  });

  const getCurrentVersion = Op(function* () {
    const packageJsonPath = yield* fromRepoRoot("packages/op/package.json");
    const raw = yield* readFile(packageJsonPath);
    const parsedJson = yield* parseJson(raw);
    const parsed = yield* parse(v.object({ version: NonEmptyString }), parsedJson);

    return parsed.version;
  });

  const getReleaseDate = Op.try(() => new Date().toISOString().slice(0, 10));

  const promoteUnreleased = Op(function* (
    changelog: string,
    nextVersion: string,
    releaseDate: string,
  ) {
    const unreleasedStart = changelog.indexOf(UNRELEASED_HEADING);
    if (unreleasedStart === -1) {
      return yield* new ChangelogError({ message: 'CHANGELOG.md is missing "## [Unreleased]"' });
    }

    const nextHeadingStart = changelog.indexOf(
      "\n## [",
      unreleasedStart + UNRELEASED_HEADING.length,
    );
    if (nextHeadingStart === -1) {
      return yield* new ChangelogError({
        message: 'CHANGELOG.md must include at least one released section after "Unreleased"',
      });
    }

    const preamble = changelog.slice(0, unreleasedStart).trimEnd();
    const unreleasedBodyRaw = changelog
      .slice(unreleasedStart + UNRELEASED_HEADING.length, nextHeadingStart)
      .trim();
    const releasedSections = changelog.slice(nextHeadingStart).trimStart();

    const unreleasedBody = unreleasedBodyRaw.replace(NO_ENTRIES_PLACEHOLDER, "").trim();
    const releaseBody = /- /m.test(unreleasedBody) ? unreleasedBody : NO_CHANGES_SECTION;

    const newUnreleased = `${UNRELEASED_HEADING}\n\n### Added\n\n${NO_ENTRIES_PLACEHOLDER}`;
    const newReleaseSection = `## [${nextVersion}] - ${releaseDate}\n\n${releaseBody}`;

    return `${preamble}\n\n${newUnreleased}\n\n${newReleaseSection}\n\n${releasedSections}\n`;
  });

  const run = Op(function* (command: string) {
    if (dryRun) {
      logger.info(`${DRY_RUN_PREFIX} would run: ${command}`);
      return;
    }

    return yield* Op.try(
      () => execSync(command, { stdio: "inherit", cwd: repoRoot }),
      (cause) => new CommandError({ cause, command }),
    );
  });

  const bumpKind = yield* parseBumpKind(process.argv[2]);
  const currentVersion = yield* getCurrentVersion();
  const nextVersion = yield* bumpVersion(currentVersion, bumpKind);
  const releaseDate = yield* getReleaseDate();
  const changelogPath = yield* fromRepoRoot("packages/op/CHANGELOG.md");

  const changelog = yield* readFile(changelogPath);
  const updatedChangelog = yield* promoteUnreleased(changelog, nextVersion, releaseDate);
  yield* writeUtf8(changelogPath, updatedChangelog);

  yield* run(`pnpm --filter @prodkit/op version ${bumpKind} --no-git-tag-version`);
  yield* run("pnpm run fmt");
  yield* run("pnpm --filter @prodkit/op run release:prepare");
  yield* run("git add packages/op/CHANGELOG.md packages/op/package.json");
  yield* run(`git commit -m "${nextVersion}"`);
  yield* run(`git tag v${nextVersion}`);

  return { nextVersion, dryRun };
});

main
  .run(
    // defaults to dry run to avoid accidental release cuts
    Boolean(JSON.parse(process.env.DRY_RUN || "1")),
  )
  .then((result) => {
    result.match({
      ok: ({ nextVersion, dryRun }) => {
        if (dryRun) {
          logger.info(`${DRY_RUN_PREFIX} release cut simulation complete for v${nextVersion}`);
          logger.info("no files, commits, or tags were changed\n");
          logger.info("next step: run with DRY_RUN=0 to cut the release\n");
          return;
        }

        logger.info(`release cut complete: v${nextVersion}\n`);
        logger.info("next step: pnpm --filter @prodkit/op run release:push\n");
      },
      err: (error) => {
        logger.error(error);
        process.exit(1);
      },
    });
  });
