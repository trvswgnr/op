import { fail, gen, run, tryPromise } from "..";
{
  class DivisionByZeroError extends Error {
    readonly type = "DivisionByZeroError";
  }
  class NegativeError extends Error {
    readonly type = "NegativeError";
    readonly n: number;
    constructor(n: number) {
      super();
      this.n = n;
    }
  }

  const divide = (a: number, b: number) =>
    gen(function* () {
      if (b === 0) return yield* fail(new DivisionByZeroError());
      return a / b;
    });

  const sqrt = (n: number) =>
    gen(function* () {
      if (n < 0) return yield* fail(new NegativeError(n));
      return Math.sqrt(n);
    });

  // Errors compose automatically through yield*
  // TypeScript infers: Effect<DivByZero | Negative, number>
  const program = gen(function* () {
    const a = yield* divide(10, 3); // unwraps or short-circuits
    const b = yield* sqrt(a - 4); // same — different error type
    return b * 2;
  });

  const result = await run(program);
  // Result<DivByZero | Negative, number>
}
{
  class FetchError extends Error {
    readonly type = "FetchError";
    constructor({ cause }: { cause: unknown }) {
      super();
      this.cause = cause;
    }
  }
  class HttpError extends Error {
    readonly type = "HttpError";
    readonly status: number;
    readonly statusText: string;
    constructor({ status, statusText }: { status: number; statusText: string }) {
      super();
      this.status = status;
      this.statusText = statusText;
    }
  }
  // class ParseError extends TypedError("ParseError")<{ raw: unknown }> {}
  class ParseError extends Error {
    readonly type = "ParseError";
    readonly raw: unknown;
    constructor({ raw }: { raw: unknown }) {
      super();
      this.raw = raw;
    }
  }

  const parseUser = (data: unknown) =>
    gen(function* () {
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

  const fetchData = (url: string) =>
    gen(function* () {
      const res = yield* tryPromise(
        async () => {
          const res = await fetch(url);
          if (!res.ok) {
            throw new HttpError({ status: res.status, statusText: res.statusText });
          }
          return res;
        },
        (e): FetchError => new FetchError({ cause: e }),
      );
      const json = yield* tryPromise(
        () => res.json(),
        (e): ParseError => new ParseError({ raw: e }),
      );
      return json;
    });
  // Inferred: Effect<HttpErr | ParseErr, any>

  const getUser = (id: string) =>
    gen(function* () {
      const data = yield* fetchData(`/api/users/${id}`);
      const user = yield* parseUser(data);
      return user;
    });
  // Errors accumulate through the union automatically

  // At the edge
  const result = await run(getUser("123"));
  if (!result.ok) {
    switch (result.error.type) {
      case "FetchError": // handle
      case "ParseError": // handle
    }
  }
}
