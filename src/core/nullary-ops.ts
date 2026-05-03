import { TimeoutError, UnhandledException } from "../errors.js";
import { Result } from "../result.js";
import { withRetryOp, withSignalOp, withTimeoutOp } from "../policies.js";
import type {
  ExitContext,
  ExitFn,
  Instruction,
  Op,
  OpHooks,
  OpLifecycleHook,
  ReleaseFn,
  WithPredicateMethod,
} from "./types.js";
import { RegisterExitFinalizerInstruction, SuspendInstruction } from "./instructions.js";
import { drive } from "./runtime.js";
import { mapOp, mapErrOp, flatMapOp, tapOp, tapErrOp, recoverOp } from "./arity-ops.js";
import { runOp } from "./run-op.js";

type InferNullaryOpErr<R> = R extends Op<unknown, infer E, []> ? E : never;
type RecoverValue<R> = R extends Op<infer T, unknown, []> ? T : Awaited<R>;
type RecoverError<R> = R extends Op<unknown, infer E, []> ? E : never;

export const NULLARY_OP_SYMBOL = Symbol("NullaryOp");

export function isNullaryOp(value: unknown): value is Op<unknown, unknown, []> {
  return (
    typeof value === "function" &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === "function" &&
    NULLARY_OP_SYMBOL in value
  );
}

function conditionalPredicate<E>(pred: ((error: E) => boolean) | WithPredicateMethod<E>, error: E) {
  return "is" in pred ? pred.is(error) : pred(error);
}

function dispatchLifecycleNullary<T, E>(
  hooks: OpHooks<T, E>,
  event: OpLifecycleHook,
  finalize: ExitFn<T, E>,
): Op<T, E, []> {
  if (event !== "exit") {
    const _: never = event;
    return _;
  }

  return hooks.registerExitFinalize(finalize);
}

export function makeNullaryOp<T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
  hooks: OpHooks<T, E>,
): Op<T, Exclude<E, UnhandledException>, []> {
  let self: Op<T, Exclude<E, UnhandledException>, []>;
  const state = {
    [NULLARY_OP_SYMBOL]: true,
    [Symbol.iterator]: gen,
    run: () => runOp(self),
    withRetry: hooks.withRetry,
    withTimeout: hooks.withTimeout,
    withSignal: hooks.withSignal,
    withRelease: hooks.withRelease,
    on: (event: OpLifecycleHook, finalize: ExitFn<T, E>) =>
      dispatchLifecycleNullary(hooks, event, finalize),
    map: <U>(transform: (value: T) => U) => mapOp(self, transform),
    mapErr: <E2>(transform: (error: E) => E2) => mapErrOp(self, transform),
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, []>) => flatMapOp(self, bind),
    tap: <R>(observe: (value: T) => R) => tapOp(self, observe),
    tapErr: <R>(observe: (error: E) => R) => tapErrOp(self, observe),
    recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
      recoverOp(self, predicate, handler),
    _tag: "Op" as const,
  };
  const callable = () => state;
  self = Object.assign(callable, state) as Op<T, Exclude<E, UnhandledException>, []>;

  return self;
}

export function withCleanupNullaryOp<T, E>(op: Op<T, E, []>, release: ReleaseFn<T>): Op<T, E, []> {
  return makeNullaryOp(
    function* () {
      const result = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(op, signal),
      )) as Result<T, E | UnhandledException>;

      if (result.isErr()) return yield* result;

      yield new RegisterExitFinalizerInstruction(() =>
        Promise.resolve(release(result.value)).then(() => {}),
      );

      return result.value;
    },
    {
      withRetry: (policy) => withCleanupNullaryOp(op.withRetry(policy), release),
      withTimeout: (timeoutMs) => withCleanupNullaryOp(op.withTimeout(timeoutMs), release),
      withSignal: (signal) => withCleanupNullaryOp(op.withSignal(signal), release),
      withRelease: (nextRelease) =>
        withCleanupNullaryOp(withCleanupNullaryOp(op, release), nextRelease),
      registerExitFinalize: (finalize) =>
        onExitNullaryOp(withCleanupNullaryOp(op, release), finalize),
    },
  );
}

