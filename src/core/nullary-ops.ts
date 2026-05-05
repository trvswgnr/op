import { TimeoutError, UnhandledException } from "../errors.js";
import { Result } from "../result.js";
import { withRetryOp, withSignalOp, withTimeoutOp, type RetryPolicy } from "../policies.js";
import type {
  EnterContext,
  EnterFn,
  ExitContext,
  ExitFn,
  Instruction,
  LifecycleFn,
  Op,
  OpHooks,
  OpLifecycleHook,
  InferOpErr,
  InferOpOk,
  ReleaseFn,
  TrackedErr,
  WithPredicateMethod,
} from "./types.js";
import { RegisterExitFinalizerInstruction, SuspendInstruction } from "./instructions.js";
import { drive } from "./runtime.js";
import { runOp } from "./run-op.js";
import { cast } from "../shared.js";

const EMPTY_ARGS: [] = [];

export const NULLARY_OP_SYMBOL = Symbol("NullaryOp");

export function isOp(value: unknown): value is Op<unknown, unknown, readonly unknown[]> {
  return typeof value === "function" && "_tag" in value && value._tag === "Op";
}

export function isNullaryOp(value: unknown): value is Op<unknown, unknown, []> {
  return (
    typeof value === "function" &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === "function" &&
    NULLARY_OP_SYMBOL in value
  );
}

function coerceToNullaryOp(value: unknown): Op<unknown, unknown, []> | undefined {
  if (!isOp(value)) return undefined;
  if (isNullaryOp(value)) return value;
  return cast(value());
}

function conditionalPredicate<E>(pred: ((error: E) => boolean) | WithPredicateMethod<E>, error: E) {
  return "is" in pred ? pred.is(error) : pred(error);
}

function dispatchLifecycleNullary<T, E>(
  hooks: OpHooks<T, E>,
  event: OpLifecycleHook,
  handler: LifecycleFn<T, E, []>,
): Op<T, E, []> {
  if (event === "enter") {
    // Discriminant narrows runtime event, but TS cannot narrow unioned function type through generic `event`.
    return hooks.registerEnterInitialize(cast(handler));
  }

  if (event === "exit") {
    // Discriminant narrows runtime event, but TS cannot narrow unioned function type through generic `event`.
    return hooks.registerExitFinalize(cast(handler));
  }

  const _: never = event;
  return _;
}

type DefaultHooks<T, E> = Pick<
  OpHooks<T, E>,
  "withRelease" | "registerEnterInitialize" | "registerExitFinalize"
>;

export function createDefaultHooks<T, E>(getSelf: () => Op<T, E, []>): DefaultHooks<T, E> {
  return {
    withRelease: (release) => withCleanupNullaryOp(getSelf(), release),
    registerEnterInitialize: (initialize) => onEnterNullaryOp(getSelf(), initialize),
    registerExitFinalize: (finalize) => onExitNullaryOp(getSelf(), finalize),
  };
}

export function makeNullaryOp<T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
  hooks: OpHooks<T, E>,
): Op<T, TrackedErr<E>, []> {
  let self: Op<T, TrackedErr<E>, []>;
  const hasPushThroughConfig = hooks.inner !== undefined && hooks.rebuild !== undefined;
  const pushInner = hooks.inner;
  const rebuild = hooks.rebuild;
  const rebuildForTimeout = hooks.rebuildForTimeout ?? hooks.rebuild;
  const state = {
    [NULLARY_OP_SYMBOL]: true,
    [Symbol.iterator]: gen,
    run: () => runOp(self),
    withRetry: (policy?: RetryPolicy) => {
      if (!hasPushThroughConfig || pushInner === undefined || rebuild === undefined) {
        return cast(withRetryOp(self, policy));
      }
      return cast(rebuild(pushInner.withRetry(policy)));
    },
    withTimeout: (timeoutMs: number) => {
      if (!hasPushThroughConfig || pushInner === undefined || rebuildForTimeout === undefined) {
        return cast(withTimeoutOp(self, timeoutMs));
      }
      return cast(rebuildForTimeout(pushInner.withTimeout(timeoutMs)));
    },
    withSignal: (signal: AbortSignal) => {
      if (!hasPushThroughConfig || pushInner === undefined || rebuild === undefined) {
        return cast(withSignalOp(self, signal));
      }
      return cast(rebuild(pushInner.withSignal(signal)));
    },
    withRelease: hooks.withRelease,
    on: (event: OpLifecycleHook, handler: LifecycleFn<T, E, []>) =>
      dispatchLifecycleNullary(hooks, event, handler),
    map: <U>(transform: (value: T) => U) => mapNullaryOp(self, transform),
    mapErr: <E2>(transform: (error: E) => E2) => mapErrNullaryOp(self, transform),
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, []>) => flatMapNullaryOp(self, bind),
    tap: <R>(observe: (value: T) => R) => tapNullaryOp(self, observe),
    tapErr: <R>(observe: (error: E) => R) => tapErrNullaryOp(self, observe),
    recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
      recoverNullaryOp(self, predicate, handler),
    _tag: "Op" as const,
  };

  const callable = () => state;

  // SAFETY: `Object.assign` only decorates that function object with fluent handlers, so this
  // cast restores the intended callable+methods intersection that TS cannot infer
  self = cast(Object.assign(callable, state));

  return self;
}

