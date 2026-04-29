import { UnhandledException, UnreachableError, type TimeoutError } from "./errors.js";
import { err, ok, type Result, type Err, type ExtractErr } from "./result.js";
import type { RetryPolicy } from "./policies.js";
import type { Tagged } from "./tagged.js";

export interface Suspended {
  readonly _tag: "Suspended";
  readonly suspend: (signal: AbortSignal) => Promise<unknown>;
}

export type Instruction<E> = Err<unknown, E> | Suspended;

export interface WithRetry<T, E, A extends readonly unknown[]> {
  withRetry(policy?: RetryPolicy): Op<T, E, A>;
}

export interface WithTimeout<T, E, A extends readonly unknown[]> {
  withTimeout(timeoutMs: number): Op<T, E | TimeoutError, A>;
}

export interface WithSignal<T, E, A extends readonly unknown[]> {
  withSignal(signal: AbortSignal): Op<T, E, A>;
}

export interface WithMap<T, E, A extends readonly unknown[]> {
  map<U>(transform: (value: T) => U): Op<Awaited<U>, E, A>;
}

export interface WithFlatMap<T, E, A extends readonly unknown[]> {
  flatMap<U, E2>(bind: (value: T) => Op<U, E2, readonly []>): Op<U, E | E2, A>;
}

export interface OpBase<T, E> {
  readonly _tag: "Op";
  [Symbol.iterator](): Generator<Instruction<E>, T, unknown>;
}

export interface OpNullary<T, E>
  extends
    OpBase<T, E>,
    WithRetry<T, E, []>,
    WithTimeout<T, E, []>,
    WithSignal<T, E, []>,
    WithMap<T, E, []>,
    WithFlatMap<T, E, []> {
  (): OpBase<T, E>;
  run(): Promise<Result<T, E | UnhandledException>>;
}

export interface OpArity<T, E, A extends readonly unknown[]>
  extends
    WithRetry<T, E, A>,
    WithTimeout<T, E, A>,
    WithSignal<T, E, A>,
    WithMap<T, E, A>,
    WithFlatMap<T, E, A> {
  (...args: A): OpNullary<T, E>;
  run(...args: A): Promise<Result<T, E | UnhandledException>>;
}

type _Op<T, E, A extends readonly unknown[]> = [] extends A ? OpNullary<T, E> : OpArity<T, E, A>;

export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A> & Tagged<"Op">;

export function runOp<T, E>(op: Op<T, E, readonly []>): Promise<Result<T, E | UnhandledException>> {
  return drive(op, new AbortController().signal);
}

function isSuspended(value: unknown): value is Suspended {
  return (
    typeof value === "object" && value !== null && "_tag" in value && value._tag === "Suspended"
  );
}

function isErrInstruction<E>(value: unknown): value is Err<unknown, E> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("isErr" in value) ||
    typeof value.isErr !== "function"
  ) {
    return false;
  }
  return value.isErr();
}

export async function drive<T, E>(
  op: Op<T, E, readonly []>,
  signal: AbortSignal,
): Promise<Result<T, E | UnhandledException>> {
  try {
    const ef = typeof op === "function" ? op() : op;
    const iter = ef[Symbol.iterator]();
    const closeIterator = () => {
      try {
        iter.return?.(undefined as never);
      } catch {
        // Ignore cleanup faults so the original result/error is preserved.
      }
    };
    let step = iter.next();
    while (!step.done) {
      try {
        if (isSuspended(step.value)) {
          step = iter.next(await step.value.suspend(signal));
          continue;
        }
        if (isErrInstruction<E>(step.value)) {
          closeIterator();
          return err(step.value.error);
        }
        closeIterator();
        return err(
          new UnhandledException({
            cause: new TypeError("Op generator yielded an invalid instruction"),
          }),
        );
      } catch (cause) {
        closeIterator();
        return err(new UnhandledException({ cause }));
      }
    }
    const value = await step.value;
    return ok(value);
  } catch (cause) {
    return err(new UnhandledException({ cause }));
  }
}

export interface FromGenFn {
  <Y extends Instruction<unknown>, T>(f: () => Generator<Y, T, unknown>): Op<T, ExtractErr<Y>, []>;
  <Y extends Instruction<unknown>, T, A extends readonly unknown[]>(
    f: (...args: A) => Generator<Y, T, unknown>,
  ): Op<T, ExtractErr<Y>, A>;
  (
    f: (...args: unknown[]) => Generator<Instruction<unknown>, unknown, unknown>,
  ): Op<unknown, unknown, []> | Op<unknown, unknown, readonly unknown[]>;
}

export interface OpHooks<T, E> {
  withRetry: (policy?: RetryPolicy) => Op<T, E, readonly []>;
  withTimeout: (timeoutMs: number) => Op<T, E | TimeoutError, readonly []>;
  withSignal: (signal: AbortSignal) => Op<T, E, readonly []>;
}

