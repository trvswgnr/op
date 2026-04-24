import { ErrorGroup, UnexpectedError, UnreachableError } from "./errors.js";
import { drive, makeNullaryOp, type Instruction, type Op } from "./core.js";
import { withRetryOp, withTimeoutOp, withSignalOp, type RetryPolicy } from "./policies.js";
import { err, ok, type Err, type Result } from "./result.js";

type NullaryOp = Op<unknown, unknown, readonly []>;
type SuccessOf<O> = O extends Op<infer T, unknown, readonly []> ? T : never;
type ErrorOf<O> = O extends Op<unknown, infer E, readonly []> ? E : never;

const makeCombinatorOp = <T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
): Op<T, E, readonly []> => {
  let self!: Op<T, E, readonly []>;
  self = makeNullaryOp(gen, {
    withRetry: (policy?: RetryPolicy) => withRetryOp(self as never, policy) as never,
    withTimeout: (timeoutMs: number) => withTimeoutOp(self as never, timeoutMs) as never,
    withSignal: (signal: AbortSignal) => withSignalOp(self as never, signal) as never,
  });
  return self;
};

const fanOut = <T, E>(
  ops: readonly Op<T, E, readonly []>[],
  outerSignal: AbortSignal,
): {
  runs: readonly Promise<Result<T, E | UnexpectedError>>[];
  controllers: readonly AbortController[];
  detach: () => void;
} => {
  const entries = ops.map((op) => ({ op, controller: new AbortController() }));
  const cascade = () => {
    for (const e of entries) e.controller.abort(outerSignal.reason);
  };
  if (outerSignal.aborted) cascade();
  else outerSignal.addEventListener("abort", cascade, { once: true });
  const detach = () => outerSignal.removeEventListener("abort", cascade);
  const controllers = entries.map((e) => e.controller);
  const runs = entries.map((e) => drive(e.op, e.controller.signal));
  return { runs, controllers, detach };
};

export const allOp = <const Ops extends readonly NullaryOp[]>(
  ops: Ops,
): Op<
  { [K in keyof Ops]: SuccessOf<Ops[K]> },
  ErrorOf<Ops[number]> | UnexpectedError,
  readonly []
> => {
  const snapshot = ops.slice();
  return makeCombinatorOp(function* () {
    const result = (yield {
      type: "Suspended" as const,
      suspend: (outerSignal) => driveAll(snapshot, outerSignal),
    }) as Result<never, never>;
    if (!result.ok) {
      yield err(result.error);
      throw new UnreachableError();
    }
    return result.value;
  });
};

const driveAll = async <T, E>(
  ops: readonly Op<T, E, readonly []>[],
  outerSignal: AbortSignal,
): Promise<Result<T[], E | UnexpectedError>> => {
  if (ops.length === 0) return ok([]);
  const { runs, controllers, detach } = fanOut(ops, outerSignal);

  let firstErr: Err<E | UnexpectedError> | undefined;

  const observed = runs.map((p, i) =>
    p.then((res) => {
      if (!res.ok && firstErr === undefined) {
        firstErr = res;
        controllers.forEach((c, j) => {
          if (j !== i) c.abort();
        });
      }
      return res;
    }),
  );

  const results = await Promise.all(observed);
  detach();

  if (firstErr !== undefined) return firstErr;
  const values: T[] = [];
  for (const r of results) if (r.ok) values.push(r.value);
  return ok(values);
};

export const allSettledOp = <const Ops extends readonly NullaryOp[]>(
  ops: Ops,
): Op<
  { [K in keyof Ops]: Result<SuccessOf<Ops[K]>, ErrorOf<Ops[K]> | UnexpectedError> },
  never,
  readonly []
> => {
  const snapshot = ops.slice();
  type V = { [K in keyof Ops]: Result<SuccessOf<Ops[K]>, ErrorOf<Ops[K]> | UnexpectedError> };
  return makeCombinatorOp<V, never>(function* (): Generator<Instruction<never>, V, unknown> {
    const value = (yield {
      type: "Suspended" as const,
      suspend: (outerSignal) => driveAllSettled(snapshot, outerSignal),
    }) as V;
    return value;
  });
};

