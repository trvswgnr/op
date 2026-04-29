import { TimeoutError, UnhandledException, UnreachableError } from "./errors.js";
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

export type CleanupFn<T> = (value: T) => unknown;

export interface WithCleanup<T, E, A extends readonly unknown[]> {
  withCleanup(cleanup: CleanupFn<T>): Op<T, E, A>;
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
    WithCleanup<T, E, []>,
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
    WithCleanup<T, E, A>,
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
  const runFinalizersSafely = async (): Promise<unknown | undefined> => {
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
    const closeIterator = () => {
      try {
        iter.return?.(undefined as never);
      } catch {
        // Ignore cleanup faults so the original result/error is preserved.
      }
    };
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
          closeIterator();
          await runFinalizersSafely();
          return err(step.value.error);
        }
        closeIterator();
        await runFinalizersSafely();
        return err(
          new UnhandledException({
            cause: new TypeError("Op generator yielded an invalid instruction"),
          }),
        );
      } catch (cause) {
        closeIterator();
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
  withCleanup: (cleanup: CleanupFn<T>) => Op<T, E, readonly []>;
}

function isNullaryOp(value: unknown): value is Op<unknown, unknown, readonly []> {
  return typeof value === "function" && Symbol.iterator in value;
}

export const makeNullaryOp = <T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
  hooks: OpHooks<T, E>,
): Op<T, E, readonly []> => {
  const self = {
    [Symbol.iterator]: gen,
    run: () => runOp(self as never),
    withRetry: hooks.withRetry,
    withTimeout: hooks.withTimeout,
    withSignal: hooks.withSignal,
    withCleanup: hooks.withCleanup,
    map: <U>(transform: (value: T) => U) => mapOp(self as never, transform),
    mapErr: <E2>(transform: (error: E) => E2) => mapErrOp(self as never, transform),
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, readonly []>) => flatMapOp(self as never, bind),
    tap: <R>(observe: (value: T) => R) => tapOp(self as never, observe),
    tapErr: <R>(observe: (error: E) => R) => tapErrOp(self as never, observe),
    recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
      recoverOp(self as never, predicate, handler),
    _tag: "Op" as const,
  };
  const op = () => self;
  return Object.assign(op, self) as never;
};

