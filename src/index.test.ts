import { describe, expect, test, assert, expectTypeOf } from "vitest";
import {
  fail,
  gen,
  Op,
  Result,
  run,
  succeed,
  fromPromise,
  UnexpectedError,
  TypedError,
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
});

describe("succeed", () => {
  test("run returns Ok with value", async () => {
    const result = await run(succeed(69));
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(69);
  });

  test("handles various value types", async () => {
    const r1 = await run(succeed(0));
    assert(r1.ok === true, "r1.ok should be true");
    expect(r1.value).toBe(0);

    const r2 = await run(succeed(""));
    assert(r2.ok === true, "r2.ok should be true");
    expect(r2.value).toBe("");

    const r3 = await run(succeed(null));
    assert(r3.ok === true, "r3.ok should be true");
    expect(r3.value).toBe(null);

    const r4 = await run(succeed({ foo: "bar" }));
    assert(r4.ok === true, "r4.ok should be true");
    expect(r4.value).toEqual({ foo: "bar" });

    const r5 = await run(succeed([1, 2, 3]));
    assert(r5.ok === true, "r5.ok should be true");
    expect(r5.value).toEqual([1, 2, 3]);
  });
});

describe("fail", () => {
  test("run returns Err with error", async () => {
    const result = await run(fail("error"));
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBe("error");
  });

  test("preserves custom error objects", async () => {
    const customErr = new Error("custom message");
    const result = await run(fail(customErr));
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBe(customErr);
    expect(result.error.message).toBe("custom message");
  });

  test("short-circuits immediately", async () => {
    let executed = false;
    const result = await run(
      gen(function* () {
        yield* fail("stop");
        executed = true;
        return yield* succeed(1);
      }),
    );
    expect(result.ok).toBe(false);
    expect(executed).toBe(false);
  });
});

describe("fromPromise", () => {
  test("success path returns Ok with resolved value", async () => {
    const result = await run(
      fromPromise(
        () => Promise.resolve(1),
        () => "err",
      ),
    );
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(1);
  });

  test("rejection maps to Err via onError", async () => {
    const result = await run(
      fromPromise(
        () => Promise.reject(new Error("failed")),
        (e) => (e instanceof Error ? e.message : String(e)),
      ),
    );
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBe("failed");
  });

  test("UnexpectedError when promise rejects without proper handling", async () => {
    const testError = new TypeError("whoops");
    const result = await run(
      gen(function* () {
        const x = yield* fromPromise(
          () => Promise.reject("raw rejection"),
          () => {
            throw testError;
          },
        );
        return x;
      }),
    );
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
    expect(result.error.cause).toBe(testError);
  });

  test("UnexpectedError when onError throws", async () => {
    const error = new Error("onError threw");
    const result = await run(
      fromPromise(
        () => Promise.reject("boom"),
        () => {
          throw error;
        },
      ),
    );
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
    expect(result.error.cause).toBeInstanceOf(Error);
    expect(result.error.cause).toBe(error);
  });
});

describe("gen", () => {
  test("sequential succeed composes values", async () => {
    const result = await run(
      gen(function* () {
        const a = yield* succeed(1);
        const b = yield* succeed(2);
        return a + b;
      }),
    );
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(3);
  });

  test("fail short-circuits before subsequent effects", async () => {
    let firstRan = false;
    let secondRan = false;
    const result = await run(
      gen(function* () {
        yield* succeed(void (firstRan = true));
        yield* fail("oops");
        secondRan = true;
        return yield* succeed(2);
      }),
    );
    expect(firstRan).toBe(true);
    assert(result.ok === false, "result.ok should be true");
    expect(result.error).toBe("oops");
    expect(secondRan).toBe(false);
  });

  test("fromPromise in gen - success path", async () => {
    const result = await run(
      gen(function* () {
        const a = yield* succeed(10);
        const b = yield* fromPromise(
          () => Promise.resolve(a * 2),
          () => "err",
        );
        return b;
      }),
    );
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(20);
  });

  test("fromPromise in gen - error path", async () => {
    const p = gen(function* () {
      yield* succeed(1);
      return yield* fromPromise(
        () => Promise.reject("async fail"),
        (e) => ({ mapped: e }),
      );
    });
    const result = await run(p);
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toEqual({ mapped: "async fail" });
  });

  test("fromPromise in gen - onError is optional", async () => {
    const p = gen(function* () {
      return yield* fromPromise(() => Promise.reject("async fail"));
    });
    const result = await run(p);
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
  });

  test("parameterized gen - run passes args into the generator", async () => {
    const add = gen(function* (a: number, b: number) {
      return a + b;
    });
    const result = await add.run(2, 3);
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(5);
  });

  test("parameterized gen composes via yield* and callable op", async () => {
    const add = gen(function* (a: number, b: number) {
      return a + b;
    });
    const program = gen(function* () {
      return yield* add(1, 2);
    });
    const viaRun = await program.run();
    const viaFreeRun = await run(program);
    assert(viaRun.ok === true, "viaRun.ok should be true");
    assert(viaFreeRun.ok === true, "viaFreeRun.ok should be true");
    expect(viaRun.value).toBe(3);
    expect(viaFreeRun.value).toBe(3);
  });

  test("nullary gen - run() matches run(effect)", async () => {
    const program = gen(function* () {
      return yield* succeed(69);
    });
    const a = await program.run();
    const b = await run(program);
    assert(a.ok === true, "a.ok should be true");
    assert(b.ok === true, "b.ok should be true");
    expect(a.value).toBe(69);
    expect(b.value).toBe(69);
  });
});

