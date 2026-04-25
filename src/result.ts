import { Result, type Err, type Ok } from "better-result";

export type ExtractErr<Y> = Y extends Err<unknown, infer U> ? U : never;

export const ok = Result.ok;
export const err = Result.err;

export type { Ok, Err };
export { Result };
