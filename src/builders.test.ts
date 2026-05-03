import { describe, expect, test, assert } from "vitest";
import { fail, fromGenFn, succeed, _try } from "./builders.js";
import { UnhandledException } from "./errors.js";

describe("succeed", () => {
  test("run returns Ok with value", async () => {
    const result = await succeed(69).run();
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toBe(69);
  });

  test("handles various value types", async () => {
    const r1 = await succeed(0).run();
    assert(r1.isOk() === true, "should be Ok");
    expect(r1.value).toBe(0);

    const r2 = await succeed("").run();
    assert(r2.isOk() === true, "should be Ok");
    expect(r2.value).toBe("");

    const r3 = await succeed(null).run();
    assert(r3.isOk() === true, "should be Ok");
    expect(r3.value).toBe(null);

    const r4 = await succeed({ foo: "bar" }).run();
    assert(r4.isOk() === true, "should be Ok");
    expect(r4.value).toEqual({ foo: "bar" });

    const r5 = await succeed([1, 2, 3]).run();
    assert(r5.isOk() === true, "should be Ok");
    expect(r5.value).toEqual([1, 2, 3]);
  });

  test("handles promises", async () => {
    const result = await succeed(Promise.resolve(69)).run();
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toBe(69);

    const program = fromGenFn(function* () {
      const a = yield* succeed(Promise.resolve(1));
      const b = yield* succeed(Promise.resolve(2));
      return a + b;
    });
    const result2 = await program.run();
    assert(result2.isOk() === true, "should be Ok");
    expect(result2.value).toBe(3);
  });
});

describe("fail", () => {
  test("run returns Err with error", async () => {
    const result = await fail("error").run();
    assert(result.isErr() === true, "should be Err");
    expect(result.error).toBe("error");
  });

  test("preserves custom error objects", async () => {
    const customErr = new Error("custom message");
    const result = await fail(customErr).run();
    assert(result.isErr() === true, "should be Err");
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
    expect(result.isErr()).toBe(true);
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
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toBe(1);
  });

  test("rejection maps to Err via onError", async () => {
    {
      const result = await _try(
        () => Promise.reject("failed"),
        (e) => `mapped: ${e}`,
      ).run();
      assert(result.isErr() === true, "should be Err");
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
    assert(result.isErr() === true, "should be Err");
    expect(result.error).toBe(`mapped: ${syncThrow}`);
  });

  test("UnhandledException when promise rejects without proper handling", async () => {
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
    assert(result.isErr() === true, "should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    expect(result.error.cause).toBe(testError);
  });

  test("UnhandledException when onError throws", async () => {
    const error = new Error("onError threw");
    const result = await _try(
      () => Promise.reject("boom"),
      () => {
        throw error;
      },
    ).run();
    assert(result.isErr() === true, "should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
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
    assert(result.isOk() === true, "result should be Ok");
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
    assert(result.isErr() === true, "should be Err");
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
    assert(result.isOk() === true, "result should be Ok");
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
    assert(result.isErr() === true, "should be Err");
    expect(result.error).toEqual({ mapped: "async fail" });
  });

  test("_try in gen - onError is optional", async () => {
    const p = fromGenFn(function* () {
      return yield* _try(() => Promise.reject("async fail"));
    });
    const result = await p.run();
    assert(result.isErr() === true, "should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
  });

  test("parameterized gen - run passes args into the generator", async () => {
    const add = fromGenFn(function* (a: number, b: number) {
      return a + b;
    });
    const result = await add(2, 3).run();
    assert(result.isOk() === true, "result should be Ok");
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
    assert(viaRun.isOk() === true, "should be Ok");
    assert(viaFreeRun.isOk() === true, "should be Ok");
    expect(viaRun.value).toBe(3);
    expect(viaFreeRun.value).toBe(3);
  });

  test("nullary gen - run() matches run(op)", async () => {
    const program = fromGenFn(function* () {
      return yield* succeed(69);
    });
    const a = await program.run();
    const b = await program.run();
    assert(a.isOk() === true, "should be Ok");
    assert(b.isOk() === true, "should be Ok");
    expect(a.value).toBe(69);
    expect(b.value).toBe(69);
  });
});
