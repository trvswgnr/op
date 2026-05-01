import { TimeoutError, UnhandledException } from "./errors.js";
import { err, type Result } from "./result.js";
import { makeFluentArityOp, onExitOp, onOp, withReleaseOp } from "./core/arity-ops.js";
import {
  type ExitFn,
  type Instruction,
  type Op,
  type OpArity,
  type OpLifecycleHook,
  type ReleaseFn,
} from "./core/types.js";
import { SuspendInstruction } from "./core/instructions.js";
import { drive } from "./core/runtime.js";
import { isNullaryOp, makeNullaryOp } from "./core/nullary-ops.js";

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

const DEFAULT_BACKOFF_OPTIONS: BackoffOptions = { base: 1_000, max: 30_000, jitter: 1 };

const normalizeBackoffOptions = (opts?: BackoffOptions): BackoffOptions => {
  const baseCandidate = opts?.base ?? DEFAULT_BACKOFF_OPTIONS.base;
  const base =
    Number.isFinite(baseCandidate) && baseCandidate > 0
      ? baseCandidate
      : DEFAULT_BACKOFF_OPTIONS.base;

  const maxCandidate = opts?.max ?? DEFAULT_BACKOFF_OPTIONS.max;
  const max = Number.isFinite(maxCandidate) && maxCandidate >= base ? maxCandidate : base;

  const jitterCandidate = opts?.jitter ?? DEFAULT_BACKOFF_OPTIONS.jitter;
  const jitter = Number.isFinite(jitterCandidate)
    ? Math.min(1, Math.max(0, jitterCandidate))
    : DEFAULT_BACKOFF_OPTIONS.jitter;

  return { base, max, jitter };
};

/**
 * Creates a delay function for exponential backoff with optional jitter
 * @param opts Options for the backoff function
 * @returns A function that calculates the delay in milliseconds for a given attempt
 */
export function exponentialBackoff(opts?: BackoffOptions): (attempt: number) => number {
  const { base, max, jitter } = normalizeBackoffOptions(opts);

  return (attempt: number): number => {
    const exp = Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), max);
    if (jitter === 0) return exp;
    const spread = exp * jitter;
    return exp - spread + Math.random() * spread;
  };
}
exponentialBackoff.DEFAULT = exponentialBackoff(DEFAULT_BACKOFF_OPTIONS);

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  shouldRetry: () => true,
  getDelay: exponentialBackoff.DEFAULT,
};

const mapFluentOp = <T, EIn, EOut, A extends readonly unknown[]>(
  op: Op<T, EIn, A>,
  mapNullary: (resolved: Op<T, EIn, []>) => Op<T, EOut, []>,
): Op<T, EOut, A> => {
  if (isNullaryOp(op)) {
    // TS cannot express that `[] extends A` may collapse to the nullary branch here
    // Runtime behavior is correct: nullary input remains nullary after mapping
    return mapNullary(op) as unknown as Op<T, EOut, A>;
  }

  const arity = op as OpArity<T, EIn, A>;
  return makeFluentArityOp(
    (...args: A) => mapNullary(arity(...args)),
    (self) => ({
      withRetry: (policy?: RetryPolicy) => withRetryOp(self, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(self, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(self, signal),
      withRelease: (release: ReleaseFn<T>) => withReleaseOp(self, release),
      on: (event: OpLifecycleHook, finalize: ExitFn<T, EOut>) => onOp(self, event, finalize),
    }),
  );
};

const makePolicyNullaryOp = <T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
): Op<T, E, []> => {
  const self: Op<T, E, []> = makeNullaryOp(gen, {
    withRetry: (policy?: RetryPolicy) => withRetryOp(self, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(self, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(self, signal),
    withRelease: (release: ReleaseFn<T>) => withReleaseOp(self, release),
    registerExitFinalize: (finalize: ExitFn<T, E>) => onExitOp(self, finalize),
  });
  return self;
};

const withRetryNullaryOp = <T, E>(
  op: Op<T, E, []>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Op<T, E, []> => {
  // Retries only re-run the same op; the exposed typed error channel remains `E`.
  // Internally we include `UnhandledException` for runtime safety in `drive`.
  return makePolicyNullaryOp<T, E | UnhandledException>(function* () {
    let attempt = 1;

    while (true) {
      const attemptStep = (yield new SuspendInstruction((signal: AbortSignal) =>
        drive(op, signal).then((result) => ({ result, aborted: signal.aborted })),
      )) as { result: Result<T, E | UnhandledException>; aborted: boolean };

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
        const delayAborted = yield new SuspendInstruction((signal: AbortSignal) =>
          abortableDelay(delayMs, signal).then(() => signal.aborted),
        );
        if (delayAborted) {
          return yield* err(cause);
        }
      }

      attempt += 1;
    }
  }) as Op<T, E, []>;
};

const withTimeoutNullaryOp = <T, E>(
  op: Op<T, E, []>,
  timeoutMs: number,
): Op<T, E | TimeoutError, []> => {
  const clampedTimeoutMs = Math.max(0, timeoutMs);
  // `drive` can still surface `UnhandledException` internally; we intentionally expose only
  // the public contract of `E | TimeoutError` for fluent API stability.
  return makePolicyNullaryOp<T, E | UnhandledException | TimeoutError>(function* () {
    const result = (yield new SuspendInstruction((outerSignal: AbortSignal) =>
      raceTimeout((signal) => drive(op, signal), clampedTimeoutMs, outerSignal),
    )) as Result<T, E | UnhandledException | TimeoutError>;
    if (result.isErr()) {
      return yield* err(result.error);
    }
    return result.value;
  }) as Op<T, E | TimeoutError, []>;
};

const withSignalNullaryOp = <T, E>(op: Op<T, E, []>, signal: AbortSignal): Op<T, E, []> => {
  // Same contract as source op: binding a signal does not widen the typed error channel.
  return makePolicyNullaryOp<T, E | UnhandledException>(function* () {
    const result = (yield new SuspendInstruction((outerSignal: AbortSignal) =>
      runWithBoundSignal((mergedSignal) => drive(op, mergedSignal), signal, outerSignal),
    )) as Result<T, E | UnhandledException>;
    if (result.isErr()) {
      return yield* err(result.error);
    }
    return result.value;
  }) as Op<T, E, []>;
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
