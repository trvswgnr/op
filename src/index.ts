export { type Typed, UnexpectedError, TypedError } from "./lib.js";
import { succeed, fail, fromPromise, gen, run, type Op as _Op } from "./lib.js";

export const Op = Object.assign(gen, {
  run,
  ok: succeed,
  err: fail,
  fromPromise,
});

export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A>;
