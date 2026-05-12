import { defer, fail, fromGenFn, succeed, _try } from "./builders.js";
import { allOp, allSettledOp, anyOp, raceOp, settleOp } from "./combinators.js";
import { ErrorGroup, TimeoutError } from "./errors.js";
import {
  type EnterContext,
  type ExitContext,
  type OpLifecycleHook,
  OpInterface,
} from "./core/types.js";
import { runOp } from "./core/run-op.js";
import { exponentialBackoff } from "./policies.js";
import { Tagged } from "./tagged.js";

const empty: Op<void, never, []> = succeed(undefined);

/**
 * Runtime factory and namespace for building and composing operations.
 *
 * - Call `Op(function* (...) { ... })` to build generator-based operations.
 * - Use static helpers (`Op.of`, `Op.fail`, `Op.try`, `Op.all`, `Op.any`, etc.) for common patterns.
 * - Use `Op.run(op)` to execute a nullary operation value directly. For external cancellation,
 *   compose with `.withSignal(signal)` first and then run.
 */
export const Op = Object.assign(fromGenFn, {
  /** Type discriminant for the `Op` factory namespace value. */
  _tag: "OpFactory" as const,
  /**
   * Executes a nullary operation and resolves to its `Result<T, E | UnhandledException>`.
   *
   * This helper is for already-constructed nullary `Op` values. For parameterized
   * operations, call instance `.run(...args)` on the op itself.
   *
   * @example
   * const value = await Op.run(Op.of(1));
   */
  run: runOp,
  /**
   * Creates an operation that succeeds with the provided value.
   *
   * Promise inputs are awaited before producing the success value.
   *
   * @example
   * const value = Op.of(42);
   */
  of: succeed,
  /**
   * Creates an operation that fails with the provided typed error value.
   *
   * @example
   * const failed = Op.fail("bad-input" as const);
   */
  fail,
  /**
   * Registers an exit finalizer for the current run via `yield* Op.defer(...)`.
   *
   * @example
   * const program = Op(function* () {
   *   yield* Op.defer(() => console.log("cleanup"));
   *   return 1;
   * });
   */
  defer,
  /**
   * Lifts a sync/async callback into an operation.
   *
   * - Fulfillment returns `Ok`.
   * - Throw/reject is normalized to `UnhandledException` when `onError` is omitted.
   * - With `onError`, failures are mapped to your typed error.
   *
   * @example
   * const fetched = Op.try(() => fetch("/health"));
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

/**
 * Operation: a generator-based program with success type `T`, error type `E`, and parameter tuple `A`
 * `A` for `Op((...args: A) => function* { ... })`. Use `[]` when the generator has no parameters
 *
 * Call `run(...args)` to execute and get `Result<T, E>`. Compose behavior with
 * `withRetry(policy)`, `withTimeout(ms)`, `withSignal(signal)`, `withRelease(release)`,
 * `.on("enter", initialize)`, `.on("exit", finalize)`, and `Op.defer(finalize)` inside generators.
 * Enter handlers receive {@link EnterContext} (`signal` + runtime `args`); exit handlers receive
 * {@link ExitContext} (`signal` + runtime `args` + same `result` as `.run()`).
 *
 * @template T Value returned when the operation succeeds
 * @template E Error type from yielded failures (not counting {@link UnhandledException} from throws)
 * @template A Argument tuple for parameterized operations
 */
export type Op<T, E, A extends readonly unknown[]> = OpInterface<T, E, A> & Tagged<"Op">;

export type { EnterContext, ExitContext, OpLifecycleHook };
export type { BackoffOptions, RetryPolicy } from "./policies.js";

export { TimeoutError, ErrorGroup, exponentialBackoff };
