import { TimeoutError, UnhandledException } from "../errors.js";
import { err, type Result } from "../result.js";
import type { RetryPolicy } from "../policies.js";
import type {
  ExitContext,
  ExitFn,
  Instruction,
  Op,
  OpBase,
  OpHooks,
  OpLifecycleHook,
  ReleaseFn,
  WithPredicateMethod,
} from "./types.js";
import { drive } from "./runtime.js";
import { mapOp, mapErrOp, flatMapOp, tapOp, tapErrOp, recoverOp } from "./arity-ops.js";
import { runOp } from "./run-op.js";

type InferNullaryOpErr<R> = R extends Op<unknown, infer E, readonly []> ? E : never;
type RecoverValue<R> = R extends Op<infer T, unknown, readonly []> ? T : Awaited<R>;
type RecoverError<R> = R extends Op<unknown, infer E, readonly []> ? E : never;

function isNullaryOp(value: unknown): value is Op<unknown, unknown, readonly []> {
  return typeof value === "function" && Symbol.iterator in value;
}

const conditionalPredicate = <E>(
  pred: ((error: E) => boolean) | WithPredicateMethod<E>,
  error: E,
) => {
  return "is" in pred ? pred.is(error) : pred(error);
};

const dispatchLifecycleNullary = <T, E>(
  hooks: OpHooks<T, E>,
  event: OpLifecycleHook,
  finalize: ExitFn<T, E>,
): Op<T, E, readonly []> => {
  if (event !== "exit") {
    const _: never = event;
    return _;
  }
  return hooks.registerExitFinalize(finalize);
};

export const makeNullaryOp = <T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
  hooks: OpHooks<T, E>,
): Op<T, E, readonly []> => {
  let self: Op<T, E, readonly []>;
  const state = {
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
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, readonly []>) => flatMapOp(self, bind),
    tap: <R>(observe: (value: T) => R) => tapOp(self, observe),
    tapErr: <R>(observe: (error: E) => R) => tapErrOp(self, observe),
    recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
      recoverOp(self, predicate, handler),
    _tag: "Op" as const,
  };
  const callable = (() => state) as () => OpBase<T, E>;
  self = Object.assign(callable, state) as Op<T, E, readonly []>;
  return self;
};

const withCleanupNullaryOp = <T, E>(
  op: Op<T, E, readonly []>,
  release: ReleaseFn<T>,
): Op<T, E, readonly []> => {
  return makeNullaryOp<T, E | UnhandledException>(
    function* () {
      const result = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(op, signal),
      }) as Result<T, E | UnhandledException>;
      if (result.isErr()) {
        return yield* err(result.error);
      }
      yield {
        _tag: "RegisterCleanup" as const,
        finalize: (_ctx: ExitContext<unknown, unknown>) =>
          Promise.resolve(release(result.value)).then(() => {}),
      };
      return result.value;
    },
    {
      withRetry: (policy?: RetryPolicy) => withCleanupNullaryOp(op.withRetry(policy), release),
      withTimeout: (timeoutMs: number) => withCleanupNullaryOp(op.withTimeout(timeoutMs), release),
      withSignal: (signal: AbortSignal) => withCleanupNullaryOp(op.withSignal(signal), release),
      withRelease: (nextRelease: ReleaseFn<T>) =>
        withCleanupNullaryOp(withCleanupNullaryOp(op, release), nextRelease),
      registerExitFinalize: (finalize: ExitFn<T, E>) =>
        onExitNullaryOp(withCleanupNullaryOp(op, release), finalize),
    },
  ) as Op<T, E, readonly []>;
};

const onExitNullaryOp = <T, E>(
  op: Op<T, E, readonly []>,
  finalize: ExitFn<T, E>,
): Op<T, E, readonly []> => {
  return makeNullaryOp<T, E | UnhandledException>(
    function* () {
      yield {
        _tag: "RegisterCleanup" as const,
        finalize: (ctx: ExitContext<unknown, unknown>) =>
          Promise.resolve(finalize(ctx as ExitContext<T, E>)).then(() => undefined),
      };
      const result = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(op, signal),
      }) as Result<T, E | UnhandledException>;
      if (result.isErr()) {
        return yield* err(result.error);
      }
      return result.value;
    },
    {
      withRetry: (policy?: RetryPolicy) => onExitNullaryOp(op.withRetry(policy), finalize),
      withTimeout: (timeoutMs: number) =>
        onExitNullaryOp(op.withTimeout(timeoutMs), finalize as ExitFn<T, E | TimeoutError>),
      withSignal: (signal: AbortSignal) => onExitNullaryOp(op.withSignal(signal), finalize),
      withRelease: (release: ReleaseFn<T>) =>
        withCleanupNullaryOp(onExitNullaryOp(op, finalize), release),
      registerExitFinalize: (nextFinalize: ExitFn<T, E>) =>
        onExitNullaryOp(onExitNullaryOp(op, finalize), nextFinalize),
    },
  ) as Op<T, E, readonly []>;
};

