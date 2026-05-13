import { UnhandledException } from "./errors.js";
import { makeFluentOp, onOp } from "./core/ops.js";
import type { TrackedErr, AnyExitFn, Instruction, OpInterface } from "./core/types.js";
import type { Op } from "./index.js";
import { RegisterExitFinalizerInstruction, SuspendInstruction } from "./core/instructions.js";
import { withRetryOp, withTimeoutOp, withSignalOp } from "./policies.js";
import { Result, type InferErr } from "./result.js";
import { makeCoreOp, createDefaultHooks, withCleanupCoreOp } from "./core/ops.js";
import { unsafeCoerce, isAwaited } from "./shared.js";

export function succeed<T>(value: T | PromiseLike<T>): Op<Awaited<T>, never, []> {
  if (!isAwaited(value)) {
    return _try(() => value);
  }

  const op: Op<Awaited<T>, never, []> = makeCoreOp(
    function* () {
      return value;
    },
    createDefaultHooks(() => op),
  );

  return op;
}

/*
 * Lifts a value into an operation that always fails
 */
export function fail<E>(value: E): Op<never, E, []> {
  const op: Op<never, E, []> = makeCoreOp(
    function* () {
      return yield* Result.err(value);
    },
    createDefaultHooks(() => op),
  );

  return op;
}

export function defer(finalize: AnyExitFn): Op<void, never, []> {
  const op: Op<void, never, []> = makeCoreOp(
    function* () {
      yield new RegisterExitFinalizerInstruction((ctx) =>
        Promise.resolve(finalize(ctx)).then(() => {}),
      );
    },
    createDefaultHooks(() => op),
  );
  return op;
}

/*
 * Suspends until a promise settles, then continues with its value or a mapped failure
 *
 * `onError` may return a value or promise. Program-shaped values are used as the mapped typed
 * error value and are not driven.
 */
export function _try<T, E = UnhandledException>(
  f: (signal: AbortSignal) => T,
  onError?: (e: unknown) => E | PromiseLike<E>,
): Op<Awaited<T>, TrackedErr<Awaited<E>>, []> {
  const op: Op<Awaited<T>, TrackedErr<Awaited<E>>, []> = makeCoreOp(
    function* () {
      const result: Result<
        Awaited<T>,
        Awaited<E> | UnhandledException
      > = yield* new SuspendInstruction(async (context) =>
        Promise.resolve()
          .then(() => f(context.signal))
          .then(
            (a) => Result.ok(a),
            async (cause) => {
              if (!onError) return Result.err(new UnhandledException({ cause }));
              const mapped = await onError(cause);
              return Result.err(mapped);
            },
          ),
      );

      if (result.isErr()) return yield* result;
      return result.value;
    },
    createDefaultHooks(() => op),
  );
  return op;
}

function bindArityArgsToFinalizers<T>(
  iterator: Generator<Instruction<unknown>, T, unknown>,
  args: readonly unknown[],
): Generator<Instruction<unknown>, T, unknown> {
  const bindStep = (
    step: IteratorResult<Instruction<unknown>, T>,
  ): IteratorResult<Instruction<unknown>, T> => {
    if (step.done) return step;
    if (!(step.value instanceof RegisterExitFinalizerInstruction)) return step;
    if (step.value.args !== undefined) return step;
    return {
      done: false,
      value: new RegisterExitFinalizerInstruction(step.value.finalize, args),
    };
  };

  return {
    next: (value?: unknown) => bindStep(iterator.next(value)),
    return: (value?: T) =>
      bindStep(
        iterator.return(
          // SAFETY: value is only forwarded to generator finalization during close.
          unsafeCoerce<T>(value),
        ),
      ),
    throw: (error?: unknown) => bindStep(iterator.throw(error)),
    [Symbol.iterator]() {
      return this;
    },
  };
}

function makeArityOp<T, E, A extends readonly unknown[]>(
  invoke: (...args: A) => Op<T, E, []>,
  makeIterable?: () => Op<T, E, []>,
): OpInterface<T, E, A> {
  return makeFluentOp(
    invoke,
    (self) => ({
      withRetry: (policy) =>
        makeArityOp(
          (...args) => withRetryOp(invoke(...args), policy),
          makeIterable ? () => withRetryOp(makeIterable(), policy) : undefined,
        ),
      withTimeout: (timeoutMs) =>
        makeArityOp(
          (...args) => withTimeoutOp(invoke(...args), timeoutMs),
          makeIterable ? () => withTimeoutOp(makeIterable(), timeoutMs) : undefined,
        ),
      withSignal: (signal) =>
        makeArityOp(
          (...args) => withSignalOp(invoke(...args), signal),
          makeIterable ? () => withSignalOp(makeIterable(), signal) : undefined,
        ),
      withRelease: (release) =>
        makeArityOp(
          (...args) => withCleanupCoreOp(invoke(...args), release),
          makeIterable ? () => withCleanupCoreOp(makeIterable(), release) : undefined,
        ),
      on: (event, handler) => onOp(self, event, handler),
    }),
    makeIterable,
  );
}

/**
 * Turns a generator function into an {@link Op}
 */
export function fromGenFn<Y extends Instruction<unknown>, T, A extends readonly unknown[]>(
  f: (...args: A) => Generator<Y, T, unknown>,
): Op<T, InferErr<Y>, A> {
  // We intentionally always build through the tuple-arity lifting path, including for `A = []`.
  // This keeps runtime behavior uniform while preserving exact tuple signatures at the type level.
  const invoke = (...args: A) => {
    const bound: Op<T, InferErr<Y>, []> = makeCoreOp(
      () =>
        // SAFETY: TS cannot model `Generator<Y, T, unknown>` as the internal instruction supertype.
        unsafeCoerce<Generator<Instruction<InferErr<Y>>, T, unknown>>(
          bindArityArgsToFinalizers(f(...args), args),
        ),
      createDefaultHooks(() => bound),
    );
    return bound;
  };
  const op = makeArityOp(
    invoke,
    f.length === 0
      ? () =>
          invoke(
            // SAFETY: only generator functions with zero declared parameters expose the nullary iterator path.
            ...unsafeCoerce<A>([]),
          )
      : undefined,
  );

  // SAFETY: `makeArityOp` returns an OpInterface<T, E, A>, so we need to cast it to an Op<T, E, A>
  return unsafeCoerce(op);
}
