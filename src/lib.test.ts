import { describe, expect, test, assert, expectTypeOf, vi } from "vitest";
import {
  fail,
  fromGenFn,
  Op,
  Result,
  succeed,
  _try,
  UnexpectedError,
  TypedError,
  withRetry,
  RetryStrategy,
} from "./lib.js";

describe("UnexpectedError", () => {
  test("creates error with message 'An unexpected error occurred'", () => {
    const err = new UnexpectedError({ cause: "test" });
    expect(err.message).toBe("An unexpected error occurred");
  });

  test("accepts and preserves cause in constructor options", () => {
    const cause = new Error("original");
    const err = new UnexpectedError({ cause });
    expect(err.cause).toBe(cause);
  });

  test("type discriminant is 'UnexpectedError'", () => {
    const err = new UnexpectedError({ cause: null });
    expect(err.type).toBe("UnexpectedError");
  });

  test("instanceof Error and UnexpectedError", () => {
    const err = new UnexpectedError({ cause: "x" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UnexpectedError);
  });
});

describe("TypedError", () => {
  test("default message uses the type name", () => {
    const NetworkError = TypedError("NetworkError", "A network error occurred");
    const err = new NetworkError();
    expect(err.message).toBe("A network error occurred");
    expect(err.type).toBe("NetworkError");
    expect(err.data).toEqual({});
  });

  test("subclass with no extra data can be constructed with no arguments", () => {
    class DivisionByZeroError extends TypedError("DivisionByZeroError") {}
    const err = new DivisionByZeroError();
    expect(err.message).toBe("");
    expect(err.data).toEqual({});
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DivisionByZeroError);
  });

  test("custom message overrides default and is not left on data", () => {
    const ValidationError = TypedError("ValidationError");
    const err = new ValidationError({ message: "field required" });
    expect(err.message).toBe("field required");
    expect(err.data).toEqual({});
    expect("message" in err.data).toBe(false);
  });

  test("message key with undefined falls back to default text", () => {
    const E = TypedError("E", "An E error occurred");
    const err = new E({ message: undefined });
    expect(err.message).toBe("An E error occurred");
    expect(err.data).toEqual({});
  });

  test("cause is passed to Error and stripped from data", () => {
    const E = TypedError("E");
    const cause = new Error("root");
    const err = new E({ cause });
    expect(err.cause).toBe(cause);
    expect(err.data).toEqual({});
    expect("cause" in err.data).toBe(false);
  });

  test("preserves arbitrary payload fields on data", () => {
    class NotFound extends TypedError("NotFound")<{
      resource: string;
      id: number;
    }> {}
    const err = new NotFound({ resource: "user", id: 42, message: "gone", cause: "db" });
    expect(err.message).toBe("gone");
    expect(err.cause).toBe("db");
    expect(err.data).toEqual({ resource: "user", id: 42 });
  });

  test("does not mutate the passed data object, creates a new object without message and cause", () => {
    const E = TypedError("E");
    const payload = Object.freeze({ message: "m", cause: 1, extra: true });
    const err = new E(payload);
    expect(err.data).toEqual({ extra: true });
  });

  test("type narrowing: distinct factories produce distinct classes", () => {
    const A = TypedError("A");
    const B = TypedError("B");
    const a = new A();
    const b = new B();
    expect(a).toBeInstanceOf(A);
    expect(a).not.toBeInstanceOf(B);
    expect(b).toBeInstanceOf(B);
    expect(b).not.toBeInstanceOf(A);
  });

  test("expectTypeOf: default data allows zero-arg constructor", () => {
    const E = TypedError("E");
    const e = new E();
    expectTypeOf(e).toEqualTypeOf<TypedError<"E">>();
  });

  test("can be used directly in gen", async () => {
    class CustomError extends TypedError("CustomError") {}
    const customError = new CustomError();
    const e = fromGenFn(function* () {
      return yield* customError;
    });
    expectTypeOf(e).toEqualTypeOf<Op<never, CustomError, []>>();
    const result = await e.run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBe(customError);
  });
});

