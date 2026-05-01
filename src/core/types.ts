import type { TimeoutError, UnhandledException } from "../errors.js";
import type { Err, Result } from "../result.js";
import type { RetryPolicy } from "../policies.js";
import type { RegisterExitFinalizerInstruction, SuspendInstruction } from "./instructions.js";
import { Tagged } from "../tagged.js";

/**
 * Passed to {@link ExitFn} when the run unwinds. `result` is the same {@link Result} instance `.run()` returns
 * for this settle (including {@link UnhandledException} on the error channel when relevant).
 */
export interface ExitContext<T, E> {
  readonly signal: AbortSignal;
  readonly result: Result<T, E | UnhandledException>;
}

export type ExitFn<T = unknown, E = unknown> = (ctx: ExitContext<T, E>) => unknown;

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

/** Lifecycle channels exposed by {@link Op}. Today only `"exit"` is supported; more may be added later. */
export type OpLifecycleHook = "exit";

export interface WithRelease<T, E, A extends readonly unknown[]> {
  withRelease(release: ReleaseFn<T>): Op<T, E, A>;
}

export interface WithLifecycleHooks<T, E, A extends readonly unknown[]> {
  /** Registers a lifecycle handler. `"exit"` runs when the run unwinds (success, failure, cancel). Receives {@link ExitContext} with the same `result` `.run()` returns. Chaining stacks handlers in LIFO order with `Op.defer` / `.withRelease` on the same run. */
  on(event: OpLifecycleHook, finalize: ExitFn<T, E>): Op<T, E, A>;
}

export interface WithMap<T, E, A extends readonly unknown[]> {
  map<U>(transform: (value: T) => U): Op<Awaited<U>, E, A>;
}

export interface WithMapErr<T, E, A extends readonly unknown[]> {
  mapErr<E2>(transform: (error: E) => E2): Op<T, E2, A>;
}

export interface WithFlatMap<T, E, A extends readonly unknown[]> {
  flatMap<U, E2>(bind: (value: T) => Op<U, E2, []>): Op<U, E | E2, A>;
}

export type InferNullaryOpErr<R> = R extends Op<unknown, infer E, []> ? E : never;

export interface WithTap<T, E, A extends readonly unknown[]> {
  tap<R>(observe: (value: T) => R): Op<T, E | InferNullaryOpErr<R>, A>;
}

export interface WithTapErr<T, E, A extends readonly unknown[]> {
  tapErr<R>(observe: (error: E) => R): Op<T, E | InferNullaryOpErr<R>, A>;
}

export type RecoverValue<R> = R extends Op<infer T, unknown, []> ? T : Awaited<R>;
export type RecoverError<R> = R extends Op<unknown, infer E, []> ? E : never;

export type WithPredicateMethod<E> = { is: (value: unknown) => value is E };

export interface WithRecover<T, E, A extends readonly unknown[]> {
  recover<ECaught extends E, R>(
    predicate: (error: E) => error is ECaught,
    handler: (error: ECaught) => R,
  ): Op<T | RecoverValue<R>, Exclude<E, ECaught> | RecoverError<R>, A>;
  recover<ECaught extends E, R>(
    predicate: WithPredicateMethod<ECaught>,
    handler: (error: ECaught) => R,
  ): Op<T | RecoverValue<R>, Exclude<E, ECaught> | RecoverError<R>, A>;
  recover<R>(
    predicate: (error: E) => boolean,
    handler: (error: E) => R,
  ): Op<T | RecoverValue<R>, E | RecoverError<R>, A>;
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
  /** Backs public `.on("exit", fn)` on ops built from these hooks. */
  registerExitFinalize: (finalize: ExitFn<T, E>) => Op<T, E, []>;
}
