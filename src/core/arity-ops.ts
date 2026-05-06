import { TimeoutError } from "../errors.js";
import type { RetryPolicy } from "../policies.js";
import type {
  EnterFn,
  ExitFn,
  LifecycleFn,
  Op,
  OpArity,
  OpLifecycleHook,
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
      map: <U>(transform: (value: T) => U) =>
        liftArityOp(self, (resolved) => mapNullaryOp(resolved, transform)),
      mapErr: <E2>(transform: (error: E) => E2) =>
        liftArityOp(
          self,
          (resolved) => mapErrNullaryOp(resolved, transform),
          (resolved) =>
            mapErrNullaryOp(resolved, (error) =>
              TimeoutError.is(error) ? error : transform(error),
            ),
        ),
      flatMap: <U, E2>(bind: (value: T) => Op<U, E2, []>) =>
        liftArityOp(self, (resolved) => flatMapNullaryOp(resolved, bind)),
      tap: <R>(observe: (value: T) => R) =>
        liftArityOp(self, (resolved) => tapNullaryOp(resolved, observe)),
      tapErr: <R>(observe: (error: E) => R) =>
        liftArityOp(
          self,
          (resolved) => tapErrNullaryOp(resolved, observe),
          (resolved) =>
            tapErrNullaryOp(resolved, (error) =>
              TimeoutError.is(error) ? undefined : observe(error),
            ),
        ),
      recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
        liftArityOp(
          self,
          (resolved) => recoverNullaryOp(resolved, predicate, handler),
          (resolved) =>
            recoverNullaryOp(
              resolved,
              (error) => !TimeoutError.is(error) && predicate(error),
              cast(handler),
            ),
        ),
      _tag: "Op" as const,
    }),
  );
  return self;
}

export function liftArityOp<TIn, EIn, A extends readonly unknown[], TOut, EOut>(
  op: OpArity<TIn, EIn, A>,
  mapNullary: (resolved: Op<TIn, EIn, []>) => Op<TOut, EOut, []>,
  mapNullaryForTimeout?: (
    resolved: Op<TIn, EIn | TimeoutError, []>,
  ) => Op<TOut, EOut | TimeoutError, []>,
): OpArity<TOut, EOut, A> {
  return makeFluentArityOp(
    (...args) => mapNullary(op(...args)),
    (self) => ({
      withRetry: (policy) => liftArityOp(asArityOp(op.withRetry(policy)), mapNullary),
      withTimeout: (timeoutMs) =>
        liftArityOp<TIn, EIn | TimeoutError, A, TOut, EOut | TimeoutError>(
          asArityOp(op.withTimeout(timeoutMs)),
          cast(mapNullaryForTimeout ?? mapNullary),
          mapNullaryForTimeout,
        ),
      withSignal: (signal) => liftArityOp(asArityOp(op.withSignal(signal)), mapNullary),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, handler) => onOp(self, event, handler),
    }),
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
    (...args) => onEnterNullaryOp(source(...args), ({ signal }) => initialize({ signal, args })),
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
  const source = op;
  return makeFluentArityOp(
    (...args) => withCleanupNullaryOp(source(...args), release),
    (self) => ({
      withRetry: (policy) => withReleaseOp(asArityOp(source.withRetry(policy)), release),
      withTimeout: (timeoutMs) => withReleaseOp(asArityOp(source.withTimeout(timeoutMs)), release),
      withSignal: (signal) => withReleaseOp(asArityOp(source.withSignal(signal)), release),
      withRelease: (nextRelease) => withReleaseOp(self, nextRelease),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}
