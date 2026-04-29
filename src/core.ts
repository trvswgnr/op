import { UnhandledException, type TimeoutError } from "./errors.js";
import { err, ok, type Result, type Err, type ExtractErr } from "./result.js";
import type { RetryPolicy } from "./policies.js";
import type { Tagged } from "./tagged.js";

export interface Suspended {
  readonly _tag: "Suspended";
  readonly suspend: (signal: AbortSignal) => Promise<unknown>;
}

export type Instruction<E> = Err<unknown, E> | Suspended;

export interface WithRetry<T, E, A extends readonly unknown[]> {
  withRetry(policy?: RetryPolicy): Op<T, E, A>;
}

export interface WithTimeout<T, E, A extends readonly unknown[]> {
  withTimeout(timeoutMs: number): Op<T, E | TimeoutError, A>;
}

export interface WithSignal<T, E, A extends readonly unknown[]> {
  withSignal(signal: AbortSignal): Op<T, E, A>;
}

export interface OpBase<T, E> {
  readonly _tag: "Op";
  [Symbol.iterator](): Generator<Instruction<E>, T, unknown>;
}

export interface OpNullary<T, E>
  extends OpBase<T, E>, WithRetry<T, E, []>, WithTimeout<T, E, []>, WithSignal<T, E, []> {
  (): OpBase<T, E>;
  run(): Promise<Result<T, E | UnhandledException>>;
}

export interface OpArity<T, E, A extends readonly unknown[]>
  extends WithRetry<T, E, A>, WithTimeout<T, E, A>, WithSignal<T, E, A> {
  (...args: A): OpNullary<T, E>;
  run(...args: A): Promise<Result<T, E | UnhandledException>>;
}

type _Op<T, E, A extends readonly unknown[]> = [] extends A ? OpNullary<T, E> : OpArity<T, E, A>;

export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A> & Tagged<"Op">;

export function runOp<T, E>(op: Op<T, E, readonly []>): Promise<Result<T, E | UnhandledException>> {
  return drive(op, new AbortController().signal);
}

function isSuspended(value: unknown): value is Suspended {
  return (
    typeof value === "object" && value !== null && "_tag" in value && value._tag === "Suspended"
  );
}

function isErrInstruction<E>(value: unknown): value is Err<unknown, E> {
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

export async function drive<T, E>(
  op: Op<T, E, readonly []>,
  signal: AbortSignal,
): Promise<Result<T, E | UnhandledException>> {
  try {
    const ef = typeof op === "function" ? op() : op;
    const iter = ef[Symbol.iterator]();
    const closeIterator = () => {
      try {
        iter.return?.(undefined as never);
      } catch {
        // Ignore cleanup faults so the original result/error is preserved.
      }
    };
    let step = iter.next();
    while (!step.done) {
      try {
        if (isSuspended(step.value)) {
          step = iter.next(await step.value.suspend(signal));
          continue;
        }
        if (isErrInstruction<E>(step.value)) {
          closeIterator();
          return err(step.value.error);
        }
        closeIterator();
        return err(
          new UnhandledException({
            cause: new TypeError("Op generator yielded an invalid instruction"),
          }),
        );
      } catch (cause) {
        closeIterator();
        return err(new UnhandledException({ cause }));
      }
    }
    const value = await step.value;
    return ok(value);
  } catch (cause) {
    return err(new UnhandledException({ cause }));
  }
}

export interface FromGenFn {
  <Y extends Instruction<unknown>, T>(f: () => Generator<Y, T, unknown>): Op<T, ExtractErr<Y>, []>;
  <Y extends Instruction<unknown>, T, A extends readonly unknown[]>(
    f: (...args: A) => Generator<Y, T, unknown>,
  ): Op<T, ExtractErr<Y>, A>;
  (
    f: (...args: unknown[]) => Generator<Instruction<unknown>, unknown, unknown>,
  ): Op<unknown, unknown, []> | Op<unknown, unknown, readonly unknown[]>;
}

export interface OpHooks<T, E> {
  withRetry: (policy?: RetryPolicy) => Op<T, E, readonly []>;
  withTimeout: (timeoutMs: number) => Op<T, E | TimeoutError, readonly []>;
  withSignal: (signal: AbortSignal) => Op<T, E, readonly []>;
}

export const makeNullaryOp = <T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
  hooks: OpHooks<T, E>,
): Op<T, E, readonly []> => {
  const self = {
    [Symbol.iterator]: gen,
    run: () => runOp(self as never),
    withRetry: hooks.withRetry,
    withTimeout: hooks.withTimeout,
    withSignal: hooks.withSignal,
    _tag: "Op" as const,
  };
  const op = () => self;
  return Object.assign(op, self) as never;
};
