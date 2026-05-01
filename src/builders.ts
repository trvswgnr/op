import { TimeoutError, UnhandledException } from "./errors.js";
import { makeFluentArityOp, onExitOp, onOp, withReleaseOp } from "./core/arity-ops.js";
import {
  type AnyExitFn,
  type ExitFn,
  type FromGenFn,
  type Instruction,
  type Op,
  type OpLifecycleHook,
  type ReleaseFn,
} from "./core/types.js";
import { withRetryOp, withTimeoutOp, withSignalOp, type RetryPolicy } from "./policies.js";
import { err, ok, type Result } from "./result.js";
import { makeNullaryOp } from "./core/nullary-ops.js";

/**
 * Lifts a value into an operation that always completes successfully.
 */
export const succeed = <T>(value: Awaited<T> | Promise<T>): Op<Awaited<T>, never, []> => {
  if (value instanceof Promise) {
    return _try(() => value);
  }

  const op: Op<Awaited<T>, never, readonly []> = makeNullaryOp(
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
export const fail = <E>(value: E): Op<never, E, readonly []> => {
  const op: Op<never, E, readonly []> = makeNullaryOp(
    function* () {
      return yield* err(value);
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
export const defer = (finalize: AnyExitFn): Op<void, never, readonly []> => {
  const op: Op<void, never, readonly []> = makeNullaryOp(
    function* () {
      yield {
        _tag: "RegisterCleanup" as const,
        finalize: (ctx) => Promise.resolve(finalize(ctx)).then(() => {}),
      };
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
): Op<Awaited<T>, E, readonly []> => {
  const op: Op<Awaited<T>, E, readonly []> = makeNullaryOp(
    function* () {
      const result = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) =>
          Promise.resolve()
            .then(() => f(signal))
            .then(
              (a) => ok(a),
              (cause) => err(onError ? onError(cause) : new UnhandledException({ cause })),
            ),
      }) as Result<T, E>;
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
  invoke: (...args: A) => Op<T, E, readonly []>,
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

export const hasParams = (f: (...args: unknown[]) => unknown): boolean => {
  if (typeof f !== "function") throw new TypeError("Expected a function");
  if (f.length > 0) return true;
  const source = Function.prototype.toString.call(f);
  const firstParen = source.indexOf("(");
  const secondParen = source.indexOf(")", firstParen + 1);
  return (
    firstParen >= 0 &&
    secondParen > firstParen + 1 &&
    source.slice(firstParen + 1, secondParen).trim() !== ""
  );
};

/**
 * Turns a generator function into an {@link Op}.
 */
export const fromGenFn: FromGenFn = (
  f: (...args: unknown[]) => Generator<Instruction<unknown>, unknown, unknown>,
): Op<unknown, unknown, []> | Op<unknown, unknown, readonly unknown[]> => {
  const makeBoundOp = (...args: unknown[]): Op<unknown, unknown, readonly []> => {
    const bound: Op<unknown, unknown, readonly []> = makeNullaryOp(() => f(...args), {
      withRetry: (policy?: RetryPolicy) => withRetryOp(bound, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(bound, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(bound, signal),
      withRelease: (release: ReleaseFn<unknown>) => withReleaseOp(bound, release),
      registerExitFinalize: (finalize: ExitFn<unknown, unknown>) => onExitOp(bound, finalize),
    });
    return bound;
  };

  // keep true nullary generator functions as nullary ops
  if (!hasParams(f)) {
    return makeBoundOp();
  }

  return makeArityOp<unknown, unknown, readonly unknown[]>((...args) => makeBoundOp(...args));
};