const driveAllSettled = async <T, E>(
  ops: readonly Op<T, E, readonly []>[],
  outerSignal: AbortSignal,
): Promise<Result<T, E | UnexpectedError>[]> => {
  if (ops.length === 0) return [];
  const fan = fanOut(ops, outerSignal);
  const results = await Promise.all(fan.runs);
  fan.detach();
  return results;
};

export const anyOp = <const Ops extends readonly NullaryOp[]>(
  ops: Ops,
): Op<SuccessOf<Ops[number]>, ErrorGroup<ErrorOf<Ops[number]> | UnexpectedError>, readonly []> => {
  const snapshot = ops.slice();
  type V = SuccessOf<Ops[number]>;
  type E = ErrorGroup<ErrorOf<Ops[number]> | UnexpectedError>;
  return makeCombinatorOp<V, E>(function* (): Generator<Instruction<E>, V, unknown> {
    const result = (yield {
      type: "Suspended" as const,
      suspend: (outerSignal) => driveAny(snapshot, outerSignal),
    }) as Result<V, E>;
    if (!result.ok) {
      yield err(result.error);
      throw new UnreachableError();
    }
    return result.value;
  });
};

const driveAny = <T, E>(
  ops: readonly Op<T, E, readonly []>[],
  outerSignal: AbortSignal,
): Promise<Result<T, ErrorGroup<E | UnexpectedError>>> => {
  if (ops.length === 0) {
    return Promise.resolve(err(new ErrorGroup([], "Op.any requires at least one operation")));
  }
  const fan = fanOut(ops, outerSignal);

  return new Promise<Result<T, ErrorGroup<E | UnexpectedError>>>((resolve) => {
    let winnerDecided = false;

    const observed = fan.runs.map((p, i) =>
      p.then((res) => {
        if (!winnerDecided && res.ok) {
          winnerDecided = true;
          fan.controllers.forEach((c, j) => {
            if (j !== i) c.abort();
          });
          fan.detach();
          resolve(ok(res.value));
        }
        return res;
      }),
    );

    Promise.all(observed).then((results) => {
      if (winnerDecided) return;
      fan.detach();
      const errors: (E | UnexpectedError)[] = [];
      for (const r of results) if (!r.ok) errors.push(r.error);
      resolve(err(new ErrorGroup(errors, "Op.any failed because all operations failed")));
    });
  });
};

export const raceOp = <const Ops extends readonly NullaryOp[]>(
  ops: Ops,
): Op<SuccessOf<Ops[number]>, ErrorOf<Ops[number]> | UnexpectedError, readonly []> => {
  const snapshot = ops.slice();
  type V = SuccessOf<Ops[number]>;
  type E = ErrorOf<Ops[number]> | UnexpectedError;
  return makeCombinatorOp<V, E>(function* (): Generator<Instruction<E>, V, unknown> {
    const result = (yield {
      type: "Suspended" as const,
      suspend: (outerSignal) => driveRace(snapshot, outerSignal),
    }) as Result<V, E>;
    if (!result.ok) {
      yield err(result.error);
      throw new UnreachableError();
    }
    return result.value;
  });
};

const driveRace = <T, E>(
  ops: readonly Op<T, E, readonly []>[],
  outerSignal: AbortSignal,
): Promise<Result<T, E | UnexpectedError>> => {
  if (ops.length === 0) {
    return Promise.resolve(err(new UnexpectedError("Op.race requires at least one operation")));
  }
  const { runs, controllers, detach } = fanOut(ops, outerSignal);

  return new Promise((resolve) => {
    let settled = false;
    runs.forEach((p, i) => {
      p.then((res) => {
        if (settled) return;
        settled = true;
        controllers.forEach((c, j) => {
          if (j !== i) c.abort();
        });
        detach();
        resolve(res);
      });
    });
  });
};
