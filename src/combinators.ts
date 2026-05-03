import { ErrorGroup, UnhandledException } from "./errors.js";
import { type Instruction, type Op, type ExitFn, type ReleaseFn } from "./core/types.js";
import { SuspendInstruction } from "./core/instructions.js";
import { drive } from "./core/runtime.js";
import { onExitOp, withReleaseOp } from "./core/arity-ops.js";
import { withRetryOp, withTimeoutOp, withSignalOp, type RetryPolicy } from "./policies.js";
import { Err, Ok, Result } from "./result.js";
import { makeNullaryOp } from "./core/nullary-ops.js";

type AnyNullaryOp = Op<unknown, unknown, []>;
type InferOpOk<O> = O extends Op<infer T, unknown, []> ? T : never;
type InferOpErr<O> = O extends Op<unknown, infer E, []> ? E : never;

function makeCombinatorOp<T, E>(gen: () => Generator<Instruction<E>, T, unknown>): Op<T, E, []> {
  const self: Op<T, E, []> = makeNullaryOp(gen, {
    withRetry: (policy?: RetryPolicy) => withRetryOp(self, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(self, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(self, signal),
    withRelease: (release: ReleaseFn<T>) => withReleaseOp(self, release),
    registerExitFinalize: (finalize: ExitFn<T, E>) => onExitOp(self, finalize),
  });
  return self;
}

type FanOut<T, E> = {
  runs: readonly Promise<Result<T, E | UnhandledException>>[];
  controllers: readonly AbortController[];
  detach: () => void;
};

/**
 * Fan-out contract:
 * - Every child gets its own AbortController so winner/loser cancellation can be isolated
 * - We check `outerSignal.aborted` before adding a listener so already-cancelled parents
 *   synchronously cascade into children instead of missing the abort edge
 * - Callers must invoke `detach()` once the combinator settles to avoid retaining listeners
 */
function fanOut<T, E>(ops: readonly Op<T, E, []>[], outerSignal: AbortSignal): FanOut<T, E> {
  const entries = ops.map((op) => ({ op, controller: new AbortController() }));
  const cascade = () => entries.forEach((e) => e.controller.abort(outerSignal.reason));

  if (outerSignal.aborted) cascade();
  else outerSignal.addEventListener("abort", cascade, { once: true });

  const detach = () => outerSignal.removeEventListener("abort", cascade);
  const controllers = entries.map((e) => e.controller);
  const runs = entries.map((e) => drive(e.op, e.controller.signal));

  return { runs, controllers, detach };
}

function concurrencyLimit(
  concurrency: number | undefined,
  size: number,
): Result<number, UnhandledException> {
  if (concurrency === undefined) return Result.ok(size);

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    const cause = new RangeError("concurrency must be a positive integer");
    return Result.err(new UnhandledException({ cause }));
  }

  return Result.ok(Math.min(concurrency, size));
}

type AllOpOk<Ops extends readonly AnyNullaryOp[]> = { [K in keyof Ops]: InferOpOk<Ops[K]> };
type AllOpErr<Ops extends readonly AnyNullaryOp[]> = InferOpErr<Ops[number]> | UnhandledException;
export function allOp<const Ops extends readonly AnyNullaryOp[]>(
  ops: Ops,
  concurrency?: number,
): Op<AllOpOk<Ops>, AllOpErr<Ops>, []> {
  const snapshot = ops.slice();

  return makeCombinatorOp(function* () {
    const result = (yield new SuspendInstruction((outerSignal) =>
      driveAll(snapshot, outerSignal, concurrency),
    )) as Result<AllOpOk<Ops>, AllOpErr<Ops>>;

    if (result.isErr()) return yield* result;
    return result.value;
  });
}

/**
 * Drives the `Op.all` combinator
 *
 * Concurrency contract (`Op.all`, bounded mode):
 * - Up to `concurrency` children run at once
 * - First failure aborts in-flight siblings and prevents launching queued work
 * - The driver still waits for active siblings to settle so loser cleanup/finalizers run
 *   before returning the first observed error
 */
async function driveAll<T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
  concurrency: number | undefined,
): Promise<Result<T[], E | UnhandledException>> {
  const limit = concurrencyLimit(concurrency, ops.length);

  if (limit.isErr()) return limit;

  if (ops.length === 0) return Result.ok([]);

  if (limit.value >= ops.length) return driveAllUnbounded(ops, outerSignal);

  const results = Array<Result<T, E | UnhandledException> | undefined>(ops.length);

  const controllers = new Set<AbortController>();
  const cascade = () => controllers.forEach((c) => c.abort(outerSignal.reason));

  if (outerSignal.aborted) cascade();
  else outerSignal.addEventListener("abort", cascade, { once: true });

  let nextIndex = 0;
  let firstErr: Err<T[], E | UnhandledException> | undefined;
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
        firstErr = res;
        for (const c of controllers) c.abort();
      }
    }
  };
  const promises = Array(limit.value)
    .fill(undefined)
    .map(() => worker());

  const detach = () => outerSignal.removeEventListener("abort", cascade);

  await Promise.all(promises).finally(detach);

  if (firstErr !== undefined) return firstErr;
  return Result.ok(results.filter((r) => r !== undefined && r.isOk()).map((x) => x.value));
}

