import type { Instruction } from "./core/types.js";
import type { Op } from "./index.js";

export const EMPTY_TUPLE: [] = [];

/**
 * UNSAFE: casts any value to a given type
 *
 * @warning This function is UNSAFE and should be used only when the type is known to be correct
 * Every call site for this function should be accompanied by a comment explaining why it is
 * absolutely necessary.
 */
export function unsafeCoerce<T>(value: unknown): T {
  // oxlint-disable-next-line typescript/consistent-type-assertions - only used here
  return value as T;
}

export function isOp(value: unknown): value is Op<unknown, unknown, readonly unknown[]> {
  return typeof value === "function" && "_tag" in value && value._tag === "Op";
}

export function coerceToNullaryOp(value: unknown): Op<unknown, unknown, []> | undefined {
  if (!isOp(value)) return undefined;
  return value();
}

export function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  if (value instanceof Promise) return true;

  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export function isAwaited<T>(value: T | PromiseLike<T> | Awaited<T>): value is Awaited<T> {
  return !isPromiseLike(value);
}

export function isGeneratorObject(
  value: unknown,
): value is Generator<Instruction<unknown>, unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (!("next" in value) || typeof value.next !== "function") return false;
  if (!("throw" in value) || typeof value.throw !== "function") return false;
  if (!(Symbol.iterator in value) || typeof value[Symbol.iterator] !== "function") return false;
  return true;
}
