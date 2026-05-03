import { Result, type Err, type Ok, InferErr } from "better-result";

export const ok = Result.ok;
export const err = Result.err;

export type { Ok, Err, InferErr };
export { Result };
