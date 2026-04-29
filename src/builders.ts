import { UnhandledException, UnreachableError } from "./errors.js";
import {
  flatMapOp,
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

  const self = {
    *[Symbol.iterator]() {
      return value;
    },
    run: () => runOp(self as never),
    withRetry: (policy?: RetryPolicy) => withRetryOp(self as never, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(self as never, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(self as never, signal),
    map: <U>(transform: (value: Awaited<T>) => U) => mapOp(self as never, transform),
    mapErr: <E2>(transform: (error: never) => E2) => mapErrOp(self as never, transform),
    flatMap: <U, E2>(bind: (value: Awaited<T>) => Op<U, E2, readonly []>) =>
      flatMapOp(self as never, bind),
    tap: <R>(observe: (value: Awaited<T>) => R) => tapOp(self as never, observe),
    tapErr: <R>(observe: (error: never) => R) => tapErrOp(self as never, observe),
    recover: <R>(predicate: (error: never) => boolean, handler: (error: never) => R) =>
      recoverOp(self as never, predicate, handler),
    _tag: "Op",
  };
  const op = () => self;
  return Object.assign(op, self) as never;
};

/**
 * Lifts a value into an operation that always fails.
 */
export const fail = <E>(value: E): Op<never, E, readonly []> => {
  const self = {
    *[Symbol.iterator]() {
      yield err(value);
      throw new UnreachableError();
    },
    run: () => runOp(self as never),
    withRetry: (policy?: RetryPolicy) => withRetryOp(self as never, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(self as never, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(self as never, signal),
    map: <U>(transform: (value: never) => U) => mapOp(self as never, transform),
    mapErr: <E2>(transform: (error: E) => E2) => mapErrOp(self as never, transform),
    flatMap: <U, E2>(bind: (value: never) => Op<U, E2, readonly []>) =>
      flatMapOp(self as never, bind),
    tap: <R>(observe: (value: never) => R) => tapOp(self as never, observe),
    tapErr: <R>(observe: (error: E) => R) => tapErrOp(self as never, observe),
    recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
      recoverOp(self as never, predicate, handler),
    _tag: "Op" as const,
  };
  const op = () => self;
  return Object.assign(op, self) as never;
};

/**
 * Suspends until a promise settles, then continues with its value or a mapped failure.
 */
export const _try = <T, E = UnhandledException>(
  f: (signal: AbortSignal) => T,
  onError?: (e: unknown) => E,
): Op<Awaited<T>, E, readonly []> => {
  const self = {
    *[Symbol.iterator]() {
      const result: Result<T, E> = yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) =>
          Promise.resolve()
            .then(() => f(signal))
            .then(
              (a) => ok(a),
              (cause) => err(onError ? onError(cause) : new UnhandledException({ cause })),
            ) as Promise<Result<T, E>>,
      };
      if (result.isErr()) {
        yield result;
        throw new UnreachableError();
      }
      return result.value;
    },
    run: () => runOp(self as never),
    withRetry: (policy?: RetryPolicy) => withRetryOp(self as never, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(self as never, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(self as never, signal),
    map: <U>(transform: (value: Awaited<T>) => U) => mapOp(self as never, transform),
    mapErr: <E2>(transform: (error: E) => E2) => mapErrOp(self as never, transform),
    flatMap: <U, E2>(bind: (value: Awaited<T>) => Op<U, E2, readonly []>) =>
      flatMapOp(self as never, bind),
    tap: <R>(observe: (value: Awaited<T>) => R) => tapOp(self as never, observe),
    tapErr: <R>(observe: (error: E) => R) => tapErrOp(self as never, observe),
    recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
      recoverOp(self as never, predicate, handler),
    _tag: "Op" as const,
  };
  const op = () => self;
  return Object.assign(op, self) as never;
};

/**
 * Turns a generator function into an {@link Op}.
 */
export const fromGenFn: FromGenFn = (
  f: (...args: unknown[]) => Generator<Instruction<unknown>, unknown, unknown>,
): Op<unknown, unknown, []> | Op<unknown, unknown, readonly unknown[]> => {
  const g = (...args: unknown[]) => {
    const inner = {
      [Symbol.iterator]: () => f(...args),
      run: () => runOp(inner as never),
      withRetry: (policy?: RetryPolicy) => withRetryOp(inner as never, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(inner as never, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(inner as never, signal),
      map: <U>(transform: (value: unknown) => U) => mapOp(inner as never, transform),
      mapErr: <E2>(transform: (error: unknown) => E2) => mapErrOp(inner as never, transform),
      flatMap: <U, E2>(bind: (value: unknown) => Op<U, E2, readonly []>) =>
        flatMapOp(inner as never, bind),
      tap: <R>(observe: (value: unknown) => R) => tapOp(inner as never, observe),
      tapErr: <R>(observe: (error: unknown) => R) => tapErrOp(inner as never, observe),
      recover: <R>(predicate: (error: unknown) => boolean, handler: (error: unknown) => R) =>
        recoverOp(inner as never, predicate, handler),
      _tag: "Op",
    };
    const _op = () => inner;
    return Object.assign(_op, inner);
  };
  const out: Op<unknown, unknown, unknown[]> = Object.assign(g, {
    run: (...args: unknown[]) => runOp(g(...args) as never),
    withRetry: (policy?: RetryPolicy) => withRetryOp(out as never, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(out as never, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(out as never, signal),
    map: <U>(transform: (value: unknown) => U) => mapOp(out as never, transform),
    mapErr: <E2>(transform: (error: unknown) => E2) => mapErrOp(out as never, transform),
    flatMap: <U, E2>(bind: (value: unknown) => Op<U, E2, readonly []>) =>
      flatMapOp(out as never, bind),
    tap: <R>(observe: (value: unknown) => R) => tapOp(out as never, observe),
    tapErr: <R>(observe: (error: unknown) => R) => tapErrOp(out as never, observe),
    recover: <R>(predicate: (error: unknown) => boolean, handler: (error: unknown) => R) =>
      recoverOp(out as never, predicate, handler),
    _tag: "Op" as const,
  }) as never;

  return out as Op<unknown, unknown, []> | Op<unknown, unknown, readonly unknown[]>;
};
