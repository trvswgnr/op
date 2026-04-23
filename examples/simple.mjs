import { Op, TypedError } from "@prodkit/op";

export class DivisionByZeroError extends TypedError("DivisionByZeroError") {}

export class NegativeError extends Error {
  constructor(n) {
    super();
    this.type = "NegativeError";
    this.n = n;
  }
}

export const divide = Op(function* (a, b) {
  if (b === 0) return yield* new DivisionByZeroError();
  return a / b;
});

export const sqrt = Op(function* (n) {
  if (n < 0) return yield* Op.fail(new NegativeError(n));
  return Math.sqrt(n);
});

export const mathComposeProgram = Op(function* () {
  const quotient = yield* divide(10, 3);
  const rooted = yield* sqrt(quotient - 4);
  return rooted * 2;
});

export class FetchError extends Error {
  constructor({ cause }) {
    super();
    this.type = "FetchError";
    this.cause = cause;
  }
}

export class HttpError extends Error {
  constructor({ status, statusText }) {
    super();
    this.type = "HttpError";
    this.status = status;
    this.statusText = statusText;
  }
}

export class ParseError extends Error {
  constructor({ raw }) {
    super();
    this.type = "ParseError";
    this.raw = raw;
  }
}

export const parseUser = Op(function* (payload) {
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

export const fetchData = Op(function* (url) {
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
    (e) => new FetchError({ cause: e }),
  );

  const parsedBody = yield* Op.try(
    () => response.json(),
    (e) => new ParseError({ raw: e }),
  );

  return parsedBody;
});

export const userProgram = Op(function* (id) {
  const userPayload = yield* fetchData(`/api/users/${id}`);
  const user = yield* parseUser(userPayload);
  return user;
});