const withCleanupNullaryOp = <T, E>(
  op: Op<T, E, readonly []>,
  cleanup: CleanupFn<T>,
): Op<T, E, readonly []> => {
  return makeNullaryOp<T, E | UnhandledException>(
    function* () {
      const result = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(op, signal),
      }) as Result<T, E | UnhandledException>;
      if (result.isErr()) {
        yield err(result.error);
        throw new UnreachableError();
      }
      yield {
        _tag: "RegisterCleanup" as const,
        finalize: () => Promise.resolve(cleanup(result.value)).then(() => undefined),
      };
      return result.value;
    },
    {
      withRetry: (policy?: RetryPolicy) =>
        withCleanupNullaryOp(op.withRetry(policy) as never, cleanup) as never,
      withTimeout: (timeoutMs: number) =>
        withCleanupNullaryOp(op.withTimeout(timeoutMs) as never, cleanup) as never,
      withSignal: (signal: AbortSignal) =>
        withCleanupNullaryOp(op.withSignal(signal) as never, cleanup) as never,
      withCleanup: (nextCleanup: CleanupFn<T>) =>
        withCleanupNullaryOp(withCleanupNullaryOp(op, cleanup) as never, nextCleanup) as never,
    },
  ) as never;
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
        yield err(result.error);
        throw new UnreachableError();
      }
      const mapped = (yield {
        _tag: "Suspended" as const,
        suspend: () => Promise.resolve(transform(result.value)),
      }) as Awaited<U>;
      return mapped;
    },
    {
      withRetry: (policy?: RetryPolicy) =>
        mapNullaryOp(op.withRetry(policy) as never, transform) as never,
      withTimeout: (timeoutMs: number) =>
        mapNullaryOp(op.withTimeout(timeoutMs) as never, transform) as never,
      withSignal: (signal: AbortSignal) =>
        mapNullaryOp(op.withSignal(signal) as never, transform) as never,
      withCleanup: (cleanup: CleanupFn<Awaited<U>>) =>
        withCleanupNullaryOp(mapNullaryOp(op, transform) as never, cleanup) as never,
    },
  ) as never;
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
        yield err(first.error);
        throw new UnreachableError();
      }

      const second = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(bind(first.value), signal),
      }) as Result<U, E2 | UnhandledException>;
      if (second.isErr()) {
        yield err(second.error);
        throw new UnreachableError();
      }
      return second.value;
    },
    {
      withRetry: (policy?: RetryPolicy) =>
        flatMapNullaryOp(op.withRetry(policy) as never, bind) as never,
      withTimeout: (timeoutMs: number) =>
        flatMapNullaryOp(op.withTimeout(timeoutMs) as never, bind) as never,
      withSignal: (signal: AbortSignal) =>
        flatMapNullaryOp(op.withSignal(signal) as never, bind) as never,
      withCleanup: (cleanup: CleanupFn<U>) =>
        withCleanupNullaryOp(flatMapNullaryOp(op, bind) as never, cleanup) as never,
    },
  ) as never;
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
        yield err(source.error);
        throw new UnreachableError();
      }

      const observed = (yield {
        _tag: "Suspended" as const,
        suspend: () => Promise.resolve(observe(source.value)),
      }) as R;

      if (!isNullaryOp(observed)) {
        return source.value;
      }

      const observedResult = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) =>
          drive(observed as Op<unknown, TapError<R>, readonly []>, signal),
      }) as Result<unknown, TapError<R> | UnhandledException>;
      if (observedResult.isErr()) {
        yield err(observedResult.error);
        throw new UnreachableError();
      }
      return source.value;
    },
    {
      withRetry: (policy?: RetryPolicy) =>
        tapNullaryOp(op.withRetry(policy) as never, observe) as never,
      withTimeout: (timeoutMs: number) =>
        tapNullaryOp(op.withTimeout(timeoutMs) as never, observe) as never,
      withSignal: (signal: AbortSignal) =>
        tapNullaryOp(op.withSignal(signal) as never, observe) as never,
      withCleanup: (cleanup: CleanupFn<T>) =>
        withCleanupNullaryOp(tapNullaryOp(op, observe) as never, cleanup) as never,
    },
  ) as never;
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
        yield err(source.error);
        throw new UnreachableError();
      }

      const observed = (yield {
        _tag: "Suspended" as const,
        suspend: () => Promise.resolve(observe(source.error as E)),
      }) as R;
      if (!isNullaryOp(observed)) {
        yield err(source.error);
        throw new UnreachableError();
      }

      const observedResult = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) =>
          drive(observed as Op<unknown, TapError<R>, readonly []>, signal),
      }) as Result<unknown, TapError<R> | UnhandledException>;
      if (observedResult.isErr()) {
        yield err(observedResult.error);
        throw new UnreachableError();
      }

      yield err(source.error);
      throw new UnreachableError();
    },
    {
      withRetry: (policy?: RetryPolicy) =>
        tapErrNullaryOp(op.withRetry(policy) as never, observe) as never,
      withTimeout: (timeoutMs: number) =>
        tapErrNullaryOp(op.withTimeout(timeoutMs) as never, (error: E | TimeoutError) => {
          if (!(error instanceof TimeoutError)) {
            return observe(error);
          }
        }) as never,
      withSignal: (signal: AbortSignal) =>
        tapErrNullaryOp(op.withSignal(signal) as never, observe) as never,
      withCleanup: (cleanup: CleanupFn<T>) =>
        withCleanupNullaryOp(tapErrNullaryOp(op, observe) as never, cleanup) as never,
    },
  ) as never;
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
          yield err(result.error);
          throw new UnreachableError();
        }

        const mapped = (yield {
          _tag: "Suspended" as const,
          suspend: () => Promise.resolve(transform(result.error as E)),
        }) as E2;
        yield err(mapped);
        throw new UnreachableError();
      }
      return result.value;
    },
    {
      withRetry: (policy?: RetryPolicy) =>
        mapErrNullaryOp(op.withRetry(policy) as never, transform) as never,
      withTimeout: (timeoutMs: number) =>
        mapErrNullaryOp(op.withTimeout(timeoutMs) as never, (error: E | TimeoutError) =>
          error instanceof TimeoutError ? error : transform(error),
        ) as never,
      withSignal: (signal: AbortSignal) =>
        mapErrNullaryOp(op.withSignal(signal) as never, transform) as never,
      withCleanup: (cleanup: CleanupFn<T>) =>
        withCleanupNullaryOp(mapErrNullaryOp(op, transform) as never, cleanup) as never,
    },
  ) as never;
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
        yield err(result.error);
        throw new UnreachableError();
      }

      const error = result.error as E;

      if (!conditionalPredicate(predicate, error)) {
        yield err(error);
        throw new UnreachableError();
      }

      const recovered = (yield {
        _tag: "Suspended" as const,
        suspend: () => Promise.resolve(handler(error)),
      }) as R;

      if (!isNullaryOp(recovered)) {
        return recovered as RecoverValue<R>;
      }

      const recoveredResult = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) =>
          drive(recovered as Op<RecoverValue<R>, RecoverError<R>, readonly []>, signal),
      }) as Result<RecoverValue<R>, RecoverError<R> | UnhandledException>;

      if (recoveredResult.isErr()) {
        yield err(recoveredResult.error);
        throw new UnreachableError();
      }

      return recoveredResult.value as RecoverValue<R>;
    },
    {
      withRetry: (policy?: RetryPolicy) =>
        recoverNullaryOp(op.withRetry(policy) as never, predicate, handler) as never,
      withTimeout: (timeoutMs: number) =>
        recoverNullaryOp(
          op.withTimeout(timeoutMs) as never,
          (error: E | TimeoutError) =>
            !(error instanceof TimeoutError) && conditionalPredicate(predicate, error),
          handler,
        ) as never,
      withSignal: (signal: AbortSignal) =>
        recoverNullaryOp(op.withSignal(signal) as never, predicate, handler) as never,
      withCleanup: (cleanup: CleanupFn<T | RecoverValue<R>>) =>
        withCleanupNullaryOp(recoverNullaryOp(op, predicate, handler) as never, cleanup) as never,
    },
  ) as never;
};

