import type { InferErr, Result, UnhandledException } from "better-result";
import {
  Op,
  TimeoutError,
  type EnterContext,
  type ExitContext,
  type OpLifecycleHook,
  type RetryPolicy,
} from "@prodkit/op";
import { hasBrand, NEVER, unsafeCoerce, type AbortSignalLike } from "@prodkit/op/internal";
import type { Dependency, DI } from "./index.js";

declare global {
  interface ObjectConstructor {
    hasOwn<T extends object, K extends PropertyKey>(
      object: T,
      key: K,
    ): object is T & Record<K, unknown>;
  }
}

export class MissingDependencyError extends Error {
  override readonly name = "MissingDependencyError";
  readonly _tag = "MissingDependencyError";
  readonly key: string;
  constructor(key: string) {
    super(`${key} is required but was not provided`);
    this.key = key;
  }

  static is(value: unknown): value is MissingDependencyError {
    return value instanceof MissingDependencyError;
  }
}

export type RunResult<T, E> = Promise<Result<T, E | UnhandledException>>;

export const DI_TOKEN = Symbol("prodkit.std.di.dependency");
const DI_REQ_TOKEN = Symbol("prodkit.std.di.req");
const DI_OP_TOKEN = Symbol("prodkit.std.di.op");
export const DI_TAG = "DI";

export type AnyDependency = Dependency<unknown, string>;

export type DependencyValue<C, V = unknown> = C extends abstract new (
  ...args: never[]
) => Dependency<infer T, string>
  ? T & V
  : C extends Dependency<infer T, string>
    ? T & V
    : never;

export type Binding<C extends AnyDependency, V = unknown> = {
  readonly _tag: "DependencyBinding";
  readonly dependency: C;
  readonly value: DependencyValue<C, V>;
};
export type AnyBinding = Binding<AnyDependency>;
export type LazyBinding<C extends AnyDependency, V = unknown> = {
  readonly _tag: "DependencyLazyBinding";
  readonly dependency: C;
  readonly resolve: () => DependencyValue<C, V>;
};
export type AnyLazyBinding = LazyBinding<AnyDependency>;

export type InferReqs<C> = C extends DI.Op<infer _T, infer _E, infer _A, infer R> ? R : never;

/** Yielded by `DI.require` and bare dependency classes to ask the runtime for a dependency binding. */
export class DependencyReqInstruction<T, R> {
  readonly _tag = "DependencyReqInstruction";
  readonly [DI_REQ_TOKEN]: { _T: T; _R: R } = NEVER;
  readonly dependency: AnyDependency;

  constructor(dependency: AnyDependency) {
    this.dependency = dependency;
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  *[Symbol.iterator](): Generator<this, any, unknown> {
    return yield this;
  }

  static is(value: unknown): value is DependencyReqInstruction<unknown, AnyDependency> {
    return value instanceof DependencyReqInstruction;
  }
}

export type ConditionalIterable<T, E, A extends readonly unknown[], R> = A extends []
  ? { [Symbol.iterator](): Generator<EmbedDiOpInstruction<T, E, R>, T, unknown> }
  : {};

export interface DependencyCtor<Name extends string> {
  readonly _tag: typeof DI_TAG;
  readonly key: Name;
  readonly [DI_TOKEN]: never;

  new <T>(): Dependency<T, Name>;
}

/** Constructor-or-token metatype used in dependency-req set `R` for a dependency key class. */
export type DependencyReq<C> = C extends abstract new (...args: never[]) => infer I ? I : C;

/** Yield wrapping a nested nullary `DI.Op` so the parent generator can `yield*` it. */
export class EmbedDiOpInstruction<T, E, R> {
  readonly _tag = "EmbedDiOpInstruction";
  readonly op: DI.Op<T, E, [], R>;

