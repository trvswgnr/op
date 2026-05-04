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

/**
 * Passed to {@link ExitFn} when the run unwinds. `result` is the same {@link Result} instance `.run()` returns
 * for this settle (including {@link UnhandledException} on the error channel when relevant)
 */
export interface ExitContext<T, E> {
  readonly signal: AbortSignal;
  readonly result: Result<T, E | UnhandledException>;
}

/** Passed to {@link EnterFn} when a run starts, before the wrapped operation body begins. */
export interface EnterContext {
  readonly signal: AbortSignal;
}

export type EnterFn = (ctx: EnterContext) => unknown;
export type ExitFn<T = unknown, E = unknown> = (ctx: ExitContext<T, E>) => unknown;
export type LifecycleFn<T = unknown, E = unknown> = EnterFn | ExitFn<T, E>;

/** Widened hook for {@link builders.defer} where enclosing `Op` `T`/`E` are not inferred. */
export type AnyExitFn = ExitFn<unknown, unknown>;

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
  /**
   * Registers a lifecycle handler.
   *
   * - `"enter"` runs when this op wrapper starts a run. Handlers stack by wrapper depth (last chained runs first).
   * - `"exit"` runs when the run unwinds (success, failure, cancel), receiving the same {@link Result}
   *   instance `.run()` returns for that settle.
   */
  on(event: "enter", initialize: EnterFn): Op<T, E, A>;
  on(event: "exit", finalize: ExitFn<T, E>): Op<T, E, A>;
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

export type InferNullaryOpErr<R> = R extends Op<unknown, infer E, []> ? E : never;

export interface WithTap<T, E, A extends readonly unknown[]> {
  tap<R>(observe: (value: T) => R): Op<T, E | InferNullaryOpErr<R>, A>;
}

export interface WithTapErr<T, E, A extends readonly unknown[]> {
  tapErr<R>(observe: (error: TrackedErr<E>) => R): Op<T, TrackedErr<E> | InferNullaryOpErr<R>, A>;
}

export type RecoverValue<R> = R extends Op<infer T, unknown, []> ? T : Awaited<R>;
export type RecoverError<R> = R extends Op<unknown, infer E, []> ? E : never;

export type WithPredicateMethod<E> = { is: (value: unknown) => value is E };

export interface WithRecover<T, E, A extends readonly unknown[]> {
  recover<ECaught extends TrackedErr<E>, R>(
    predicate: (error: TrackedErr<E>) => error is ECaught,
    handler: (error: ECaught) => R,
  ): Op<T | RecoverValue<R>, TrackedErr<E, ECaught> | RecoverError<R>, A>;
  recover<ECaught extends TrackedErr<E>, R>(
    predicate: WithPredicateMethod<TrackedErr<ECaught>>,
    handler: (error: ECaught) => R,
  ): Op<T | RecoverValue<R>, TrackedErr<E, ECaught> | RecoverError<R>, A>;
  recover<R>(
    predicate: (error: TrackedErr<E>) => boolean,
    handler: (error: TrackedErr<E>) => R,
  ): Op<T | RecoverValue<R>, TrackedErr<E> | RecoverError<R>, A>;
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
  withRetry: (policy?: RetryPolicy) => Op<T, E, []>;
  withTimeout: (timeoutMs: number) => Op<T, E | TimeoutError, []>;
  withSignal: (signal: AbortSignal) => Op<T, E, []>;
  withRelease: (release: ReleaseFn<T>) => Op<T, E, []>;
  /** Backs public `.on("enter", fn)` on ops built from these hooks. */
  registerEnterInitialize: (initialize: EnterFn) => Op<T, E, []>;
  /** Backs public `.on("exit", fn)` on ops built from these hooks. */
  registerExitFinalize: (finalize: ExitFn<T, E>) => Op<T, E, []>;
}
