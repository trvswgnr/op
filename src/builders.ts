import { UnexpectedError, UnreachableError } from "./errors.js";
import { type FromGenFn, type Instruction, type Op, runOp } from "./core.js";
import { withRetryOp, withTimeoutOp, withSignalOp, type RetryPolicy } from "./policies.js";
import { err, ok, type Result } from "./result.js";

/**
 * Lifts a value into an operation that always completes successfully.
 */
export const succeed = <T>(value: T): Op<Awaited<T>, never, []> => {
  if (value instanceof Promise) {
    return _try(() => value);
  }

  const self = {
    *[Symbol.iterator]() {
      return value;
    },
    run: () => runOp(self as never),
    withRetry: (policy?: RetryPolicy) => withRetryOp(self as never, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(self as never, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(self as never, signal),
    type: "Op",
  };
  const op = () => self;
  return Object.assign(op, self) as never;
};

/**
 * Lifts a value into an operation that always fails.
 */
export const fail = <E>(value: E): Op<never, E, readonly []> => {
  const self = {
    *[Symbol.iterator]() {
      yield err(value);
      throw new UnreachableError();
    },
    run: () => runOp(self as never),
    withRetry: (policy?: RetryPolicy) => withRetryOp(self as never, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(self as never, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(self as never, signal),
    type: "Op" as const,
  };
  const op = () => self;
  return Object.assign(op, self) as never;
};

/**
 * Suspends until a promise settles, then continues with its value or a mapped failure.
 */
export const _try = <T, E = UnexpectedError>(
  f: (signal: AbortSignal) => T,
  onError?: (e: unknown) => E,
): Op<Awaited<T>, E, readonly []> => {
  const self = {
    *[Symbol.iterator]() {
      const result: Result<T, E> = yield {
        type: "Suspended" as const,
        suspend: (signal: AbortSignal) =>
          Promise.resolve()
            .then(() => f(signal))
            .then(
              (a) => ok(a),
              (cause) => err(onError ? onError(cause) : new UnexpectedError(cause)),
            ) as Promise<Result<T, E>>,
      };
      if (result.type === "Err") {
        yield result;
        throw new UnreachableError();
      }
      return result.value;
    },
    run: () => runOp(self as never),
    withRetry: (policy?: RetryPolicy) => withRetryOp(self as never, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(self as never, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(self as never, signal),
    type: "Op" as const,
  };
  const op = () => self;
  return Object.assign(op, self) as never;
};

/**
 * Turns a generator function into an {@link Op}.
 */
export const fromGenFn: FromGenFn = (
  f: (...args: unknown[]) => Generator<Instruction<unknown>, unknown, unknown>,
): Op<unknown, unknown, []> | Op<unknown, unknown, readonly unknown[]> => {
  const g = (...args: unknown[]) => {
    const inner = {
      [Symbol.iterator]: () => f(...args),
      run: () => runOp(inner as never),
      withRetry: (policy?: RetryPolicy) => withRetryOp(inner as never, policy),
      withTimeout: (timeoutMs: number) => withTimeoutOp(inner as never, timeoutMs),
      withSignal: (signal: AbortSignal) => withSignalOp(inner as never, signal),
      type: "Op",
    };
    const _op = () => inner;
    return Object.assign(_op, inner);
  };
  const out: Op<unknown, unknown, unknown[]> = Object.assign(g, {
    run: (...args: unknown[]) => runOp(g(...args) as never),
    withRetry: (policy?: RetryPolicy) => withRetryOp(out as never, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(out as never, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(out as never, signal),
    type: "Op" as const,
  }) as never;

  return out as Op<unknown, unknown, []> | Op<unknown, unknown, readonly unknown[]>;
};