describe("run", () => {
  test("sync effect completes without awaiting", async () => {
    const result = await run(succeed("sync"));
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe("sync");
  });

  test("async effect suspends and resumes correctly", async () => {
    const result = await run(
      fromPromise(
        () => Promise.resolve("async"),
        () => "err",
      ),
    );
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe("async");
  });

  test("chained async effects", async () => {
    const program = gen(function* () {
      const first = yield* fromPromise(
        () => Promise.resolve({ data: "raw" }),
        () => "fetch err",
      );
      const second = yield* fromPromise(
        () => Promise.resolve(JSON.parse(`{"n": 69}`)),
        () => "parse err",
      );
      return { first, second };
    });
    const result = await run(program);
    assert(result.ok === true, "result.ok should be true");
    expect(result.value.first).toEqual({ data: "raw" });
    expect(result.value.second).toEqual({ n: 69 });
  });

  test("UnexpectedError propagates from rejecting promise", async () => {
    const error = new Error("unhandled");
    const makeNumber = gen(function* (n: number) {
      return n;
    });
    const alwaysFails = gen(function* () {
      return yield* fromPromise(() => Promise.reject(error));
    });
    const program = gen(function* () {
      yield* makeNumber(1);
      const x = yield* alwaysFails();
      return x;
    });
    const result = await run(program);
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
    expect(result.error.cause).toBeInstanceOf(Error);
    expect(result.error.cause).toBe(error);
  });
});

describe("edge cases and invariants", () => {
  test("Ok result has correct shape", async () => {
    const result = await run(succeed(1));
    assert(result.ok === true, "result.ok should be true");
    expect(result.type).toBe("Ok");
    expect(result.value).toBe(1);
  });

  test("Err result has correct shape", async () => {
    const result = await run(fail("e"));
    assert(result.ok === false, "result.ok should be false");
    expect(result.type).toBe("Err");
    expect(result.error).toBe("e");
  });

  test("result from run is frozen", async () => {
    const okResult = await run(succeed(1));
    expect(okResult.ok).toBe(true);
    expect(Object.isFrozen(okResult)).toBe(true);

    const errResult = await run(fail("e"));
    assert(errResult.ok === false, "errResult.ok should be false");
    expect(Object.isFrozen(errResult)).toBe(true);
  });

  test("empty and zero values work correctly", async () => {
    const r0 = await run(succeed(0));
    assert(r0.ok === true, "r0.ok should be true");
    expect(r0.value).toBe(0);

    const rEmpty = await run(succeed(""));
    assert(rEmpty.ok === true, "rEmpty.ok should be true");
    expect(rEmpty.value).toBe("");
  });

  test("returns UnexpectedError when throw in generator", async () => {
    const error = new Error("unhandled");
    const result = await run(
      gen(function* () {
        throw error;
      }),
    );
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
    expect(result.error.cause).toBe(error);
  });
  test("returns UnexpectedError when unhandled Promise rejection in gen", async () => {
    const error = new Error("unhandled");
    const result = await run(
      gen(function* () {
        return Promise.reject(error);
      }),
    );
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
    expect(result.error.cause).toBe(error);
  });
});

describe("type inference", () => {
  test("infers the correct type from the generator", () => {
    const p1 = gen(function* () {
      return yield* succeed(1);
    });
    expectTypeOf(p1).toEqualTypeOf<Op<number, never, []>>();
    const p2 = gen(function* (a: number) {
      return yield* succeed(a);
    });
    expectTypeOf(p2).toEqualTypeOf<Op<number, never, [a: number]>>();
    const p3 = succeed(1);
    expectTypeOf(p3).toEqualTypeOf<Op<number, never, []>>();
    const p4 = fail("error");
    expectTypeOf(p4).toEqualTypeOf<Op<never, string, []>>();
    const p5 = fromPromise(() => Promise.resolve(1));
    expectTypeOf(p5).toEqualTypeOf<Op<number, UnexpectedError, []>>();
    const p6 = fromPromise(
      () => Promise.resolve(1),
      () => "error",
    );
    expectTypeOf(p6).toEqualTypeOf<Op<number, string, []>>();
  });
  test("infers the correct type from the run", () => {
    const p1 = gen(function* () {
      return yield* succeed(1);
    }).run();
    expectTypeOf(p1).toEqualTypeOf<Promise<Result<number, UnexpectedError>>>();
    const p2 = gen(function* (a: string) {
      return yield* succeed(a);
    }).run("hello");
    expectTypeOf(p2).toEqualTypeOf<Promise<Result<string, UnexpectedError>>>();
  });
  test("op.run() arity is enforced by the type checker", async () => {
    const p1 = gen(function* () {
      return yield* succeed(1);
    });
    expect((await p1.run()).ok).toBe(true);
    // @ts-expect-error - nullary run does not accept arguments
    p1.run(1);

    const p2 = gen(function* (a: number) {
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

  test("disguishes between multiple error types", async () => {
    // note: requires that the types returned are distinct
    class CustomError1 extends Error {
      readonly unique = "CustomError1";
    }
    class CustomError2 extends Error {
      readonly alsoUnique = "CustomError2";
    }
    class CustomError3 extends TypedError("CustomError3") {}
    const alwaysFails1 = gen(function* () {
      if (Math.random() < 0) {
        return yield* succeed(1);
      }
      return yield* fail(new CustomError1("error1"));
    });
    const alwaysFails2 = gen(function* () {
      if (Math.random() < 0) {
        return yield* succeed(1);
      }
      return yield* fail(new CustomError2("error2"));
    });
    const alwaysFails3 = gen(function* () {
      if (Math.random() < 0) {
        return yield* succeed(1);
      }
      return yield* fail(new CustomError3());
    });
    const program = gen(function* () {
      const a = yield* alwaysFails1();
      const b = yield* alwaysFails2();
      const c = yield* alwaysFails3();
      return a + b + c;
    });
    const result = await run(program);
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(CustomError1);
  });
});
