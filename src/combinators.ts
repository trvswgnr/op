import { ErrorGroup, UnhandledException } from "./errors.js";
import { type Instruction, type Op, type ExitFn, type ReleaseFn } from "./core/types.js";
import { SuspendInstruction } from "./core/instructions.js";
import { drive } from "./core/runtime.js";
import { onExitOp, withReleaseOp } from "./core/arity-ops.js";
import { withRetryOp, withTimeoutOp, withSignalOp, type RetryPolicy } from "./policies.js";
import { Result } from "./result.js";
import { makeNullaryOp } from "./core/nullary-ops.js";

type NullaryOp = Op<unknown, unknown, []>;
type SuccessOf<O> = O extends Op<infer T, unknown, []> ? T : never;
type ErrorOf<O> = O extends Op<unknown, infer E, []> ? E : never;

const makeCombinatorOp = <T, E>(gen: () => Generator<Instruction<E>, T, unknown>): Op<T, E, []> => {
  const self: Op<T, E, []> = makeNullaryOp(gen, {
    withRetry: (policy?: RetryPolicy) => withRetryOp(self, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(self, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(self, signal),
    withRelease: (release: ReleaseFn<T>) => withReleaseOp(self, release),
    registerExitFinalize: (finalize: ExitFn<T, E>) => onExitOp(self, finalize),
  });
  return self;
};

const fanOut = <T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
): {
  runs: readonly Promise<Result<T, E | UnhandledException>>[];
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

const concurrencyLimit = (
  concurrency: number | undefined,
  size: number,
): Result<number, UnhandledException> => {
  if (concurrency === undefined) return Result.ok(size);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    return Result.err(
      new UnhandledException({ cause: new RangeError("concurrency must be a positive integer") }),
    );
  }
  return Result.ok(Math.min(concurrency, size));
};

export const allOp = <const Ops extends readonly NullaryOp[]>(
  ops: Ops,
  concurrency?: number,
): Op<{ [K in keyof Ops]: SuccessOf<Ops[K]> }, ErrorOf<Ops[number]> | UnhandledException, []> => {
  const snapshot = ops.slice();
  return makeCombinatorOp(function* () {
    const result = (yield new SuspendInstruction((outerSignal) =>
      driveAll(snapshot, outerSignal, concurrency),
    )) as Result<never, never>;
    if (result.isErr()) {
      return yield* Result.err(result.error);
    }
    return result.value;
  });
};

const driveAll = async <T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
  concurrency: number | undefined,
): Promise<Result<T[], E | UnhandledException>> => {
  const limit = concurrencyLimit(concurrency, ops.length);
  if (limit.isErr()) return Result.err(limit.error);

  if (ops.length === 0) return Result.ok([]);
  if (limit.value >= ops.length) return driveAllUnbounded(ops, outerSignal);

  const results: (Result<T, E | UnhandledException> | undefined)[] = new Array(ops.length);
  const controllers = new Set<AbortController>();
  const cascade = () => {
    for (const c of controllers) c.abort(outerSignal.reason);
  };
  if (outerSignal.aborted) cascade();
  else outerSignal.addEventListener("abort", cascade, { once: true });

  let nextIndex = 0;
  let firstErr: (E | UnhandledException) | undefined;

  const worker = async () => {
    while (firstErr === undefined) {
      const i = nextIndex;
      nextIndex += 1;
      const op = ops[i];
      if (op === undefined) return;

      const controller = new AbortController();
      controllers.add(controller);
      if (outerSignal.aborted) controller.abort(outerSignal.reason);
      const res = await drive(op, controller.signal);
      controllers.delete(controller);
      results[i] = res;

      if (res.isErr() && firstErr === undefined) {
        firstErr = res.error;
        for (const c of controllers) c.abort();
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: limit.value }, () => worker()));
  } finally {
    outerSignal.removeEventListener("abort", cascade);
  }

  if (firstErr !== undefined) return Result.err(firstErr);
  const values: T[] = [];
  for (const r of results) if (r?.isOk()) values.push(r.value);
  return Result.ok(values);
};

const driveAllUnbounded = async <T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
): Promise<Result<T[], E | UnhandledException>> => {
  const { runs, controllers, detach } = fanOut(ops, outerSignal);

  let firstErr: (E | UnhandledException) | undefined;

  const observed = runs.map((p, i) =>
    p.then((res) => {
      if (res.isErr() && firstErr === undefined) {
        firstErr = res.error;
        controllers.forEach((c, j) => {
          if (j !== i) c.abort();
        });
      }
      return res;
    }),
  );

  const results = await Promise.all(observed);
  detach();

  if (firstErr !== undefined) return Result.err(firstErr);
  const values: T[] = [];
  for (const r of results) if (r.isOk()) values.push(r.value);
  return Result.ok(values);
};

export const allSettledOp = <const Ops extends readonly NullaryOp[]>(
  ops: Ops,
  concurrency?: number,
): Op<
  { [K in keyof Ops]: Result<SuccessOf<Ops[K]>, ErrorOf<Ops[K]> | UnhandledException> },
  UnhandledException,
  []