/**
 * Concurrency contract (`Op.all`, unbounded mode):
 * - All children start immediately
 * - First failure aborts all other children
 * - Return waits for every branch to settle, so aborted losers finish cleanup before the
 *   combinator resolves with either the first error or ordered successful values
 */
async function driveAllUnbounded<T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
): Promise<Result<T[], E | UnhandledException>> {
  const fan = fanOut(ops, outerSignal);

  let firstErr: Err<Result<T, E | UnhandledException>[], E | UnhandledException> | undefined;
  const observed = fan.runs.map((p, i) =>
    p.then((res) => {
      if (res.isErr() && firstErr === undefined) {
        firstErr = res;
        fan.controllers.forEach((c, j) => {
          if (j !== i) c.abort();
        });
      }
      return res;
    }),
  );

  const results = await Promise.all(observed);

  fan.detach();

  if (firstErr !== undefined) return firstErr;

  return Result.ok(results.filter(Result.isOk).map((x) => x.value));
}

type AllSettledOpOk<Ops extends readonly AnyNullaryOp[]> = {
  [K in keyof Ops]: Result<InferOpOk<Ops[K]>, InferOpErr<Ops[K]> | UnhandledException>;
};
export function allSettledOp<const Ops extends readonly AnyNullaryOp[]>(
  ops: Ops,
  concurrency?: number,
): Op<AllSettledOpOk<Ops>, never, []> {
  const snapshot = ops.slice();

  return makeCombinatorOp(function* () {
    const result = (yield new SuspendInstruction((outerSignal) =>
      driveAllSettled(snapshot, outerSignal, concurrency),
    )) as Result<AllSettledOpOk<Ops>, never>;

    if (result.isErr()) return yield* result;
    return result.value;
  });
}

export function settleOp<T, E>(op: Op<T, E, []>): Op<Result<T, E>, never, []> {
  return makeCombinatorOp(function* () {
    return (yield new SuspendInstruction((outerSignal) => drive(op, outerSignal))) as Result<T, E>;
  });
}

/**
 * Drives the `Op.allSettled` combinator
 *
 * Concurrency contract (`Op.allSettled`, bounded mode):
 * - Up to `concurrency` children run at once
 * - Child failures never abort siblings; every child is allowed to finish
 * - Settle result preserves input order and includes each branch outcome
 */
async function driveAllSettled<T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
  concurrency: number | undefined,
): Promise<Result<Result<T, E | UnhandledException>[], UnhandledException>> {
  const limit = concurrencyLimit(concurrency, ops.length);

  if (limit.isErr()) return limit;

  if (ops.length === 0) return Result.ok([]);

  if (limit.value >= ops.length) {
    const results = await driveAllSettledUnbounded(ops, outerSignal);
    return Result.ok(results);
  }

  const controllers = new Set<AbortController>();
  const cascade = () => controllers.forEach((c) => c.abort(outerSignal.reason));

  if (outerSignal.aborted) cascade();
  else outerSignal.addEventListener("abort", cascade, { once: true });

  const results = Array<Result<T, E | UnhandledException> | undefined>(ops.length);

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

  const promises = Array(limit.value)
    .fill(undefined)
    .map(() => worker());
  const detach = () => outerSignal.removeEventListener("abort", cascade);

  await Promise.all(promises).finally(detach);

  return Result.ok(results.filter((r) => r !== undefined));
}

async function driveAllSettledUnbounded<T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
): Promise<Result<T, E | UnhandledException>[]> {
  const fan = fanOut(ops, outerSignal);
  const results = await Promise.all(fan.runs);
  fan.detach();
  return results;
}

