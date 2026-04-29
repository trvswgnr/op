import { UnhandledException, UnreachableError } from "./errors.js";
import {
  flatMapOp,
  makeNullaryOp,
  mapErrOp,
  mapOp,
  recoverOp,
  tapOp,
  tapErrOp,
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
    },
  );
  return op as never;
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
    },
  );
  return op;
};

const makeArityOp = <T, E, A extends readonly unknown[]>(
  invoke: (...args: A) => Op<T, E, readonly []>,
): Op<T, E, A> => {
  const out: Op<T, E, A> = Object.assign(invoke, {
    run: (...args: A) => runOp(invoke(...args)),
    withRetry: (policy?: RetryPolicy) =>
      makeArityOp<T, E, A>((...args: A) => withRetryOp(invoke(...args), policy) as never),
    withTimeout: (timeoutMs: number) =>
      makeArityOp((...args: A) => withTimeoutOp(invoke(...args), timeoutMs) as never),
    withSignal: (signal: AbortSignal) =>
      makeArityOp<T, E, A>((...args: A) => withSignalOp(invoke(...args), signal) as never),
    map: <U>(transform: (value: T) => U) => mapOp(out as never, transform),
    mapErr: <E2>(transform: (error: E) => E2) => mapErrOp(out as never, transform),
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, readonly []>) => flatMapOp(out as never, bind),
    tap: <R>(observe: (value: T) => R) => tapOp(out as never, observe),
    tapErr: <R>(observe: (error: E) => R) => tapErrOp(out as never, observe),
    recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
      recoverOp(out as never, predicate, handler),
    _tag: "Op" as const,
  }) as never;

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
    });
    return bound;
  };

  if (f.length === 0) {
    return makeBoundOp() as Op<unknown, unknown, []>;
  }

  return makeArityOp<unknown, unknown, readonly unknown[]>((...args) => makeBoundOp(...args));
};
