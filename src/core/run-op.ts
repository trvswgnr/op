import { UnhandledException } from "../errors.js";
import type { Result } from "../result.js";
import type { Op } from "./types.js";
import { drive } from "./runtime.js";

export function runOp<T, E>(op: Op<T, E, readonly []>): Promise<Result<T, E | UnhandledException>> {
  return drive(op, new AbortController().signal);
}