export const withCleanupOp = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  cleanup: CleanupFn<T>,
): Op<T, E, A> => {
  if (Symbol.iterator in op) {
    return withCleanupNullaryOp(op as Op<T, E, readonly []>, cleanup) as never;
  }

  const g = (...args: A) =>
    withCleanupNullaryOp((op as OpArity<T, E, A>)(...args) as never, cleanup);
  const out = Object.assign(g, {
    run: (...args: A) => drive(g(...args) as never, new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => withCleanupOp(op.withRetry(policy), cleanup),
    withTimeout: (timeoutMs: number) => withCleanupOp(op.withTimeout(timeoutMs), cleanup),
    withSignal: (signal: AbortSignal) => withCleanupOp(op.withSignal(signal), cleanup),
    withCleanup: (nextCleanup: CleanupFn<T>) => withCleanupOp(out as never, nextCleanup),
    map: <U>(transform: (value: T) => U) => mapOp(out as never, transform),
    mapErr: <E2>(transform: (error: E) => E2) => mapErrOp(out as never, transform),
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, readonly []>) => flatMapOp(out as never, bind),
    tap: <R>(observe: (value: T) => R) => tapOp(out as never, observe),
    tapErr: <R>(observe: (error: E) => R) => tapErrOp(out as never, observe),
    recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
      recoverOp(out as never, predicate, handler),
    _tag: "Op" as const,
  });
  return out as never;
};

