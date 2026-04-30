import { TimeoutError, UnhandledException } from "./errors.js";
import { err, ok, type Result, type Err, type ExtractErr } from "./result.js";
import type { RetryPolicy } from "./policies.js";
import type { Tagged } from "./tagged.js";

export interface Suspended {
  readonly _tag: "Suspended";
  readonly suspend: (signal: AbortSignal) => Promise<unknown>;
}

export interface RegisterCleanup {
  readonly _tag: "RegisterCleanup";
  readonly finalize: () => Promise<void>;
}

export type Instruction<E> = Err<unknown, E> | Suspended | RegisterCleanup;

export interface WithRetry<T, E, A extends readonly unknown[]> {
  withRetry(policy?: RetryPolicy): Op<T, E, A>;
}

export interface WithTimeout<T, E, A extends readonly unknown[]> {
  withTimeout(timeoutMs: number): Op<T, E | TimeoutError, A>;
}

export interface WithSignal<T, E, A extends readonly unknown[]> {
  withSignal(signal: AbortSignal): Op<T, E, A>;
}

export type ReleaseFn<T> = (value: T) => unknown;
export type ExitFn = () => unknown;

export interface WithRelease<T, E, A extends readonly unknown[]> {
  withRelease(release: ReleaseFn<T>): Op<T, E, A>;
}

export interface WithOnExit<T, E, A extends readonly unknown[]> {
  onExit(finalize: ExitFn): Op<T, E, A>;
}

export interface WithMap<T, E, A extends readonly unknown[]> {
  map<U>(transform: (value: T) => U): Op<Awaited<U>, E, A>;
}

export interface WithMapErr<T, E, A extends readonly unknown[]> {
  mapErr<E2>(transform: (error: E) => E2): Op<T, E2, A>;
}

export interface WithFlatMap<T, E, A extends readonly unknown[]> {
  flatMap<U, E2>(bind: (value: T) => Op<U, E2, readonly []>): Op<U, E | E2, A>;
}

type TapError<R> = R extends Op<unknown, infer E, readonly []> ? E : never;

export interface WithTap<T, E, A extends readonly unknown[]> {
  tap<R>(observe: (value: T) => R): Op<T, E | TapError<R>, A>;
}

export interface WithTapErr<T, E, A extends readonly unknown[]> {
  tapErr<R>(observe: (error: E) => R): Op<T, E | TapError<R>, A>;
}

type RecoverValue<R> = R extends Op<infer T, unknown, readonly []> ? T : Awaited<R>;
type RecoverError<R> = R extends Op<unknown, infer E, readonly []> ? E : never;

type WithPredicateMethod<E> = { is: (value: unknown) => value is E };

export interface WithRecover<T, E, A extends readonly unknown[]> {
  recover<ECaught extends E, R>(
    predicate: (error: E) => error is ECaught,
    handler: (error: ECaught) => R,
  ): Op<T | RecoverValue<R>, Exclude<E, ECaught> | RecoverError<R>, A>;
  recover<ECaught extends E, R>(
    predicate: WithPredicateMethod<ECaught>,
    handler: (error: ECaught) => R,
  ): Op<T | RecoverValue<R>, Exclude<E, ECaught> | RecoverError<R>, A>;
  recover<R>(
    predicate: (error: E) => boolean,
    handler: (error: E) => R,
  ): Op<T | RecoverValue<R>, E | RecoverError<R>, A>;
}

const hasPredicateMethod = <E>(value: unknown): value is WithPredicateMethod<E> => {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "is" in value &&
    typeof value.is === "function"
  );
};

export interface OpBase<T, E> {
  readonly _tag: "Op";
  [Symbol.iterator](): Generator<Instruction<E>, T, unknown>;
}

export interface OpNullary<T, E>
  extends
    OpBase<T, E>,
    WithRetry<T, E, []>,
    WithTimeout<T, E, []>,
    WithSignal<T, E, []>,
    WithRelease<T, E, []>,
    WithOnExit<T, E, []>,
    WithMap<T, E, []>,
    WithMapErr<T, E, []>,
    WithFlatMap<T, E, []>,
    WithTap<T, E, []>,
    WithTapErr<T, E, []>,
    WithRecover<T, E, []> {
  (): OpBase<T, E>;
  run(): Promise<Result<T, E | UnhandledException>>;
}

