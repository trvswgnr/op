import { Op, TypedError } from "@prodkit/op";

export class DivisionByZeroError extends TypedError("DivisionByZeroError") {}

export class NegativeError extends Error {
  type: "NegativeError";
  n: number;

  constructor(n: number) {
    super();
    this.type = "NegativeError";
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

export const mathComposeProgram = Op(function* () {
  const quotient = yield* divide(10, 3);
  const rooted = yield* sqrt(quotient - 4);
  return rooted * 2;
});

export class FetchError extends Error {
  type: "FetchError";
  cause: unknown;

  constructor({ cause }: { cause: unknown }) {
    super();
    this.type = "FetchError";
    this.cause = cause;
  }
}

export class HttpError extends Error {
  type: "HttpError";
  status: number;
  statusText: string;

  constructor({ status, statusText }: { status: number; statusText: string }) {
    super();
    this.type = "HttpError";
    this.status = status;
    this.statusText = statusText;
  }
}

export class ParseError extends Error {
  type: "ParseError";
  raw: unknown;

  constructor({ raw }: { raw: unknown }) {
    super();
    this.type = "ParseError";
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
    (cause) => new FetchError({ cause }),
  );

  const parsedBody = yield* Op.try(
    () => response.json(),
    (e) => new ParseError({ raw: e }),
  );

  return parsedBody;
});

export const userProgram = Op(function* (id: string) {
  const userPayload = yield* fetchData(`/api/users/${id}`);
  const user = yield* parseUser(userPayload);
  return user;
});
