import { TimeoutError, UnhandledException } from "../errors.js";
import { err, ok, type Result } from "../result.js";
import type { ExitContext, Instruction, Op } from "./types.js";

function isSuspended(
  value: unknown,
): value is { readonly _tag: "Suspended"; suspend: (signal: AbortSignal) => Promise<unknown> } {
  return (
    typeof value === "object" && value !== null && "_tag" in value && value._tag === "Suspended"
  );
}

function isErrInstruction<E>(value: unknown): value is { isErr: () => boolean; error: E } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("isErr" in value) ||
    typeof value.isErr !== "function"
  ) {
    return false;
  }
  return value.isErr();
}

function isRegisterCleanup(value: unknown): value is {
  readonly _tag: "RegisterCleanup";
  readonly finalize: (ctx: ExitContext<unknown, unknown>) => Promise<void>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "RegisterCleanup" &&
    "finalize" in value &&
    typeof value.finalize === "function"
  );
}

const closeGenerator = (iterator: Iterator<unknown, unknown, unknown>) => {
  try {
    // we intentionally ignore the return payload bc only generator finalization matters
    iterator.return?.(undefined);
  } catch {
    // ignore cleanup faults so the original result/error is preserved
  }
};

/** Fold multiple teardown faults into a nested `Error.cause` chain (outer = first failure in LIFO unwind). */
function chainCleanupFaults(faults: readonly unknown[]): unknown {
  if (faults.length === 0) {
    return undefined;
  }
  if (faults.length === 1) {
    return faults[0];
  }
  let chain: unknown = faults[faults.length - 1];
  for (let i = faults.length - 2; i >= 0; i--) {
    const f = faults[i];
    const msg = f instanceof Error ? f.message : String(f);
    const name = f instanceof Error ? f.name : "Error";
    const layer = new Error(msg, { cause: chain });
    layer.name = name;
    chain = layer;
  }
  return chain;
}

export async function drive<T, E>(
  op: Op<T, E, []>,
  signal: AbortSignal,
): Promise<Result<T, E | UnhandledException>> {
  const finalizers: Array<(ctx: ExitContext<unknown, unknown>) => Promise<void>> = [];
  /** Run every finalizer LIFO; collect faults from each (later-registered runs first; all still run even if one throws). */
  const runFinalizersSafely = async (
    ctx: ExitContext<unknown, unknown>,
  ): Promise<unknown | void> => {
    const faults: unknown[] = [];
    for (let index = finalizers.length - 1; index >= 0; index -= 1) {
      const finalize = finalizers[index];
      if (finalize !== undefined) {
        try {
          await finalize(ctx);
        } catch (e) {
          faults.push(e);
        }
      }
    }
    if (faults.length === 0) {
      return undefined;
    }
    if (faults.length === 1) {
      return faults[0];
    }
    return chainCleanupFaults(faults);
  };
  const settleWithCleanup = async (
    result: Result<T, E | UnhandledException>,
    iter?: Iterator<Instruction<unknown>, T, unknown>,
  ): Promise<Result<T, E | UnhandledException>> => {
    if (iter !== undefined) {
      closeGenerator(iter);
    }
    const exitCtx: ExitContext<T, E> = { signal, result };
    const cleanupFault = await runFinalizersSafely(exitCtx);
    if (cleanupFault !== undefined) {
      return err(new UnhandledException({ cause: cleanupFault }));
    }
    return result;
  };

  try {
    const ef = typeof op === "function" ? op() : op;
    const iter = ef[Symbol.iterator]();
    let step = iter.next();
    while (!step.done) {
      try {
        if (isSuspended(step.value)) {
          step = iter.next(await step.value.suspend(signal));
          continue;
        }
        const instr = step.value;
        if (isRegisterCleanup(instr)) {
          finalizers.push(instr.finalize);
          step = iter.next(undefined);
          continue;
        }
        if (isErrInstruction<E>(instr)) {
          return settleWithCleanup(err(instr.error), iter);
        }
        const invalidErr = new UnhandledException({
          cause: new TypeError("Op generator yielded an invalid instruction"),
        });
        return settleWithCleanup(err(invalidErr), iter);
      } catch (cause) {
        const unhandled = new UnhandledException({ cause });
        return settleWithCleanup(err(unhandled), iter);
      }
    }
    const value = await step.value;
    return settleWithCleanup(ok(value));
  } catch (cause) {
    const unhandled = new UnhandledException({ cause });
    return settleWithCleanup(err(unhandled));
  }
}

export {
  chainCleanupFaults,
  closeGenerator,
  isErrInstruction,
  isRegisterCleanup,
  isSuspended,
  TimeoutError,
};
