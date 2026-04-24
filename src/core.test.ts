import { describe, expect, test, assert } from "vitest";
import { fail, fromGenFn, succeed, _try } from "./builders.js";
import { UnexpectedError } from "./errors.js";

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
