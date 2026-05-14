import type { Op } from "./index.js";
import type { OpIterable } from "./core/types.js";

export const EMPTY_TUPLE: [] = [];
export const OP_BRAND: unique symbol = Symbol("prodkit.op");

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
  return typeof value === "function" && OP_BRAND in value && value[OP_BRAND] === true;
}

export function isIterableOp(
  value: unknown,
): value is Op<unknown, unknown, []> & OpIterable<unknown, unknown> {
  return isOp(value) && Symbol.iterator in value && typeof value[Symbol.iterator] === "function";
}

export function coerceToNullaryOp(value: unknown): Op<unknown, unknown, []> | undefined {
  if (!isIterableOp(value)) return undefined;
  const nullary = value();
  return isIterableOp(nullary) ? nullary : undefined;
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

export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms)) {
    return Promise.reject(new RangeError("sleep duration must be a finite number"));
  }

  const durationMs = Math.max(0, ms);
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
