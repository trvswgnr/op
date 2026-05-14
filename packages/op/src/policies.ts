import { TimeoutError, UnhandledException } from "./errors.js";
import { Result } from "./result.js";
import { makeFluentOp, onOp, withCleanupCoreOp } from "./core/fluent.js";
import { TrackedErr, type Instruction, type OpInterface, type RunContext } from "./core/types.js";
import type { Op } from "./index.js";
import { SuspendInstruction } from "./core/instructions.js";
import { createRunContext, drive, driveInterruptOnAbort } from "./core/runtime.js";
import { makeCoreOp, createDefaultHooks } from "./core/fluent.js";
import { isIterableOp, unsafeCoerce, sleepWithSignal } from "./shared.js";

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

function makePolicyLiftedOp<T, E, A extends readonly unknown[]>(
  invoke: (...args: A) => Op<T, E, []>,
  makeIterable?: () => Op<T, E, []>,
): OpInterface<T, E, A> {
  return makeFluentOp(
    invoke,
    (self) => ({
      withRetry: (policy) =>
        makePolicyLiftedOp(
          (...args) => withRetryOp(invoke(...args), policy),
          makeIterable ? () => withRetryOp(makeIterable(), policy) : undefined,
        ),
      withTimeout: (timeoutMs) =>
        makePolicyLiftedOp(
          (...args) => withTimeoutOp(invoke(...args), timeoutMs),
          makeIterable ? () => withTimeoutOp(makeIterable(), timeoutMs) : undefined,
        ),
      withSignal: (signal) =>
        makePolicyLiftedOp(
          (...args) => withSignalOp(invoke(...args), signal),
          makeIterable ? () => withSignalOp(makeIterable(), signal) : undefined,
        ),
      withRelease: (release) =>
        makePolicyLiftedOp(
          (...args) => withCleanupCoreOp(invoke(...args), release),
          makeIterable ? () => withCleanupCoreOp(makeIterable(), release) : undefined,
        ),
      on: (event, handler) => onOp(self, event, handler),
    }),
    makeIterable,
  );
}

function makePolicyCoreOp<T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
): Op<T, TrackedErr<E>, []> {
  const self: Op<T, TrackedErr<E>, []> = makeCoreOp(
    gen,
    createDefaultHooks(() => self),
  );

  return self;
}

/**
 * Creates a promise that resolves when the given delay is complete or the given signal is aborted
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return sleepWithSignal(ms, signal).catch(() => {});
}

/**
 * Creates a nullary op that retries the given op with the given policy
 *
 * - Retries only re-run the same op; the exposed typed error channel remains `E`
 * - Internally we include `UnhandledException` for runtime safety in `drive`
 */
