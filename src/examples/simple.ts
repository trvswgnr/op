import path from "node:path";
import { fileURLToPath } from "node:url";
import { Op, UnexpectedError, TypedError } from "../index.js";

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

export const divide = Op(function* (a: number, b: number) {
  if (b === 0) return yield* new DivisionByZeroError();
  return a / b;
});

export const sqrt = Op(function* (n: number) {
  if (n < 0) return yield* Op.fail(new NegativeError(n));
  return Math.sqrt(n);
});

// Compose domain operations with typed failures.
// TypeScript infers: Op<number, DivisionByZeroError | NegativeError, []>
export const mathComposeProgram = Op(function* () {
  const quotient = yield* divide(10, 3); // use value or return early on failure
  const rooted = yield* sqrt(quotient - 4);
  return rooted * 2;
});

if (isMainModule()) {
  async function runMathComposeDemo() {
    const mathResult = await mathComposeProgram.run();
    // mathResult: Result<number, DivisionByZeroError | NegativeError | UnexpectedError>
    switch (mathResult.type) {
      case "Ok":
        console.log("mathComposeProgram succeeded");
        console.log(mathResult.value);
        return;
      case "Err":
        console.error("mathComposeProgram failed");
        console.error(mathResult.error);
        return;
    }
    mathResult satisfies never;
  }
  await runMathComposeDemo();
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

export const parseUser = Op(function* (payload: unknown) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("name" in payload) ||
    typeof payload.name !== "string"
  ) {
    return yield* Op.fail(new ParseError({ raw: payload }));
  }
  return { name: payload.name };
});

export const fetchData = Op(function* (url: string) {
  const response = yield* Op.try(
    async () => {
      const fetchedResponse = await fetch(url);
      if (!fetchedResponse.ok) {
        throw new HttpError({
          status: fetchedResponse.status,
          statusText: fetchedResponse.statusText,
        });
      }
      return fetchedResponse;
    },
    (e): FetchError => new FetchError({ cause: e }),
  );
  const parsedBody = yield* Op.try(
    () => response.json(),
    (e): ParseError => new ParseError({ raw: e }),
  );
  return parsedBody;
});

// Error unions stay explicit as the workflow grows.
export const userProgram = Op(function* (id: string) {
  const userPayload = yield* fetchData(`/api/users/${id}`);
  const user = yield* parseUser(userPayload);
  return user;
});

if (isMainModule()) {
  const result = await userProgram.run("123");
  if (!result.ok) {
    handleError(result.error);
  }

  function handleError(error: FetchError | ParseError | UnexpectedError): number {
    switch (error.type) {
      case "FetchError":
        console.error("caught a FetchError!");
        console.error(error.cause);
        return 1;
      case "ParseError":
        console.error("caught a ParseError!");
        console.error(error.raw);
        return 2;
      case "UnexpectedError":
        console.error("caught an UnexpectedError!");
        console.error(error.cause);
        return 3;
    }
  }
}
