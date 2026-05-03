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

export function makeFluentArityOp<T, E, A extends readonly unknown[]>(
  invoke: (...args: A) => Op<T, E, []>,
  makeHandlers: (self: Op<T, E, A>) => FluentArityHandlers<T, E, A>,
): Op<T, E, A> {
  const self = Object.assign(invoke, {
    run: (...args: A) => drive(invoke(...args), new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => makeHandlers(self).withRetry(policy),
    withTimeout: (timeoutMs: number) => makeHandlers(self).withTimeout(timeoutMs),
    withSignal: (signal: AbortSignal) => makeHandlers(self).withSignal(signal),
    withRelease: (release: ReleaseFn<T>) => makeHandlers(self).withRelease(release),
    on: (event: OpLifecycleHook, finalize: ExitFn<T, E>) => makeHandlers(self).on(event, finalize),
    map: <U>(transform: (value: T) => U) => mapOp(self, transform),
    mapErr: <E2>(transform: (error: E) => E2) => mapErrOp(self, transform),
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, []>) => flatMapOp(self, bind),
    tap: <R>(observe: (value: T) => R) => tapOp(self, observe),
    tapErr: <R>(observe: (error: E) => R) => tapErrOp(self, observe),
    recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
      recoverOp(self, predicate, handler),
    _tag: "Op" as const,
    // TS cannot represent a callable value that is also this exact fluent object shape
    // without losing the tuple-arg generic `A`; we cast once at construction to preserve
    // the runtime-correct shape that `drive` and all fluent helpers rely on
  }) as unknown as Op<T, E, A>;
  return self;
}

export function liftArityOp<TIn, EIn, A extends readonly unknown[], TOut, EOut>(
  op: Op<TIn, EIn, A>,
  mapNullary: (resolved: Op<TIn, EIn, []>) => Op<TOut, EOut, []>,
  makeHandlers: (
    source: OpArity<TIn, EIn, A>,
    self: Op<TOut, EOut, A>,
  ) => FluentArityHandlers<TOut, EOut, A>,
): Op<TOut, EOut, A> {
  if (isNullaryOp(op)) {
    // TS cannot refine generic `A` to `[]` from this runtime check, even though nullary
    // ops are guaranteed to satisfy that branch. We cast to preserve the caller's `A`
    return mapNullary(op) as unknown as Op<TOut, EOut, A>;
  }

  const source = op as OpArity<TIn, EIn, A>;
  return makeFluentArityOp(
    (...args) => mapNullary(source(...args)),
    (self) => makeHandlers(source, self),
  );
}

export function onExitOp<T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  finalize: ExitFn<T, E>,
): Op<T, E, A> {
  return liftArityOp(
    op,
    (resolved) => onExitNullaryOp(resolved, finalize),
    (source, self) => ({
      withRetry: (policy) => onExitOp(source.withRetry(policy), finalize),
      withTimeout: (timeoutMs) =>
        onExitOp(source.withTimeout(timeoutMs), finalize as ExitFn<T, E | TimeoutError>),
      withSignal: (signal) => onExitOp(source.withSignal(signal), finalize),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, hookFinalize) => onOp(self, event, hookFinalize),
    }),
  );
}

export function onOp<T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  event: OpLifecycleHook,
  finalize: ExitFn<T, E>,
): Op<T, E, A> {
  if (event !== "exit") {
    event satisfies never;
    return op;
  }
  return onExitOp(op, finalize);
}