type AnyOpOk<Ops extends readonly AnyNullaryOp[]> = InferOpOk<Ops[number]>;
type AnyOpErr<Ops extends readonly AnyNullaryOp[]> = ErrorGroup<InferOpErr<Ops[number]>>;

export function anyOp<const Ops extends readonly AnyNullaryOp[]>(
  ops: Ops,
): Op<AnyOpOk<Ops>, AnyOpErr<Ops>, []> {
  const snapshot = ops.slice();

  return makeCombinatorOp(function* () {
    const result = (yield new SuspendInstruction((outerSignal) =>
      driveAny(snapshot, outerSignal),
    )) as Result<AnyOpOk<Ops>, AnyOpErr<Ops>>;

    if (result.isErr()) return yield* result;
    return result.value;
  });
}

/**
 * Drives the `Op.any` combinator
 *
 * Concurrency contract (`Op.any`):
 * - All children run concurrently
 * - First successful child becomes the winner and aborts remaining siblings
 * - The combinator still waits for aborted losers to settle so cleanup/finalizers complete
 * - If no success exists, returns ErrorGroup with errors in input order
 *
 * `Op.any` waits for aborted losers to settle so cleanup/finalizers finish
 * deterministically before run() returns; winner success still takes precedence
 */
async function driveAny<T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
): Promise<Result<T, ErrorGroup<E | UnhandledException>>> {
  if (ops.length === 0) {
    const e = Result.err(new ErrorGroup([], "Op.any requires at least one operation"));
    return Promise.resolve(e);
  }

  const fan = fanOut(ops, outerSignal);

  let winner: Ok<T> | undefined;
  const results = await Promise.all(
    fan.runs.map((p, i) =>
      p.then((res) => {
        if (res.isOk() && winner === undefined) {
          winner = res as Ok<T>;
          fan.controllers.forEach((c, j) => {
            if (j !== i) c.abort();
          });
        }
        return res;
      }),
    ),
  );

  fan.detach();

  if (winner !== undefined) return winner;

  const errors = results.filter(Result.isError).map((r) => r.error);
  return Result.err(new ErrorGroup(errors, "Op.any failed because all operations failed"));
}

type RaceOpOk<Ops extends readonly AnyNullaryOp[]> = InferOpOk<Ops[number]>;
type RaceOpErr<Ops extends readonly AnyNullaryOp[]> = InferOpErr<Ops[number]>;
export function raceOp<const Ops extends readonly AnyNullaryOp[]>(
  ops: Ops,
): Op<RaceOpOk<Ops>, RaceOpErr<Ops>, []> {
  const snapshot = ops.slice();
  return makeCombinatorOp(function* () {
    const result = (yield new SuspendInstruction((outerSignal) =>
      driveRace(snapshot, outerSignal),
    )) as Result<RaceOpOk<Ops>, RaceOpErr<Ops>>;

    if (result.isErr()) return yield* result;
    return result.value;
  });
}

/**
 * Drives the `Op.race` combinator
 *
 * Concurrency contract (`Op.race`):
 * - All children run concurrently
 * - First settler (Ok or Err) wins and aborts the rest
 * - The combinator waits for aborted losers to settle so cleanup/finalizers complete
 *   before returning the winner's outcome
 *
 * `Op.race` returns the first settler's outcome, but waits for aborted
 * losers to settle so cleanup/finalizers complete before run() returns
 */
async function driveRace<T, E>(
  ops: readonly Op<T, E, []>[],
  outerSignal: AbortSignal,
): Promise<Result<T, E | UnhandledException>> {
  if (ops.length === 0) {
    const cause = new Error("Op.race requires at least one operation");
    return Promise.resolve(Result.err(new UnhandledException({ cause })));
  }

  const fan = fanOut(ops, outerSignal);

  let winner: Result<T, E | UnhandledException> | undefined;
  await Promise.all(
    fan.runs.map((p, i) =>
      p.then((res) => {
        if (winner === undefined) {
          winner = res;
          fan.controllers.forEach((c, j) => {
            if (j !== i) c.abort();
          });
        }
        return res;
      }),
    ),
  );

  fan.detach();

  if (winner !== undefined) return winner;

  const cause = new Error("Op.race failed to produce a winner");
  return Result.err(new UnhandledException({ cause }));
}
