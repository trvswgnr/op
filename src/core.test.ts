import { describe, expect, test, assert, expectTypeOf } from "vitest";
import { fail, fromGenFn, succeed, _try } from "./builders.js";
import { UnhandledException } from "./errors.js";
import { isNullaryOp } from "./core/nullary-ops.js";
import { Op } from "./core/types.js";

type InferOpArgs<T> = T extends Op<unknown, unknown, infer A> ? A : never;

describe("op.run", () => {
  test("sync op completes without awaiting", async () => {
    const result = await succeed("sync").run();
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toBe("sync");
  });

  test("async op suspends and resumes correctly", async () => {
    const result = await _try(
      () => Promise.resolve("async"),
      () => "err",
    ).run();
    assert(result.isOk() === true, "result should be Ok");
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
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value.first).toEqual({ data: "raw" });
    expect(result.value.second).toEqual({ n: 69 });
  });

  test("UnhandledException propagates from rejecting promise", async () => {
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
    assert(result.isErr() === true, "should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    expect(result.error.cause).toBeInstanceOf(Error);
    expect(result.error.cause).toBe(error);
  });

  test("runs generator finally on cancellation", async () => {
    const controller = new AbortController();
    let finalized = false;

    const program = fromGenFn(function* () {
      try {
        return yield* _try((signal) => {
          return new Promise<number>((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                reject(signal.reason);
              },
              { once: true },
            );
          });
        });
      } finally {
        finalized = true;
      }
    }).withSignal(controller.signal);

    const runPromise = program.run();
    controller.abort(new Error("cancelled"));
    const result = await runPromise;

    assert(result.isErr() === true, "should be Err");
    expect(finalized).toBe(true);
  });
});

describe("edge cases and invariants", () => {
  test("fromGenFn handles arity correctly", async () => {
    const op1 = fromGenFn(function* (a: number, b: number) {
      return a + b;
    });
    expect(isNullaryOp(op1)).toBe(false);
    expectTypeOf<InferOpArgs<typeof op1>>().toEqualTypeOf<[a: number, b: number]>();

    const op2 = fromGenFn(function* () {
      return 1;
    });
    expect(isNullaryOp(op2)).toBe(true);
    expectTypeOf<InferOpArgs<typeof op2>>().toEqualTypeOf<readonly []>();

    const op3 = fromGenFn(function* (a?: number) {
      return (a ?? 0) * 2;
    });
    expect(isNullaryOp(op3)).toBe(false);
    expectTypeOf<InferOpArgs<typeof op3>>().toEqualTypeOf<[a?: number]>();
    op3.run(1);

    const op4 = fromGenFn(function* (a: number, b?: number) {
      return (a + (b ?? 0)) * 2;
    });
    expect(isNullaryOp(op4)).toBe(false);
    expectTypeOf<InferOpArgs<typeof op4>>().toEqualTypeOf<[a: number, b?: number]>();
    op4.run(1, 2);

    const op5 = fromGenFn(function* (a: number = 1) {
      return a * 2;
    });
    expect(isNullaryOp(op5)).toBe(false);
    expectTypeOf<InferOpArgs<typeof op5>>().toEqualTypeOf<[a?: number]>();
    op5.run(1);

    const op6 = fromGenFn(function* (...args: readonly [a: number, b: number]) {
      return args.reduce((acc, curr) => acc + curr, 0);
    });
    expect(isNullaryOp(op6)).toBe(false);
    expectTypeOf<InferOpArgs<typeof op6>>().toEqualTypeOf<[a: number, b: number]>();
    op6.run(1, 2);
  });
  test("Ok result has correct shape", async () => {
    const result = await succeed(1).run();
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toBe(1);
  });

  test("Err result has correct shape", async () => {
    const result = await fail("e").run();
    assert(result.isErr() === true, "should be Err");
    expect(result.error).toBe("e");
  });

  test("result from run is frozen", async () => {
    const okResult = await succeed(1).run();
    expect(okResult.isOk()).toBe(true);
    expect(Object.isFrozen(okResult)).toBe(false);

    const errResult = await fail("e").run();
    assert(errResult.isErr() === true, "should be Err");
    expect(Object.isFrozen(errResult)).toBe(false);
  });

  test("empty and zero values work correctly", async () => {
    const r0 = await succeed(0).run();
    assert(r0.isOk() === true, "should be Ok");
    expect(r0.value).toBe(0);

    const rEmpty = await succeed("").run();
    assert(rEmpty.isOk() === true, "should be Ok");
    expect(rEmpty.value).toBe("");
  });

  test("returns UnhandledException when throw in generator", async () => {
    const error = new Error("unhandled");
    const result = await fromGenFn(function* () {
      throw error;
    }).run();
    assert(result.isErr() === true, "should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    expect(result.error.cause).toBe(error);
  });

  test("returns UnhandledException when generator yields invalid instruction", async () => {
    const result = await fromGenFn(function* () {
      yield { _tag: "NotAnInstruction" } as unknown as never;
      return 1;
    }).run();
    assert(result.isErr() === true, "should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    expect(result.error.cause).toBeInstanceOf(TypeError);
  });

  test("returns UnhandledException when unhandled Promise rejection in gen", async () => {
    const error = new Error("unhandled");
    const result = await fromGenFn(function* () {
      return Promise.reject(error);
    }).run();
    assert(result.isErr() === true, "should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    expect(result.error.cause).toBe(error);
  });
});