export const mapOp = <T, E, A extends readonly unknown[], U>(
  op: Op<T, E, A>,
  transform: (value: T) => U,
): Op<Awaited<U>, E, A> => {
  if (Symbol.iterator in op) {
    return mapNullaryOp(op as Op<T, E, readonly []>, transform) as never;
  }

  const g = (...args: A) => mapNullaryOp((op as OpArity<T, E, A>)(...args) as never, transform);
  const out = Object.assign(g, {
    run: (...args: A) => drive(g(...args) as never, new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => mapOp(op.withRetry(policy), transform),
    withTimeout: (timeoutMs: number) => mapOp(op.withTimeout(timeoutMs), transform),
    withSignal: (signal: AbortSignal) => mapOp(op.withSignal(signal), transform),
    withCleanup: (cleanup: CleanupFn<Awaited<U>>) => withCleanupOp(out as never, cleanup),
    map: <U2>(next: (value: Awaited<U>) => U2) => mapOp(out as never, next),
    mapErr: <E2>(next: (error: E) => E2) => mapErrOp(out as never, next),
    flatMap: <U2, E2>(bind: (value: Awaited<U>) => Op<U2, E2, readonly []>) =>
      flatMapOp(out as never, bind),
    tap: <R>(observe: (value: Awaited<U>) => R) => tapOp(out as never, observe),
    tapErr: <R>(observe: (error: E) => R) => tapErrOp(out as never, observe),
    recover: <R>(predicate: (error: E) => boolean, handler: (error: E) => R) =>
      recoverOp(out as never, predicate, handler),
    _tag: "Op" as const,
  });
  return out as never;
};

export const mapErrOp = <T, E, A extends readonly unknown[], E2>(
  op: Op<T, E, A>,
  transform: (error: E) => E2,
): Op<T, E2, A> => {
  if (Symbol.iterator in op) {
    return mapErrNullaryOp(op as Op<T, E, readonly []>, transform) as never;
  }

  const g = (...args: A) => mapErrNullaryOp((op as OpArity<T, E, A>)(...args) as never, transform);
  const out = Object.assign(g, {
    run: (...args: A) => drive(g(...args) as never, new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => mapErrOp(op.withRetry(policy), transform),
    withTimeout: (timeoutMs: number) =>
      mapErrOp(op.withTimeout(timeoutMs), (error: E | TimeoutError) =>
        error instanceof TimeoutError ? error : transform(error),
      ),
    withSignal: (signal: AbortSignal) => mapErrOp(op.withSignal(signal), transform),
    withCleanup: (cleanup: CleanupFn<T>) => withCleanupOp(out as never, cleanup),
    map: <U>(next: (value: T) => U) => mapOp(out as never, next),
    mapErr: <E3>(next: (error: E2) => E3) => mapErrOp(out as never, next),
    flatMap: <U, E3>(bind: (value: T) => Op<U, E3, readonly []>) => flatMapOp(out as never, bind),
    tap: <R>(observe: (value: T) => R) => tapOp(out as never, observe),
    tapErr: <R>(observe: (error: E2) => R) => tapErrOp(out as never, observe),
    recover: <R>(predicate: (error: E2) => boolean, handler: (error: E2) => R) =>
      recoverOp(out as never, predicate, handler),
    _tag: "Op" as const,
  });
  return out as never;
};

export const flatMapOp = <T, E, A extends readonly unknown[], U, E2>(
  op: Op<T, E, A>,
  bind: (value: T) => Op<U, E2, readonly []>,
): Op<U, E | E2, A> => {
  if (Symbol.iterator in op) {
    return flatMapNullaryOp(op as Op<T, E, readonly []>, bind) as never;
  }

  const g = (...args: A) => flatMapNullaryOp((op as OpArity<T, E, A>)(...args) as never, bind);
  const out = Object.assign(g, {
    run: (...args: A) => drive(g(...args) as never, new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => flatMapOp(op.withRetry(policy), bind),
    withTimeout: (timeoutMs: number) => flatMapOp(op.withTimeout(timeoutMs), bind),
    withSignal: (signal: AbortSignal) => flatMapOp(op.withSignal(signal), bind),
    withCleanup: (cleanup: CleanupFn<U>) => withCleanupOp(out as never, cleanup),
    map: <U2>(transform: (value: U) => U2) => mapOp(out as never, transform),
    mapErr: <E3>(transform: (error: E | E2) => E3) => mapErrOp(out as never, transform),
    flatMap: <U2, E3>(nextBind: (value: U) => Op<U2, E3, readonly []>) =>
      flatMapOp(out as never, nextBind),
    tap: <R>(observe: (value: U) => R) => tapOp(out as never, observe),
    tapErr: <R>(observe: (error: E | E2) => R) => tapErrOp(out as never, observe),
    recover: <R>(predicate: (error: E | E2) => boolean, handler: (error: E | E2) => R) =>
      recoverOp(out as never, predicate, handler),
    _tag: "Op" as const,
  });
  return out as never;
};

export const tapOp = <T, E, A extends readonly unknown[], R>(
  op: Op<T, E, A>,
  observe: (value: T) => R,
): Op<T, E | TapError<R>, A> => {
  if (Symbol.iterator in op) {
    return tapNullaryOp(op as Op<T, E, readonly []>, observe) as never;
  }

  const g = (...args: A) => tapNullaryOp((op as OpArity<T, E, A>)(...args) as never, observe);
  const out = Object.assign(g, {
    run: (...args: A) => drive(g(...args) as never, new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => tapOp(op.withRetry(policy), observe),
    withTimeout: (timeoutMs: number) => tapOp(op.withTimeout(timeoutMs), observe),
    withSignal: (signal: AbortSignal) => tapOp(op.withSignal(signal), observe),
    withCleanup: (cleanup: CleanupFn<T>) => withCleanupOp(out as never, cleanup),
    map: <U>(next: (value: T) => U) => mapOp(out as never, next),
    mapErr: <E2>(next: (error: E | TapError<R>) => E2) => mapErrOp(out as never, next),
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, readonly []>) => flatMapOp(out as never, bind),
    tap: <R2>(nextObserve: (value: T) => R2) => tapOp(out as never, nextObserve),
    tapErr: <R2>(nextObserve: (error: E | TapError<R>) => R2) =>
      tapErrOp(out as never, nextObserve),
    recover: <R2>(
      predicate: (error: E | TapError<R>) => boolean,
      handler: (error: E | TapError<R>) => R2,
    ) => recoverOp(out as never, predicate, handler),
    _tag: "Op" as const,
  });
  return out as never;
};

export const tapErrOp = <T, E, A extends readonly unknown[], R>(
  op: Op<T, E, A>,
  observe: (error: E) => R,
): Op<T, E | TapError<R>, A> => {
  if (Symbol.iterator in op) {
    return tapErrNullaryOp(op as Op<T, E, readonly []>, observe) as never;
  }

  const g = (...args: A) => tapErrNullaryOp((op as OpArity<T, E, A>)(...args) as never, observe);
  const out = Object.assign(g, {
    run: (...args: A) => drive(g(...args) as never, new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => tapErrOp(op.withRetry(policy), observe),
    withTimeout: (timeoutMs: number) =>
      tapErrOp(op.withTimeout(timeoutMs), (error: E | TimeoutError) => {
        if (!(error instanceof TimeoutError)) {
          return observe(error);
        }
      }),
    withSignal: (signal: AbortSignal) => tapErrOp(op.withSignal(signal), observe),
    withCleanup: (cleanup: CleanupFn<T>) => withCleanupOp(out as never, cleanup),
    map: <U>(next: (value: T) => U) => mapOp(out as never, next),
    mapErr: <E2>(next: (error: E | TapError<R>) => E2) => mapErrOp(out as never, next),
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, readonly []>) => flatMapOp(out as never, bind),
    tap: <R2>(nextObserve: (value: T) => R2) => tapOp(out as never, nextObserve),
    tapErr: <R2>(nextObserve: (error: E | TapError<R>) => R2) =>
      tapErrOp(out as never, nextObserve),
    recover: <R2>(
      predicate: (error: E | TapError<R>) => boolean,
      handler: (error: E | TapError<R>) => R2,
    ) => recoverOp(out as never, predicate, handler),
    _tag: "Op" as const,
  });
  return out as never;
};

export const recoverOp = <T, E, A extends readonly unknown[], R>(
  op: Op<T, E, A>,
  predicate: (error: E) => boolean,
  handler: (error: E) => R,
): Op<T | RecoverValue<R>, E | RecoverError<R>, A> => {
  if (Symbol.iterator in op) {
    return recoverNullaryOp(op as Op<T, E, readonly []>, predicate, handler) as never;
  }

  const g = (...args: A) =>
    recoverNullaryOp((op as OpArity<T, E, A>)(...args) as never, predicate, handler);
  const out = Object.assign(g, {
    run: (...args: A) => drive(g(...args) as never, new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => recoverOp(op.withRetry(policy), predicate, handler),
    withTimeout: (timeoutMs: number) =>
      recoverOp(
        op.withTimeout(timeoutMs),
        (error: E | TimeoutError) => !(error instanceof TimeoutError) && predicate(error as E),
        handler as (error: E | TimeoutError) => R,
      ),
    withSignal: (signal: AbortSignal) => recoverOp(op.withSignal(signal), predicate, handler),
    withCleanup: (cleanup: CleanupFn<T | RecoverValue<R>>) => withCleanupOp(out as never, cleanup),
    map: <U>(next: (value: T | RecoverValue<R>) => U) => mapOp(out as never, next),
    mapErr: <E2>(next: (error: E | RecoverError<R>) => E2) => mapErrOp(out as never, next),
    flatMap: <U, E2>(bind: (value: T | RecoverValue<R>) => Op<U, E2, readonly []>) =>
      flatMapOp(out as never, bind),
    tap: <R2>(observe: (value: T | RecoverValue<R>) => R2) => tapOp(out as never, observe),
    tapErr: <R2>(observe: (error: E | RecoverError<R>) => R2) => tapErrOp(out as never, observe),
    recover: <R2>(
      nextPredicate: (error: E | RecoverError<R>) => boolean,
      nextHandler: (error: E | RecoverError<R>) => R2,
    ) => recoverOp(out as never, nextPredicate, nextHandler),
    _tag: "Op" as const,
  });
  return out as never;
};
