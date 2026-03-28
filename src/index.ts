import {
  succeed,
  fail,
  fromPromise,
  gen,
  run,
  UnexpectedError,
  TypedError,
  type Op as _Op,
  type Instruction,
  type OpBase,
  type Result,
  type ExtractErr,
  type Typed,
} from "./lib.js";
interface OpFactory extends Typed<"OpFactory"> {
  <Y extends Instruction<unknown>, T>(f: () => Generator<Y, T, unknown>): Op<T, ExtractErr<Y>, []>;
  <Y extends Instruction<unknown>, T, A extends readonly unknown[]>(
    f: (...args: A) => Generator<Y, T, unknown>,
  ): Op<T, ExtractErr<Y>, A>;
  run: <E, T>(op: Op<T, E, readonly []> | OpBase<T, E>) => Promise<Result<T, E | UnexpectedError>>;
  pure: <T>(value: T) => Op<T, never, []>;
  fail: <E>(value: E) => Op<never, E, []>;
  suspend: <T, E = UnexpectedError>(
    f: () => Promise<T>,
    onError?: (e: unknown) => E,
  ) => Op<T, E, []>;
}

export const Op: OpFactory = Object.assign(gen, {
  type: "OpFactory" as const,
  run,
  pure: succeed,
  fail,
  suspend: fromPromise,
});

export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A>;

export { TypedError, UnexpectedError };