> => {
  const snapshot = ops.slice();
  type V = { [K in keyof Ops]: Result<SuccessOf<Ops[K]>, ErrorOf<Ops[K]> | UnhandledException> };
  return makeCombinatorOp<V, UnhandledException>(function* (): Generator<
    Instruction<UnhandledException>,
    V,
    unknown
  > {
    const result = (yield new SuspendInstruction((outerSignal) =>
      driveAllSettled(snapshot, outerSignal, concurrency),
    )) as Result<V, UnhandledException>;
    if (result.isErr()) {
      return yield* Result.err(result.error);
    }
    return result.value;
  });
};

export const settleOp = <T, E>(
  op: Op<T, E, []>,
): Op<Result<T, E | UnhandledException>, never, []> => {
  return makeCombinatorOp<Result<T, E | UnhandledException>, never>(function* () {
    const value = (yield new SuspendInstruction((outerSignal) => drive(op, outerSignal))) as Result<
      T,
      E | UnhandledException
    >;
    return value;
  });
};

const driveAllSettled = async <T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
  concurrency: number | undefined,
): Promise<Result<Result<T, E | UnhandledException>[], UnhandledException>> => {
  const limit = concurrencyLimit(concurrency, ops.length);
  if (limit.isErr()) return Result.err(limit.error);

  if (ops.length === 0) return Result.ok([]);
  if (limit.value >= ops.length) return Result.ok(await driveAllSettledUnbounded(ops, outerSignal));

  const results: (Result<T, E | UnhandledException> | undefined)[] = new Array(ops.length);
  const controllers = new Set<AbortController>();
  const cascade = () => {
    for (const c of controllers) c.abort(outerSignal.reason);
  };
  if (outerSignal.aborted) cascade();
  else outerSignal.addEventListener("abort", cascade, { once: true });

  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      const op = ops[i];
      if (op === undefined) return;

      const controller = new AbortController();
      controllers.add(controller);
      if (outerSignal.aborted) controller.abort(outerSignal.reason);
      results[i] = await drive(op, controller.signal);
      controllers.delete(controller);
    }
  };

  try {
    await Promise.all(Array.from({ length: limit.value }, () => worker()));
  } finally {
    outerSignal.removeEventListener("abort", cascade);
  }

  return Result.ok(results.filter((r): r is Result<T, E | UnhandledException> => r !== undefined));
};

const driveAllSettledUnbounded = async <T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
): Promise<Result<T, E | UnhandledException>[]> => {
  const fan = fanOut(ops, outerSignal);
  const results = await Promise.all(fan.runs);
  fan.detach();
  return results;
};

export const anyOp = <const Ops extends readonly NullaryOp[]>(
  ops: Ops,
): Op<SuccessOf<Ops[number]>, ErrorGroup<ErrorOf<Ops[number]> | UnhandledException>, []> => {
  const snapshot = ops.slice();
  type V = SuccessOf<Ops[number]>;
  type E = ErrorGroup<ErrorOf<Ops[number]> | UnhandledException>;
  return makeCombinatorOp<V, E>(function* (): Generator<Instruction<E>, V, unknown> {
    const result = (yield new SuspendInstruction((outerSignal) =>
      driveAny(snapshot, outerSignal),
    )) as Result<V, E>;
    if (result.isErr()) {
      return yield* Result.err(result.error);
    }
    return result.value;
  });
};

const driveAny = <T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
): Promise<Result<T, ErrorGroup<E | UnhandledException>>> => {
  if (ops.length === 0) {
    return Promise.resolve(
      Result.err(new ErrorGroup([], "Op.any requires at least one operation")),
    );
  }
  const fan = fanOut(ops, outerSignal);

  return new Promise<Result<T, ErrorGroup<E | UnhandledException>>>((resolve) => {
    let winnerDecided = false;

    const observed = fan.runs.map((p, i) =>
      p.then((res) => {
        if (!winnerDecided && res.isOk()) {
          winnerDecided = true;
          fan.controllers.forEach((c, j) => {
            if (j !== i) c.abort();
          });
          fan.detach();
          resolve(Result.ok(res.value));
        }
        return res;
      }),
    );

    Promise.all(observed).then((results) => {
      if (winnerDecided) return;
      fan.detach();
      const errors: (E | UnhandledException)[] = [];
      for (const r of results) if (r.isErr()) errors.push(r.error);
      resolve(Result.err(new ErrorGroup(errors, "Op.any failed because all operations failed")));
    });
  });
};

export const raceOp = <const Ops extends readonly NullaryOp[]>(
  ops: Ops,
): Op<SuccessOf<Ops[number]>, ErrorOf<Ops[number]> | UnhandledException, []> => {
  const snapshot = ops.slice();
  type V = SuccessOf<Ops[number]>;
  type E = ErrorOf<Ops[number]> | UnhandledException;
  return makeCombinatorOp<V, E>(function* (): Generator<Instruction<E>, V, unknown> {
    const result = (yield new SuspendInstruction((outerSignal) =>
      driveRace(snapshot, outerSignal),
    )) as Result<V, E>;
    if (result.isErr()) {
      return yield* Result.err(result.error);
    }
    return result.value;
  });
};

const driveRace = <T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
): Promise<Result<T, E | UnhandledException>> => {
  if (ops.length === 0) {
    return Promise.resolve(
      Result.err(
        new UnhandledException({ cause: new Error("Op.race requires at least one operation") }),
      ),
    );
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
