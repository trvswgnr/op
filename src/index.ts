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
 * Wraps a generator function in an operation. The same object also exposes `run`, `pure`, `fail`,
 * `suspend`, and `type`.
 *
 * Pass `Op` a `function*` (optionally with parameters). Inside the generator, use `yield*` on
 * child operations and on instances of classes from {@link TypedError}.
 *
 * Call `.run()` on the result, or `Op.run` with the operation (and arguments when needed), to get a
 * Promise with `ok: true` and `value`, or `ok: false` and `error`. Failures that are not produced as
 * yielded errors become {@link UnexpectedError} on the error branch.
 *
 * `Op.run` matches `.run()` on a nullary op, or `Op.run(op, ...args)` for parameterized ops.
 * `Op.pure` lifts a success value (if you pass a Promise, it is awaited like `Op.suspend`).
 * `Op.fail` fails with a value. `Op.suspend` calls a function that returns a Promise; optional
 * `onError` maps rejections, otherwise rejections become {@link UnexpectedError}. {@link trySync}
 * wraps a synchronous thunk the same way for thrown values. `Op.type` is the string `OpFactory`.
 *
 * @example
 * const program = Op(function* () {
 *   const n = yield* Op.pure(2);
 *   return n + 1;
 * });
 * const result = await program.run();
 * if (result.ok) console.log(result.value);
 *
 * @example
 * const r = await Op.run(Op.pure(10));
 * if (r.ok) console.log(r.value);
 */
export const Op = Object.assign(fromGenFn, {
  type: "OpFactory" as const,
  run: runOp,
  of: succeed,
  pure: succeed,
  fail,
  try: _try,
});

/**
 * Operation: generator-based program with success type `T`, error type `E`, and parameter tuple
 * `A` for `Op((...args: A) => function* { ... })`. Use `[]` when the generator has no parameters.
 *
 * A nullary op is callable and iterable. A parameterized op is a function from `A` to that
 * shape; `run(...args)` fixes arguments then runs the inner nullary op. Values have `type: "Op"`.
 *
 * @template T Value returned when the operation succeeds.
 * @template E Error type from yielded failures (not counting {@link UnexpectedError} from throws).
 * @template A Argument tuple for parameterized operations.
 */
export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A>;

export { TypedError, UnexpectedError };
