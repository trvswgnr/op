// oxlint-disable no-console
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, gen, fromPromise, UnexpectedError, TypedError } from "../lib.js";

function isMainModule(): boolean {
  const entry = typeof process !== "undefined" ? process.argv[1] : undefined;
  if (entry === undefined) return false;
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(thisFile) === path.resolve(entry);
}

export class DivisionByZeroError extends TypedError("DivisionByZeroError") {}
export class NegativeError extends Error {
  readonly type = "NegativeError";
  readonly n: number;
  constructor(n: number) {
    super();
    this.n = n;
  }
}

export const divide = gen(function* (a: number, b: number) {
  if (b === 0) return yield* fail(new DivisionByZeroError());
  return a / b;
});

export const sqrt = gen(function* (n: number) {
  if (n < 0) return yield* fail(new NegativeError(n));
  return Math.sqrt(n);
});

// Errors compose automatically through yield*
// TypeScript infers: Op<number, DivByZero | Negative>
export const mathComposeProgram = gen(function* () {
  const a = yield* divide(10, 3); // unwraps or short-circuits
  const b = yield* sqrt(a - 4); // same - different error type
  return b * 2;
});

if (isMainModule()) {
  const _result = await mathComposeProgram.run();
  void _result;
  // _result: Result<number, DivByZero | Negative>
}

export class FetchError extends Error {
  readonly type = "FetchError";
  constructor({ cause }: { cause: unknown }) {
    super();
    this.cause = cause;
  }
}
export class HttpError extends Error {
  readonly type = "HttpError";
  readonly status: number;
  readonly statusText: string;
  constructor({ status, statusText }: { status: number; statusText: string }) {
    super();
    this.status = status;
    this.statusText = statusText;
  }
}
export class ParseError extends Error {
  readonly type = "ParseError";
  readonly raw: unknown;
  constructor({ raw }: { raw: unknown }) {
    super();
    this.raw = raw;
  }
}

export const parseUser = gen(function* (data: unknown) {
  if (
    typeof data !== "object" ||
    data === null ||
    !("name" in data) ||
    typeof data.name !== "string"
  ) {
    return yield* fail(new ParseError({ raw: data }));
  }
  return { name: data.name };
});

export const fetchData = gen(function* (url: string) {
  const res = yield* fromPromise(
    async () => {
      const res_ = await fetch(url);
      if (!res_.ok) {
        throw new HttpError({ status: res_.status, statusText: res_.statusText });
      }
      return res_;
    },
    (e): FetchError => new FetchError({ cause: e }),
  );
  const json = yield* fromPromise(
    () => res.json(),
    (e): ParseError => new ParseError({ raw: e }),
  );
  return json;
});

// Errors accumulate through the union automatically
export const userProgram = gen(function* (id: string) {
  const data = yield* fetchData(`/api/users/${id}`);
  const user = yield* parseUser(data);
  return user;
});

if (isMainModule()) {
  const result = await userProgram.run("123");
  if (!result.ok) {
    handleError(result.error);
  }

  function handleError(error: FetchError | ParseError | UnexpectedError) {
    switch (error.type) {
      case "FetchError":
        console.error("caught a FetchError!");
        console.error(error.cause);
        return;
      case "ParseError":
        console.error("caught a ParseError!");
        console.error(error.raw);
        return;
      case "UnexpectedError":
        console.error("caught an UnexpectedError!");
        console.error(error.cause);
        return;
    }
    const _ = error satisfies never;
  }
}
