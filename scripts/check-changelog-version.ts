import { readFile } from "node:fs/promises";
import process from "node:process";
import { Op } from "@prodkit/op";
import { TaggedError } from "better-result";
import * as v from "valibot";

const logger = console;
const DEBUG_ENDPOINT = "http://127.0.0.1:7259/ingest/e27cf1e9-07cb-4244-8553-36ea50196252";
const DEBUG_SESSION_ID = "0d0b42";

const debugLog = (
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
  runId = "initial",
) => {
  fetch(DEBUG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
};

const PackageJson = v.object({ version: v.string() });
type PackageJson = v.InferOutput<typeof PackageJson>;

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

class InvalidJsonError extends TaggedError("ParseError")<{ cause: unknown; input: string }>() {}
const parseJson = Op(function* (input: string) {
  return yield* Op.try(
    () => JSON.parse(input) as unknown,
    (cause) => new InvalidJsonError({ cause, input }),
  );
});

const readUtf8 = Op(function* (path: string) {
  return yield* Op.try(() => readFile(new URL(path, import.meta.url), "utf8"));
});

class InvalidVersionError extends TaggedError("InvalidVersionError")<{ message: string }>() {}

const getVersion = Op(function* () {
  const raw = yield* readUtf8("../package.json");
  const parsedJson = yield* parseJson(raw);
  const parseOp = parse(PackageJson, parsedJson);
  const parsed = yield* parseOp;

  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    return yield* new InvalidVersionError({
      message: "package.json is missing a valid version string",
    });
  }

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

const result = await main.run();
// #region agent log
debugLog("H4", "scripts/check-changelog-version.ts:136", "main.run resolved", {
  resultTag: (result as { _tag?: unknown })._tag ?? "unknown",
  hasMatch: typeof (result as { match?: unknown }).match === "function",
});
// #endregion
result.match({
  ok: () => {
    logger.info("changelog version check passed");
    process.exit(0);
  },
  err: (error) => {
    logger.error(error);
    process.exit(1);
  },
});
