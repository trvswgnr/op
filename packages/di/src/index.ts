import type { InferErr } from "better-result";
import {
  Op,
  TimeoutError,
  type EnterContext,
  type ExitContext,
  type OpLifecycleHook,
  type RetryPolicy,
} from "@prodkit/op";
import type { AbortSignal } from "./platform";

type RunResult<TOp> = ReturnType<WrappedOp<TOp>["run"]>;

const CONTEXT_TOKEN = Symbol("prodkit.di.context");
const CONTEXT_REQUIREMENT = Symbol("prodkit.di.requirement");
const WITH_CONTEXT = Symbol("prodkit.di.withContext");

function unsafeCoerce<T>(value: unknown): T {
  return value as T;
}

export type AnyContext = Context<unknown, string>;

export type ContextValue<C> = C extends abstract new (...args: never[]) => Context<infer T, string>
  ? T
  : C extends Context<infer T, string>
    ? T
    : never;
type ContextRequirement<C> = C extends abstract new (...args: never[]) => infer I ? I : C;

export type InferContextRequirements<C> = C extends WithContext<infer _TOp, infer R> ? R : never;

export class ContextInstruction<_T, _R> {
  readonly _tag = "ContextInstruction";
  readonly [CONTEXT_REQUIREMENT]: _R;
  readonly context: AnyContext;

  constructor(context: AnyContext) {
    this[CONTEXT_REQUIREMENT] = unsafeCoerce<_R>(undefined);
    this.context = context;
  }
}

export interface Context<T, Name extends string = string> {
  readonly _tag: "Context";
  readonly key: Name;
  readonly [CONTEXT_TOKEN]: T;
  [Symbol.iterator](): Generator<ContextInstruction<T, this>, T, unknown>;
}

type ContextBuilder<Name extends string> = {
  readonly _tag: "Context";
  readonly key: Name;
  readonly [CONTEXT_TOKEN]: never;
  [Symbol.iterator](): Generator<never, never, unknown>;
  new <T>(): Context<T, Name>;
};

export interface ContextFactory {
  <const Name extends string>(key: Name): ContextBuilder<Name>;
  require<C extends AnyContext>(
    context: C,
  ): Generator<
    ContextInstruction<ContextValue<C>, ContextRequirement<C>>,
    ContextValue<C>,
    unknown
  >;
}

function createContext<const Name extends string>(key: Name): ContextBuilder<Name> {
  class ServiceContext<T> {
    readonly _tag = "Context";
    readonly key = key;
    readonly [CONTEXT_TOKEN] = unsafeCoerce<T>(undefined);

    *[Symbol.iterator](): Generator<ContextInstruction<T, this>, T, unknown> {
      return unsafeCoerce<T>(
        yield new ContextInstruction<T, this>(unsafeCoerce<AnyContext>(ServiceContext)),
      );
    }

    static readonly _tag = "Context";
    static readonly key = key;
    static readonly [CONTEXT_TOKEN] = unsafeCoerce<never>(undefined);
    static *[Symbol.iterator](): Generator<never, never, unknown> {
      throw new TypeError("Use Context.require(Service) to require a service");
    }
  }

  return unsafeCoerce<ContextBuilder<Name>>(ServiceContext);
}

function requireContext<C extends AnyContext>(
  context: C,
): Generator<ContextInstruction<ContextValue<C>, ContextRequirement<C>>, ContextValue<C>, unknown> {
  return (function* () {
    return unsafeCoerce<ContextValue<C>>(
      yield new ContextInstruction<ContextValue<C>, ContextRequirement<C>>(context),
    );
  })();
}

export const Context: ContextFactory = Object.assign(createContext, {
  require: requireContext,
});

export class WithContextInstruction<T, E, R> {
  readonly _tag = "WithContextInstruction";
  readonly op: WithContext<Op<T, E, []>, R>;

  constructor(op: WithContext<Op<T, E, []>, R>) {
    this.op = op;
  }
}

type AnyNullaryWithContext = WithContext<Op<unknown, unknown, []>, unknown>;
type AnyNullaryOp = Op<unknown, unknown, []>;
type Env = ReadonlyMap<AnyContext, unknown>;

type OpOk<TOp> = TOp extends Op<infer T, infer _E, infer _A> ? T : never;
type OpErr<TOp> = TOp extends Op<infer _T, infer E, infer _A> ? E : never;
type OpArgs<TOp> =
  TOp extends Op<infer _T, infer _E, infer A extends readonly unknown[]> ? A : readonly unknown[];