const mapNullaryOp = <T, E, U>(
  op: Op<T, E, readonly []>,
  transform: (value: T) => U,
): Op<Awaited<U>, E, readonly []> => {
  return makeNullaryOp<Awaited<U>, E | UnhandledException>(
    function* () {
      const result = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(op, signal),
      }) as Result<T, E | UnhandledException>;
      if (result.isErr()) {
        return yield* err(result.error);
      }
      const mapped = (yield {
        _tag: "Suspended" as const,
        suspend: () => Promise.resolve(transform(result.value)),
      }) as Awaited<U>;
      return mapped;
    },
    {
      withRetry: (policy?: RetryPolicy) => mapNullaryOp(op.withRetry(policy), transform),
      withTimeout: (timeoutMs: number) => mapNullaryOp(op.withTimeout(timeoutMs), transform),
      withSignal: (signal: AbortSignal) => mapNullaryOp(op.withSignal(signal), transform),
      withRelease: (release: ReleaseFn<Awaited<U>>) =>
        withCleanupNullaryOp(mapNullaryOp(op, transform), release),
      registerExitFinalize: (finalize: ExitFn<Awaited<U>, E>) =>
        onExitNullaryOp(mapNullaryOp(op, transform), finalize),
    },
  ) as Op<Awaited<U>, E, readonly []>;
};

const flatMapNullaryOp = <T, E, U, E2>(
  op: Op<T, E, readonly []>,
  bind: (value: T) => Op<U, E2, readonly []>,
): Op<U, E | E2, readonly []> => {
  return makeNullaryOp<U, E | E2 | UnhandledException>(
    function* () {
      const first = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(op, signal),
      }) as Result<T, E | UnhandledException>;
      if (first.isErr()) {
        return yield* err(first.error);
      }

      const second = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(bind(first.value), signal),
      }) as Result<U, E2 | UnhandledException>;
      if (second.isErr()) {
        return yield* err(second.error);
      }
      return second.value;
    },
    {
      withRetry: (policy?: RetryPolicy) => flatMapNullaryOp(op.withRetry(policy), bind),
      withTimeout: (timeoutMs: number) => flatMapNullaryOp(op.withTimeout(timeoutMs), bind),
      withSignal: (signal: AbortSignal) => flatMapNullaryOp(op.withSignal(signal), bind),
      withRelease: (release: ReleaseFn<U>) =>
        withCleanupNullaryOp(flatMapNullaryOp(op, bind), release),
      registerExitFinalize: (finalize: ExitFn<U, E | E2>) =>
        onExitNullaryOp(flatMapNullaryOp(op, bind), finalize),
    },
  ) as Op<U, E | E2, readonly []>;
};

const tapNullaryOp = <T, E, R>(
  op: Op<T, E, readonly []>,
  observe: (value: T) => R,
): Op<T, E | InferNullaryOpErr<R>, readonly []> => {
  return makeNullaryOp<T, E | InferNullaryOpErr<R> | UnhandledException>(
    function* () {
      const source = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(op, signal),
      }) as Result<T, E | UnhandledException>;
      if (source.isErr()) {
        return yield* err(source.error);
      }

      const observed = yield {
        _tag: "Suspended" as const,
        suspend: () => Promise.resolve(observe(source.value)),
      };

      if (!isNullaryOp(observed)) {
        return source.value;
      }

      const observedResult = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(observed, signal),
      }) as Result<unknown, InferNullaryOpErr<R> | UnhandledException>;
      if (observedResult.isErr()) {
        return yield* err(observedResult.error);
      }
      return source.value;
    },
    {
      withRetry: (policy?: RetryPolicy) => tapNullaryOp(op.withRetry(policy), observe),
      withTimeout: (timeoutMs: number) => tapNullaryOp(op.withTimeout(timeoutMs), observe),
      withSignal: (signal: AbortSignal) => tapNullaryOp(op.withSignal(signal), observe),
      withRelease: (release: ReleaseFn<T>) =>
        withCleanupNullaryOp(tapNullaryOp(op, observe), release),
      registerExitFinalize: (finalize: ExitFn<T, E | InferNullaryOpErr<R>>) =>
        onExitNullaryOp(tapNullaryOp(op, observe), finalize),
    },
  ) as Op<T, E | InferNullaryOpErr<R>, readonly []>;
};

