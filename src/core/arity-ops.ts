import { TimeoutError } from "../errors.js";
import type { RetryPolicy } from "../policies.js";
import type {
  ExitFn,
  InferNullaryOpErr,
  Op,
  OpArity,
  OpLifecycleHook,
  RecoverError,
  RecoverValue,
  ReleaseFn,
} from "./types.js";
import { drive } from "./runtime.js";
import {
  flatMapNullaryOp,
  isNullaryOp,
  mapErrNullaryOp,
  mapNullaryOp,
  onExitNullaryOp,
  recoverNullaryOp,
  tapErrNullaryOp,
  tapNullaryOp,
  withCleanupNullaryOp,
} from "./nullary-ops.js";

export interface FluentArityHandlers<T, E, A extends readonly unknown[]> {
  withRetry: (policy?: RetryPolicy) => Op<T, E, A>;
  withTimeout: (timeoutMs: number) => Op<T, E | TimeoutError, A>;
  withSignal: (signal: AbortSignal) => Op<T, E, A>;
  withRelease: (release: ReleaseFn<T>) => Op<T, E, A>;
  on: (event: OpLifecycleHook, finalize: ExitFn<T, E>) => Op<T, E, A>;
}

export const makeFluentArityOp = <T, E, A extends readonly unknown[]>(
  invoke: (...args: A) => Op<T, E, readonly []>,
  makeHandlers: (self: Op<T, E, A>) => FluentArityHandlers<T, E, A>,
): Op<T, E, A> => {
  let self: Op<T, E, A>;
  const handlers = () => makeHandlers(self);
  self = Object.assign(invoke, {
    run: (...args: A) => drive(invoke(...args), new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => handlers().withRetry(policy),
    withTimeout: (timeoutMs: number) => handlers().withTimeout(timeoutMs),
    withSignal: (signal: AbortSignal) => handlers().withSignal(signal),
    withRelease: (release: ReleaseFn<T>) => handlers().withRelease(release),
    on: (event: OpLifecycleHook, finalize: ExitFn<T, E>) => handlers().on(event, finalize),
    map: <U>(transform: (value: T) => U) => mapOp(self, transform),
    mapErr: <E2>(transform: (error: E) => E2) => mapErrOp(self, transform),
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, readonly []>) => flatMapOp(self, bind),
    tap: <R>(observe: (value: T) => R) => tapOp(self, observe),
    tapErr: <R>(observe: (error: E) => R) => tapErrOp(self, observe),
    recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
      recoverOp(self, predicate, handler),
    _tag: "Op" as const,
  }) as unknown as Op<T, E, A>;
  return self;
};

const liftArityOp = <TIn, EIn, A extends readonly unknown[], TOut, EOut>(
  op: Op<TIn, EIn, A>,
  mapNullary: (resolved: Op<TIn, EIn, readonly []>) => Op<TOut, EOut, readonly []>,
  makeHandlers: (
    source: OpArity<TIn, EIn, A>,
    self: Op<TOut, EOut, A>,
  ) => FluentArityHandlers<TOut, EOut, A>,
): Op<TOut, EOut, A> => {
  if (isNullaryOp(op)) {
    return mapNullary(op) as unknown as Op<TOut, EOut, A>;
  }

  const source = op as OpArity<TIn, EIn, A>;
  const g = (...args: A) => mapNullary(source(...args));
  return makeFluentArityOp(g, (self) => makeHandlers(source, self));
};

const onExitOp = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  finalize: ExitFn<T, E>,
): Op<T, E, A> => {
  return liftArityOp(
    op,
    (resolved) => onExitNullaryOp(resolved, finalize),
    (source, self) => ({
      withRetry: (policy?: RetryPolicy) => onExitOp(source.withRetry(policy), finalize),
      withTimeout: (timeoutMs: number) =>
        onExitOp(source.withTimeout(timeoutMs), finalize as ExitFn<T, E | TimeoutError>),
      withSignal: (signal: AbortSignal) => onExitOp(source.withSignal(signal), finalize),
      withRelease: (release: ReleaseFn<T>) => withReleaseOp(self, release),
      on: (event: OpLifecycleHook, hookFinalize: ExitFn<T, E>) => onOp(self, event, hookFinalize),
    }),
  );
};

const onOp = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  event: OpLifecycleHook,
  finalize: ExitFn<T, E>,
): Op<T, E, A> => {
  if (event !== "exit") {
    const _: never = event;
    return _;
  }
  return onExitOp(op, finalize);
};

const withReleaseOp = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  release: ReleaseFn<T>,
): Op<T, E, A> => {
  return liftArityOp(
    op,
    (resolved) => withCleanupNullaryOp(resolved, release),
    (source, self) => ({
      withRetry: (policy?: RetryPolicy) => withReleaseOp(source.withRetry(policy), release),
      withTimeout: (timeoutMs: number) => withReleaseOp(source.withTimeout(timeoutMs), release),
      withSignal: (signal: AbortSignal) => withReleaseOp(source.withSignal(signal), release),
      withRelease: (nextRelease: ReleaseFn<T>) => withReleaseOp(self, nextRelease),
      on: (event: OpLifecycleHook, finalize: ExitFn<T, E>) => onOp(self, event, finalize),
    }),
  );
};

