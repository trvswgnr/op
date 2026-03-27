import { fail, gen, tryPromise, UnexpectedError } from "..";
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

  const divide = gen(function* (a: number, b: number) {
    if (b === 0) return yield* fail(new DivisionByZeroError());
    return a / b;
  });

  const sqrt = gen(function* (n: number) {
    if (n < 0) return yield* fail(new NegativeError(n));
    return Math.sqrt(n);
  });

  // Errors compose automatically through yield*
  // TypeScript infers: Effect<DivByZero | Negative, number>
  const program = gen(function* () {
    const a = yield* divide(10, 3); // unwraps or short-circuits
    const b = yield* sqrt(a - 4); // same - different error type
    return b * 2;
  });

  const _result = await program.run();
  // _result: Result<number, DivByZero | Negative>
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
  class ParseError extends Error {
    readonly type = "ParseError";
    readonly raw: unknown;
    constructor({ raw }: { raw: unknown }) {
      super();
      this.raw = raw;
    }
  }

  const parseUser = gen(function* (data: unknown) {
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

  const fetchData = gen(function* (url: string) {
    const res = yield* tryPromise(
      async () => {
        const res_ = await fetch(url);
        if (!res_.ok) {
          throw new HttpError({ status: res_.status, statusText: res_.statusText });
        }
        return res_;
      },
      (e): FetchError => new FetchError({ cause: e }),
    );
    const json = yield* tryPromise(
      () => res.json(),
      (e): ParseError => new ParseError({ raw: e }),
    );
    return json;
  });

  const program = gen(function* (id: string) {
    const data = yield* fetchData(`/api/users/${id}`);
    const user = yield* parseUser(data);
    return user;
  });
  // Errors accumulate through the union automatically

  // At the edge
  const result = await program.run("123");
  if (!result.ok) {
    handleError(result.error);
  }

  function handleError(error: FetchError | ParseError | UnexpectedError) {
    switch (error.type) {
      case "FetchError":
        // oxlint-disable-next-line no-console
        console.error(error.cause);
        return;
      case "ParseError":
        // oxlint-disable-next-line no-console
        console.error(error.raw);
        return;
      case "UnexpectedError":
        // oxlint-disable-next-line no-console
        console.error(error.cause);
        return;
    }
    const _ = error satisfies never;
  }
}
