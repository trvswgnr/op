import {
  succeed,
  fail,
  _try,
  fromGenFn,
  runOp,
  allOp,
  allSettledOp,
  anyOp,
  raceOp,
  ErrorGroup,
  TimeoutError,
  UnexpectedError,
  UnreachableError,
  TypedError,
  type Op as _Op,
} from "./lib.js";

export const Op = Object.assign(fromGenFn, {
  type: "OpFactory" as const,
  run: runOp,
  of: succeed,
  fail,
  try: _try,
  all: allOp,
  allSettled: allSettledOp,
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
 * A nullary op is callable and iterable. A parameterized op is a function from `A` to that
 * shape; `run(...args)` fixes arguments then runs the inner nullary op. Values have `type: "Op"`
 * and support `withRetry(strategy)` / `withTimeout(ms)` for fluent composition.
 *
 * @template T Value returned when the operation succeeds.
 * @template E Error type from yielded failures (not counting {@link UnexpectedError} from throws).
 * @template A Argument tuple for parameterized operations.
 */
export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A>;

export { TypedError, TimeoutError, UnexpectedError, UnreachableError, ErrorGroup };