const tapErrNullaryOp = <T, E, R>(
  op: Op<T, E, readonly []>,
  observe: (error: E) => R,
): Op<T, E | InferNullaryOpErr<R>, readonly []> => {
  return makeNullaryOp<T, E | InferNullaryOpErr<R> | UnhandledException>(
    function* () {
      const source = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(op, signal),
      }) as Result<T, E | UnhandledException>;
      if (source.isOk()) {
        return source.value;
      }

      if (source.error instanceof UnhandledException) {
        return yield* err(source.error);
      }

      const observed = yield {
        _tag: "Suspended" as const,
        suspend: () => Promise.resolve(observe(source.error as E)),
      };
      if (!isNullaryOp(observed)) {
        return yield* err(source.error);
      }

      const observedResult = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(observed, signal),
      }) as Result<unknown, InferNullaryOpErr<R> | UnhandledException>;
      if (observedResult.isErr()) {
        return yield* err(observedResult.error);
      }

      return yield* err(source.error);
    },
    {
      withRetry: (policy?: RetryPolicy) => tapErrNullaryOp(op.withRetry(policy), observe),
      withTimeout: (timeoutMs: number) =>
        tapErrNullaryOp(op.withTimeout(timeoutMs), (error: E | TimeoutError) => {
          if (!(error instanceof TimeoutError)) {
            return observe(error);
          }
        }),
      withSignal: (signal: AbortSignal) => tapErrNullaryOp(op.withSignal(signal), observe),
      withRelease: (release: ReleaseFn<T>) =>
        withCleanupNullaryOp(tapErrNullaryOp(op, observe), release),
      registerExitFinalize: (finalize: ExitFn<T, E | InferNullaryOpErr<R>>) =>
        onExitNullaryOp(tapErrNullaryOp(op, observe), finalize),
    },
  ) as Op<T, E | InferNullaryOpErr<R>, readonly []>;
};

const mapErrNullaryOp = <T, E, E2>(
  op: Op<T, E, readonly []>,
  transform: (error: E) => E2,
): Op<T, E2, readonly []> => {
  return makeNullaryOp<T, E2 | UnhandledException>(
    function* () {
      const result = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(op, signal),
      }) as Result<T, E | UnhandledException>;
      if (result.isErr()) {
        if (result.error instanceof UnhandledException) {
          return yield* err(result.error);
        }

        const mapped = (yield {
          _tag: "Suspended" as const,
          suspend: () => Promise.resolve(transform(result.error as E)),
        }) as E2;
        return yield* err(mapped);
      }
      return result.value;
    },
    {
      withRetry: (policy?: RetryPolicy) => mapErrNullaryOp(op.withRetry(policy), transform),
      withTimeout: (timeoutMs: number) =>
        mapErrNullaryOp(op.withTimeout(timeoutMs), (error: E | TimeoutError) =>
          error instanceof TimeoutError ? error : transform(error),
        ),
      withSignal: (signal: AbortSignal) => mapErrNullaryOp(op.withSignal(signal), transform),
      withRelease: (release: ReleaseFn<T>) =>
        withCleanupNullaryOp(mapErrNullaryOp(op, transform), release),
      registerExitFinalize: (finalize: ExitFn<T, E2>) =>
        onExitNullaryOp(mapErrNullaryOp(op, transform), finalize),
    },
  ) as Op<T, E2, readonly []>;
};

const recoverNullaryOp = <T, E, R>(
  op: Op<T, E, readonly []>,
  predicate: ((error: E) => boolean) | WithPredicateMethod<E>,
  handler: (error: E) => R,
): Op<T | RecoverValue<R>, E | RecoverError<R>, readonly []> => {
  return makeNullaryOp<T | RecoverValue<R>, E | RecoverError<R> | UnhandledException>(
    function* () {
      const result = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(op, signal),
      }) as Result<T, E | UnhandledException>;

      if (result.isOk()) {
        return result.value;
      }

      if (result.error instanceof UnhandledException) {
        return yield* err(result.error);
      }

      const error = result.error;

      if (!conditionalPredicate(predicate, error)) {
        return yield* err(error);
      }

      const recovered = yield {
        _tag: "Suspended" as const,
        suspend: () => Promise.resolve(handler(error)),
      };

      if (!isNullaryOp(recovered)) {
        return recovered as RecoverValue<R>;
      }

      const recoveredResult = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(recovered, signal),
      }) as Result<RecoverValue<R>, RecoverError<R> | UnhandledException>;

      if (recoveredResult.isErr()) {
        return yield* err(recoveredResult.error);
      }

      return recoveredResult.value;
    },
    {
      withRetry: (policy?: RetryPolicy) =>
        recoverNullaryOp(op.withRetry(policy), predicate, handler),
      withTimeout: (timeoutMs: number) =>
        recoverNullaryOp(
          op.withTimeout(timeoutMs),
          (error: E | TimeoutError) =>
            !(error instanceof TimeoutError) && conditionalPredicate(predicate, error),
          handler as (error: E | TimeoutError) => R,
        ),
      withSignal: (signal: AbortSignal) =>
        recoverNullaryOp(op.withSignal(signal), predicate, handler),
      withRelease: (release: ReleaseFn<T | RecoverValue<R>>) =>
        withCleanupNullaryOp(recoverNullaryOp(op, predicate, handler), release),
      registerExitFinalize: (finalize: ExitFn<T | RecoverValue<R>, E | RecoverError<R>>) =>
        onExitNullaryOp(recoverNullaryOp(op, predicate, handler), finalize),
    },
  ) as Op<T | RecoverValue<R>, E | RecoverError<R>, readonly []>;
};

export {
  flatMapNullaryOp,
  mapErrNullaryOp,
  mapNullaryOp,
  onExitNullaryOp,
  recoverNullaryOp,
  tapErrNullaryOp,
  tapNullaryOp,
  withCleanupNullaryOp,
};
