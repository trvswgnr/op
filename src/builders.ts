import { UnhandledException } from "./errors.js";
import { makeFluentArityOp, onExitOp, onOp, withReleaseOp } from "./core/arity-ops.js";
import { TrackedErr, type AnyExitFn, type Instruction, type Op } from "./core/types.js";
import { RegisterExitFinalizerInstruction, SuspendInstruction } from "./core/instructions.js";
import { withRetryOp, withTimeoutOp, withSignalOp } from "./policies.js";
import { Result, type InferErr } from "./result.js";
import { makeNullaryOp } from "./core/nullary-ops.js";

function isAwaited<T>(value: T | Promise<T>): value is Awaited<T> {
  return !(value instanceof Promise);
}

/**
 * Lifts a value into an operation that always completes successfully
 */
export function succeed<T>(value: T | Promise<T>): Op<Awaited<T>, never, []> {
  if (!isAwaited(value)) {
    return _try(() => value);
  }

  const op: Op<Awaited<T>, never, []> = makeNullaryOp(
    function* () {
      return value;
    },
    {
      withRetry: (policy) => withRetryOp(op, policy),
      withTimeout: (timeoutMs) => withTimeoutOp(op, timeoutMs),
      withSignal: (signal) => withSignalOp(op, signal),
      withRelease: (release) => withReleaseOp(op, release),
      registerExitFinalize: (finalize) => onExitOp(op, finalize),
    },
  );

  return op;
}

/**
 * Lifts a value into an operation that always fails
 */
export function fail<E>(value: E): Op<never, E, []> {
  const op: Op<never, E, []> = makeNullaryOp(
    function* () {
      return yield* Result.err(value);
    },
    {
      withRetry: (policy) => withRetryOp(op, policy),
      withTimeout: (timeoutMs) => withTimeoutOp(op, timeoutMs),
      withSignal: (signal) => withSignalOp(op, signal),
      withRelease: (release) => withReleaseOp(op, release),
      registerExitFinalize: (finalize) => onExitOp(op, finalize),
    },
  );

  return op;
}

/**
 * Registers deferred cleanup for the current op run. Use as `yield* Op.defer((ctx) => ...)`
 * If several callbacks throw during the same unwind, `run` fails with {@link UnhandledException}
 * whose `cause` is a nested {@link Error} chain (`.cause`), **first LIFO failure outermost**
 */
export function defer(finalize: AnyExitFn): Op<void, never, []> {
  const op: Op<void, never, []> = makeNullaryOp(
    function* () {
      yield new RegisterExitFinalizerInstruction((ctx) =>
        Promise.resolve(finalize(ctx)).then(() => {}),
      );
    },
    {
      withRetry: (policy) => withRetryOp(op, policy),
      withTimeout: (timeoutMs) => withTimeoutOp(op, timeoutMs),
      withSignal: (signal) => withSignalOp(op, signal),
      withRelease: (release) => withReleaseOp(op, release),
      registerExitFinalize: (nextFinalize) => onExitOp(op, nextFinalize),
    },
  );
  return op;
}

/**
 * Suspends until a promise settles, then continues with its value or a mapped failure
 */
export function _try<T, E = UnhandledException>(
  f: (signal: AbortSignal) => T,
  onError?: (e: unknown) => E,
): Op<Awaited<T>, TrackedErr<E>, []> {
  const op: Op<Awaited<T>, TrackedErr<E>, []> = makeNullaryOp(
    function* () {
      const result = (yield new SuspendInstruction((signal: AbortSignal) =>
        Promise.resolve()
          .then(() => f(signal))
          .then(
            (a) => Result.ok(a),
            (cause) => Result.err(onError ? onError(cause) : new UnhandledException({ cause })),
          ),
      )) as Result<T, E>;

      if (result.isErr()) return yield* result;
      return result.value as Awaited<T>;
    },
    {
      withRetry: (policy) => withRetryOp(op, policy),
      withTimeout: (timeoutMs) => withTimeoutOp(op, timeoutMs),
      withSignal: (signal) => withSignalOp(op, signal),
      withRelease: (release) => withReleaseOp(op, release),
      registerExitFinalize: (finalize) => onExitOp(op, finalize),
    },
  );
  return op;
}

function makeArityOp<T, E, A extends readonly unknown[]>(
  invoke: (...args: A) => Op<T, E, []>,
): Op<T, E, A> {
  return makeFluentArityOp(invoke, (_self) => ({
    withRetry: (policy) => makeArityOp((...args) => withRetryOp(invoke(...args), policy)),
    withTimeout: (timeoutMs) => makeArityOp((...args) => withTimeoutOp(invoke(...args), timeoutMs)),
    withSignal: (signal) => makeArityOp((...args) => withSignalOp(invoke(...args), signal)),
    withRelease: (release) => makeArityOp((...args) => withReleaseOp(invoke(...args), release)),
    on: (event, finalize) => makeArityOp((...args) => onOp(invoke(...args), event, finalize)),
  }));
}

/**
 * Turns a generator function into an {@link Op}
 */
export function fromGenFn<Y extends Instruction<unknown>, T, A extends readonly unknown[]>(
  f: (...args: A) => Generator<Y, T, unknown>,
): Op<T, InferErr<Y>, A> {
  // we are intentionally always returning the arity wrapper shape, including for `A = []` generators
  // this keeps arity/nullary classification deterministic via explicit op kind metadata
  // instead of runtime function reflection or shape guessing in correctness paths
  return makeArityOp((...args: A) => {
    const bound: Op<T, InferErr<Y>, []> = makeNullaryOp(() => f(...args) as never, {
      withRetry: (policy) => withRetryOp(bound, policy),
      withTimeout: (timeoutMs) => withTimeoutOp(bound, timeoutMs),
      withSignal: (signal) => withSignalOp(bound, signal),
      withRelease: (release) => withReleaseOp(bound, release),
      registerExitFinalize: (finalize) => onExitOp(bound, finalize),
    });
    return bound;
  });
}
