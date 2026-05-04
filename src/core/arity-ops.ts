import { TimeoutError } from "../errors.js";
import type { RetryPolicy } from "../policies.js";
import type {
  EnterFn,
  ExitFn,
  InferNullaryOpErr,
  LifecycleFn,
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
  mapErrNullaryOp,
  mapNullaryOp,
  onEnterNullaryOp,
  onExitNullaryOp,
  recoverNullaryOp,
  tapErrNullaryOp,
  tapNullaryOp,
  withCleanupNullaryOp,
} from "./nullary-ops.js";
import { cast } from "../shared.js";

export interface FluentArityHandlers<T, E, A extends readonly unknown[]> {
  withRetry: (policy?: RetryPolicy) => OpArity<T, E, A>;
  withTimeout: (timeoutMs: number) => OpArity<T, E | TimeoutError, A>;
  withSignal: (signal: AbortSignal) => OpArity<T, E, A>;
  withRelease: (release: ReleaseFn<T>) => OpArity<T, E, A>;
  on: (event: OpLifecycleHook, handler: LifecycleFn<T, E, A>) => OpArity<T, E, A>;
}

/**
 * Casts an Op to an OpArity
 *
 * TypeScript cannot preserve the full callable+fluent intersection through some
 * generic transforms (for example `Object.assign` + tuple-parameterized call signatures).
 * This cast re-attaches the known arity shape after those transforms.
 *
 * @warning This function is UNSAFE and should be used only when the type is known to be correct
 */
export function asArityOp<T, E, A extends readonly unknown[]>(op: Op<T, E, A>): OpArity<T, E, A> {
  return cast(op);
}

export function makeFluentArityOp<T, E, A extends readonly unknown[]>(
  invoke: (...args: A) => Op<T, E, []>,
  makeHandlers: (self: OpArity<T, E, A>) => FluentArityHandlers<T, E, A>,
): OpArity<T, E, A> {
  // SAFETY: `invoke` already has the runtime call signature `(...args: A) => Op<T, E, []>`.
  // `Object.assign` only decorates that function object with fluent handlers, so this
  // cast restores the intended callable+methods intersection that TS cannot infer.
  const self: OpArity<T, E, A> = cast(
    Object.assign(invoke, {
      run: (...args: A) => drive(invoke(...args), new AbortController().signal),
      withRetry: (policy?: RetryPolicy) => makeHandlers(self).withRetry(policy),
      withTimeout: (timeoutMs: number) => makeHandlers(self).withTimeout(timeoutMs),
      withSignal: (signal: AbortSignal) => makeHandlers(self).withSignal(signal),
      withRelease: (release: ReleaseFn<T>) => makeHandlers(self).withRelease(release),
      on: (event: OpLifecycleHook, handler: LifecycleFn<T, E, A>) =>
        makeHandlers(self).on(event, handler),
      map: <U>(transform: (value: T) => U) => mapOp(self, transform),
      mapErr: <E2>(transform: (error: E) => E2) => mapErrOp(self, transform),
      flatMap: <U, E2>(bind: (value: T) => Op<U, E2, []>) => flatMapOp(self, bind),
      tap: <R>(observe: (value: T) => R) => tapOp(self, observe),
      tapErr: <R>(observe: (error: E) => R) => tapErrOp(self, observe),
      recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
        recoverOp(self, predicate, handler),
      _tag: "Op" as const,
    }),
  );
  return self;
}

export function liftArityOp<TIn, EIn, A extends readonly unknown[], TOut, EOut>(
  op: OpArity<TIn, EIn, A>,
  mapNullary: (resolved: Op<TIn, EIn, []>) => Op<TOut, EOut, []>,
  makeHandlers: (
    source: OpArity<TIn, EIn, A>,
    self: OpArity<TOut, EOut, A>,
  ) => FluentArityHandlers<TOut, EOut, A>,
): OpArity<TOut, EOut, A> {
  return makeFluentArityOp(
    (...args) => mapNullary(op(...args)),
    (self) => makeHandlers(op, self),
  );
}

export function onExitOp<T, E, A extends readonly unknown[]>(
  op: OpArity<T, E, A>,
  finalize: ExitFn<T, E, A>,
): OpArity<T, E, A> {
  const source = op;
  return makeFluentArityOp(
    (...args) =>
      onExitNullaryOp(source(...args), (ctx) =>
        finalize({
          signal: ctx.signal,
          result: ctx.result,
          args,
        }),
      ),
    (self) => ({
      withRetry: (policy) => onExitOp(asArityOp(source.withRetry(policy)), finalize),
      withTimeout: (timeoutMs) =>
        onExitOp(
          asArityOp(source.withTimeout(timeoutMs)),
          // SAFETY: `withTimeout` widens the error type to `E | TimeoutError`, so we need to cast the finalize function
          cast(finalize),
        ),
      withSignal: (signal) => onExitOp(asArityOp(source.withSignal(signal)), finalize),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, hookFinalize) => onOp(self, event, hookFinalize),
    }),
  );
}

export function onEnterOp<T, E, A extends readonly unknown[]>(
  op: OpArity<T, E, A>,
  initialize: EnterFn<A>,
): OpArity<T, E, A> {
  const source = op;
  return makeFluentArityOp(
    (...args) =>
      onEnterNullaryOp(source(...args), ({ signal }) =>
        initialize({
          signal,
          args,
        }),
      ),
    (self) => ({
      withRetry: (policy) => onEnterOp(asArityOp(source.withRetry(policy)), initialize),
      withTimeout: (timeoutMs) => onEnterOp(asArityOp(source.withTimeout(timeoutMs)), initialize),
      withSignal: (signal) => onEnterOp(asArityOp(source.withSignal(signal)), initialize),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, handler) => onOp(self, event, handler),
    }),
  );
}