export interface OpArity<T, E, A extends readonly unknown[]>
  extends
    WithRetry<T, E, A>,
    WithTimeout<T, E, A>,
    WithSignal<T, E, A>,
    WithRelease<T, E, A>,
    WithOnExit<T, E, A>,
    WithMap<T, E, A>,
    WithMapErr<T, E, A>,
    WithFlatMap<T, E, A>,
    WithTap<T, E, A>,
    WithTapErr<T, E, A>,
    WithRecover<T, E, A> {
  (...args: A): OpNullary<T, E>;
  run(...args: A): Promise<Result<T, E | UnhandledException>>;
}

type _Op<T, E, A extends readonly unknown[]> = [] extends A ? OpNullary<T, E> : OpArity<T, E, A>;

export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A> & Tagged<"Op">;

export function runOp<T, E>(op: Op<T, E, readonly []>): Promise<Result<T, E | UnhandledException>> {
  return drive(op, new AbortController().signal);
}

function isSuspended(value: unknown): value is Suspended {
  return (
    typeof value === "object" && value !== null && "_tag" in value && value._tag === "Suspended"
  );
}

function isErrInstruction<E>(value: unknown): value is Err<unknown, E> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("isErr" in value) ||
    typeof value.isErr !== "function"
  ) {
    return false;
  }
  return value.isErr();
}

function isRegisterCleanup(value: unknown): value is RegisterCleanup {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "RegisterCleanup" &&
    "finalize" in value &&
    typeof value.finalize === "function"
  );
}

const closeGenerator = (iterator: Iterator<unknown, unknown, unknown>) => {
  try {
    // we intentionally ignore the return payload bc only generator finalization matters
    iterator.return?.(undefined);
  } catch {
    // ignore cleanup faults so the original result/error is preserved
  }
};

export async function drive<T, E>(
  op: Op<T, E, readonly []>,
  signal: AbortSignal,
): Promise<Result<T, E | UnhandledException>> {
  const finalizers: Array<() => Promise<void>> = [];
  const runFinalizers = async (): Promise<void> => {
    for (let index = finalizers.length - 1; index >= 0; index -= 1) {
      const finalize = finalizers[index];
      if (finalize !== undefined) {
        await finalize();
      }
    }
  };
  const runFinalizersSafely = async (): Promise<unknown | void> => {
    try {
      await runFinalizers();
      return undefined;
    } catch (cause) {
      return cause;
    }
  };

  try {
    const ef = typeof op === "function" ? op() : op;
    const iter = ef[Symbol.iterator]();
    let step = iter.next();
    while (!step.done) {
      try {
        if (isSuspended(step.value)) {
          step = iter.next(await step.value.suspend(signal));
          continue;
        }
        if (isRegisterCleanup(step.value)) {
          finalizers.push(step.value.finalize);
          step = iter.next(undefined);
          continue;
        }
        if (isErrInstruction<E>(step.value)) {
          closeGenerator(iter);
          await runFinalizersSafely();
          return err(step.value.error);
        }
        closeGenerator(iter);
        await runFinalizersSafely();
        return err(
          new UnhandledException({
            cause: new TypeError("Op generator yielded an invalid instruction"),
          }),
        );
      } catch (cause) {
        closeGenerator(iter);
        await runFinalizersSafely();
        return err(new UnhandledException({ cause }));
      }
    }
    const value = await step.value;
    const cleanupFault = await runFinalizersSafely();
    if (cleanupFault !== undefined) {
      return err(new UnhandledException({ cause: cleanupFault }));
    }
    return ok(value);
  } catch (cause) {
    await runFinalizersSafely();
    return err(new UnhandledException({ cause }));
  }
}

export interface FromGenFn {
  <Y extends Instruction<unknown>, T>(f: () => Generator<Y, T, unknown>): Op<T, ExtractErr<Y>, []>;
  <Y extends Instruction<unknown>, T, A extends readonly unknown[]>(
    f: (...args: A) => Generator<Y, T, unknown>,
  ): Op<T, ExtractErr<Y>, A>;
  (
    f: (...args: unknown[]) => Generator<Instruction<unknown>, unknown, unknown>,
  ): Op<unknown, unknown, []> | Op<unknown, unknown, readonly unknown[]>;
}

export interface OpHooks<T, E> {
  withRetry: (policy?: RetryPolicy) => Op<T, E, readonly []>;
  withTimeout: (timeoutMs: number) => Op<T, E | TimeoutError, readonly []>;
  withSignal: (signal: AbortSignal) => Op<T, E, readonly []>;
  withRelease: (release: ReleaseFn<T>) => Op<T, E, readonly []>;
  onExit: (finalize: ExitFn) => Op<T, E, readonly []>;
}

function isNullaryOp(value: unknown): value is Op<unknown, unknown, readonly []> {
  return typeof value === "function" && Symbol.iterator in value;
}