describe("succeed", () => {
  test("run returns Ok with value", async () => {
    const result = await succeed(69).run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(69);
  });

  test("handles various value types", async () => {
    const r1 = await succeed(0).run();
    assert(r1.ok === true, "r1.ok should be true");
    expect(r1.value).toBe(0);

    const r2 = await succeed("").run();
    assert(r2.ok === true, "r2.ok should be true");
    expect(r2.value).toBe("");

    const r3 = await succeed(null).run();
    assert(r3.ok === true, "r3.ok should be true");
    expect(r3.value).toBe(null);

    const r4 = await succeed({ foo: "bar" }).run();
    assert(r4.ok === true, "r4.ok should be true");
    expect(r4.value).toEqual({ foo: "bar" });

    const r5 = await succeed([1, 2, 3]).run();
    assert(r5.ok === true, "r5.ok should be true");
    expect(r5.value).toEqual([1, 2, 3]);
  });

  test("handles promises", async () => {
    const result = await succeed(Promise.resolve(69)).run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(69);

    const program = fromGenFn(function* () {
      const a = yield* succeed(Promise.resolve(1));
      const b = yield* succeed(Promise.resolve(2));
      return a + b;
    });
    const result2 = await program.run();
    assert(result2.ok === true, "result2.ok should be true");
    expect(result2.value).toBe(3);
  });
});

describe("fail", () => {
  test("run returns Err with error", async () => {
    const result = await fail("error").run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBe("error");
  });

  test("preserves custom error objects", async () => {
    const customErr = new Error("custom message");
    const result = await fail(customErr).run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBe(customErr);
    expect(result.error.message).toBe("custom message");
  });

  test("short-circuits immediately", async () => {
    let executed = false;
    const program = fromGenFn(function* () {
      yield* fail("stop");
      executed = true;
      return yield* succeed(1);
    });
    const result = await program.run();
    expect(result.ok).toBe(false);
    expect(executed).toBe(false);
  });
});

describe("_try", () => {
  test("success path returns Ok with resolved value", async () => {
    const program = _try(
      () => Promise.resolve(1),
      () => "err",
    );
    const result = await program.run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(1);
  });

  test("rejection maps to Err via onError", async () => {
    {
      const result = await _try(
        () => Promise.reject("failed"),
        (e) => `mapped: ${e}`,
      ).run();
      assert(result.ok === false, "result.ok should be false");
      expect(result.error).toBe("mapped: failed");
    }
  });

  test("works with sync throws", async () => {
    const result = await _try(
      () => {
        throw "failed";
      },
      (e) => `mapped: ${e}`,
    ).run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBe("mapped: failed");
  });

  test("UnexpectedError when promise rejects without proper handling", async () => {
    const testError = new TypeError("whoops");
    const result = await fromGenFn(function* () {
      const x = yield* _try(
        () => Promise.reject("raw rejection"),
        () => {
          throw testError;
        },
      );
      return x;
    }).run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
    expect(result.error.cause).toBe(testError);
  });

  test("UnexpectedError when onError throws", async () => {
    const error = new Error("onError threw");
    const result = await _try(
      () => Promise.reject("boom"),
      () => {
        throw error;
      },
    ).run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
    expect(result.error.cause).toBeInstanceOf(Error);
    expect(result.error.cause).toBe(error);
  });
});

describe("gen", () => {
  test("sequential succeed composes values", async () => {
    const result = await fromGenFn(function* () {
      const a = yield* succeed(1);
      const b = yield* succeed(2);
      return a + b;
    }).run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(3);
  });

  test("fail short-circuits before subsequent ops", async () => {
    let firstRan = false;
    let secondRan = false;
    const result = await fromGenFn(function* () {
      yield* succeed(void (firstRan = true));
      yield* fail("oops");
      secondRan = true;
      return yield* succeed(2);
    }).run();
    expect(firstRan).toBe(true);
    assert(result.ok === false, "result.ok should be true");
    expect(result.error).toBe("oops");
    expect(secondRan).toBe(false);
  });

  test("_try in gen - success path", async () => {
    const result = await fromGenFn(function* () {
      const a = yield* succeed(10);
      const b = yield* _try(
        () => Promise.resolve(a * 2),
        () => "err",
      );
      return b;
    }).run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(20);
  });

  test("_try in gen - error path", async () => {
    const p = fromGenFn(function* () {
      yield* succeed(1);
      return yield* _try(
        () => Promise.reject("async fail"),
        (e) => ({ mapped: e }),
      );
    });
    const result = await p.run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toEqual({ mapped: "async fail" });
  });

  test("_try in gen - onError is optional", async () => {
    const p = fromGenFn(function* () {
      return yield* _try(() => Promise.reject("async fail"));
    });
    const result = await p.run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
  });

  test("parameterized gen - run passes args into the generator", async () => {
    const add = fromGenFn(function* (a: number, b: number) {
      return a + b;
    });
    const result = await add(2, 3).run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(5);
  });

  test("parameterized gen composes via yield* and callable op", async () => {
    const add = fromGenFn(function* (a: number, b: number) {
      return a + b;
    });
    const program = fromGenFn(function* () {
      return yield* add(1, 2);
    });
    const viaRun = await program.run();
    const viaFreeRun = await program.run();
    assert(viaRun.ok === true, "viaRun.ok should be true");
    assert(viaFreeRun.ok === true, "viaFreeRun.ok should be true");
    expect(viaRun.value).toBe(3);
    expect(viaFreeRun.value).toBe(3);
  });

  test("nullary gen - run() matches run(op)", async () => {
    const program = fromGenFn(function* () {
      return yield* succeed(69);
    });
    const a = await program.run();
    const b = await program.run();
    assert(a.ok === true, "a.ok should be true");
    assert(b.ok === true, "b.ok should be true");
    expect(a.value).toBe(69);
    expect(b.value).toBe(69);
  });
});