export function withCleanupNullaryOp<T, E>(op: Op<T, E, []>, release: ReleaseFn<T>): Op<T, E, []> {
  return makeNullaryOp(
    function* () {
      const result: Result<T, E | UnhandledException> = yield* new SuspendInstruction(
        (signal: AbortSignal) => drive(op, signal),
      );

      if (result.isErr()) return yield* result;

      yield new RegisterExitFinalizerInstruction(() =>
        Promise.resolve(release(result.value)).then(() => {}),
      );

      return result.value;
    },
    {
      inner: op,
      rebuild: (newInner) => withCleanupNullaryOp(cast<Op<T, E, []>>(newInner), release),
      withRelease: (nextRelease) =>
        withCleanupNullaryOp(withCleanupNullaryOp(op, release), nextRelease),
      registerEnterInitialize: (initialize) =>
        onEnterNullaryOp(withCleanupNullaryOp(op, release), initialize),
      registerExitFinalize: (finalize) =>
        onExitNullaryOp(withCleanupNullaryOp(op, release), finalize),
    },
  );
}

export function onEnterNullaryOp<T, E>(op: Op<T, E, []>, initialize: EnterFn<[]>): Op<T, E, []> {
  return makeNullaryOp(
    function* () {
      yield new SuspendInstruction(async (signal: AbortSignal) => {
        const enterCtx: EnterContext<[]> = { signal, args: EMPTY_ARGS };
        await Promise.resolve(initialize(enterCtx));
      });

      const result: Result<T, E | UnhandledException> = yield* new SuspendInstruction(
        (signal: AbortSignal) => drive(op, signal),
      );

      if (result.isErr()) return yield* Result.err(result.error);
      return result.value;
    },
    {
      inner: op,
      rebuild: (newInner) => onEnterNullaryOp(cast<Op<T, E, []>>(newInner), initialize),
      withRelease: (release) => withCleanupNullaryOp(onEnterNullaryOp(op, initialize), release),
      registerEnterInitialize: (nextInitialize) =>
        onEnterNullaryOp(onEnterNullaryOp(op, initialize), nextInitialize),
      registerExitFinalize: (finalize) =>
        onExitNullaryOp(onEnterNullaryOp(op, initialize), finalize),
    },
  );
}

export function onExitNullaryOp<T, E>(op: Op<T, E, []>, finalize: ExitFn<T, E, []>): Op<T, E, []> {
  return makeNullaryOp(
    function* () {
      yield new RegisterExitFinalizerInstruction(async (ctx) => {
        // Finalizer registry erases generic payloads to unknown; this restores the concrete op result types.
        const exitCtx: ExitContext<T, E, []> = {
          signal: ctx.signal,
          result: cast(ctx.result),
          args: EMPTY_ARGS,
        };
        await Promise.resolve(finalize(exitCtx));
      });

      const result: Result<T, E | UnhandledException> = yield* new SuspendInstruction(
        (signal: AbortSignal) => drive(op, signal),
      );

      if (result.isErr()) return yield* Result.err(result.error);
      return result.value;
    },
    {
      inner: op,
      rebuild: (newInner) => onExitNullaryOp(cast<Op<T, E, []>>(newInner), finalize),
      rebuildForTimeout: (newInner) =>
        // SAFETY: timeout push-through widens inner error type, so widen finalize accordingly.
        onExitNullaryOp(cast<Op<T, E | TimeoutError, []>>(newInner), cast(finalize)),
      withRelease: (release) => withCleanupNullaryOp(onExitNullaryOp(op, finalize), release),
      registerEnterInitialize: (initialize) =>
        onEnterNullaryOp(onExitNullaryOp(op, finalize), initialize),
      registerExitFinalize: (nextFinalize) =>
        onExitNullaryOp(onExitNullaryOp(op, finalize), nextFinalize),
    },
  );
}