export function withReleaseOp<T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  release: ReleaseFn<T>,
): Op<T, E, A> {
  return liftArityOp(
    op,
    (resolved) => withCleanupNullaryOp(resolved, release),
    (source, self) => ({
      withRetry: (policy) => withReleaseOp(source.withRetry(policy), release),
      withTimeout: (timeoutMs) => withReleaseOp(source.withTimeout(timeoutMs), release),
      withSignal: (signal) => withReleaseOp(source.withSignal(signal), release),
      withRelease: (nextRelease) => withReleaseOp(self, nextRelease),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

export function mapOp<T, E, A extends readonly unknown[], U>(
  op: Op<T, E, A>,
  transform: (value: T) => U,
): Op<Awaited<U>, E, A> {
  return liftArityOp(
    op,
    (resolved) => mapNullaryOp(resolved, transform),
    (source, self) => ({
      withRetry: (policy) => mapOp(source.withRetry(policy), transform),
      withTimeout: (timeoutMs) => mapOp(source.withTimeout(timeoutMs), transform),
      withSignal: (signal) => mapOp(source.withSignal(signal), transform),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

export function mapErrOp<T, E, A extends readonly unknown[], E2>(
  op: Op<T, E, A>,
  transform: (error: E) => E2,
): Op<T, E2, A> {
  return liftArityOp(
    op,
    (resolved) => mapErrNullaryOp(resolved, transform),
    (source, self) => ({
      withRetry: (policy) => mapErrOp(source.withRetry(policy), transform),
      withTimeout: (timeoutMs) =>
        mapErrOp(source.withTimeout(timeoutMs), (error) =>
          error instanceof TimeoutError ? error : transform(error),
        ),
      withSignal: (signal) => mapErrOp(source.withSignal(signal), transform),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

export function flatMapOp<T, E, A extends readonly unknown[], U, E2>(
  op: Op<T, E, A>,
  bind: (value: T) => Op<U, E2, []>,
): Op<U, E | E2, A> {
  return liftArityOp(
    op,
    (resolved) => flatMapNullaryOp(resolved, bind),
    (source, self) => ({
      withRetry: (policy) => flatMapOp(source.withRetry(policy), bind),
      withTimeout: (timeoutMs) => flatMapOp(source.withTimeout(timeoutMs), bind),
      withSignal: (signal) => flatMapOp(source.withSignal(signal), bind),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

export function tapOp<T, E, A extends readonly unknown[], R>(
  op: Op<T, E, A>,
  observe: (value: T) => R,
): Op<T, E | InferNullaryOpErr<R>, A> {
  return liftArityOp(
    op,
    (resolved) => tapNullaryOp(resolved, observe),
    (source, self) => ({
      withRetry: (policy) => tapOp(source.withRetry(policy), observe),
      withTimeout: (timeoutMs) => tapOp(source.withTimeout(timeoutMs), observe),
      withSignal: (signal) => tapOp(source.withSignal(signal), observe),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

export function tapErrOp<T, E, A extends readonly unknown[], R>(
  op: Op<T, E, A>,
  observe: (error: E) => R,
): Op<T, E | InferNullaryOpErr<R>, A> {
  return liftArityOp(
    op,
    (resolved) => tapErrNullaryOp(resolved, observe),
    (source, self) => ({
      withRetry: (policy) => tapErrOp(source.withRetry(policy), observe),
      withTimeout: (timeoutMs) =>
        tapErrOp(source.withTimeout(timeoutMs), (error) =>
          TimeoutError.is(error) ? undefined : observe(error),
        ),
      withSignal: (signal) => tapErrOp(source.withSignal(signal), observe),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

export function recoverOp<T, E, A extends readonly unknown[], R>(
  op: Op<T, E, A>,
  predicate: (error: E) => boolean,
  handler: (error: E) => R,
): Op<T | RecoverValue<R>, E | RecoverError<R>, A> {
  return liftArityOp(
    op,
    (resolved) => recoverNullaryOp(resolved, predicate, handler),
    (source, self) => ({
      withRetry: (policy) => recoverOp(source.withRetry(policy), predicate, handler),
      withTimeout: (timeoutMs) =>
        recoverOp(
          source.withTimeout(timeoutMs),
          (error) => !TimeoutError.is(error) && predicate(error),
          handler as (error: E | TimeoutError) => R,
        ),
      withSignal: (signal) => recoverOp(source.withSignal(signal), predicate, handler),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}
