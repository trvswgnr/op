import { describe, expect, test, assert } from "vitest";
import { fail, gen, run, succeed, tryPromise, UnexpectedError } from "./index.js";

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

describe("tryPromise", () => {
  test("success path returns Ok with resolved value", async () => {
    const result = await run(
      tryPromise(
        () => Promise.resolve(1),
        () => "err",
      ),
    );
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(1);
  });

  test("rejection maps to Err via onError", async () => {
    const result = await run(
      tryPromise(
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
        const x = yield* tryPromise(
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
      tryPromise(
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
    let secondRan = false;
    const result = await run(
      gen(function* () {
        yield* succeed(1);
        yield* fail("oops");
        secondRan = true;
        return yield* succeed(2);
      }),
    );
    assert(result.ok === false, "result.ok should be true");
    expect(result.error).toBe("oops");
    expect(secondRan).toBe(false);
  });

  test("tryPromise in gen - success path", async () => {
    const result = await run(
      gen(function* () {
        const a = yield* succeed(10);
        const b = yield* tryPromise(
          () => Promise.resolve(a * 2),
          () => "err",
        );
        return b;
      }),
    );
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe(20);
  });

  test("tryPromise in gen - error path", async () => {
    const result = await run(
      gen(function* () {
        yield* succeed(1);
        return yield* tryPromise(
          () => Promise.reject("async fail"),
          (e) => ({ mapped: String(e) }),
        );
      }),
    );
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toEqual({ mapped: "async fail" });
  });

  test("tryPromise in gen - onError is optional", async () => {
    const result = await run(
      gen(function* () {
        return yield* tryPromise(() => Promise.reject("async fail"));
      }),
    );
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBeInstanceOf(UnexpectedError);
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
      tryPromise(
        () => Promise.resolve("async"),
        () => "err",
      ),
    );
    assert(result.ok === true, "result.ok should be true");
    expect(result.value).toBe("async");
  });

  test("chained async effects", async () => {
    const result = await run(
      gen(function* () {
        const first = yield* tryPromise(
          () => Promise.resolve({ data: "raw" }),
          () => "fetch err",
        );
        const second = yield* tryPromise(
          () => Promise.resolve(JSON.parse(`{"n": 69}`)),
          () => "parse err",
        );
        return { first, second };
      }),
    );
    assert(result.ok === true, "result.ok should be true");
    expect(result.value.first).toEqual({ data: "raw" });
    expect(result.value.second).toEqual({ n: 69 });
  });

  test("UnexpectedError propagates from rejecting promise", async () => {
    const error = new Error("unhandled");
    const result = await run(
      gen(function* () {
        yield* succeed(1);
        const x = yield {
          type: "Suspended" as const,
          promise: Promise.reject(error),
        };
        return x;
      }),
    );
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
});