type Nullary<TOp> = TOp extends Op<infer T, infer E, infer _A> ? Op<T, E, []> : never;
type WrappedOp<TOp> = Op<OpOk<TOp>, OpErr<TOp>, OpArgs<TOp>>;

type InferContext<Y> =
  | (Y extends ContextInstruction<unknown, infer R> ? R : never)
  | (Y extends WithContextInstruction<unknown, unknown, infer R> ? R : never);
type SimplifyRequirement<R> = R extends unknown ? R : never;

type InferContextErr<Y> = Y extends WithContextInstruction<unknown, infer E, unknown> ? E : never;

type ObserverContext<R> = R extends WithContext<AnyNullaryOp, infer RContext> ? RContext : never;
type ObserverErr<R> =
  R extends Op<unknown, infer E, []>
    ? E
    : R extends WithContext<Op<unknown, infer E, []>, unknown>
      ? E
      : never;
type ObserverOk<R> =
  R extends Op<infer T, unknown, []>
    ? T
    : R extends WithContext<Op<infer T, unknown, []>, unknown>
      ? T
      : Awaited<R>;

type MaybeOp<T, E> = Op<T, E, []> | WithContext<Op<T, E, []>, unknown>;

export interface WithContextBase<TOp, R> {
  readonly _tag: "WithContext";
  readonly [WITH_CONTEXT]: true;

  (...args: OpArgs<TOp>): WithContext<Nullary<TOp>, R>;

  /** Lowers a fully-provided wrapper back to a normal `Op`. */
  toOp(this: WithContext<TOp, never>): TOp;

  /** Runs a fully-provided wrapper with the same argument shape as the wrapped `Op`. */
  readonly run: [R] extends [never] ? (...args: OpArgs<TOp>) => RunResult<TOp> : never;

  /** Provides one service and removes it from the remaining requirement type. */
  provide<C extends AnyContext>(
    context: C,
    value: ContextValue<C>,
  ): WithContext<TOp, Exclude<R, ContextRequirement<C>>>;

  withRetry(policy?: RetryPolicy): WithContext<TOp, R>;
  withTimeout(
    timeoutMs: number,
  ): WithContext<Op<OpOk<TOp>, OpErr<TOp> | TimeoutError, OpArgs<TOp>>, R>;
  withSignal(signal: AbortSignal): WithContext<TOp, R>;
  withRelease(release: (value: OpOk<TOp>) => unknown): WithContext<TOp, R>;

  on(event: "enter", initialize: (ctx: EnterContext<OpArgs<TOp>>) => unknown): WithContext<TOp, R>;
  on(
    event: "exit",
    finalize: (ctx: ExitContext<OpOk<TOp>, OpErr<TOp>, OpArgs<TOp>>) => unknown,
  ): WithContext<TOp, R>;

  map<U>(
    transform: (value: OpOk<TOp>) => U,
  ): WithContext<Op<Awaited<U>, OpErr<TOp>, OpArgs<TOp>>, R>;
  mapErr<E2>(transform: (error: OpErr<TOp>) => E2): WithContext<Op<OpOk<TOp>, E2, OpArgs<TOp>>, R>;

  flatMap<U, E2, R2>(
    bind: (value: OpOk<TOp>) => WithContext<Op<U, E2, []>, R2>,
  ): WithContext<Op<U, OpErr<TOp> | E2, OpArgs<TOp>>, R | R2>;
  flatMap<U, E2>(
    bind: (value: OpOk<TOp>) => Op<U, E2, []>,
  ): WithContext<Op<U, OpErr<TOp> | E2, OpArgs<TOp>>, R>;

  tap<RObserved>(
    observe: (value: OpOk<TOp>) => RObserved,
  ): WithContext<
    Op<OpOk<TOp>, OpErr<TOp> | ObserverErr<RObserved>, OpArgs<TOp>>,
    R | ObserverContext<RObserved>
  >;
  tapErr<RObserved>(
    observe: (error: OpErr<TOp>) => RObserved,
  ): WithContext<
    Op<OpOk<TOp>, OpErr<TOp> | ObserverErr<RObserved>, OpArgs<TOp>>,
    R | ObserverContext<RObserved>
  >;

