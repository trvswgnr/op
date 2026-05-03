import { TimeoutError, UnhandledException } from "./errors.js";
import { makeFluentArityOp, onExitOp, onOp, withReleaseOp } from "./core/arity-ops.js";
import {
  type AnyExitFn,
  type ExitFn,
  type Instruction,
  type Op,
  type OpLifecycleHook,
  type ReleaseFn,
} from "./core/types.js";
import { RegisterExitFinalizerInstruction, SuspendInstruction } from "./core/instructions.js";
import { withRetryOp, withTimeoutOp, withSignalOp, type RetryPolicy } from "./policies.js";
import { Result, type InferErr } from "./result.js";
import { makeNullaryOp } from "./core/nullary-ops.js";

const isAwaited = <T>(value: T | Promise<T>): value is Awaited<T> => {
  return !(value instanceof Promise);
};

/**
 * Lifts a value into an operation that always completes successfully.
 */
export const succeed = <T>(value: T | Promise<T>): Op<Awaited<T>, never, []> => {
  if (!isAwaited(value)) {
    return _try(() => value);
  }

  const op: Op<Awaited<T>, never, []> = makeNullaryOp(
    function* () {
      return value;
    },
    {
      withRetry: (policy?: RetryPolicy) => withRetryOp(op, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(op, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(op, signal),
      withRelease: (release: ReleaseFn<Awaited<T>>) => withReleaseOp(op, release),
      registerExitFinalize: (finalize: ExitFn<Awaited<T>, never>) => onExitOp(op, finalize),
    },
  );
  return op;
};

/**
 * Lifts a value into an operation that always fails.
 */
export const fail = <E>(value: E): Op<never, E, []> => {
  const op: Op<never, E, []> = makeNullaryOp(
    function* () {
      return yield* Result.err(value);
    },
    {
      withRetry: (policy?: RetryPolicy) => withRetryOp(op, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(op, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(op, signal),
      withRelease: (release: ReleaseFn<never>) => withReleaseOp(op, release),
      registerExitFinalize: (finalize: ExitFn<never, E>) => onExitOp(op, finalize),
    },
  );
  return op;
};

/**
 * Registers deferred cleanup for the current op run. Use as `yield* Op.defer((ctx) => ...)`.
 * If several callbacks throw during the same unwind, `run` fails with {@link UnhandledException}
 * whose `cause` is a nested {@link Error} chain (`.cause`), **first LIFO failure outermost**.
 */
export const defer = (finalize: AnyExitFn): Op<void, never, []> => {
  const op: Op<void, never, []> = makeNullaryOp(
    function* () {
      yield new RegisterExitFinalizerInstruction((ctx) =>
        Promise.resolve(finalize(ctx)).then(() => {}),
      );
    },
    {
      withRetry: (policy?: RetryPolicy) => withRetryOp(op, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(op, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(op, signal),
      withRelease: (release: ReleaseFn<void>) => withReleaseOp(op, release),
      registerExitFinalize: (nextFinalize: ExitFn<void, never>) => onExitOp(op, nextFinalize),
    },
  );
  return op;
};

/**
 * Suspends until a promise settles, then continues with its value or a mapped failure.
 */
export const _try = <T, E = UnhandledException>(
  f: (signal: AbortSignal) => T,
  onError?: (e: unknown) => E,
): Op<Awaited<T>, E, []> => {
  const op: Op<Awaited<T>, E, []> = makeNullaryOp(
    function* () {
      const result = (yield new SuspendInstruction((signal: AbortSignal) =>
        Promise.resolve()
          .then(() => f(signal))
          .then(
            (a) => Result.ok(a),
            (cause) => Result.err(onError ? onError(cause) : new UnhandledException({ cause })),
          ),
      )) as Result<T, E>;
      if (result.isErr()) {
        return yield* result;
      }
      return result.value as Awaited<T>;
    },
    {
      withRetry: (policy?: RetryPolicy) => withRetryOp(op, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(op, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(op, signal),
      withRelease: (release: ReleaseFn<Awaited<T>>) => withReleaseOp(op, release),
      registerExitFinalize: (finalize: ExitFn<Awaited<T>, E>) => onExitOp(op, finalize),
    },
  );
  return op;
};

const makeArityOp = <T, E, A extends readonly unknown[]>(
  invoke: (...args: A) => Op<T, E, []>,
): Op<T, E, A> => {
  return makeFluentArityOp(invoke, (_self) => ({
    withRetry: (policy?: RetryPolicy) =>
      makeArityOp<T, E, A>((...args: A) => withRetryOp(invoke(...args), policy)),
    withTimeout: (timeoutMs: number) =>
      makeArityOp<T, E | TimeoutError, A>((...args: A) =>
        withTimeoutOp(invoke(...args), timeoutMs),
      ),
    withSignal: (signal: AbortSignal) =>
      makeArityOp<T, E, A>((...args: A) => withSignalOp(invoke(...args), signal)),
    withRelease: (release: ReleaseFn<T>) =>
      makeArityOp<T, E, A>((...args: A) => withReleaseOp(invoke(...args), release)),
    on: (event: OpLifecycleHook, finalize: ExitFn<T, E>) =>
      makeArityOp<T, E, A>((...args: A) => onOp(invoke(...args), event, finalize)),
  }));
};

/**
 * Turns a generator function into an {@link Op}.
 */
export const fromGenFn = <Y extends Instruction<unknown>, T, A extends readonly unknown[]>(
  f: (...args: A) => Generator<Y, T, unknown>,
): Op<T, InferErr<Y>, A> => {
  const makeBoundOp = (...args: A) => {
    const bound: Op<unknown, unknown, []> = makeNullaryOp(() => f(...args), {
      withRetry: (policy?: RetryPolicy) => withRetryOp(bound, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(bound, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(bound, signal),
      withRelease: (release: ReleaseFn<unknown>) => withReleaseOp(bound, release),
      registerExitFinalize: (finalize: ExitFn<unknown, unknown>) => onExitOp(bound, finalize),
    });
    return bound;
  };

  // we are intentionally always returning the arity wrapper shape, including for `A = []` generators.
  // this keeps arity/nullary classification deterministic via explicit op kind metadata
  // instead of runtime function reflection or shape guessing in correctness paths
  return makeArityOp<T, InferErr<Y>, A>((...args) => makeBoundOp(...args) as never);
};