  constructor(op: DI.Op<T, E, [], R>) {
    this.op = op;
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  *[Symbol.iterator](): Generator<this, any, unknown> {
    return yield this;
  }
}

export type BindingReq<P> = P extends Binding<infer C> ? DependencyReq<C> : never;
export type LazyBindingReq<P> = P extends LazyBinding<infer C> ? DependencyReq<C> : never;
type SatisfiedReq<P, R> = R extends unknown ? (P extends R ? R : never) : never;
export type UseEntry = AnyBinding | AnyLazyBinding | AnyDependency;
export type UseReq<P, R> =
  P extends Binding<infer C>
    ? DependencyReq<C>
    : P extends LazyBinding<infer C>
      ? DependencyReq<C>
      : P extends AnyDependency
        ? SatisfiedReq<P, R>
        : never;

export type AnyNullaryDiOp = DI.Op<unknown, unknown, [], unknown>;
export type AnyDiOp = DI.Op<unknown, unknown, readonly unknown[], unknown>;
export type AnyNullaryOp = Op<unknown, unknown, []>;
export type Env = ReadonlyMap<AnyDependency, unknown>;

export type InferYieldReq<Y> =
  | (Y extends DependencyReqInstruction<unknown, infer R> ? R : never)
  | (Y extends EmbedDiOpInstruction<unknown, unknown, infer R> ? R : never);
export type DistributeReq<R> = R extends unknown ? R : never;

export type InferEmbedErr<Y> =
  Y extends EmbedDiOpInstruction<unknown, infer E, unknown> ? E : never;

export type OpLike<T, E> = Op<T, E, []> | DI.Op<T, E, [], unknown>;

export type ObserverReq<X> = X extends DI.Op<unknown, unknown, [], infer R> ? R : never;
export type ObserverErr<X> = X extends OpLike<unknown, infer E> ? E : never;
export type ObserverOk<X> = X extends OpLike<infer T, unknown> ? T : Awaited<X>;

export interface DiOpBase<T, E, A extends readonly unknown[], R> {
  readonly _tag: "DiOp";
  readonly [DI_OP_TOKEN]: true;

  (...args: A): DI.Op<T, E, [], R>;

  /** Runs a fully-provided wrapper with the same argument shape as the wrapped `Op`. */
  readonly run: [R] extends [never]
    ? (...args: A) => Promise<Result<T, E | UnhandledException>>
    : never;

  /** Applies dependency bindings and removes them from the remaining req type. */
  use<const Entries extends readonly UseEntry[]>(
    // TODO: this type is wrong. Entries should only be the ones that are not already in the env
    ...entries: Entries
  ): DI.Op<T, E, A, Exclude<R, UseReq<Entries[number], R>>>;

  withRetry(policy?: RetryPolicy): DI.Op<T, E, A, R>;
  withTimeout(timeoutMs: number): DI.Op<T, E | TimeoutError, A, R>;
  withSignal(signal: AbortSignalLike): DI.Op<T, E, A, R>;
  withRelease(release: (value: T) => unknown): DI.Op<T, E, A, R>;

  on(event: "enter", initialize: (ctx: EnterContext<A>) => unknown): DI.Op<T, E, A, R>;
  on(event: "exit", finalize: (ctx: ExitContext<T, E, A>) => unknown): DI.Op<T, E, A, R>;

  map<U>(transform: (value: T) => U): DI.Op<Awaited<U>, E, A, R>;
  mapErr<E2>(transform: (error: E) => E2): DI.Op<T, E2, A, R>;

  flatMap<U, E2, R2>(bind: (value: T) => DI.Op<U, E2, [], R2>): DI.Op<U, E | E2, A, R | R2>;
  flatMap<U, E2>(bind: (value: T) => Op<U, E2, []>): DI.Op<U, E | E2, A, R>;

  tap<RObserved>(
    observe: (value: T) => RObserved,
  ): DI.Op<T, E | ObserverErr<RObserved>, A, R | ObserverReq<RObserved>>;
  tapErr<RObserved>(
    observe: (error: E) => RObserved,
  ): DI.Op<T, E | ObserverErr<RObserved>, A, R | ObserverReq<RObserved>>;

