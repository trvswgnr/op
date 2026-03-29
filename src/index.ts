import {
  succeed,
  fail,
  fromPromise,
  fromGenFn,
  runOp,
  UnexpectedError,
  TypedError,
  type Op as _Op,
} from "./lib.js";

export const Op = Object.assign(fromGenFn, {
  type: "OpFactory" as const,
  run: runOp,
  pure: succeed,
  fail,
  suspend: fromPromise,
});

export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A>;

export { TypedError, UnexpectedError };