  recover<ECaught extends OpErr<TOp>, RRecovered>(
    predicate: (error: OpErr<TOp>) => error is ECaught,
    handler: (error: ECaught) => RRecovered,
  ): WithContext<
    Op<
      OpOk<TOp> | ObserverOk<RRecovered>,
      Exclude<OpErr<TOp>, ECaught> | ObserverErr<RRecovered>,
      OpArgs<TOp>
    >,
    R | ObserverContext<RRecovered>
  >;
  recover<RRecovered>(
    predicate: (error: OpErr<TOp>) => boolean,
    handler: (error: OpErr<TOp>) => RRecovered,
  ): WithContext<
    Op<OpOk<TOp> | ObserverOk<RRecovered>, OpErr<TOp> | ObserverErr<RRecovered>, OpArgs<TOp>>,
    R | ObserverContext<RRecovered>
  >;
}

export type WithContext<TOp, R> = WithContextBase<TOp, R> &
  (OpArgs<TOp> extends []
    ? {
        [Symbol.iterator](): Generator<
          WithContextInstruction<OpOk<TOp>, OpErr<TOp>, R>,
          OpOk<TOp>,
          unknown
        >;
      }
    : {});

interface WithContextState<TOp> {
  readonly build: (env: Env) => TOp;
  readonly env: Env;
  readonly makeIterable?: ((env: Env) => AnyNullaryOp) | undefined;
}

function isContextInstruction(value: unknown): value is ContextInstruction<unknown, AnyContext> {
  return value instanceof ContextInstruction;
}

function isWithContextInstruction(
  value: unknown,
): value is WithContextInstruction<unknown, unknown, unknown> {
  return value instanceof WithContextInstruction;
}

function isWithContext(value: unknown): value is AnyNullaryWithContext {
  return (
    typeof value === "function" &&
    value !== null &&
    WITH_CONTEXT in value &&
    value[WITH_CONTEXT] === true
  );
}

function extendEnv(env: Env, context: AnyContext, value: unknown): Env {
  const next = new Map(env);
  next.set(context, value);
  return next;
}

function resolveObserved(value: unknown, env: Env): unknown {
  if (!isWithContext(value)) return value;
  return lower(value, env);
}

function lower<TOp>(value: WithContext<TOp, unknown>, env: Env): TOp {
  return (value as unknown as { toOp: (env?: Env) => TOp }).toOp(env);
}

function wrapped<TOp>(op: TOp): WrappedOp<TOp> {
  return unsafeCoerce<WrappedOp<TOp>>(op);
}

