import { TimeoutError, UnhandledException } from "./errors.js";
import { Result } from "./result.js";
import { asArityOp, makeFluentArityOp, onOp, withReleaseOp } from "./core/arity-ops.js";
import { TrackedErr, type Instruction, type Op, type OpArity } from "./core/types.js";
import { SuspendInstruction } from "./core/instructions.js";
import { drive } from "./core/runtime.js";
import { isNullaryOp, makeNullaryOp, createDefaultHooks } from "./core/nullary-ops.js";
import { cast } from "./shared.js";

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
 * Creates a retry delay function with exponential growth and optional jitter
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

function normalizeBackoffOptions(opts?: BackoffOptions): BackoffOptions {
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
}

/**
 * Creates a delay function for exponential backoff with optional jitter
 * @param opts Options for the backoff function
 * @returns A function that calculates the delay in milliseconds for a given attempt
 */
export function exponentialBackoff(opts?: BackoffOptions): (attempt: number) => number {
  const { base, max, jitter } = normalizeBackoffOptions(opts);

  return (attempt) => {
    const exp = Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), max);

    if (jitter === 0) return exp;

    const spread = exp * jitter;

    return exp - spread + Math.random() * spread;
  };
}
exponentialBackoff.DEFAULT = exponentialBackoff(DEFAULT_BACKOFF_OPTIONS);

export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  shouldRetry: () => true,
  getDelay: exponentialBackoff.DEFAULT,
}) satisfies RetryPolicy;

function mapArityFluentOp<T, EIn, EOut, A extends readonly unknown[]>(
  source: OpArity<T, EIn, A>,
  mapNullary: (resolved: Op<T, EIn, []>) => Op<T, EOut, []>,
): OpArity<T, EOut, A> {
  return makeFluentArityOp(
    (...args: A) => mapNullary(source(...args)),
    (self) => ({
      withRetry: (policy) => mapArityFluentOp(asArityOp(source.withRetry(policy)), mapNullary),
      withTimeout: (timeoutMs) =>
        mapArityFluentOp(
          asArityOp(
            // SAFETY: `withTimeout` widens the source error to `EIn | TimeoutError`, but this
            // mapper is polymorphic over the error channel and forwards whatever union it receives.
            // The cast narrows only for TS so we can reuse the same fluent mapper pipeline.
            cast(source.withTimeout(timeoutMs)),
          ),
          mapNullary,
        ),
      withSignal: (signal) => mapArityFluentOp(asArityOp(source.withSignal(signal)), mapNullary),
      withRelease: (release) => withReleaseOp(self, release),
      on: (event, finalize) => onOp(self, event, finalize),
    }),
  );
}

function mapFluentOp<T, EIn, EOut, A extends readonly unknown[]>(
  op: Op<T, EIn, A>,
  mapNullary: (resolved: Op<T, EIn, []>) => Op<T, EOut, []>,
): Op<T, EOut, A> {
  if (isNullaryOp(op)) {
    // SAFETY: TS cannot express that `[] extends A` may collapse to the nullary branch here
    // Runtime behavior is correct: nullary input remains nullary after mapping
    return cast(mapNullary(op));
  }

  return cast(mapArityFluentOp(op, mapNullary));
}

function makePolicyNullaryOp<T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
): Op<T, TrackedErr<E>, []> {
  const self: Op<T, TrackedErr<E>, []> = makeNullaryOp(gen, {
    withRetry: (policy) => withRetryOp(self, policy),
    withTimeout: (timeoutMs) => withTimeoutOp(self, timeoutMs),
    withSignal: (signal) => withSignalOp(self, signal),
    ...createDefaultHooks(() => self),
  });

  return self;
}

/**
 * Creates a promise that resolves when the given delay is complete or the given signal is aborted
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
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
}

/**
 * Creates a nullary op that retries the given op with the given policy
 *
 * - Retries only re-run the same op; the exposed typed error channel remains `E`
 * - Internally we include `UnhandledException` for runtime safety in `drive`
 */