export const makeNullaryOp = <T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
  hooks: OpHooks<T, E>,
): Op<T, E, readonly []> => {
  let self!: Op<T, E, readonly []>;
  const state = {
    [Symbol.iterator]: gen,
    run: () => runOp(self),
    withRetry: hooks.withRetry,
    withTimeout: hooks.withTimeout,
    withSignal: hooks.withSignal,
    withRelease: hooks.withRelease,
    onExit: hooks.onExit,
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
  self = Object.assign(callable, state) as unknown as Op<T, E, readonly []>;
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
        finalize: () => Promise.resolve(release(result.value)).then(() => {}),
      };
      return result.value;
    },
    {
      withRetry: (policy?: RetryPolicy) => withCleanupNullaryOp(op.withRetry(policy), release),
      withTimeout: (timeoutMs: number) => withCleanupNullaryOp(op.withTimeout(timeoutMs), release),
      withSignal: (signal: AbortSignal) => withCleanupNullaryOp(op.withSignal(signal), release),
      withRelease: (nextRelease: ReleaseFn<T>) =>
        withCleanupNullaryOp(withCleanupNullaryOp(op, release), nextRelease),
      onExit: (finalize: ExitFn) => onExitNullaryOp(withCleanupNullaryOp(op, release), finalize),
    },
  ) as Op<T, E, readonly []>;
};

const onExitNullaryOp = <T, E>(
  op: Op<T, E, readonly []>,
  finalize: ExitFn,
): Op<T, E, readonly []> => {
  return makeNullaryOp<T, E | UnhandledException>(
    function* () {
      yield {
        _tag: "RegisterCleanup" as const,
        finalize: () => Promise.resolve(finalize()).then(() => undefined),
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
      withTimeout: (timeoutMs: number) => onExitNullaryOp(op.withTimeout(timeoutMs), finalize),
      withSignal: (signal: AbortSignal) => onExitNullaryOp(op.withSignal(signal), finalize),
      withRelease: (release: ReleaseFn<T>) =>
        withCleanupNullaryOp(onExitNullaryOp(op, finalize), release),
      onExit: (nextFinalize: ExitFn) =>
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
      onExit: (finalize: ExitFn) => onExitNullaryOp(mapNullaryOp(op, transform), finalize),
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
      onExit: (finalize: ExitFn) => onExitNullaryOp(flatMapNullaryOp(op, bind), finalize),
    },
  ) as Op<U, E | E2, readonly []>;
};

const tapNullaryOp = <T, E, R>(
  op: Op<T, E, readonly []>,
  observe: (value: T) => R,
): Op<T, E | TapError<R>, readonly []> => {
  return makeNullaryOp<T, E | TapError<R> | UnhandledException>(
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
      }) as Result<unknown, TapError<R> | UnhandledException>;
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
      onExit: (finalize: ExitFn) => onExitNullaryOp(tapNullaryOp(op, observe), finalize),
    },
  ) as Op<T, E | TapError<R>, readonly []>;
};

const tapErrNullaryOp = <T, E, R>(
  op: Op<T, E, readonly []>,
  observe: (error: E) => R,
): Op<T, E | TapError<R>, readonly []> => {
  return makeNullaryOp<T, E | TapError<R> | UnhandledException>(
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
      }) as Result<unknown, TapError<R> | UnhandledException>;
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
      onExit: (finalize: ExitFn) => onExitNullaryOp(tapErrNullaryOp(op, observe), finalize),
    },
  ) as Op<T, E | TapError<R>, readonly []>;
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
      onExit: (finalize: ExitFn) => onExitNullaryOp(mapErrNullaryOp(op, transform), finalize),
    },
  ) as Op<T, E2, readonly []>;
};

const conditionalPredicate = <E>(
  pred: ((error: E) => boolean) | WithPredicateMethod<E>,
  error: E,
) => {
  return hasPredicateMethod(pred) ? pred.is(error) : pred(error);
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
      onExit: (finalize: ExitFn) =>
        onExitNullaryOp(recoverNullaryOp(op, predicate, handler), finalize),
    },
  ) as Op<T | RecoverValue<R>, E | RecoverError<R>, readonly []>;
};

interface FluentArityHandlers<T, E, A extends readonly unknown[]> {
  withRetry: (policy?: RetryPolicy) => Op<T, E, A>;
  withTimeout: (timeoutMs: number) => Op<T, E | TimeoutError, A>;
  withSignal: (signal: AbortSignal) => Op<T, E, A>;
  withRelease: (release: ReleaseFn<T>) => Op<T, E, A>;
  onExit: (finalize: ExitFn) => Op<T, E, A>;
}