describe("withRetry", () => {
  class FetchError extends Error {
    readonly type = "FetchError";
  }
  const toFetchError = (cause: unknown): FetchError =>
    cause instanceof FetchError ? cause : new FetchError(String(cause));

  const createFetcher = () => {
    let attempt = 0;
    return async (url: string) => {
      if (attempt === 0) {
        attempt++;
        throw new FetchError("couldn't fetch");
      }
      return { url };
    };
  };

  test("retries on failure with default options", async () => {
    const fetcher = createFetcher();
    const program = withRetry(
      fromGenFn(function* (id: string) {
        return yield* _try(() => fetcher(`https://example.com/${id}`));
      }),
    );

    const result = await program.run("123");
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toEqual({ url: `https://example.com/123` });
  });

  test("retries until success with custom retry predicate and delay", async () => {
    const fetcher = vi.fn(createFetcher());
    const strategy: RetryStrategy = {
      maxAttempts: 3,
      shouldRetry: (cause) => cause instanceof FetchError,
      getDelay: (attempt) => attempt * 100,
    };

    const program = withRetry(
      fromGenFn(function* (id: string) {
        return yield* _try(() => fetcher(`https://example.com/${id}`), toFetchError);
      }),
      strategy,
    );

    const result = await program.run("123");
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toEqual({ url: `https://example.com/123` });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("stops after maxAttempts and returns the last error", async () => {
    const fetcher = vi.fn(async (_url: string) => {
      throw new FetchError("always fails");
    });

    const strategy: RetryStrategy = {
      maxAttempts: 3,
      shouldRetry: (cause) => cause instanceof FetchError,
      getDelay: () => 0,
    };

    const program = withRetry(
      fromGenFn(function* (id: string) {
        return yield* _try(() => fetcher(`https://example.com/${id}`), toFetchError);
      }),
      strategy,
    );

    const result = await program.run("123");
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(FetchError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test("does not retry when shouldRetry returns false", async () => {
    const fetcher = vi.fn(async (_url: string) => {
      throw new FetchError("retry denied");
    });

    const strategy: RetryStrategy = {
      maxAttempts: 5,
      shouldRetry: () => false,
      getDelay: () => 0,
    };

    const program = withRetry(
      fromGenFn(function* (id: string) {
        return yield* _try(() => fetcher(`https://example.com/${id}`), toFetchError);
      }),
      strategy,
    );

    const result = await program.run("123");
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(FetchError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("waits for configured delay before retrying", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(createFetcher());
      const strategy: RetryStrategy = {
        maxAttempts: 2,
        shouldRetry: () => true,
        getDelay: () => 100,
      };

      const program = withRetry(
        fromGenFn(function* (id: string) {
          return yield* _try(() => fetcher(`https://example.com/${id}`));
        }),
        strategy,
      );

      const runPromise = program.run("123");

      await Promise.resolve();
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      const result = await runPromise;
      assert(result.ok === true, "result.ok should be true");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("works when wrapping _try directly", async () => {
    let attempts = 0;
    const program = withRetry(
      _try(
        async () => {
          attempts += 1;
          if (attempts < 2) {
            throw new FetchError("transient failure");
          }
          return { ok: true as const };
        },
        toFetchError,
      ),
      {
        maxAttempts: 3,
        shouldRetry: (cause) => cause instanceof FetchError,
        getDelay: () => 0,
      },
    );

    const result = await program.run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  test("wrapping _try directly can retry UnexpectedError causes", async () => {
    let attempts = 0;
    const transient = new Error("temporary outage");
    const program = withRetry(_try(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw transient;
      }
      return "done";
    }), {
      maxAttempts: 3,
      shouldRetry: (cause) =>
        cause instanceof UnexpectedError && cause.cause === transient,
      getDelay: () => 0,
    });

    const result = await program.run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe("done");
    expect(attempts).toBe(3);
  });

  test("retries a child op inside a parent op", async () => {
    let attempts = 0;
    const transient = new FetchError("intermittent");
    const child = () =>
      _try(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw transient;
          }
          return 20;
        },
        toFetchError,
      );

    const parent = fromGenFn(function* () {
      const base = yield* succeed(22);
      const fetched = yield* withRetry(child(), {
        maxAttempts: 3,
        shouldRetry: (cause) => cause instanceof FetchError,
        getDelay: () => 0,
      });
      return base + fetched;
    });

    const result = await parent.run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(42);
    expect(attempts).toBe(2);
  });
});

describe("op.run", () => {
  test("sync op completes without awaiting", async () => {
    const result = await succeed("sync").run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe("sync");
  });

  test("async op suspends and resumes correctly", async () => {
    const result = await _try(
      () => Promise.resolve("async"),
      () => "err",
    ).run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe("async");
  });

  test("chained async ops", async () => {
    const program = fromGenFn(function* () {
      const first = yield* _try(
        () => Promise.resolve({ data: "raw" }),
        () => "fetch err",
      );
      const second = yield* _try(
        () => Promise.resolve(JSON.parse(`{"n": 69}`)),
        () => "parse err",
      );
      return { first, second };
    });
    const result = await program.run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.value.first).toEqual({ data: "raw" });
    expect(result.value.second).toEqual({ n: 69 });
  });

  test("UnexpectedError propagates from rejecting promise", async () => {
    const error = new Error("unhandled");
    const makeNumber = fromGenFn(function* (n: number) {
      return n;
    });
    const alwaysFails = fromGenFn(function* () {
      return yield* _try(() => Promise.reject(error));
    });
    const program = fromGenFn(function* () {
      yield* makeNumber(1);
      const x = yield* alwaysFails();
      return x;
    });
    const result = await program.run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
    expect(result.error.cause).toBeInstanceOf(Error);
    expect(result.error.cause).toBe(error);
  });
});

describe("edge cases and invariants", () => {
  test("Ok result has correct shape", async () => {
    const result = await succeed(1).run();
    assert(result.ok === true, "result.ok should be true");
    expect(result.type).toBe("Ok");
    expect(result.value).toBe(1);
  });

  test("Err result has correct shape", async () => {
    const result = await fail("e").run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.type).toBe("Err");
    expect(result.error).toBe("e");
  });

  test("result from run is frozen", async () => {
    const okResult = await succeed(1).run();
    expect(okResult.ok).toBe(true);
    expect(Object.isFrozen(okResult)).toBe(true);

    const errResult = await fail("e").run();
    assert(errResult.ok === false, "errResult.ok should be false");
    expect(Object.isFrozen(errResult)).toBe(true);
  });

  test("empty and zero values work correctly", async () => {
    const r0 = await succeed(0).run();
    assert(r0.ok === true, "r0.ok should be true");
    expect(r0.value).toBe(0);

    const rEmpty = await succeed("").run();
    assert(rEmpty.ok === true, "rEmpty.ok should be true");
    expect(rEmpty.value).toBe("");
  });

  test("returns UnexpectedError when throw in generator", async () => {
    const error = new Error("unhandled");
    const result = await fromGenFn(function* () {
      throw error;
    }).run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
    expect(result.error.cause).toBe(error);
  });
  test("returns UnexpectedError when unhandled Promise rejection in gen", async () => {
    const error = new Error("unhandled");
    const result = await fromGenFn(function* () {
      return Promise.reject(error);
    }).run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
    expect(result.error.cause).toBe(error);
  });
});

describe("type inference", () => {
  test("infers the correct type from the generator", () => {
    const p1 = fromGenFn(function* () {
      return yield* succeed(1);
    });
    expectTypeOf(p1).toEqualTypeOf<Op<number, never, []>>();
    const p2 = fromGenFn(function* (a: number) {
      return yield* succeed(a);
    });
    expectTypeOf(p2).toEqualTypeOf<Op<number, never, [a: number]>>();
    const p3 = succeed(1);
    expectTypeOf(p3).toEqualTypeOf<Op<number, never, []>>();
    const p4 = fail("error");
    expectTypeOf(p4).toEqualTypeOf<Op<never, string, []>>();
    const p5 = _try(() => Promise.resolve(1));
    expectTypeOf(p5).toEqualTypeOf<Op<number, UnexpectedError, []>>();
    const p6 = _try(
      () => Promise.resolve(1),
      () => "error",
    );
    expectTypeOf(p6).toEqualTypeOf<Op<number, string, []>>();
  });
  test("infers the correct type from the run", () => {
    const p1 = fromGenFn(function* () {
      return yield* succeed(1);
    }).run();
    expectTypeOf(p1).toEqualTypeOf<Promise<Result<number, UnexpectedError>>>();
    const p2 = fromGenFn(function* (a: string) {
      return yield* succeed(a);
    }).run("hello");
    expectTypeOf(p2).toEqualTypeOf<Promise<Result<string, UnexpectedError>>>();
  });
  test("op.run() arity is enforced by the type checker", async () => {
    const p1 = fromGenFn(function* () {
      return yield* succeed(1);
    });
    expect((await p1.run()).ok).toBe(true);
    // @ts-expect-error - nullary run does not accept arguments
    p1.run(1);

    const p2 = fromGenFn(function* (a: number) {
      return yield* succeed(a);
    });
    // @ts-expect-error - missing required argument
    p2.run(); // note: not enforced at runtime
    // @ts-expect-error - too many arguments
    p2.run(1, 2); // note: not enforced at runtime
    const r2 = await p2.run(69);
    assert(r2.ok === true, "r2.ok should be true");
    expect(r2.value).toBe(69);
  });

  test("withRetry preserves inferred op shapes", async () => {
    const p1 = withRetry(_try(() => Promise.resolve(1)));
    expectTypeOf(p1).toEqualTypeOf<Op<number, UnexpectedError, []>>();

    const p2 = withRetry(
      _try(
        () => Promise.resolve(1),
        () => "retryable",
      ),
    );
    expectTypeOf(p2).toEqualTypeOf<Op<number, string, []>>();

    const p3 = withRetry(
      fromGenFn(function* (id: string) {
        return yield* succeed(id.length);
      }),
    );
    expectTypeOf(p3).toEqualTypeOf<Op<number, never, [id: string]>>();

    const nested = fromGenFn(function* () {
      const v = yield* withRetry(_try(() => Promise.resolve(1)));
      return v + 1;
    });
    expectTypeOf(nested).toEqualTypeOf<Op<number, UnexpectedError, []>>();

    const r1 = p1.run();
    expectTypeOf(r1).toEqualTypeOf<Promise<Result<number, UnexpectedError>>>();

    const r2 = p2.run();
    expectTypeOf(r2).toEqualTypeOf<Promise<Result<number, string | UnexpectedError>>>();

    const r3 = p3.run("abc");
    expectTypeOf(r3).toEqualTypeOf<Promise<Result<number, UnexpectedError>>>();

    expect((await p1.run()).ok).toBe(true);

    // @ts-expect-error - nullary retry op does not accept args
    p1.run(1);
    // @ts-expect-error - parameterized retry op requires argument
    p3.run();
    // @ts-expect-error - parameterized retry op does not accept extra args
    p3.run("abc", "extra");
  });

  test("disguishes between multiple error types", async () => {
    // note: requires that the types returned are distinct
    class CustomError1 extends Error {
      readonly unique = "CustomError1";
    }
    class CustomError2 extends Error {
      readonly alsoUnique = "CustomError2";
    }
    class CustomError3 extends TypedError("CustomError3") {}
    const alwaysFails1 = fromGenFn(function* () {
      if (Math.random() < 0) {
        return yield* succeed(1);
      }
      return yield* fail(new CustomError1("error1"));
    });
    const alwaysFails2 = fromGenFn(function* () {
      if (Math.random() < 0) {
        return yield* succeed(1);
      }
      return yield* fail(new CustomError2("error2"));
    });
    const alwaysFails3 = fromGenFn(function* () {
      if (Math.random() < 0) {
        return yield* succeed(1);
      }
      return yield* fail(new CustomError3());
    });
    const program = fromGenFn(function* () {
      const a = yield* alwaysFails1();
      const b = yield* alwaysFails2();
      const c = yield* alwaysFails3();
      return a + b + c;
    });
    const result = await program.run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(CustomError1);
  });
});