function withRetryNullaryOp<T, E>(
  op: Op<T, E, []>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Op<T, E, []> {
  return makePolicyNullaryOp(function* () {
    let attempt = 1;

    while (true) {
      type AttemptStep = { result: Result<T, E | UnhandledException>; aborted: boolean };
      const attemptStep: AttemptStep = cast(
        yield new SuspendInstruction((signal: AbortSignal) =>
          drive(op, signal).then((result) => ({ result, aborted: signal.aborted })),
        ),
      );

      const result = attemptStep.result;

      if (result.isOk()) return result.value;

      const error = result.error;
      const retryCause = UnhandledException.is(error) ? error.cause : error;

      const canRetry =
        !attemptStep.aborted && attempt < policy.maxAttempts && policy.shouldRetry(retryCause);

      if (!canRetry) return yield* Result.err(error);

      const delayMs = Math.max(0, policy.getDelay(attempt, error));
      if (delayMs > 0) {
        const delayAborted: boolean = cast(
          yield new SuspendInstruction((signal: AbortSignal) =>
            abortableDelay(delayMs, signal).then(() => signal.aborted),
          ),
        );

        if (delayAborted) return yield* result;
      }

      attempt += 1;
    }
  });
}

/**
 * Creates a nullary op that times out the given op with the given timeout
 *
 * - `drive` can still surface `UnhandledException` internally
 * - We intentionally expose only he public contract of `E | TimeoutError` for fluent API stability
 */
function withTimeoutNullaryOp<T, E>(
  op: Op<T, E, []>,
  timeoutMs: number,
): Op<T, E | TimeoutError, []> {
  const clampedTimeoutMs = Math.max(0, timeoutMs);

  return makePolicyNullaryOp(function* () {
    const result: Result<T, E | UnhandledException | TimeoutError> = cast(
      yield new SuspendInstruction((outerSignal: AbortSignal) =>
        raceTimeout((signal) => drive(op, signal), clampedTimeoutMs, outerSignal),
      ),
    );

    if (result.isErr()) return yield* result;
    return result.value;
  });
}

/**
 * Creates a nullary op that binds the given signal to the given op
 *
 * - Same contract as source op: binding a signal does not widen the typed error channel
 */
function withSignalNullaryOp<T, E>(op: Op<T, E, []>, signal: AbortSignal): Op<T, E, []> {
  return makePolicyNullaryOp(function* () {
    const result: Result<T, E | UnhandledException> = cast(
      yield new SuspendInstruction((outerSignal: AbortSignal) =>
        runWithBoundSignal((mergedSignal) => drive(op, mergedSignal), signal, outerSignal),
      ),
    );

    if (result.isErr()) return yield* result;
    return result.value;
  });
}

export function withRetryOp<T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Op<T, E, A> {
  return mapFluentOp(op, (resolved) => withRetryNullaryOp(resolved, policy));
}

export function withTimeoutOp<T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  timeoutMs: number,
): Op<T, E | TimeoutError, A> {
  return mapFluentOp(op, (resolved) => withTimeoutNullaryOp(resolved, timeoutMs));
}

export function withSignalOp<T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  signal: AbortSignal,
): Op<T, E, A> {
  return mapFluentOp(op, (resolved) => withSignalNullaryOp(resolved, signal));
}

/**
 * Runs the given operation with the given bound signal and outer signal
 *
 * Listener lifecycle contract:
 * - The composed controller mirrors both bound and outer cancellation
 * - We eagerly check `aborted` before registering listeners so pre-aborted signals
 *   cannot miss propagation
 * - Cleanup stays in Promise.finally so listeners are removed on success, error, or abort
 */
async function runWithBoundSignal<T, E>(
  run: (signal: AbortSignal) => Promise<Result<T, E>>,
  boundSignal: AbortSignal,
  outerSignal: AbortSignal,
): Promise<Result<T, E>> {
  const controller = new AbortController();

  const forwardBoundAbort = () => controller.abort(boundSignal.reason);
  if (boundSignal.aborted) forwardBoundAbort();
  else boundSignal.addEventListener("abort", forwardBoundAbort, { once: true });

  const forwardOuterAbort = () => controller.abort(outerSignal.reason);
  if (outerSignal.aborted) forwardOuterAbort();
  else outerSignal.addEventListener("abort", forwardOuterAbort, { once: true });

  const result = await run(controller.signal).finally(() => {
    boundSignal.removeEventListener("abort", forwardBoundAbort);
    outerSignal.removeEventListener("abort", forwardOuterAbort);
  });

  return result;
}

/**
 * Runs the given operation with the given timeout and outer signal
 *
 * Listener lifecycle contract:
 * - The timeout path and outer signal both cancel the same controller
 * - Timeout resolves with TimeoutError while also aborting the work branch so branch-local
 *   cleanup runs through normal cancellation flow
 * - Promise.finally clears timer + listener in every settle path to avoid timer/listener leaks
 */
async function raceTimeout<T, E>(
  run: (signal: AbortSignal) => Promise<Result<T, E>>,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<Result<T, E | TimeoutError>> {
  const controller = new AbortController();
  const cascade = () => controller.abort(outerSignal.reason);

  if (outerSignal.aborted) cascade();
  else outerSignal.addEventListener("abort", cascade, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Result<T, E | TimeoutError>>((resolve) => {
    timeoutId = setTimeout(() => {
      const e = new TimeoutError({ timeoutMs });
      controller.abort(e);
      resolve(Result.err(e));
    }, timeoutMs);
  });

  const result = await Promise.race([run(controller.signal), timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    outerSignal.removeEventListener("abort", cascade);
  });

  return result;
}