function makeWithContext<TOp, R>(state: WithContextState<TOp>): WithContext<TOp, R> {
  const self = Object.assign(
    (...args: OpArgs<TOp>) =>
      makeWithContext<Nullary<TOp>, R>({
        build: (env) => unsafeCoerce<Nullary<TOp>>(wrapped(state.build(env))(...args)),
        env: state.env,
        makeIterable: (env) => unsafeCoerce<AnyNullaryOp>(wrapped(state.build(env))(...args)),
      }),
    {
      _tag: "WithContext" as const,
      [WITH_CONTEXT]: true as const,
      toOp: (envOverride?: Env) => state.build(envOverride ?? state.env),
      run: (...args: OpArgs<TOp>) => wrapped(state.build(state.env)).run(...args),
      provide: (context: AnyContext, value: unknown) =>
        makeWithContext({
          ...state,
          env: extendEnv(state.env, context, value),
        }),
      withRetry: (policy?: RetryPolicy) =>
        makeWithContext({
          ...state,
          build: (env) => unsafeCoerce<TOp>(wrapped(state.build(env)).withRetry(policy)),
        }),
      withTimeout: (timeoutMs: number) =>
        makeWithContext({
          ...state,
          build: (env) => unsafeCoerce<TOp>(wrapped(state.build(env)).withTimeout(timeoutMs)),
        }),
      withSignal: (signal: AbortSignal) =>
        makeWithContext({
          ...state,
          build: (env) => unsafeCoerce<TOp>(wrapped(state.build(env)).withSignal(signal)),
        }),
      withRelease: (release: (value: OpOk<TOp>) => unknown) =>
        makeWithContext({
          ...state,
          build: (env) => unsafeCoerce<TOp>(wrapped(state.build(env)).withRelease(release)),
        }),
      on: (event: OpLifecycleHook, handler: unknown) =>
        makeWithContext({
          ...state,
          build: (env) =>
            unsafeCoerce<TOp>(
              wrapped(state.build(env)).on(unsafeCoerce(event), unsafeCoerce(handler)),
            ),
        }),
      map: (transform: (value: OpOk<TOp>) => unknown) =>
        makeWithContext({
          ...state,
          build: (env) => unsafeCoerce<TOp>(wrapped(state.build(env)).map(transform)),
        }),
      mapErr: (transform: (error: OpErr<TOp>) => unknown) =>
        makeWithContext({
          ...state,
          build: (env) => unsafeCoerce<TOp>(wrapped(state.build(env)).mapErr(transform)),
        }),
      flatMap: (bind: (value: OpOk<TOp>) => MaybeOp<unknown, unknown>) =>
        makeWithContext({
          ...state,
          build: (env) =>
            unsafeCoerce<TOp>(
              wrapped(state.build(env)).flatMap((value) =>
                unsafeCoerce<AnyNullaryOp>(resolveObserved(bind(value), env)),
              ),
            ),
        }),
      tap: (observe: (value: OpOk<TOp>) => unknown) =>
        makeWithContext({
          ...state,
          build: (env) =>
            unsafeCoerce<TOp>(
              wrapped(state.build(env)).tap((value) => resolveObserved(observe(value), env)),
            ),
        }),
      tapErr: (observe: (error: OpErr<TOp>) => unknown) =>
        makeWithContext({
          ...state,
          build: (env) =>
            unsafeCoerce<TOp>(
              wrapped(state.build(env)).tapErr((error) => resolveObserved(observe(error), env)),
            ),
        }),
      recover: (
        predicate: (error: OpErr<TOp>) => boolean,
        handler: (error: OpErr<TOp>) => unknown,
      ) =>
        makeWithContext({
          ...state,
          build: (env) =>
            unsafeCoerce<TOp>(
              wrapped(state.build(env)).recover(unsafeCoerce(predicate), (error) =>
                resolveObserved(handler(unsafeCoerce<OpErr<TOp>>(error)), env),
              ),
            ),
        }),
    },
  );

  if (state.makeIterable !== undefined) {
    Object.assign(self, {
      [Symbol.iterator]: function* (): Generator<
        WithContextInstruction<OpOk<TOp>, OpErr<TOp>, R>,
        OpOk<TOp>,
        unknown
      > {
        return unsafeCoerce<OpOk<TOp>>(
          yield unsafeCoerce<WithContextInstruction<OpOk<TOp>, OpErr<TOp>, R>>(
            new WithContextInstruction(unsafeCoerce<AnyNullaryWithContext>(self)),
          ),
        );
      },
    });
  }

  return unsafeCoerce<WithContext<TOp, R>>(self);
}

function buildContextOp<Y, T, A extends readonly unknown[]>(
  f: (...args: A) => Generator<Y, T, unknown>,
  env: Env,
): Op<T, InferErr<Y> | InferContextErr<Y>, A> {
  return unsafeCoerce<Op<T, InferErr<Y> | InferContextErr<Y>, A>>(
    Op(function* (...args: A) {
      const iterator = f(...args);
      let input: unknown;

      while (true) {
        const step = iterator.next(input);
        if (step.done) return step.value;

        const instruction = step.value;
        if (isContextInstruction(instruction)) {
          if (env.has(instruction.context)) {
            input = env.get(instruction.context);
            continue;
          }

          throw new Error(`Missing context: ${instruction.context.key}`);
        }

        if (isWithContextInstruction(instruction)) {
          input = yield* lower(instruction.op, env);
          continue;
        }

        input = yield unsafeCoerce<never>(instruction);
      }
    }),
  );
}

export function withContext<
  Y,
  T,
  A extends readonly unknown[],
  R extends InferContext<Y> = SimplifyRequirement<InferContext<Y>>,
>(
  f: (...args: A) => Generator<Y, T, unknown>,
): WithContext<Op<T, InferErr<Y> | InferContextErr<Y>, A>, R> {
  const makeIterable =
    f.length === 0 ? (env: Env) => unsafeCoerce<AnyNullaryOp>(buildContextOp(f, env)) : undefined;

  return makeWithContext<Op<T, InferErr<Y> | InferContextErr<Y>, A>, R>({
    build: (env) => buildContextOp(f, env),
    env: new Map(),
    makeIterable,
  });
}
