import { TimeoutError, UnhandledException, UnreachableError } from "./errors.js";
import {
  flatMapOp,
  makeNullaryOp,
  mapErrOp,
  mapOp,
  recoverOp,
  tapOp,
  tapErrOp,
  withCleanupOp,
  type CleanupFn,
  type FromGenFn,
  type Instruction,
  type Op,
  runOp,
} from "./core.js";
import { withRetryOp, withTimeoutOp, withSignalOp, type RetryPolicy } from "./policies.js";
import { err, ok, type Result } from "./result.js";

/**
 * Lifts a value into an operation that always completes successfully.
 */
export const succeed = <T>(value: T): Op<Awaited<T>, never, []> => {
  if (value instanceof Promise) {
    return _try(() => value);
  }

  let op!: Op<Awaited<T>, never, readonly []>;
  op = makeNullaryOp<Awaited<T>, never>(
    function* (): Generator<Instruction<never>, Awaited<T>, unknown> {
      return value as Awaited<T>;
    },
    {
      withRetry: (policy?: RetryPolicy) => withRetryOp(op, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(op, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(op, signal),
      withCleanup: (cleanup: CleanupFn<Awaited<T>>) => withCleanupOp(op, cleanup),
    },
  );
  return op;
};

/**
 * Lifts a value into an operation that always fails.
 */
export const fail = <E>(value: E): Op<never, E, readonly []> => {
  let op!: Op<never, E, readonly []>;
  op = makeNullaryOp<never, E>(
    function* () {
      yield err(value);
      throw new UnreachableError();
    },
    {
      withRetry: (policy?: RetryPolicy) => withRetryOp(op, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(op, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(op, signal),
      withCleanup: (cleanup: CleanupFn<never>) => withCleanupOp(op, cleanup),
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
  let op!: Op<Awaited<T>, E, readonly []>;
  op = makeNullaryOp<Awaited<T>, E>(
    function* (): Generator<Instruction<E>, Awaited<T>, unknown> {
      const result = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) =>
          Promise.resolve()
            .then(() => f(signal))
            .then(
              (a) => ok(a),
              (cause) => err(onError ? onError(cause) : new UnhandledException({ cause })),
            ) as Promise<Result<T, E>>,
      }) as Result<T, E>;
      if (result.isErr()) {
        yield result;
        throw new UnreachableError();
      }
      return result.value as Awaited<T>;
    },
    {
      withRetry: (policy?: RetryPolicy) => withRetryOp(op, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(op, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(op, signal),
      withCleanup: (cleanup: CleanupFn<Awaited<T>>) => withCleanupOp(op, cleanup),
    },
  );
  return op;
};

const makeArityOp = <T, E, A extends readonly unknown[]>(
  invoke: (...args: A) => Op<T, E, readonly []>,
): Op<T, E, A> => {
  const out = Object.assign(invoke, {
    run: (...args: A) => runOp(invoke(...args)),
    withRetry: (policy?: RetryPolicy) =>
      makeArityOp<T, E, A>((...args: A) => withRetryOp(invoke(...args), policy)),
    withTimeout: (timeoutMs: number) =>
      makeArityOp<T, E | TimeoutError, A>((...args: A) =>
        withTimeoutOp(invoke(...args), timeoutMs),
      ),
    withSignal: (signal: AbortSignal) =>
      makeArityOp<T, E, A>((...args: A) => withSignalOp(invoke(...args), signal)),
    withCleanup: (cleanup: CleanupFn<T>) =>
      makeArityOp<T, E, A>((...args: A) => withCleanupOp(invoke(...args), cleanup)),
    map: <U>(transform: (value: T) => U) => mapOp(out, transform),
    mapErr: <E2>(transform: (error: E) => E2) => mapErrOp(out, transform),
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, readonly []>) => flatMapOp(out, bind),
    tap: <R>(observe: (value: T) => R) => tapOp(out, observe),
    tapErr: <R>(observe: (error: E) => R) => tapErrOp(out, observe),
    recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
      recoverOp(out, predicate, handler),
    _tag: "Op" as const,
    // TS cannot reconcile the callable signature switch between nullary and arity ops.
    // This cast is safe because `invoke` always returns a nullary op and every fluent method
    // delegates back through `makeArityOp`, preserving the same `A`.
  }) as unknown as Op<T, E, A>;

  return out;
};

/**
 * Turns a generator function into an {@link Op}.
 */
export const fromGenFn: FromGenFn = (
  f: (...args: unknown[]) => Generator<Instruction<unknown>, unknown, unknown>,
): Op<unknown, unknown, []> | Op<unknown, unknown, readonly unknown[]> => {
  const makeBoundOp = (...args: unknown[]): Op<unknown, unknown, readonly []> => {
    let bound!: Op<unknown, unknown, readonly []>;
    bound = makeNullaryOp<unknown, unknown>(() => f(...args), {
      withRetry: (policy?: RetryPolicy) => withRetryOp(bound, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(bound, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(bound, signal),
      withCleanup: (cleanup: CleanupFn<unknown>) => withCleanupOp(bound, cleanup),
    });
    return bound;
  };

  if (f.length === 0) {
    // `FromGenFn` has an explicit zero-arg overload, but TS does not narrow on `f.length`.
    return makeBoundOp() as Op<unknown, unknown, []>;
  }

  return makeArityOp<unknown, unknown, readonly unknown[]>((...args) => makeBoundOp(...args));
};