export function mapNullaryOp<T, E, U>(
  op: Op<T, E, []>,
  transform: (value: T) => U,
): Op<Awaited<U>, E, []> {
  return makeNullaryOp(
    function* () {
      const result: Result<T, E | UnhandledException> = yield* new SuspendInstruction(
        (signal: AbortSignal) => drive(op, signal),
      );

      if (result.isErr()) return yield* result;

      const mapped: Awaited<U> = yield* new SuspendInstruction(() =>
        Promise.resolve(transform(result.value)),
      );

      return mapped;
    },
    {
      ...createDefaultHooks(() => mapNullaryOp(op, transform)),
      inner: op,
      rebuild: (newInner) => mapNullaryOp(cast<Op<T, E, []>>(newInner), transform),
    },
  );
}

export function flatMapNullaryOp<T, E, U, E2>(
  op: Op<T, E, []>,
  bind: (value: T) => Op<U, E2, []>,
): Op<U, E | E2, []> {
  const mapped: Op<U, E | E2, []> = makeNullaryOp<U, E | E2 | UnhandledException>(
    function* () {
      const first: Result<T, E | UnhandledException> = yield* new SuspendInstruction(
        (signal: AbortSignal) => drive(op, signal),
      );

      if (first.isErr()) return yield* first;

      const second: Result<U, E2 | UnhandledException> = yield* new SuspendInstruction(
        (signal: AbortSignal) => drive(bind(first.value), signal),
      );

      if (second.isErr()) return yield* second;
      return second.value;
    },
    {
      ...createDefaultHooks(() => mapped),
    },
  );

  return mapped;
}

export function tapNullaryOp<T, E, R>(
  op: Op<T, E, []>,
  observe: (value: T) => R,
): Op<T, E | InferOpErr<R>, []> {
  return makeNullaryOp<T, E | InferOpErr<R> | UnhandledException>(
    function* () {
      const source: Result<T, E | UnhandledException> = yield* new SuspendInstruction(
        (signal: AbortSignal) => drive(op, signal),
      );

      if (source.isErr()) return yield* source;

      const observed = yield new SuspendInstruction(() => Promise.resolve(observe(source.value)));
      const observedOp: Op<unknown, unknown, []> | undefined = yield* new SuspendInstruction(() =>
        Promise.resolve(coerceToNullaryOp(observed)),
      );

      if (!observedOp) return source.value;

      const observedResult: Result<unknown, InferOpErr<R> | UnhandledException> =
        yield* new SuspendInstruction((signal: AbortSignal) => drive(observedOp, signal));

      if (observedResult.isErr()) return yield* observedResult;
      return source.value;
    },
    {
      ...createDefaultHooks(() => tapNullaryOp(op, observe)),
      inner: op,
      rebuild: (newInner) => tapNullaryOp(cast<Op<T, E, []>>(newInner), observe),
    },
  );
}

