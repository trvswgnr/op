import { succeed, fail, _try, fromGenFn } from "./builders.js";
import { allOp, allSettledOp, anyOp, raceOp, settleOp } from "./combinators.js";
import { runOp, type Op as _Op } from "./core.js";
import { exponentialBackoff } from "./policies.js";
import { ErrorGroup, TimeoutError, UnreachableError } from "./errors.js";

export * from "better-result";

export const Op = Object.assign(fromGenFn, {
  _tag: "OpFactory" as const,
  run: runOp,
  of: succeed,
  fail,
  try: _try,
  all: allOp,
  allSettled: allSettledOp,
  settle: settleOp,
  any: anyOp,
  race: raceOp,
  get empty(): Op<void, never, readonly []> {
    return succeed(undefined);
  },
});

/**
 * Operation: generator-based program with success type `T`, error type `E`, and parameter tuple
 * `A` for `Op((...args: A) => function* { ... })`. Use `[]` when the generator has no parameters.
 *
 * Call `run(...args)` to execute and get `Result<T, E>`. Compose behavior with
 * `withRetry(policy)`, `withTimeout(ms)`, and `withSignal(signal)`.
 *
 * @template T Value returned when the operation succeeds.
 * @template E Error type from yielded failures (not counting {@link UnhandledException} from throws).
 * @template A Argument tuple for parameterized operations.
 */
export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A>;

export { TimeoutError, UnreachableError, ErrorGroup, exponentialBackoff };
