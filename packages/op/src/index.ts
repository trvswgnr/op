import { defer, fail, fromGenFn, sleep, succeed, _try } from "./builders.js";
import { allOp, allSettledOp, anyOp, raceOp, settleOp } from "./combinators.js";
import { ErrorGroup, TimeoutError, type UnhandledException } from "./errors.js";
import {
  type EnterContext,
  type ExitContext,
  type OpLifecycleHook,
  OpInterface,
} from "./core/types.js";
import { runOp } from "./core/run-op.js";
import { exponentialBackoff } from "./policies.js";
import { Tagged } from "./tagged.js";
import { type Result } from "./result.js";

const empty: Op<void, never, []> = succeed(undefined);

/**
 * An operation that can be run and composed with other operations.
 *
 * - Runtime factory and namespace for building and composing operations.
 * - Call `Op(function* (...) { ... })` to build generator-based operations.
 * - Use static helpers (`Op.of`, `Op.fail`, `Op.try`, `Op.all`, `Op.any`, etc.)
 *   for common patterns.
 *
 * Use `Op.run(op)` to execute an operation directly. For external cancellation,
 *   compose with `.withSignal(signal)` first and then run.
 *
 * @example
 * const op = Op(function* () {
 *   if (Math.random() > 0.5) {
 *     return yield* Op.fail("error");
 *   }
 *   return yield* Op.of(69);
 * });
 * const result = await op.run();
 * console.log(result);
 */
export const Op = Object.assign(fromGenFn, {
  /** Type discriminant for the `Op` factory namespace value. */
  _tag: "OpFactory" as const,
  /**
   * Executes an operation with its runtime arguments and resolves to its `Result<T, E | UnhandledException>`.
   *
   * @example
   * const value = await Op.run(Op.of(1));
   */
  run: <T, E, A extends readonly unknown[]>(
    op: Op<T, E, A>,
    ...args: A
  ): Promise<Result<T, E | UnhandledException>> => {
    return runOp(op(...args));
  },
  /**
   * Creates an operation that always succeeds with the provided value.
   *
   * Promise inputs are awaited before producing the success value.
   *
   * @example
   * const value = Op.of(69);
   */
  of: succeed,
  /**
   * Creates an operation that always fails with the provided typed error value.
   *
   * @example
   * const failed = Op.fail("bad-input" as const);
   */
  fail,
  /**
   * Registers an exit finalizer for the current run via `yield* Op.defer(...)`.
   *
   * If several callbacks throw during the same unwind, `run` fails with {@link UnhandledException}
   * whose `cause` is a nested {@link Error} chain (`.cause`) with the **first LIFO
   * failure as the outermost error**.
   *
   * **Important**: Op.defer *must* be `yield*`ed or it will do nothing
   *
   * @note Should always be used inside an `Op(function* () { ... })` body.
   *
   * @example
   * const program = Op(function* () {
   *   yield* Op.defer(() => console.log("cleanup"));
   *   return 1;
   * });
   */
  defer,
  /**
   * Suspends the current operation for `ms` milliseconds.
   *
   * Negative durations are normalized to `0`. Non-finite durations fail at run time
   * with `UnhandledException`.
   * The sleep observes surrounding cancellation from `.withSignal(...)`,
   * `.withTimeout(...)`, and combinators.
   *
   * @example
   * const delayed = Op(function* () {
   *   yield* Op.sleep(100);
   *   return "ready";
   * });
   */
  sleep,
  /**
   * Lifts a sync or async callback into an operation.
   *
   * - Fulfillment returns `Ok`.
   * - Throw/reject is normalized to `UnhandledException` when `onError` is omitted.
   * - With `onError`, failures are mapped to your typed error.
   *
   * @example
   * const fetched = Op.try(() => fetch("/health"));
   *
   * @example
   * const fetched = Op.try(
   *   () => fetch("/health"),
   *   (cause) => new FetchError({ cause }),
   * );
   */
  try: _try,
  /**
   * Runs nullary operations concurrently and preserves input order on success.
   *
   * `Op.all` fails fast on the first observed error, aborts remaining siblings,
   * and still waits for active losers to settle so cleanup/finalizers complete.
   *
   * @example
   * const pair = Op.all([Op.of(1), Op.of("ok")]);
   */
  all: allOp,
  /**
   * Runs all branches and returns per-branch `Result` values in input order.
   *
   * Branch failures do not abort siblings. Invalid `concurrency` (non-integer or
   * less than 1) returns `Err(UnhandledException)` at run time.
   *
   * @example
   * const settled = Op.allSettled([Op.of(1), Op.fail("nope" as const)]);
   */
  allSettled: allSettledOp,
  /**
   * Converts one operation into an infallible wrapper that returns `Result` as data.
   *
   * @example
   * const settled = Op.settle(Op.try(() => JSON.parse("{}")));
   */
  settle: settleOp,
  /**
   * Resolves with the first successful branch and aborts the rest.
   *
   * If every branch fails, returns `Err(ErrorGroup<...>)` with errors retained
   * in input order.
   *
   * @example
   * const fastestSuccess = Op.any([Op.fail("x"), Op.of(2)]);
   */
  any: anyOp,
  /**
   * Returns the first branch to settle (`Ok` or `Err`) and aborts the rest.
   *
   * @example
   * const firstSettler = Op.race([Op.of(1), Op.try(() => Promise.resolve(2))]);
   */
  race: raceOp,
  /**
   * Shared no-op operation that succeeds with `undefined`.
   *
   * @example
   * const noop = Op.empty;
   */
  empty,
});

export type Op<T, E, A extends readonly unknown[]> = OpInterface<T, E, A> & Tagged<"Op">;

export type { EnterContext, ExitContext, OpLifecycleHook };
export type { BackoffOptions, RetryPolicy } from "./policies.js";

export { TimeoutError, ErrorGroup, exponentialBackoff };
