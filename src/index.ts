import { defer, fail, fromGenFn, succeed, _try } from "./builders.js";
import { allOp, allSettledOp, anyOp, raceOp, settleOp } from "./combinators.js";
import { ErrorGroup, TimeoutError } from "./errors.js";
import {
  type EnterContext,
  type ExitContext,
  type OpLifecycleHook,
  OpNullary,
  OpArity,
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
 * - Use `Op.run(op)` to execute a nullary operation value directly.
 */
export const Op = Object.assign(fromGenFn, {
  _tag: "OpFactory" as const,
  run: runOp,
  of: succeed,
  fail,
  defer,
  try: _try,
  all: allOp,
  allSettled: allSettledOp,
  settle: settleOp,
  any: anyOp,
  race: raceOp,
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
export type Op<T, E, A extends readonly unknown[]> = (A extends []
  ? OpNullary<T, E>
  : OpArity<T, E, A>) &
  Tagged<"Op">;

export type { EnterContext, ExitContext, OpLifecycleHook };
export type { BackoffOptions, RetryPolicy } from "./policies.js";

export { TimeoutError, ErrorGroup, exponentialBackoff };
