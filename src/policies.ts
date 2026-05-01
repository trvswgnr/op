import { TimeoutError, UnhandledException } from "./errors.js";
import { err, type Result } from "./result.js";
import {
  type ExitFn,
  type Instruction,
  type OpLifecycleHook,
  type Op,
  type OpArity,
  type ReleaseFn,
  drive,
  flatMapOp,
  makeNullaryOp,
  mapErrOp,
  mapOp,
  onExitOp,
  onOp,
  recoverOp,
  tapErrOp,
  tapOp,
  withReleaseOp,
} from "./core.js";

/** Retry policy for `op.withRetry(policy)`. */
export interface RetryPolicy {
  /** Total tries, including the first attempt. */
  maxAttempts: number;
  /** Whether to retry after a failure (receives the root cause). */
  shouldRetry: (cause: unknown) => boolean;
  /** Delay in milliseconds before the next attempt (attempt starts at 1). */
  getDelay: (attempt: number, cause: unknown) => number;
}

/**
 * Creates a retry delay function with exponential growth and optional jitter.
 */
export interface BackoffOptions {
  /** Initial delay in milliseconds. */
  base: number;
  /** Maximum delay in milliseconds. */
  max: number;
  /** Fraction of the computed delay to randomize (0 = none, 1 = full jitter). */
  jitter: number;
}

/**
 * Creates a delay function for exponential backoff with optional jitter
 * @param opts Options for the backoff function
 * @returns A function that calculates the delay in milliseconds for a given attempt
 * @throws A {@link RangeError} if an option is invalid
 */
export function exponentialBackoff(opts?: BackoffOptions): (attempt: number) => number {
  const { base, max, jitter } = opts ?? { base: 1_000, max: 30_000, jitter: 1 };

  if (base <= 0) throw new RangeError("baseMs must be positive");
  if (max < base) throw new RangeError("maxMs must be >= baseMs");
  if (jitter < 0 || jitter > 1) throw new RangeError("jitter must be between 0 and 1");

  return (attempt: number): number => {
    const exp = Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), max);
    if (jitter === 0) return exp;
    const spread = exp * jitter;
    return exp - spread + Math.random() * spread;
  };
}
exponentialBackoff.DEFAULT = exponentialBackoff({ base: 1_000, max: 30_000, jitter: 1 });

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  shouldRetry: () => true,
  getDelay: exponentialBackoff.DEFAULT,
};