const liftArityOp = <TIn, EIn, A extends readonly unknown[], TOut, EOut>(
  op: Op<TIn, EIn, A>,
  mapNullary: (resolved: Op<TIn, EIn, readonly []>) => Op<TOut, EOut, readonly []>,
  makeHandlers: (
    source: OpArity<TIn, EIn, A>,
    getSelf: () => Op<TOut, EOut, A>,
  ) => FluentArityHandlers<TOut, EOut, A>,
): Op<TOut, EOut, A> => {
  if (Symbol.iterator in op) {
    return mapNullary(op) as unknown as Op<TOut, EOut, A>;
  }

  let out!: Op<TOut, EOut, A>;
  const source = op as OpArity<TIn, EIn, A>;
  const g = (...args: A) => mapNullary(source(...args));
  const handlers = makeHandlers(source, () => out);
  out = Object.assign(g, {
    run: (...args: A) => drive(g(...args), new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => handlers.withRetry(policy),
    withTimeout: (timeoutMs: number) => handlers.withTimeout(timeoutMs),
    withSignal: (signal: AbortSignal) => handlers.withSignal(signal),
    withRelease: (release: ReleaseFn<TOut>) => handlers.withRelease(release),
    onExit: (finalize: ExitFn) => handlers.onExit(finalize),
    map: <U>(transform: (value: TOut) => U) => mapOp(out, transform),
    mapErr: <E2>(transform: (error: EOut) => E2) => mapErrOp(out, transform),
    flatMap: <U, E2>(bind: (value: TOut) => Op<U, E2, readonly []>) => flatMapOp(out, bind),
    tap: <R>(observe: (value: TOut) => R) => tapOp(out, observe),
    tapErr: <R>(observe: (error: EOut) => R) => tapErrOp(out, observe),
    recover: <R>(predicate: (error: EOut) => boolean, handler: (error: EOut) => R) =>
      recoverOp(out, predicate, handler),
    _tag: "Op" as const,
  }) as unknown as Op<TOut, EOut, A>;
  return out;
};

export const withReleaseOp = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  release: ReleaseFn<T>,
): Op<T, E, A> => {
  return liftArityOp(
    op,
    (resolved) => withCleanupNullaryOp(resolved, release),
    (source, getSelf) => ({
      withRetry: (policy?: RetryPolicy) => withReleaseOp(source.withRetry(policy), release),
      withTimeout: (timeoutMs: number) => withReleaseOp(source.withTimeout(timeoutMs), release),
      withSignal: (signal: AbortSignal) => withReleaseOp(source.withSignal(signal), release),
      withRelease: (nextRelease: ReleaseFn<T>) => withReleaseOp(getSelf(), nextRelease),
      onExit: (finalize: ExitFn) => onExitOp(getSelf(), finalize),
    }),
  );
};

export const onExitOp = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  finalize: ExitFn,
): Op<T, E, A> => {
  return liftArityOp(
    op,
    (resolved) => onExitNullaryOp(resolved, finalize),
    (source, getSelf) => ({
      withRetry: (policy?: RetryPolicy) => onExitOp(source.withRetry(policy), finalize),
      withTimeout: (timeoutMs: number) => onExitOp(source.withTimeout(timeoutMs), finalize),
      withSignal: (signal: AbortSignal) => onExitOp(source.withSignal(signal), finalize),
      withRelease: (release: ReleaseFn<T>) => withReleaseOp(getSelf(), release),
      onExit: (nextFinalize: ExitFn) => onExitOp(getSelf(), nextFinalize),
    }),
  );
};

export const mapOp = <T, E, A extends readonly unknown[], U>(
  op: Op<T, E, A>,
  transform: (value: T) => U,
): Op<Awaited<U>, E, A> => {
  return liftArityOp(
    op,
    (resolved) => mapNullaryOp(resolved, transform),
    (source, getSelf) => ({
      withRetry: (policy?: RetryPolicy) => mapOp(source.withRetry(policy), transform),
      withTimeout: (timeoutMs: number) => mapOp(source.withTimeout(timeoutMs), transform),
      withSignal: (signal: AbortSignal) => mapOp(source.withSignal(signal), transform),
      withRelease: (release: ReleaseFn<Awaited<U>>) => withReleaseOp(getSelf(), release),
      onExit: (finalize: ExitFn) => onExitOp(getSelf(), finalize),
    }),
  );
};

