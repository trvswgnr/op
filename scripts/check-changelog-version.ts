import { readFile } from "node:fs/promises";
import process from "node:process";
import { Op } from "@prodkit/op";
import { TaggedError } from "better-result";
import * as v from "valibot";

const logger = console;

const PackageJson = v.object({ version: v.pipe(v.string(), v.nonEmpty()) });
type PackageJson = v.InferOutput<typeof PackageJson>;

class InvalidJsonError extends TaggedError("ParseError")<{ cause: unknown; input: string }>() {}
const parseJson = Op(function* (input: string) {
  return yield* Op.try(
    () => JSON.parse(input) as unknown,
    (cause) => new InvalidJsonError({ cause, input }),
  );
});

class ParseError extends TaggedError("ParseError")<{
  issues: v.BaseIssue<unknown>[];
  input: unknown;
}>() {}
const parse = <S extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: S,
  input: unknown,
) =>
  Op(function* () {
    const result = v.safeParse(schema, input);
    if (!result.success) {
      return yield* Op.fail(new ParseError({ issues: result.issues, input }));
    }
    return result.output;
  });

class InvalidFileError extends TaggedError("InvalidFileError")<{
  cause: unknown;
  path: string;
}>() {}
const readUtf8 = Op(function* (path: string) {
  return yield* Op.try(
    () => readFile(new URL(path, import.meta.url), "utf8"),
    (cause) => new InvalidFileError({ cause, path }),
  );
});

const getVersion = Op(function* () {
  const raw = yield* readUtf8("../package.json");
  const parsed = yield* parse(PackageJson, yield* parseJson(raw));
  return parsed.version;
});

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
  const version = yield* getVersion();
  const changelog = yield* readUtf8("../CHANGELOG.md");

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