function withRetryCoreOp<T, E>(
  op: Op<T, E, []>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Op<T, E, []> {
  return makePolicyCoreOp(function* () {
    let attempt = 1;

    while (true) {
      type AttemptStep = { result: Result<T, E | UnhandledException>; aborted: boolean };
      const attemptStep: AttemptStep = yield* new SuspendInstruction((context) =>
        drive(op, context).then((result) => ({ result, aborted: context.signal.aborted })),
      );

      const result = attemptStep.result;

      if (result.isOk()) return result.value;

      const error = result.error;
      const retryCause = UnhandledException.is(error) ? error.cause : error;

      const canRetry =
        !attemptStep.aborted && attempt < policy.maxAttempts && policy.shouldRetry(retryCause);

      if (!canRetry) return yield* Result.err(error);

      const delayMs = Math.max(0, policy.getDelay(attempt, retryCause));
      if (delayMs > 0) {
        const delayAborted: boolean = yield* new SuspendInstruction((context) =>
          abortableDelay(delayMs, context.signal).then(() => context.signal.aborted),
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
function withTimeoutCoreOp<T, E>(op: Op<T, E, []>, timeoutMs: number): Op<T, E | TimeoutError, []> {
  const clampedTimeoutMs = Math.max(0, timeoutMs);

  return makePolicyCoreOp(function* () {
    const result: Result<T, E | UnhandledException | TimeoutError> = yield* new SuspendInstruction(
      (outerContext) =>
        raceTimeout(
          (context) => driveInterruptOnAbort(op, context),
          clampedTimeoutMs,
          outerContext,
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
function withSignalCoreOp<T, E>(op: Op<T, E, []>, signal: AbortSignal): Op<T, E, []> {
  return makePolicyCoreOp(function* () {
    const result: Result<T, E | UnhandledException> = yield* new SuspendInstruction(
      (outerContext) =>
        runWithBoundSignal((mergedContext) => drive(op, mergedContext), signal, outerContext),
    );

    if (result.isErr()) return yield* result;
    return result.value;
  });
}

export function withRetryOp<T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Op<T, E, A> {
  // SAFETY: makePolicyLiftedOp preserves the source op arity and only changes run behavior.
  return unsafeCoerce(
    makePolicyLiftedOp(
      (...args: A) => withRetryCoreOp(op(...args), policy),
      isIterableOp(op) ? () => withRetryCoreOp(op(), policy) : undefined,
    ),
  );
}

export function withTimeoutOp<T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  timeoutMs: number,
): Op<T, E | TimeoutError, A> {
  // SAFETY: makePolicyLiftedOp preserves arity while withTimeoutCoreOp widens only the error type.
  return unsafeCoerce(
    makePolicyLiftedOp(
      (...args: A) => withTimeoutCoreOp(op(...args), timeoutMs),
      isIterableOp(op) ? () => withTimeoutCoreOp(op(), timeoutMs) : undefined,
    ),
  );
}

export function withSignalOp<T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  signal: AbortSignal,
): Op<T, E, A> {
  // SAFETY: makePolicyLiftedOp preserves the source op arity and error channel.
  return unsafeCoerce(
    makePolicyLiftedOp(
      (...args: A) => withSignalCoreOp(op(...args), signal),
      isIterableOp(op) ? () => withSignalCoreOp(op(), signal) : undefined,
    ),
  );
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
  run: (context: RunContext<readonly unknown[]>) => PromiseLike<Result<T, E>>,
  boundSignal: AbortSignal,
  outerContext: RunContext<readonly unknown[]>,
): Promise<Result<T, E>> {
  const controller = new AbortController();
  const runContext = createRunContext(controller.signal, outerContext.args);

  const forwardBoundAbort = () => controller.abort(boundSignal.reason);
  if (boundSignal.aborted) forwardBoundAbort();
  else boundSignal.addEventListener("abort", forwardBoundAbort, { once: true });

  const forwardOuterAbort = () => controller.abort(outerContext.signal.reason);
  if (outerContext.signal.aborted) forwardOuterAbort();
  else outerContext.signal.addEventListener("abort", forwardOuterAbort, { once: true });

  let result: Result<T, E> | undefined;
  try {
    result = await run(runContext);
  } finally {
    boundSignal.removeEventListener("abort", forwardBoundAbort);
    outerContext.signal.removeEventListener("abort", forwardOuterAbort);
  }

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
  run: (context: RunContext<readonly unknown[]>) => PromiseLike<Result<T, E>>,
  timeoutMs: number,
  outerContext: RunContext<readonly unknown[]>,
): Promise<Result<T, E | TimeoutError>> {
  const controller = new AbortController();
  const runContext = createRunContext(controller.signal, outerContext.args);
  const cascade = () => controller.abort(outerContext.signal.reason);

  if (outerContext.signal.aborted) cascade();
  else outerContext.signal.addEventListener("abort", cascade, { once: true });

  const runPromise = run(runContext);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: TimeoutError | undefined;
  const timeout = new Promise<Result<T, E | TimeoutError>>((resolve) => {
    timeoutId = setTimeout(() => {
      timeoutError = new TimeoutError({ timeoutMs });
      controller.abort(timeoutError);
      resolve(Result.err(timeoutError));
    }, timeoutMs);
  });

  const firstResult = await Promise.race([runPromise, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    outerContext.signal.removeEventListener("abort", cascade);
  });

  if (timeoutError === undefined) {
    return firstResult;
  }

  await runPromise;
  return Result.err(timeoutError);
}
