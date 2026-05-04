import { defer, fail, fromGenFn, succeed, _try } from "./builders.js";
import { allOp, allSettledOp, anyOp, raceOp, settleOp } from "./combinators.js";
import { ErrorGroup, TimeoutError } from "./errors.js";
import {
  type EnterContext,
  type ExitContext,
  type Op as _Op,
  type OpLifecycleHook,
} from "./core/types.js";
import { runOp } from "./core/run-op.js";
import { exponentialBackoff } from "./policies.js";

const empty: _Op<void, never, []> = succeed(undefined);

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
 * Enter handlers receive {@link EnterContext}; exit handlers receive {@link ExitContext} with the same
 * `result` as `.run()`.
 *
 * @template T Value returned when the operation succeeds
 * @template E Error type from yielded failures (not counting {@link UnhandledException} from throws)
 * @template A Argument tuple for parameterized operations
 */
export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A>;

export type { EnterContext, ExitContext, OpLifecycleHook };

export { TimeoutError, ErrorGroup, exponentialBackoff };