  recover<ECaught extends E, RRecovered>(
    predicate: (error: E) => error is ECaught,
    handler: (error: ECaught) => RRecovered,
  ): DI.Op<
    T | ObserverOk<RRecovered>,
    Exclude<E, ECaught> | ObserverErr<RRecovered>,
    A,
    R | ObserverReq<RRecovered>
  >;
  recover<RRecovered>(
    predicate: (error: E) => boolean,
    handler: (error: E) => RRecovered,
  ): DI.Op<T | ObserverOk<RRecovered>, E | ObserverErr<RRecovered>, A, R | ObserverReq<RRecovered>>;
}

export interface DiOpState<T, E, A extends readonly unknown[]> {
  readonly buildOp: (env: Env) => Op<T, E, A>;
  readonly env: Env;
  readonly iterable: boolean;
}

export interface DiOpRuntime<T, E, A extends readonly unknown[]> {
  toOp(env?: Env): Op<T, E, A>;
}

export type DiOpCallable<T, E, A extends readonly unknown[], R> = ((
  ...args: A
) => DI.Op<T, E, [], R>) &
  DiOpRuntime<T, E, A> & {
    readonly _tag: "DiOp";
    readonly [DI_OP_TOKEN]: true;
    readonly run: (...args: A) => RunResult<T, E>;
    readonly use: (...entries: readonly UseEntry[]) => DI.Op<T, E, A, unknown>;
    readonly withRetry: (policy?: RetryPolicy) => DI.Op<T, E, A, R>;
    readonly withTimeout: (timeoutMs: number) => DI.Op<T, E | TimeoutError, A, R>;
    readonly withSignal: (signal: AbortSignalLike) => DI.Op<T, E, A, R>;
    readonly withRelease: (release: (value: T) => unknown) => DI.Op<T, E, A, R>;
    readonly on: (event: OpLifecycleHook, handler: unknown) => DI.Op<T, E, A, R>;
    readonly map: (transform: (value: T) => unknown) => DI.Op<unknown, E, A, R>;
    readonly mapErr: (transform: (error: E) => unknown) => DI.Op<T, unknown, A, R>;
    readonly flatMap: (
      bind: (value: T) => OpLike<unknown, unknown>,
    ) => DI.Op<unknown, unknown, A, R>;
    readonly tap: (observe: (value: T) => unknown) => DI.Op<T, unknown, A, R>;
    readonly tapErr: (observe: (error: E) => unknown) => DI.Op<T, unknown, A, R>;
    readonly recover: (
      predicate: (error: E) => boolean,
      handler: (error: E) => unknown,
    ) => DI.Op<unknown, unknown, A, R>;
  };

function isEmbeddedDependencyOperationInstruction(
  value: unknown,
): value is EmbedDiOpInstruction<unknown, unknown, unknown> {
  return value instanceof EmbedDiOpInstruction;
}

function isDependencyOperation(value: unknown): value is AnyDiOp {
  return hasBrand(value, DI_OP_TOKEN);
}

function isDependencyBinding(value: unknown): value is AnyBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "_tag") &&
    value._tag === "DependencyBinding"
  );
}

function isDependencyLazyBinding(value: unknown): value is AnyLazyBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "_tag") &&
    value._tag === "DependencyLazyBinding"
  );
}

function dependencyTokenFromEntry(entry: AnyDependency): AnyDependency {
  const ctor = entry.constructor;
  if (typeof ctor !== "function") return entry;

  let current: unknown = ctor;
  while (typeof current === "function") {
    if (
      Object.hasOwn(current, "_tag") &&
      current._tag === DI_TAG &&
      Object.hasOwn(current, "key") &&
      Object.hasOwn(current, DI_TOKEN)
    ) {
      return unsafeCoerce<AnyDependency>(current);
    }
    current = Object.getPrototypeOf(current);
  }

  return entry;
}

function withDependencyBinding(env: Env, dependency: AnyDependency, value: unknown): Env {
  const nextEnv = new Map(env);
  nextEnv.set(dependency, value);
  return nextEnv;
}