export function onExitNullaryOp<T, E>(op: Op<T, E, []>, finalize: ExitFn<T, E>): Op<T, E, []> {
  return makeNullaryOp(
    function* () {
      yield new RegisterExitFinalizerInstruction((ctx) =>
        Promise.resolve(finalize(ctx as ExitContext<T, E>)).then(() => {}),
      );

      const result = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(op, signal),
      )) as Result<T, E | UnhandledException>;

      if (result.isErr()) return yield* Result.err(result.error);
      return result.value;
    },
    {
      withRetry: (policy) => onExitNullaryOp(op.withRetry(policy), finalize),
      withTimeout: (timeoutMs) =>
        onExitNullaryOp(op.withTimeout(timeoutMs), finalize as ExitFn<T, E | TimeoutError>),
      withSignal: (signal) => onExitNullaryOp(op.withSignal(signal), finalize),
      withRelease: (release) => withCleanupNullaryOp(onExitNullaryOp(op, finalize), release),
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
      const result = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(op, signal),
      )) as Result<T, E | UnhandledException>;

      if (result.isErr()) return yield* result;

      const mapped = (yield new SuspendInstruction(() =>
        Promise.resolve(transform(result.value)),
      )) as Awaited<U>;

      return mapped;
    },
    {
      withRetry: (policy) => mapNullaryOp(op.withRetry(policy), transform),
      withTimeout: (timeoutMs) => mapNullaryOp(op.withTimeout(timeoutMs), transform),
      withSignal: (signal) => mapNullaryOp(op.withSignal(signal), transform),
      withRelease: (release) => withCleanupNullaryOp(mapNullaryOp(op, transform), release),
      registerExitFinalize: (finalize) => onExitNullaryOp(mapNullaryOp(op, transform), finalize),
    },
  );
}

export function flatMapNullaryOp<T, E, U, E2>(
  op: Op<T, E, []>,
  bind: (value: T) => Op<U, E2, []>,
): Op<U, E | E2, []> {
  const mapped: Op<U, E | E2, []> = makeNullaryOp<U, E | E2 | UnhandledException>(
    function* () {
      const first = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(op, signal),
      )) as Result<T, E | UnhandledException>;

      if (first.isErr()) return yield* first;

      const second = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(bind(first.value), signal),
      )) as Result<U, E2 | UnhandledException>;

      if (second.isErr()) return yield* second;
      return second.value;
    },
    {
      withRetry: (policy) => withRetryOp(mapped, policy),
      withTimeout: (timeoutMs) => withTimeoutOp(mapped, timeoutMs),
      withSignal: (signal) => withSignalOp(mapped, signal),
      withRelease: (release) => withCleanupNullaryOp(mapped, release),
      registerExitFinalize: (finalize) => onExitNullaryOp(mapped, finalize),
    },
  );

  return mapped;
}

export function tapNullaryOp<T, E, R>(
  op: Op<T, E, []>,
  observe: (value: T) => R,
): Op<T, E | InferNullaryOpErr<R>, []> {
  return makeNullaryOp<T, E | InferNullaryOpErr<R> | UnhandledException>(
    function* () {
      const source = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(op, signal),
      )) as Result<T, E | UnhandledException>;

      if (source.isErr()) return yield* source;

      const observed = yield new SuspendInstruction(() => Promise.resolve(observe(source.value)));

      if (!isNullaryOp(observed)) return source.value;

      const observedResult = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(observed, signal),
      )) as Result<unknown, InferNullaryOpErr<R> | UnhandledException>;

      if (observedResult.isErr()) return yield* observedResult;
      return source.value;
    },
    {
      withRetry: (policy) => tapNullaryOp(op.withRetry(policy), observe),
      withTimeout: (timeoutMs) => tapNullaryOp(op.withTimeout(timeoutMs), observe),
      withSignal: (signal) => tapNullaryOp(op.withSignal(signal), observe),
      withRelease: (release) => withCleanupNullaryOp(tapNullaryOp(op, observe), release),
      registerExitFinalize: (finalize) => onExitNullaryOp(tapNullaryOp(op, observe), finalize),
    },
  );
}

