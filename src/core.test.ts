import { assert, describe, expect, test } from "vitest";
import { chainCleanupFaults, closeGenerator, drive } from "./core/runtime.js";
import { makeNullaryOp } from "./core/nullary-ops.js";
import {
  isErrInstruction,
  RegisterExitFinalizerInstruction,
  SuspendInstruction,
} from "./core/instructions.js";
import type { Instruction, Op } from "./core/types.js";
import { UnhandledException } from "./errors.js";
import { Result } from "./result.js";

function makeRuntimeOp<T, E>(gen: () => Generator<Instruction<E>, T, unknown>): Op<T, E, []> {
  const op: Op<T, E, []> = makeNullaryOp(gen, {
    withRelease: (_release) => op,
    registerEnterInitialize: (_initialize) => op,
    registerExitFinalize: (_finalize) => op,
  });
  return op;
}

describe("core/runtime helpers", () => {
  test("chainCleanupFaults handles empty, single, and multi-fault chains", () => {
    expect(chainCleanupFaults([])).toBeUndefined();

    const only = new Error("only");
    expect(chainCleanupFaults([only])).toBe(only);

    const first = new Error("first");
    const second = "second-non-error";
    const third = new Error("third");
    const chain = chainCleanupFaults([first, second, third]);
    expect(chain).toBeInstanceOf(Error);
    const outer = chain as Error;
    expect(outer.message).toBe("first");
    expect((outer.cause as Error).message).toBe("second-non-error");
    expect(((outer.cause as Error).cause as Error).message).toBe("third");
  });

  test("closeGenerator swallows iterator.return failures", () => {
    let called = false;
    const iterator = {
      next: () => ({ done: true as const, value: undefined }),
      return: () => {
        called = true;
        throw new Error("boom");
      },
    };

    expect(() => closeGenerator(iterator)).not.toThrow();
    expect(called).toBe(true);
  });

  test("instruction type guards correctly classify values", () => {
    const suspended = new SuspendInstruction(async () => 1);
    const finalizer = new RegisterExitFinalizerInstruction(async () => {});
    const typedErr = Result.err("typed");
    const typedOk = Result.ok("value");

    expect(suspended instanceof SuspendInstruction).toBe(true);
    expect({ suspend: async () => 1 } instanceof SuspendInstruction).toBe(false);

    expect(finalizer instanceof RegisterExitFinalizerInstruction).toBe(true);
    expect({ finalize: async () => {} } instanceof RegisterExitFinalizerInstruction).toBe(false);

    expect(isErrInstruction(typedErr)).toBe(true);
    expect(isErrInstruction(typedOk)).toBe(false);
    expect(isErrInstruction({ isErr: () => false, error: "x" })).toBe(false);
    expect(isErrInstruction("nope")).toBe(false);
  });
});

describe("drive runtime behavior", () => {
  test("resumeSuspended path passes the bound signal to suspend work", async () => {
    let seenSignal: AbortSignal | undefined;
    const op = makeRuntimeOp<number, never>(function* () {
      const value = (yield new SuspendInstruction(async (signal) => {
        seenSignal = signal;
        return 69;
      })) as number;
      return value + 1;
    });

    const signal = new AbortController().signal;
    const result = await drive(op, signal);

    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toBe(70);
    expect(seenSignal).toBe(signal);
  });

  test("invalid yielded instructions return Err(UnhandledException(TypeError))", async () => {
    const op = makeRuntimeOp<number, never>(function* () {
      yield { _tag: "NotAnInstruction" } as never;
      return 1;
    });

    const result = await drive(op, new AbortController().signal);

    assert(result.isErr() === true, "result should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    expect(result.error.cause).toBeInstanceOf(TypeError);
  });

  test("registerExitFinalizer runs all handlers in LIFO order", async () => {
    const seen: string[] = [];
    const op = makeRuntimeOp<number, never>(function* () {
      yield new RegisterExitFinalizerInstruction(async (ctx) => {
        seen.push(`first-${ctx.result.isOk() ? "ok" : "err"}`);
      });
      yield new RegisterExitFinalizerInstruction(async (ctx) => {
        seen.push(`second-${ctx.result.isOk() ? "ok" : "err"}`);
      });
      return 123;
    });

    const result = await drive(op, new AbortController().signal);

    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toBe(123);
    expect(seen).toEqual(["second-ok", "first-ok"]);
  });

  test("finalizer throw after successful body converts to UnhandledException", async () => {
    const cleanupFault = new Error("cleanup-failed");
    const op = makeRuntimeOp<string, never>(function* () {
      yield new RegisterExitFinalizerInstruction(async () => {
        throw cleanupFault;
      });
      return "ok";
    });

    const result = await drive(op, new AbortController().signal);

    assert(result.isErr() === true, "result should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    const unhandled = result.error as UnhandledException;
    expect(unhandled.cause).toBe(cleanupFault);
  });

  test("cleanup fault takes precedence over typed body error", async () => {
    const cleanupFault = new Error("cleanup-failed");
    const op = makeRuntimeOp<never, string>(function* () {
      yield new RegisterExitFinalizerInstruction(async () => {
        throw cleanupFault;
      });
      return yield* Result.err("typed-body-error");
    });

    const result = await drive(op, new AbortController().signal);

    assert(result.isErr() === true, "result should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    const unhandled = result.error as UnhandledException;
    expect(unhandled.cause).toBe(cleanupFault);
  });

  test("multiple throwing finalizers are folded into a cause chain", async () => {
    const firstUnwindFault = new Error("second-registered-runs-first");
    const secondUnwindFault = "first-registered-runs-second";
    const op = makeRuntimeOp<string, never>(function* () {
      yield new RegisterExitFinalizerInstruction(async () => {
        throw secondUnwindFault;
      });
      yield new RegisterExitFinalizerInstruction(async () => {
        throw firstUnwindFault;
      });
      return "done";
    });

    const result = await drive(op, new AbortController().signal);

    assert(result.isErr() === true, "result should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    const outer = result.error.cause as Error;
    expect(outer.message).toBe("second-registered-runs-first");
    expect(outer.cause).toBe("first-registered-runs-second");
  });
});