export const makeNullaryOp = <T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
  hooks: OpHooks<T, E>,
): Op<T, E, readonly []> => {
  const self = {
    [Symbol.iterator]: gen,
    run: () => runOp(self as never),
    withRetry: hooks.withRetry,
    withTimeout: hooks.withTimeout,
    withSignal: hooks.withSignal,
    map: <U>(transform: (value: T) => U) => mapOp(self as never, transform),
    flatMap: <U, E2>(bind: (value: T) => Op<U, E2, readonly []>) => flatMapOp(self as never, bind),
    _tag: "Op" as const,
  };
  const op = () => self;
  return Object.assign(op, self) as never;
};

const mapNullaryOp = <T, E, U>(
  op: Op<T, E, readonly []>,
  transform: (value: T) => U,
): Op<Awaited<U>, E, readonly []> => {
  return makeNullaryOp<Awaited<U>, E | UnhandledException>(
    function* () {
      const result = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(op, signal),
      }) as Result<T, E | UnhandledException>;
      if (result.isErr()) {
        yield err(result.error);
        throw new UnreachableError();
      }
      const mapped = (yield {
        _tag: "Suspended" as const,
        suspend: () => Promise.resolve(transform(result.value)),
      }) as Awaited<U>;
      return mapped;
    },
    {
      withRetry: (policy?: RetryPolicy) =>
        mapNullaryOp(op.withRetry(policy) as never, transform) as never,
      withTimeout: (timeoutMs: number) =>
        mapNullaryOp(op.withTimeout(timeoutMs) as never, transform) as never,
      withSignal: (signal: AbortSignal) =>
        mapNullaryOp(op.withSignal(signal) as never, transform) as never,
    },
  ) as never;
};

const flatMapNullaryOp = <T, E, U, E2>(
  op: Op<T, E, readonly []>,
  bind: (value: T) => Op<U, E2, readonly []>,
): Op<U, E | E2, readonly []> => {
  return makeNullaryOp<U, E | E2 | UnhandledException>(
    function* () {
      const first = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(op, signal),
      }) as Result<T, E | UnhandledException>;
      if (first.isErr()) {
        yield err(first.error);
        throw new UnreachableError();
      }

      const second = (yield {
        _tag: "Suspended" as const,
        suspend: (signal: AbortSignal) => drive(bind(first.value), signal),
      }) as Result<U, E2 | UnhandledException>;
      if (second.isErr()) {
        yield err(second.error);
        throw new UnreachableError();
      }
      return second.value;
    },
    {
      withRetry: (policy?: RetryPolicy) =>
        flatMapNullaryOp(op.withRetry(policy) as never, bind) as never,
      withTimeout: (timeoutMs: number) =>
        flatMapNullaryOp(op.withTimeout(timeoutMs) as never, bind) as never,
      withSignal: (signal: AbortSignal) =>
        flatMapNullaryOp(op.withSignal(signal) as never, bind) as never,
    },
  ) as never;
};

export const mapOp = <T, E, A extends readonly unknown[], U>(
  op: Op<T, E, A>,
  transform: (value: T) => U,
): Op<Awaited<U>, E, A> => {
  if (Symbol.iterator in op) {
    return mapNullaryOp(op as Op<T, E, readonly []>, transform) as never;
  }

  const g = (...args: A) => mapNullaryOp((op as OpArity<T, E, A>)(...args) as never, transform);
  const out = Object.assign(g, {
    run: (...args: A) => drive(g(...args) as never, new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => mapOp(op.withRetry(policy), transform),
    withTimeout: (timeoutMs: number) => mapOp(op.withTimeout(timeoutMs), transform),
    withSignal: (signal: AbortSignal) => mapOp(op.withSignal(signal), transform),
    map: <U2>(next: (value: Awaited<U>) => U2) => mapOp(out as never, next),
    flatMap: <U2, E2>(bind: (value: Awaited<U>) => Op<U2, E2, readonly []>) =>
      flatMapOp(out as never, bind),
    _tag: "Op" as const,
  });
  return out as never;
};

export const flatMapOp = <T, E, A extends readonly unknown[], U, E2>(
  op: Op<T, E, A>,
  bind: (value: T) => Op<U, E2, readonly []>,
): Op<U, E | E2, A> => {
  if (Symbol.iterator in op) {
    return flatMapNullaryOp(op as Op<T, E, readonly []>, bind) as never;
  }

  const g = (...args: A) => flatMapNullaryOp((op as OpArity<T, E, A>)(...args) as never, bind);
  const out = Object.assign(g, {
    run: (...args: A) => drive(g(...args) as never, new AbortController().signal),
    withRetry: (policy?: RetryPolicy) => flatMapOp(op.withRetry(policy), bind),
    withTimeout: (timeoutMs: number) => flatMapOp(op.withTimeout(timeoutMs), bind),
    withSignal: (signal: AbortSignal) => flatMapOp(op.withSignal(signal), bind),
    map: <U2>(transform: (value: U) => U2) => mapOp(out as never, transform),
    flatMap: <U2, E3>(nextBind: (value: U) => Op<U2, E3, readonly []>) =>
      flatMapOp(out as never, nextBind),
    _tag: "Op" as const,
  });
  return out as never;
};