export function tapErrNullaryOp<T, E, R>(
  op: Op<T, E, []>,
  observe: (error: E) => R,
): Op<T, E | InferOpErr<R>, []> {
  return makeNullaryOp<T, E | InferOpErr<R> | UnhandledException>(
    function* () {
      const source: Result<T, E | UnhandledException> = yield* new SuspendInstruction(
        (signal: AbortSignal) => drive(op, signal),
      );

      if (source.isOk()) return source.value;
      const sourceError = source.error;

      if (UnhandledException.is(sourceError)) return yield* sourceError;

      const observed = yield new SuspendInstruction(() => Promise.resolve(observe(sourceError)));
      const observedOp: Op<unknown, unknown, []> | undefined = yield* new SuspendInstruction(() =>
        Promise.resolve(coerceToNullaryOp(observed)),
      );

      if (!observedOp) return yield* source;

      const observedResult: Result<T, InferOpErr<R> | UnhandledException> =
        yield* new SuspendInstruction((signal: AbortSignal) => drive(observedOp, signal));

      if (observedResult.isErr()) return yield* observedResult;
      return yield* source;
    },
    {
      ...createDefaultHooks(() => tapErrNullaryOp(op, observe)),
      inner: op,
      rebuild: (newInner) => tapErrNullaryOp(cast<Op<T, E, []>>(newInner), observe),
      rebuildForTimeout: (newInner) =>
        tapErrNullaryOp(cast<Op<T, E | TimeoutError, []>>(newInner), (error: E | TimeoutError) =>
          TimeoutError.is(error) ? undefined : observe(error),
        ),
    },
  );
}

export function mapErrNullaryOp<T, E, E2>(
  op: Op<T, E, []>,
  transform: (error: E) => E2,
): Op<T, E2, []> {
  return makeNullaryOp<T, E2 | UnhandledException>(
    function* () {
      const result: Result<T, E | UnhandledException> = yield* new SuspendInstruction(
        (signal: AbortSignal) => drive(op, signal),
      );

      if (result.isOk()) return result.value;

      if (UnhandledException.is(result.error)) return yield* result.error;

      const mapped: E2 = yield* new SuspendInstruction(() =>
        Promise.resolve(
          transform(
            // SAFETY: result error is a union of E and UnhandledException, so we need to cast it to E
            // to match the transform function type
            cast(result.error),
          ),
        ),
      );

      return yield* Result.err(mapped);
    },
    {
      ...createDefaultHooks(() => mapErrNullaryOp(op, transform)),
      inner: op,
      rebuild: (newInner) => mapErrNullaryOp(cast<Op<T, E, []>>(newInner), transform),
      rebuildForTimeout: (newInner) =>
        mapErrNullaryOp(cast<Op<T, E | TimeoutError, []>>(newInner), (error: E | TimeoutError) =>
          TimeoutError.is(error) ? error : transform(error),
        ),
    },
  );
}

export function recoverNullaryOp<T, E, R>(
  op: Op<T, E, []>,
  predicate: ((error: E) => boolean) | WithPredicateMethod<E>,
  handler: (error: E) => R,
): Op<T | InferOpOk<R>, E | InferOpErr<R>, []> {
  return makeNullaryOp<T | InferOpOk<R>, E | InferOpErr<R> | UnhandledException>(
    function* () {
      const result: Result<T, E | UnhandledException> = yield* new SuspendInstruction(
        (signal: AbortSignal) => drive(op, signal),
      );

      if (result.isOk()) return result.value;

      if (UnhandledException.is(result.error)) return yield* result;

      const error = result.error;

      if (!conditionalPredicate(predicate, error)) return yield* Result.err(error);

      const recovered: InferOpOk<R> = yield* new SuspendInstruction(() =>
        Promise.resolve(handler(error)),
      );
      const recoveredOp: Op<unknown, unknown, []> | undefined = yield* new SuspendInstruction(() =>
        Promise.resolve(coerceToNullaryOp(recovered)),
      );

      if (!recoveredOp) return recovered;

      const recoveredResult: Result<
        InferOpOk<R>,
        InferOpErr<R> | UnhandledException
      > = yield* new SuspendInstruction((signal: AbortSignal) => drive(recoveredOp, signal));

      if (recoveredResult.isErr()) return yield* recoveredResult;
      return recoveredResult.value;
    },
    {
      ...createDefaultHooks(() => recoverNullaryOp(op, predicate, handler)),
      inner: op,
      rebuild: (newInner) => recoverNullaryOp(cast<Op<T, E, []>>(newInner), predicate, handler),
      rebuildForTimeout: (newInner) =>
        recoverNullaryOp(
          cast<Op<T, E | TimeoutError, []>>(newInner),
          (error: E | TimeoutError) =>
            !TimeoutError.is(error) && conditionalPredicate(predicate, error),
          cast(handler),
        ),
    },
  );
}
