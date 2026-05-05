import type { TimeoutError, UnhandledException } from "../errors.js";
import type { Err, Result } from "../result.js";
import type { RetryPolicy } from "../policies.js";
import type { RegisterExitFinalizerInstruction, SuspendInstruction } from "./instructions.js";
import { Tagged } from "../tagged.js";
import { NULLARY_OP_SYMBOL } from "./nullary-ops.js";

export type TrackedErr<E, Excluded = never> = E extends UnhandledException
  ? never
  : E extends Excluded
    ? never
    : E;

export type InferOpOk<R> = R extends Op<infer T, unknown, infer _> ? T : Awaited<R>;
export type InferOpErr<R> = R extends Op<unknown, infer E, infer _> ? E : never;

/**
 * Passed to {@link ExitFn} when the run unwinds.
 *
 * - `args` are the runtime inputs for this run
 * - `result` is the same {@link Result} instance `.run()` returns for this settle
 *   (including {@link UnhandledException} on the error channel when relevant)
 */
export interface ExitContext<T, E, A extends readonly unknown[] = []> {
  readonly signal: AbortSignal;
  readonly args: A;
  readonly result: Result<T, E | UnhandledException>;
}

/** Passed to {@link EnterFn} when a run starts, before the wrapped operation body begins. */
export interface EnterContext<A extends readonly unknown[] = []> {
  readonly signal: AbortSignal;
  readonly args: A;
}

export type EnterFn<A extends readonly unknown[] = []> = (ctx: EnterContext<A>) => unknown;
export type ExitFn<T = unknown, E = unknown, A extends readonly unknown[] = []> = (
  ctx: ExitContext<T, E, A>,
) => unknown;
export type LifecycleFn<T = unknown, E = unknown, A extends readonly unknown[] = []> =
  | EnterFn<A>
  | ExitFn<T, E, A>;

/** Widened hook for {@link builders.defer} where enclosing `Op` `T`/`E` are not inferred. */
export type AnyExitFn = ExitFn<unknown, unknown, readonly unknown[]>;

export type Instruction<E> =
  | Err<unknown, E>
  | SuspendInstruction
  | RegisterExitFinalizerInstruction;

export interface WithRetry<T, E, A extends readonly unknown[]> {
  withRetry(policy?: RetryPolicy): Op<T, E, A>;
}

export interface WithTimeout<T, E, A extends readonly unknown[]> {
  withTimeout(timeoutMs: number): Op<T, E | TimeoutError, A>;
}

export interface WithSignal<T, E, A extends readonly unknown[]> {
  withSignal(signal: AbortSignal): Op<T, E, A>;
}

export type ReleaseFn<T> = (value: T) => unknown;

/** Lifecycle channels exposed by {@link Op}. */
export type OpLifecycleHook = "enter" | "exit";

export interface WithRelease<T, E, A extends readonly unknown[]> {
  withRelease(release: ReleaseFn<T>): Op<T, E, A>;
}

export interface WithLifecycleHooks<T, E, A extends readonly unknown[]> {
  /** Register a handler that runs before the operation body starts. */
  on(event: "enter", initialize: EnterFn<A>): Op<T, E, A>;
  /** Register a handler that runs after the operation settles. */
  on(event: "exit", finalize: ExitFn<T, E, A>): Op<T, E, A>;
}

export interface WithMap<T, E, A extends readonly unknown[]> {
  map<U>(transform: (value: T) => U): Op<Awaited<U>, E, A>;
}

export interface WithMapErr<T, E, A extends readonly unknown[]> {
  mapErr<E2>(transform: (error: TrackedErr<E>) => E2): Op<T, E2, A>;
}

export interface WithFlatMap<T, E, A extends readonly unknown[]> {
  flatMap<U, E2>(bind: (value: T) => Op<U, E2, []>): Op<U, E | E2, A>;
}

export interface WithTap<T, E, A extends readonly unknown[]> {
  tap<R>(observe: (value: T) => R): Op<T, E | InferOpErr<R>, A>;
}

export interface WithTapErr<T, E, A extends readonly unknown[]> {
  tapErr<R>(observe: (error: TrackedErr<E>) => R): Op<T, TrackedErr<E> | InferOpErr<R>, A>;
}

export type WithPredicateMethod<E> = { is: (value: unknown) => value is E };

export interface WithRecover<T, E, A extends readonly unknown[]> {
  recover<ECaught extends TrackedErr<E>, R>(
    predicate: (error: TrackedErr<E>) => error is ECaught,
    handler: (error: ECaught) => R,
  ): Op<T | InferOpOk<R>, TrackedErr<E, ECaught> | InferOpErr<R>, A>;
  recover<ECaught extends TrackedErr<E>, R>(
    predicate: WithPredicateMethod<TrackedErr<ECaught>>,
    handler: (error: ECaught) => R,
  ): Op<T | InferOpOk<R>, TrackedErr<E, ECaught> | InferOpErr<R>, A>;
  recover<R>(
    predicate: (error: TrackedErr<E>) => boolean,
    handler: (error: TrackedErr<E>) => R,
  ): Op<T | InferOpOk<R>, TrackedErr<E> | InferOpErr<R>, A>;
}

export interface OpNullary<T, E>
  extends
    WithRetry<T, E, []>,
    WithTimeout<T, E, []>,
    WithSignal<T, E, []>,
    WithRelease<T, E, []>,
    WithLifecycleHooks<T, E, []>,
    WithMap<T, E, []>,
    WithMapErr<T, E, []>,
    WithFlatMap<T, E, []>,
    WithTap<T, E, []>,
    WithTapErr<T, E, []>,
    WithRecover<T, E, []> {
  (): OpNullary<T, E>;
  run(): Promise<Result<T, E | UnhandledException>>;
  readonly _tag: "Op";
  [Symbol.iterator](): Generator<Instruction<E>, T, unknown>;
  [NULLARY_OP_SYMBOL]: true;
}

export interface OpArity<T, E, A extends readonly unknown[]>
  extends
    WithRetry<T, E, A>,
    WithTimeout<T, E, A>,
    WithSignal<T, E, A>,
    WithRelease<T, E, A>,
    WithLifecycleHooks<T, E, A>,
    WithMap<T, E, A>,
    WithMapErr<T, E, A>,
    WithFlatMap<T, E, A>,
    WithTap<T, E, A>,
    WithTapErr<T, E, A>,
    WithRecover<T, E, A> {
  (...args: A): Op<T, E, []>;
  run(...args: A): Promise<Result<T, E | UnhandledException>>;
}

export type Op<T, E, A extends readonly unknown[]> = (A extends []
  ? OpNullary<T, E>
  : OpArity<T, E, A>) &
  Tagged<"Op">;

export interface OpHooks<T, E> {
  /** Inner op to push policy wrappers to (when present with `rebuild`). */
  inner?: Op<unknown, unknown, []>;
  /** Rebuild this operator around a new inner op for push-through policy behavior. */
  rebuild?: (newInner: Op<unknown, unknown, []>) => Op<T, unknown, []>;
  /** Optional timeout-specific rebuild for error-channel widening edge cases. */
  rebuildForTimeout?: (newInner: Op<unknown, unknown, []>) => Op<T, unknown, []>;
  withRelease: (release: ReleaseFn<T>) => Op<T, E, []>;
  /** Backs public `.on("enter", fn)` on ops built from these hooks. */
  registerEnterInitialize: (initialize: EnterFn<[]>) => Op<T, E, []>;
  /** Backs public `.on("exit", fn)` on ops built from these hooks. */
  registerExitFinalize: (finalize: ExitFn<T, E, []>) => Op<T, E, []>;
}