export function tapErrNullaryOp<T, E, R>(
  op: Op<T, E, []>,
  observe: (error: E) => R,
): Op<T, E | InferNullaryOpErr<R>, []> {
  return makeNullaryOp<T, E | InferNullaryOpErr<R> | UnhandledException>(
    function* () {
      const source = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(op, signal),
      )) as Result<T, E | UnhandledException>;

      if (source.isOk()) return source.value;
      const sourceError = source.error;

      if (UnhandledException.is(sourceError)) return yield* sourceError;

      const observed = yield new SuspendInstruction(() => Promise.resolve(observe(sourceError)));

      if (!isNullaryOp(observed)) return yield* source;

      const observedResult = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(observed, signal),
      )) as Result<T, InferNullaryOpErr<R> | UnhandledException>;

      if (observedResult.isErr()) return yield* observedResult;
      return yield* source;
    },
    {
      withRetry: (policy) => tapErrNullaryOp(op.withRetry(policy), observe),
      withTimeout: (timeoutMs) =>
        tapErrNullaryOp(op.withTimeout(timeoutMs), (error) =>
          TimeoutError.is(error) ? undefined : observe(error),
        ),
      withSignal: (signal: AbortSignal) => tapErrNullaryOp(op.withSignal(signal), observe),
      withRelease: (release: ReleaseFn<T>) =>
        withCleanupNullaryOp(tapErrNullaryOp(op, observe), release),
      registerExitFinalize: (finalize: ExitFn<T, E | InferNullaryOpErr<R>>) =>
        onExitNullaryOp(tapErrNullaryOp(op, observe), finalize),
    },
  ) as Op<T, E | InferNullaryOpErr<R>, []>;
}

export function mapErrNullaryOp<T, E, E2>(
  op: Op<T, E, []>,
  transform: (error: E) => E2,
): Op<T, E2, []> {
  return makeNullaryOp<T, E2 | UnhandledException>(
    function* () {
      const result = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(op, signal),
      )) as Result<T, E | UnhandledException>;

      if (result.isOk()) return result.value;

      if (UnhandledException.is(result.error)) return yield* result.error;

      const mapped = (yield new SuspendInstruction(() =>
        Promise.resolve(transform(result.error as E)),
      )) as E2;

      return yield* Result.err(mapped);
    },
    {
      withRetry: (policy) => mapErrNullaryOp(op.withRetry(policy), transform),
      withTimeout: (timeoutMs) =>
        mapErrNullaryOp(op.withTimeout(timeoutMs), (error) =>
          TimeoutError.is(error) ? error : transform(error),
        ),
      withSignal: (signal) => mapErrNullaryOp(op.withSignal(signal), transform),
      withRelease: (release) => withCleanupNullaryOp(mapErrNullaryOp(op, transform), release),
      registerExitFinalize: (finalize) => onExitNullaryOp(mapErrNullaryOp(op, transform), finalize),
    },
  );
}

export function recoverNullaryOp<T, E, R>(
  op: Op<T, E, []>,
  predicate: ((error: E) => boolean) | WithPredicateMethod<E>,
  handler: (error: E) => R,
): Op<T | RecoverValue<R>, E | RecoverError<R>, []> {
  return makeNullaryOp<T | RecoverValue<R>, E | RecoverError<R> | UnhandledException>(
    function* () {
      const result = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(op, signal),
      )) as Result<T, E | UnhandledException>;

      if (result.isOk()) return result.value;

      if (UnhandledException.is(result.error)) return yield* result;

      const error = result.error;

      if (!conditionalPredicate(predicate, error)) return yield* Result.err(error);

      const recovered = (yield new SuspendInstruction(() =>
        Promise.resolve(handler(error)),
      )) as RecoverValue<R>;

      if (!isNullaryOp(recovered)) return recovered;

      const recoveredResult = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(recovered, signal),
      )) as Result<RecoverValue<R>, RecoverError<R> | UnhandledException>;

      if (recoveredResult.isErr()) return yield* recoveredResult;
      return recoveredResult.value;
    },
    {
      withRetry: (policy) => recoverNullaryOp(op.withRetry(policy), predicate, handler),
      withTimeout: (timeoutMs) =>
        recoverNullaryOp(
          op.withTimeout(timeoutMs),
          (error) => !TimeoutError.is(error) && conditionalPredicate(predicate, error),
          handler as (error: E | TimeoutError) => R,
        ),
      withSignal: (signal) => recoverNullaryOp(op.withSignal(signal), predicate, handler),
      withRelease: (release) =>
        withCleanupNullaryOp(recoverNullaryOp(op, predicate, handler), release),
      registerExitFinalize: (finalize) =>
        onExitNullaryOp(recoverNullaryOp(op, predicate, handler), finalize),
    },
  );
}
