import { UnhandledException } from "../errors.js";
import type { Result } from "../result.js";
import { drive } from "./runtime.js";
import type { Op } from "../index.js";

export function runOp<T, E>(op: Op<T, E, []>): Promise<Result<T, E | UnhandledException>> {
  return drive(op, new AbortController().signal);
}