function withDependencyEntry(env: Env, entry: UseEntry): Env {
  if (isDependencyBinding(entry)) {
    return withDependencyBinding(env, entry.dependency, entry.value);
  }
  if (isDependencyLazyBinding(entry)) {
    return withDependencyBinding(env, entry.dependency, entry);
  }
  return withDependencyBinding(env, dependencyTokenFromEntry(entry), entry);
}

const MISSING_DEPENDENCY = Symbol("prodkit.std.di.missing-dependency");

function resolveDependencyValue(env: Env, dependency: AnyDependency): unknown {
  let matchedToken: AnyDependency | undefined;
  let matchedValue: unknown = MISSING_DEPENDENCY;

  if (env.has(dependency)) {
    matchedToken = dependency;
    matchedValue = env.get(dependency);
  } else {
    for (const [token, value] of env.entries()) {
      if (token.key === dependency.key) {
        matchedToken = token;
        matchedValue = value;
        break;
      }
    }
  }

  if (matchedValue === MISSING_DEPENDENCY) {
    return MISSING_DEPENDENCY;
  }

  if (isDependencyLazyBinding(matchedValue)) {
    const resolved = matchedValue.resolve();
    if (matchedToken !== undefined && env instanceof Map) {
      env.set(matchedToken, resolved);
    }
    return resolved;
  }

  return matchedValue;
}

function toRuntimeOp<T, E, A extends readonly unknown[]>(
  value: DI.Op<T, E, A, unknown>,
  env: Env,
): Op<T, E, A> {
  return unsafeCoerce<DiOpRuntime<T, E, A>>(value).toOp(env);
}

function toRuntimeNullaryOp(value: AnyDiOp, env: Env): AnyNullaryOp {
  return toRuntimeOp(unsafeCoerce<AnyNullaryDiOp>(value), env);
}

function materializeDependencyAwareReturn(value: unknown, env: Env): unknown {
  if (!isDependencyOperation(value)) return value;
  return toRuntimeNullaryOp(value, env);
}

function runWithState<T, E, A extends readonly unknown[]>(
  state: DiOpState<T, E, A>,
  args: A,
): RunResult<T, E> {
  return state.buildOp(new Map(state.env)).run(...args);
}

function invokeWithState<T, E, A extends readonly unknown[]>(
  state: DiOpState<T, E, A>,
  env: Env,
  args: A,
): Op<T, E, []> {
  return state.buildOp(new Map(env))(...args);
}

function recreateDependencyOp<T, E, A extends readonly unknown[], R>(
  state: DiOpState<T, E, A>,
): DI.Op<T, E, A, R> {
  return createDependencyOp<T, E, A, R>(state);
}

function mapDependencyOp<T, E, A extends readonly unknown[], R, TOut, EOut>(
  state: DiOpState<T, E, A>,
  mapOp: (op: Op<T, E, A>, env: Env) => Op<TOut, EOut, A>,
): DI.Op<TOut, EOut, A, R> {
  return recreateDependencyOp<TOut, EOut, A, R>({
    ...state,
    buildOp: (env) => mapOp(state.buildOp(env), env),
  });
}

function applyUseEntries<T, E, A extends readonly unknown[], R>(
  state: DiOpState<T, E, A>,
  entries: readonly UseEntry[],
): DI.Op<T, E, A, R> {
  return recreateDependencyOp<T, E, A, R>({
    ...state,
    env: entries.reduce((env, entry) => withDependencyEntry(env, entry), state.env),
  });
}

function asDiOp<T, E, A extends readonly unknown[], R>(
  value: DiOpCallable<T, E, A, R>,
): DI.Op<T, E, A, R> {
  return unsafeCoerce<DI.Op<T, E, A, R>>(value);
}

function buildIterableFacade<T, E, R>(
  self: DiOpCallable<T, E, [], R>,
): {
  [Symbol.iterator](): Generator<EmbedDiOpInstruction<T, E, R>, T, unknown>;
} {
  return {
    [Symbol.iterator]: function* (): Generator<EmbedDiOpInstruction<T, E, R>, T, unknown> {
      return yield* new EmbedDiOpInstruction(asDiOp<T, E, [], R>(self));
    },
  };
}