const mapOp = <T, E, A extends readonly unknown[], U>(
  op: Op<T, E, A>,
  transform: (value: T) => U,
): Op<Awaited<U>, E, A> => {
  return liftArityOp(
    op,
    (resolved) => mapNullaryOp(resolved, transform),
    (source, self) => ({
      withRetry: (policy?: RetryPolicy) => mapOp(source.withRetry(policy), transform),
      withTimeout: (timeoutMs: number) => mapOp(source.withTimeout(timeoutMs), transform),
      withSignal: (signal: AbortSignal) => mapOp(source.withSignal(signal), transform),
      withRelease: (release: ReleaseFn<Awaited<U>>) => withReleaseOp(self, release),
      on: (event: OpLifecycleHook, finalize: ExitFn<Awaited<U>, E>) => onOp(self, event, finalize),
    }),
  );
};

const mapErrOp = <T, E, A extends readonly unknown[], E2>(
  op: Op<T, E, A>,
  transform: (error: E) => E2,
): Op<T, E2, A> => {
  return liftArityOp(
    op,
    (resolved) => mapErrNullaryOp(resolved, transform),
    (source, self) => ({
      withRetry: (policy?: RetryPolicy) => mapErrOp(source.withRetry(policy), transform),
      withTimeout: (timeoutMs: number) =>
        mapErrOp(source.withTimeout(timeoutMs), (error: E | TimeoutError) =>
          error instanceof TimeoutError ? error : transform(error),
        ),
      withSignal: (signal: AbortSignal) => mapErrOp(source.withSignal(signal), transform),
      withRelease: (release: ReleaseFn<T>) => withReleaseOp(self, release),
      on: (event: OpLifecycleHook, finalize: ExitFn<T, E2>) => onOp(self, event, finalize),
    }),
  );
};

const flatMapOp = <T, E, A extends readonly unknown[], U, E2>(
  op: Op<T, E, A>,
  bind: (value: T) => Op<U, E2, readonly []>,
): Op<U, E | E2, A> => {
  return liftArityOp(
    op,
    (resolved) => flatMapNullaryOp(resolved, bind),
    (source, self) => ({
      withRetry: (policy?: RetryPolicy) => flatMapOp(source.withRetry(policy), bind),
      withTimeout: (timeoutMs: number) => flatMapOp(source.withTimeout(timeoutMs), bind),
      withSignal: (signal: AbortSignal) => flatMapOp(source.withSignal(signal), bind),
      withRelease: (release: ReleaseFn<U>) => withReleaseOp(self, release),
      on: (event: OpLifecycleHook, finalize: ExitFn<U, E | E2>) => onOp(self, event, finalize),
    }),
  );
};

const tapOp = <T, E, A extends readonly unknown[], R>(
  op: Op<T, E, A>,
  observe: (value: T) => R,
): Op<T, E | InferNullaryOpErr<R>, A> => {
  return liftArityOp(
    op,
    (resolved) => tapNullaryOp(resolved, observe),
    (source, self) => ({
      withRetry: (policy?: RetryPolicy) => tapOp(source.withRetry(policy), observe),
      withTimeout: (timeoutMs: number) => tapOp(source.withTimeout(timeoutMs), observe),
      withSignal: (signal: AbortSignal) => tapOp(source.withSignal(signal), observe),
      withRelease: (release: ReleaseFn<T>) => withReleaseOp(self, release),
      on: (event: OpLifecycleHook, finalize: ExitFn<T, E | InferNullaryOpErr<R>>) =>
        onOp(self, event, finalize),
    }),
  );
};

const tapErrOp = <T, E, A extends readonly unknown[], R>(
  op: Op<T, E, A>,
  observe: (error: E) => R,
): Op<T, E | InferNullaryOpErr<R>, A> => {
  return liftArityOp(
    op,
    (resolved) => tapErrNullaryOp(resolved, observe),
    (source, self) => ({
      withRetry: (policy?: RetryPolicy) => tapErrOp(source.withRetry(policy), observe),
      withTimeout: (timeoutMs: number) =>
        tapErrOp(source.withTimeout(timeoutMs), (error: E | TimeoutError) => {
          if (!(error instanceof TimeoutError)) {
            return observe(error);
          }
        }),
      withSignal: (signal: AbortSignal) => tapErrOp(source.withSignal(signal), observe),
      withRelease: (release: ReleaseFn<T>) => withReleaseOp(self, release),
      on: (event: OpLifecycleHook, finalize: ExitFn<T, E | InferNullaryOpErr<R>>) =>
        onOp(self, event, finalize),
    }),
  );
};

const recoverOp = <T, E, A extends readonly unknown[], R>(
  op: Op<T, E, A>,
  predicate: (error: E) => boolean,
  handler: (error: E) => R,
): Op<T | RecoverValue<R>, E | RecoverError<R>, A> => {
  return liftArityOp(
    op,
    (resolved) => recoverNullaryOp(resolved, predicate, handler),
    (source, self) => ({
      withRetry: (policy?: RetryPolicy) => recoverOp(source.withRetry(policy), predicate, handler),
      withTimeout: (timeoutMs: number) =>
        recoverOp(
          source.withTimeout(timeoutMs),
          (error: E | TimeoutError) => !(error instanceof TimeoutError) && predicate(error),
          handler as (error: E | TimeoutError) => R,
        ),
      withSignal: (signal: AbortSignal) => recoverOp(source.withSignal(signal), predicate, handler),
      withRelease: (release: ReleaseFn<T | RecoverValue<R>>) => withReleaseOp(self, release),
      on: (event: OpLifecycleHook, finalize: ExitFn<T | RecoverValue<R>, E | RecoverError<R>>) =>
        onOp(self, event, finalize),
    }),
  );
};

export { flatMapOp, mapErrOp, mapOp, onExitOp, onOp, recoverOp, tapErrOp, tapOp, withReleaseOp };
