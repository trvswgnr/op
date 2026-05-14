import { Op } from "@prodkit/op";
import { TaggedError } from "better-result";

export class DivisionByZeroError extends TaggedError("DivisionByZeroError")() {}

export class NegativeError extends Error {
  _tag: "NegativeError";
  n: number;

  constructor(n: number) {
    super();
    this._tag = "NegativeError";
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

export class FetchError extends TaggedError("FetchError")() {}
export class HttpError extends TaggedError("HttpError")<{ status: number; statusText: string }>() {}
export class ParseError extends TaggedError("ParseError")<{ raw: unknown }>() {}

export const parseUser = Op(function* (payload: unknown) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("name" in payload) ||
    typeof payload.name !== "string"
  ) {
    return yield* new ParseError({ raw: payload });
  }
  return { name: payload.name };
});

export const fetchData = Op(function* (url: string) {
  const response = yield* Op.try(
    async (signal) => {
      const fetchedResponse = await fetch(url, { signal });
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

export const pollUntil = <T, E>(
  op: Op<T, E, []>,
  opts: { until: (value: T) => boolean; intervalMs: number },
): Op<T, E, []> => {
  return Op(function* () {
    while (true) {
      const value = yield* op;
      if (opts.until(value)) return value;

      yield* Op.sleep(opts.intervalMs);
    }
  });
};

export const exampleWithPoll = Op(function* () {
  const o = { count: 0 };
  const interval = setInterval(() => {
    o.count++;
  }, 50);
  yield* Op.defer(() => clearInterval(interval));

  const result = yield* pollUntil(Op.of(o), {
    until: (v) => {
      return v.count === 10;
    },
    intervalMs: 10,
  });

  return result;
});