const mapFluentOp = <T, EIn, EOut, A extends readonly unknown[]>(
  op: Op<T, EIn, A>,
  mapNullary: (resolved: Op<T, EIn, readonly []>) => Op<T, EOut, readonly []>,
): Op<T, EOut, A> => {
  if (Symbol.iterator in op) {
    // TS cannot express that `[] extends A` may collapse to the nullary branch here.
    // Runtime behavior is correct: nullary input remains nullary after mapping.
    return mapNullary(op) as unknown as Op<T, EOut, A>;
  }

  const arity = op as OpArity<T, EIn, A>;
  const g = (...args: A) => mapNullary(arity(...args));
  const out = Object.assign(g, {
    run: (...args: A) => drive(g(...args), new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => withRetryOp(out, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(out, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(out, signal),
    withRelease: (release: ReleaseFn<T>) => withReleaseOp(out, release),
    on: (event: OpLifecycleHook, finalize: ExitFn<T, EOut>) => onOp(out, event, finalize),
    map: <U>(transform: (value: T) => U) => mapOp(out, transform),
    mapErr: <E2>(transform: (error: EOut) => E2) => mapErrOp(out, transform),
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, readonly []>) => flatMapOp(out, bind),
    tap: <R>(observe: (value: T) => R) => tapOp(out, observe),
    tapErr: <R>(observe: (error: EOut) => R) => tapErrOp(out, observe),
    recover: <R>(predicate: (error: EOut) => boolean, handler: (error: EOut) => R) =>
      recoverOp(out, predicate, handler),
    _tag: "Op" as const,
    // TS cannot fully model callable object construction from `Object.assign` with conditional arity.
    // This cast is safe because `g` is the single execution path for all `A` arguments.
  }) as unknown as Op<T, EOut, A>;

  return out;
};

const makePolicyNullaryOp = <T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
): Op<T, E, readonly []> => {
  const self: Op<T, E, readonly []> = makeNullaryOp(gen, {
    withRetry: (policy?: RetryPolicy) => withRetryOp(self, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(self, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(self, signal),
    withRelease: (release: ReleaseFn<T>) => withReleaseOp(self, release),
    registerExitFinalize: (finalize: ExitFn<T, E>) => onExitOp(self, finalize),
  });
  return self;
};

const withRetryNullaryOp = <T, E>(
  op: Op<T, E, readonly []>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Op<T, E, readonly []> => {
  // Retries only re-run the same op; the exposed typed error channel remains `E`.
  // Internally we include `UnhandledException` for runtime safety in `drive`.
  return makePolicyNullaryOp<T, E | UnhandledException>(function* () {
    let attempt = 1;

    while (true) {
      const attemptStep = (yield {
        _tag: "Suspended",
        suspend: (signal: AbortSignal) =>
          drive(op, signal).then((result) => ({ result, aborted: signal.aborted })),
      }) as { result: Result<T, E | UnhandledException>; aborted: boolean };

      const result = attemptStep.result;
      if (result.isOk()) {
        return result.value;
      }

      const cause = result.error;
      const retryCause = cause instanceof UnhandledException ? cause.cause : cause;
      const canRetry =
        !attemptStep.aborted && attempt < policy.maxAttempts && policy.shouldRetry(retryCause);
      if (!canRetry) {
        return yield* err(cause);
      }

      const delayMs = Math.max(0, policy.getDelay(attempt, cause));
      if (delayMs > 0) {
        const delayAborted = yield {
          _tag: "Suspended",
          suspend: (signal: AbortSignal) =>
            abortableDelay(delayMs, signal).then(() => signal.aborted),
        };
        if (delayAborted) {
          return yield* err(cause);
        }
      }

      attempt += 1;
    }
  }) as Op<T, E, readonly []>;
};

const withTimeoutNullaryOp = <T, E>(
  op: Op<T, E, readonly []>,
  timeoutMs: number,
): Op<T, E | TimeoutError, readonly []> => {
  const clampedTimeoutMs = Math.max(0, timeoutMs);
  // `drive` can still surface `UnhandledException` internally; we intentionally expose only
  // the public contract of `E | TimeoutError` for fluent API stability.
  return makePolicyNullaryOp<T, E | UnhandledException | TimeoutError>(function* () {
    const result = (yield {
      _tag: "Suspended",
      suspend: (outerSignal: AbortSignal) =>
        raceTimeout((signal) => drive(op, signal), clampedTimeoutMs, outerSignal),
    }) as Result<T, E | UnhandledException | TimeoutError>;
    if (result.isErr()) {
      return yield* err(result.error);
    }
    return result.value;
  }) as Op<T, E | TimeoutError, readonly []>;
};

const withSignalNullaryOp = <T, E>(
  op: Op<T, E, readonly []>,
  signal: AbortSignal,
): Op<T, E, readonly []> => {
  // Same contract as source op: binding a signal does not widen the typed error channel.
  return makePolicyNullaryOp<T, E | UnhandledException>(function* () {
    const result = (yield {
      _tag: "Suspended" as const,
      suspend: (outerSignal: AbortSignal) =>
        runWithBoundSignal((mergedSignal) => drive(op, mergedSignal), signal, outerSignal),
    }) as Result<T, E | UnhandledException>;
    if (result.isErr()) {
      return yield* err(result.error);
    }
    return result.value;
  }) as Op<T, E, readonly []>;
};

export const withRetryOp = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Op<T, E, A> => {
  return mapFluentOp(op, (resolved) => withRetryNullaryOp(resolved, policy));
};

export const withTimeoutOp = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  timeoutMs: number,
): Op<T, E | TimeoutError, A> => {
  return mapFluentOp(op, (resolved) => withTimeoutNullaryOp(resolved, timeoutMs));
};

export const withSignalOp = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  signal: AbortSignal,
): Op<T, E, A> => {
  return mapFluentOp(op, (resolved) => withSignalNullaryOp(resolved, signal));
};

const runWithBoundSignal = <T, E>(
  run: (signal: AbortSignal) => Promise<Result<T, E>>,
  boundSignal: AbortSignal,
  outerSignal: AbortSignal,
): Promise<Result<T, E>> => {
  const controller = new AbortController();
  const forwardBoundAbort = () => controller.abort(boundSignal.reason);
  const forwardOuterAbort = () => controller.abort(outerSignal.reason);

  if (boundSignal.aborted) forwardBoundAbort();
  else boundSignal.addEventListener("abort", forwardBoundAbort, { once: true });

  if (outerSignal.aborted) forwardOuterAbort();
  else outerSignal.addEventListener("abort", forwardOuterAbort, { once: true });

  return run(controller.signal).finally(() => {
    boundSignal.removeEventListener("abort", forwardBoundAbort);
    outerSignal.removeEventListener("abort", forwardOuterAbort);
  });
};

const raceTimeout = <T, E>(
  run: (signal: AbortSignal) => Promise<Result<T, E>>,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<Result<T, E | TimeoutError>> => {
  const controller = new AbortController();
  const cascade = () => controller.abort(outerSignal.reason);
  if (outerSignal.aborted) cascade();
  else outerSignal.addEventListener("abort", cascade, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Result<T, E | TimeoutError>>((resolve) => {
    timeoutId = setTimeout(() => {
      const e = new TimeoutError({ timeoutMs });
      controller.abort(e);
      resolve(err(e));
    }, timeoutMs);
  });

  return Promise.race([run(controller.signal), timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    outerSignal.removeEventListener("abort", cascade);
  });
};

const abortableDelay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
