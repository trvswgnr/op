import {
  succeed,
  fail,
  _try,
  fromGenFn,
  runOp,
  UnexpectedError,
  TypedError,
  type Op as _Op,
} from "./lib.js";

/**
 * The public API.
 */
export const Op = Object.assign(fromGenFn, {
  type: "OpFactory" as const,
  run: runOp,
  of: succeed,
  fail,
  try: _try,
});

/**
 * Operation: generator-based program with success type `T`, error type `E`, and parameter tuple
 * `A` for `Op((...args: A) => function* { ... })`. Use `[]` when the generator has no parameters.
 *
 * A nullary op is callable and iterable. A parameterized op is a function from `A` to that
 * shape; `run(...args)` fixes arguments then runs the inner nullary op. Values have `type: "Op"`
 * and support `withRetry(strategy)` for fluent retry composition.
 *
 * @template T Value returned when the operation succeeds.
 * @template E Error type from yielded failures (not counting {@link UnexpectedError} from throws).
 * @template A Argument tuple for parameterized operations.
 */
export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A>;

export { TypedError, UnexpectedError };
