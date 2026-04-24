import { describe, expect, test, assert, expectTypeOf } from "vitest";
import { fail, fromGenFn, succeed, _try } from "./builders.js";
import { TimeoutError, UnexpectedError, TypedError } from "./errors.js";
import type { Op } from "./core.js";
import type { Result } from "./result.js";

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
    const syncThrow = new Error("failed");
    const result = await _try(
      () => {
        throw syncThrow;
      },
      (e) => `mapped: ${e}`,
    ).run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBe(`mapped: ${syncThrow}`);
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
    const p1 = _try(() => Promise.resolve(1)).withRetry();
    expectTypeOf(p1).toEqualTypeOf<Op<number, UnexpectedError, []>>();

    const p2 = _try(
      () => Promise.resolve(1),
      () => "retryable",
    ).withRetry();
    expectTypeOf(p2).toEqualTypeOf<Op<number, string, []>>();

    const p3 = fromGenFn(function* (id: string) {
      return yield* succeed(id.length);
    }).withRetry();
    expectTypeOf(p3).toEqualTypeOf<Op<number, never, [id: string]>>();

    const nested = fromGenFn(function* () {
      const v = yield* _try(() => Promise.resolve(1)).withRetry();
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

  test("withRetry inference for fluent async and generator ops", async () => {
    const p1 = fromGenFn(function* (id: string) {
      return yield* _try(() => Promise.resolve(id.length));
    }).withRetry();
    expectTypeOf(p1).toEqualTypeOf<Op<number, UnexpectedError, [id: string]>>();
    expectTypeOf(p1.run("abc")).toEqualTypeOf<Promise<Result<number, UnexpectedError>>>();

    const p2 = fromGenFn(function* (id: string) {
      if (Math.random() < 0) {
        return yield* fail("boom");
      }
      return id.length;
    }).withRetry();
    expectTypeOf(p2).toEqualTypeOf<Op<number, string, [id: string]>>();
    expectTypeOf(p2.run("abc")).toEqualTypeOf<Promise<Result<number, string | UnexpectedError>>>();

    expect((await p1.run("abcd")).ok).toBe(true);
  });

  test("distinguishes between multiple error types", async () => {
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

  test("withTimeout preserves inferred op shapes", async () => {
    const p1 = _try(() => Promise.resolve(1)).withTimeout(10);
    expectTypeOf(p1).toEqualTypeOf<Op<number, UnexpectedError | TimeoutError, []>>();

    const p2 = _try(
      () => Promise.resolve(1),
      () => "mapped",
    ).withTimeout(10);
    expectTypeOf(p2).toEqualTypeOf<Op<number, string | TimeoutError, []>>();

    const p3 = fromGenFn(function* (id: string) {
      return yield* succeed(id.length);
    }).withTimeout(10);
    expectTypeOf(p3).toEqualTypeOf<Op<number, TimeoutError, [id: string]>>();

    const r1 = p1.run();
    expectTypeOf(r1).toEqualTypeOf<Promise<Result<number, TimeoutError | UnexpectedError>>>();

    const r2 = p2.run();
    expectTypeOf(r2).toEqualTypeOf<
      Promise<Result<number, string | TimeoutError | UnexpectedError>>
    >();

    const r3 = p3.run("abc");
    expectTypeOf(r3).toEqualTypeOf<Promise<Result<number, TimeoutError | UnexpectedError>>>();

    expect((await p1.run()).ok).toBe(true);

    // @ts-expect-error - nullary timeout op does not accept args
    p1.run(1);
    // @ts-expect-error - parameterized timeout op requires argument
    p3.run();
    // @ts-expect-error - parameterized timeout op does not accept extra args
    p3.run("abc", "extra");

    let attempts = 0;
    class FetchError extends TypedError("FetchError") {}
    const fetcher = async () => {
      attempts++;
      if (attempts === 1) {
        throw new FetchError();
      }
      return 69;
    };
    const slowOp = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return await fetcher();
    };
    const p4 = fromGenFn(function* () {
      const x = yield* _try(slowOp, () => new FetchError())
        .withRetry()
        .withTimeout(50);
      expectTypeOf(x).toEqualTypeOf<number>();
      return x;
    });
    expectTypeOf(p4).toEqualTypeOf<Op<number, TimeoutError | FetchError, []>>();
    const result = await p4.run();
    expectTypeOf(result).toEqualTypeOf<
      Result<number, TimeoutError | FetchError | UnexpectedError>
    >();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(TimeoutError);
  });
});