export const mapErrOp = <T, E, A extends readonly unknown[], E2>(
  op: Op<T, E, A>,
  transform: (error: E) => E2,
): Op<T, E2, A> => {
  return liftArityOp(
    op,
    (resolved) => mapErrNullaryOp(resolved, transform),
    (source, getSelf) => ({
      withRetry: (policy?: RetryPolicy) => mapErrOp(source.withRetry(policy), transform),
      withTimeout: (timeoutMs: number) =>
        mapErrOp(source.withTimeout(timeoutMs), (error: E | TimeoutError) =>
          error instanceof TimeoutError ? error : transform(error),
        ),
      withSignal: (signal: AbortSignal) => mapErrOp(source.withSignal(signal), transform),
      withRelease: (release: ReleaseFn<T>) => withReleaseOp(getSelf(), release),
      onExit: (finalize: ExitFn) => onExitOp(getSelf(), finalize),
    }),
  );
};

export const flatMapOp = <T, E, A extends readonly unknown[], U, E2>(
  op: Op<T, E, A>,
  bind: (value: T) => Op<U, E2, readonly []>,
): Op<U, E | E2, A> => {
  return liftArityOp(
    op,
    (resolved) => flatMapNullaryOp(resolved, bind),
    (source, getSelf) => ({
      withRetry: (policy?: RetryPolicy) => flatMapOp(source.withRetry(policy), bind),
      withTimeout: (timeoutMs: number) => flatMapOp(source.withTimeout(timeoutMs), bind),
      withSignal: (signal: AbortSignal) => flatMapOp(source.withSignal(signal), bind),
      withRelease: (release: ReleaseFn<U>) => withReleaseOp(getSelf(), release),
      onExit: (finalize: ExitFn) => onExitOp(getSelf(), finalize),
    }),
  );
};

export const tapOp = <T, E, A extends readonly unknown[], R>(
  op: Op<T, E, A>,
  observe: (value: T) => R,
): Op<T, E | TapError<R>, A> => {
  return liftArityOp(
    op,
    (resolved) => tapNullaryOp(resolved, observe),
    (source, getSelf) => ({
      withRetry: (policy?: RetryPolicy) => tapOp(source.withRetry(policy), observe),
      withTimeout: (timeoutMs: number) => tapOp(source.withTimeout(timeoutMs), observe),
      withSignal: (signal: AbortSignal) => tapOp(source.withSignal(signal), observe),
      withRelease: (release: ReleaseFn<T>) => withReleaseOp(getSelf(), release),
      onExit: (finalize: ExitFn) => onExitOp(getSelf(), finalize),
    }),
  );
};

export const tapErrOp = <T, E, A extends readonly unknown[], R>(
  op: Op<T, E, A>,
  observe: (error: E) => R,
): Op<T, E | TapError<R>, A> => {
  return liftArityOp(
    op,
    (resolved) => tapErrNullaryOp(resolved, observe),
    (source, getSelf) => ({
      withRetry: (policy?: RetryPolicy) => tapErrOp(source.withRetry(policy), observe),
      withTimeout: (timeoutMs: number) =>
        tapErrOp(source.withTimeout(timeoutMs), (error: E | TimeoutError) => {
          if (!(error instanceof TimeoutError)) {
            return observe(error);
          }
        }),
      withSignal: (signal: AbortSignal) => tapErrOp(source.withSignal(signal), observe),
      withRelease: (release: ReleaseFn<T>) => withReleaseOp(getSelf(), release),
      onExit: (finalize: ExitFn) => onExitOp(getSelf(), finalize),
    }),
  );
};

export const recoverOp = <T, E, A extends readonly unknown[], R>(
  op: Op<T, E, A>,
  predicate: (error: E) => boolean,
  handler: (error: E) => R,
): Op<T | RecoverValue<R>, E | RecoverError<R>, A> => {
  return liftArityOp(
    op,
    (resolved) => recoverNullaryOp(resolved, predicate, handler),
    (source, getSelf) => ({
      withRetry: (policy?: RetryPolicy) => recoverOp(source.withRetry(policy), predicate, handler),
      withTimeout: (timeoutMs: number) =>
        recoverOp(
          source.withTimeout(timeoutMs),
          (error: E | TimeoutError) => !(error instanceof TimeoutError) && predicate(error),
          handler as (error: E | TimeoutError) => R,
        ),
      withSignal: (signal: AbortSignal) => recoverOp(source.withSignal(signal), predicate, handler),
      withRelease: (release: ReleaseFn<T | RecoverValue<R>>) => withReleaseOp(getSelf(), release),
      onExit: (finalize: ExitFn) => onExitOp(getSelf(), finalize),
    }),
  );
};