export function onOp<T, E, A extends readonly unknown[]>(
  op: OpArity<T, E, A>,
  event: OpLifecycleHook,
  handler: LifecycleFn<T, E, A>,
): OpArity<T, E, A> {
  if (event === "enter") {
    // Discriminant narrows runtime event, but TS cannot narrow unioned function type parameterized by `A`.
    return onEnterOp(op, cast(handler));
  }

  if (event === "exit") {
    // Discriminant narrows runtime event, but TS cannot narrow unioned function type parameterized by `A`.
    return onExitOp(op, cast(handler));
  }

  event satisfies never;
  return op;
}

export function withReleaseOp<T, E, A extends readonly unknown[]>(
  op: OpArity<T, E, A>,
  release: ReleaseFn<T>,
): OpArity<T, E, A> {
  return liftArityOp(
    op,
    (resolved) => withCleanupNullaryOp(resolved, release),
    (source, self) => ({
      withRetry: (policy) => withReleaseOp(asArityOp(source.withRetry(policy)), release),
      withTimeout: (timeoutMs) => withReleaseOp(asArityOp(source.withTimeout(timeoutMs)), release),
      withSignal: (signal) => withReleaseOp(asArityOp(source.withSignal(signal)), release),
      withRelease: (nextRelease) => withReleaseOp(self, nextRelease),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

export function mapOp<T, E, A extends readonly unknown[], U>(
  op: OpArity<T, E, A>,
  transform: (value: T) => U,
): OpArity<Awaited<U>, E, A> {
  return liftArityOp(
    op,
    (resolved) => mapNullaryOp(resolved, transform),
    (source, self) => ({
      withRetry: (policy) => mapOp(asArityOp(source.withRetry(policy)), transform),
      withTimeout: (timeoutMs) => mapOp(asArityOp(source.withTimeout(timeoutMs)), transform),
      withSignal: (signal) => mapOp(asArityOp(source.withSignal(signal)), transform),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

export function mapErrOp<T, E, A extends readonly unknown[], E2>(
  op: OpArity<T, E, A>,
  transform: (error: E) => E2,
): OpArity<T, E2, A> {
  return liftArityOp(
    op,
    (resolved) => mapErrNullaryOp(resolved, transform),
    (source, self) => ({
      withRetry: (policy) => mapErrOp(asArityOp(source.withRetry(policy)), transform),
      withTimeout: (timeoutMs) =>
        mapErrOp(asArityOp(source.withTimeout(timeoutMs)), (error) =>
          error instanceof TimeoutError ? error : transform(error),
        ),
      withSignal: (signal) => mapErrOp(asArityOp(source.withSignal(signal)), transform),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

export function flatMapOp<T, E, A extends readonly unknown[], U, E2>(
  op: OpArity<T, E, A>,
  bind: (value: T) => Op<U, E2, []>,
): OpArity<U, E | E2, A> {
  return liftArityOp(
    op,
    (resolved) => flatMapNullaryOp(resolved, bind),
    (source, self) => ({
      withRetry: (policy) => flatMapOp(asArityOp(source.withRetry(policy)), bind),
      withTimeout: (timeoutMs) => flatMapOp(asArityOp(source.withTimeout(timeoutMs)), bind),
      withSignal: (signal) => flatMapOp(asArityOp(source.withSignal(signal)), bind),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

export function tapOp<T, E, A extends readonly unknown[], R>(
  op: OpArity<T, E, A>,
  observe: (value: T) => R,
): OpArity<T, E | InferNullaryOpErr<R>, A> {
  return liftArityOp(
    op,
    (resolved) => tapNullaryOp(resolved, observe),
    (source, self) => ({
      withRetry: (policy) => tapOp(asArityOp(source.withRetry(policy)), observe),
      withTimeout: (timeoutMs) => tapOp(asArityOp(source.withTimeout(timeoutMs)), observe),
      withSignal: (signal) => tapOp(asArityOp(source.withSignal(signal)), observe),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

export function tapErrOp<T, E, A extends readonly unknown[], R>(
  op: OpArity<T, E, A>,
  observe: (error: E) => R,
): OpArity<T, E | InferNullaryOpErr<R>, A> {
  return liftArityOp(
    op,
    (resolved) => tapErrNullaryOp(resolved, observe),
    (source, self) => ({
      withRetry: (policy) => tapErrOp(asArityOp(source.withRetry(policy)), observe),
      withTimeout: (timeoutMs) =>
        tapErrOp(asArityOp(source.withTimeout(timeoutMs)), (error) =>
          TimeoutError.is(error) ? undefined : observe(error),
        ),
      withSignal: (signal) => tapErrOp(asArityOp(source.withSignal(signal)), observe),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

export function recoverOp<T, E, A extends readonly unknown[], R>(
  op: OpArity<T, E, A>,
  predicate: (error: E) => boolean,
  handler: (error: E) => R,
): OpArity<T | RecoverValue<R>, E | RecoverError<R>, A> {
  return liftArityOp(
    op,
    (resolved) => recoverNullaryOp(resolved, predicate, handler),
    (source, self) => ({
      withRetry: (policy) => recoverOp(asArityOp(source.withRetry(policy)), predicate, handler),
      withTimeout: (timeoutMs) =>
        recoverOp(
          // SAFETY: `withTimeout` widens the error type to `E | TimeoutError`, so we need to cast the source op
          // to the narrower error type `E` to match the handler type
          cast(source.withTimeout(timeoutMs)),
          (error) => !TimeoutError.is(error) && predicate(error),
          handler,
        ),
      withSignal: (signal) => recoverOp(asArityOp(source.withSignal(signal)), predicate, handler),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}