function toFlatMapOpLike(value: OpLike<unknown, unknown>, env: Env): AnyNullaryOp {
  return isDependencyOperation(value) ? toRuntimeNullaryOp(value, env) : value;
}

export function createDependencyOp<T, E, A extends readonly unknown[], R>(
  state: DiOpState<T, E, A>,
): DI.Op<T, E, A, R> {
  const lift = <TOut, EOut>(
    mapOp: (op: Op<T, E, A>, env: Env) => Op<TOut, EOut, A>,
  ): DI.Op<TOut, EOut, A, R> => mapDependencyOp(state, mapOp);

  const self: DiOpCallable<T, E, A, R> = Object.assign(
    (...args: A) =>
      recreateDependencyOp<T, E, [], R>({
        buildOp: (env) => invokeWithState(state, env, args),
        env: state.env,
        iterable: true,
      }),
    {
      _tag: "DiOp" as const,
      [DI_OP_TOKEN]: true as const,
      toOp: (envOverride?: Env) => state.buildOp(new Map(envOverride ?? state.env)),
      run: (...args: A) => runWithState(state, args),
      use: (...entries: readonly UseEntry[]) => applyUseEntries(state, entries),
      withRetry: (policy?: RetryPolicy) => lift((op) => op.withRetry(policy)),
      withTimeout: (timeoutMs: number) => lift((op) => op.withTimeout(timeoutMs)),
      withSignal: (signal: AbortSignalLike) => lift((op) => op.withSignal(signal)),
      withRelease: (release: (value: T) => unknown) => lift((op) => op.withRelease(release)),
      on: (event: OpLifecycleHook, handler: unknown) =>
        lift((op) => op.on(event as "enter", handler as never)),
      map: (transform: (value: T) => unknown) => lift((op) => op.map(transform)),
      mapErr: (transform: (error: E) => unknown) => lift((op) => op.mapErr(transform)),
      flatMap: (bind: (value: T) => OpLike<unknown, unknown>) =>
        lift((op, env) => op.flatMap((value) => toFlatMapOpLike(bind(value), env))),
      tap: (observe: (value: T) => unknown) =>
        lift((op, env) => op.tap((value) => materializeDependencyAwareReturn(observe(value), env))),
      tapErr: (observe: (error: E) => unknown) =>
        lift((op, env) =>
          op.tapErr((error) => materializeDependencyAwareReturn(observe(error), env)),
        ),
      recover: (predicate: (error: E) => boolean, handler: (error: E) => unknown) =>
        lift((op, env) =>
          op.recover(predicate, (error) => materializeDependencyAwareReturn(handler(error), env)),
        ),
    },
  );

  if (state.iterable) {
    Object.assign(self, buildIterableFacade(unsafeCoerce<DiOpCallable<T, E, [], R>>(self)));
  }

  return asDiOp(self);
}

export function buildDependencyOp<Y, T, A extends readonly unknown[]>(
  program: (...args: A) => Generator<Y, T, unknown>,
  env: Env,
): Op<T, InferErr<Y> | InferEmbedErr<Y>, A> {
  return unsafeCoerce(
    Op(function* (...args: A) {
      const iterator = program(...args);
      let input: unknown;

      while (true) {
        const step = iterator.next(input);
        if (step.done) return step.value;

        const stepValue = step.value;

        if (DependencyReqInstruction.is(stepValue)) {
          const value = resolveDependencyValue(env, stepValue.dependency);
          if (value !== MISSING_DEPENDENCY) {
            input = value;
            continue;
          }

          throw new MissingDependencyError(stepValue.dependency.key);
        }

        if (isEmbeddedDependencyOperationInstruction(stepValue)) {
          input = yield* toRuntimeOp(stepValue.op, env);
          continue;
        }

        input = yield stepValue as never;
      }
    }),
  );
}
