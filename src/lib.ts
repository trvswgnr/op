export interface Typed<TypeName extends string> {
  readonly type: TypeName;
}

/**
 * Built-in typed error for failures that are not mapped to a domain-specific error.
 *
 * The message is always `"An unexpected error occurred"`. The original failure is preserved on
 * `cause` (see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/cause Error#cause}).
 *
 * @param cause The underlying reason for the error (often the value a promise rejected with).
 *
 * @example
 * const e = new UnexpectedError(cause, "something went wrong");
 *
 * @example
 * const result = await Op.try(() => Promise.reject("oops")).run();
 * if (!result.ok && result.error instanceof UnexpectedError) {
 *   console.error(result.error.cause); // "oops"
 * }
 */
export class UnexpectedError extends Error implements Typed<"UnexpectedError"> {
  readonly type = "UnexpectedError";
  constructor(cause: unknown, message?: string) {
    super(message ?? "An unexpected error occurred", { cause });
  }
}

/**
 * Built-in typed error emitted when an operation exceeds a timeout budget.
 *
 * This is produced by {@link WithTimeout.withTimeout} and by combinators that include a timed
 * operation in their graph.
 *
 * @param timeoutMs Timeout threshold in milliseconds that was exceeded.
 */
export class TimeoutError extends Error implements Typed<"TimeoutError"> {
  readonly type = "TimeoutError";
  readonly timeoutMs: number;
  constructor({ timeoutMs }: { timeoutMs: number }) {
    super(`Operation timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Internal control-flow sentinel used to mark logically impossible paths.
 *
 * The library exports this for completeness and debugging, but most consumers should not
 * construct or throw it directly.
 */
export class UnreachableError extends Error implements Typed<"UnreachableError"> {
  readonly type = "UnreachableError";
  constructor() {
    super("Unreachable code path");
  }
}

/**
 * Instance type for classes created by {@link TypedError}.
 *
 * `message` and `cause` are standard `Error` fields. Any other constructor fields are stored on
 * {@link TypedError.data}.
 *
 * `[Symbol.iterator]` yields a single `Err` carrying this instance, so `yield*` on an instance
 * inside an {@link Op} propagates the failure like a child operation.
 *
 * @template TypeName String discriminant; available as `error.type` and `error.name`.
 * @template Data Constructor fields other than `message` and `cause`.
 */
export type TypedError<
  TypeName extends string,
  Data extends Record<string, unknown> & { message?: string | undefined; cause?: unknown } = {},
> = _TypedError<TypeName> & ({} extends Data ? {} : { [K in keyof Data]: Data[K] });
interface _TypedError<TypeName extends string> extends Error {
  readonly type: TypeName;
  [Symbol.iterator](): Generator<Err<this>, never, unknown>;
}

type TypedErrorCtorParams<
  Data extends Record<string, unknown> & { message?: never; cause?: never },
> = {} extends Data
  ? [data?: { message?: string | undefined; cause?: unknown }]
  : [data: Data & { message?: string | undefined; cause?: unknown }];

export interface TypedErrorConstructor<TypeName extends string> {
  new (data?: { message?: string | undefined; cause?: unknown }): TypedError<TypeName, {}>;
  new <Data extends Record<string, unknown> & { message?: never; cause?: never }>(
    data: Data & { message?: string | undefined; cause?: unknown },
  ): TypedError<TypeName, Data>;
}

interface ErrorGroupConstructor {
  new <E>(errors: Iterable<E>, message: string): ErrorGroup<E>;
  readonly prototype: ErrorGroup<unknown>;
}

/**
 * Built-in typed aggregate error used by combinators that need to preserve multiple failures.
 *
 * Today this is primarily emitted by {@link anyOp} when all candidates fail. The `errors` array
 * contains child failures in input order.
 *
 * @template E Child error type.
 */
export interface ErrorGroup<E> extends AggregateError, Typed<"ErrorGroup"> {
  readonly errors: E[];
}

/**
 * Runtime constructor for {@link ErrorGroup}.
 *
 * @template E Child error type.
 * @param errors Child failures to aggregate.
 * @param message Human-readable context for why the group was created.
 */
export const ErrorGroup: ErrorGroupConstructor = class<E>
  extends AggregateError
  implements Typed<"ErrorGroup">
{
  readonly type = "ErrorGroup";
  override readonly errors: E[];
  constructor(errors: Iterable<E>, message: string) {
    super(errors, message);
    this.errors = Array.from(errors);
  }
};

interface Ok<T> extends Typed<"Ok"> {
  readonly ok: true;
  readonly value: T;
}

interface Err<E> extends Typed<"Err"> {
  readonly ok: false;
  readonly error: E;
}

/**
 * Discriminated result of {@link runOp} and {@link OpNullary.run}.
 *
 * When `ok` is `true`, read `value`. When `ok` is `false`, read `error`.
 *
 * @template T Success value.
 * @template E Failure value (often a {@link TypedError} or domain error).
 */
export type Result<T, E> = Ok<T> | Err<E>;

const ok = <T>(value: T): Ok<T> => Object.freeze({ type: "Ok", ok: true, value });
const err = <E>(error: E): Err<E> => Object.freeze({ type: "Err", ok: false, error });

/**
 * Creates a new typed error class with the given type name and optional default message.
 *
 * Data can be defined as a generic type parameter to the error class.
 * This data is passed to the error constructor and can be accessed via the `data` property.
 *
 * The "message" and "cause" properties are always allowed to be passed to the constructor
 * and are excluded from the `data` property.
 *
 * Implements the `[Symbol.iterator]` method to allow it to be used in a `yield*` expression.
 *
 * @param type The name of the error type
 * @param defaultMessage Optional default message for the error
 * @returns A new typed error class that extends the global Error class
 *
 * @example
 * const NetworkError = TypedError("NetworkError");
 * const op = Op(function* () {
 *   yield* new NetworkError();
 * });
 *
 * @example
 * const ValidationError = TypedError("ValidationError", "A validation error occurred");
 * const op = Op(function* () {
 *   yield* new ValidationError();
 * });
 *
 * @example
 * const NotFoundError = TypedError("NotFoundError")<{ resource: string }>();
 * const op = Op(function* () {
 *   yield* new NotFoundError({ resource: "user" });
 * });
 */
export function TypedError<TType extends string>(
  type: TType,
  defaultMessage?: string,
): TypedErrorConstructor<TType> {
  return class<Data extends Record<string, unknown> & { message?: never; cause?: never } = {}>
    extends Error
    implements Typed<TType>
  {
    readonly type = type;

    constructor(...args: TypedErrorCtorParams<Data>) {
      const _data = args[0] ?? ({} as Data);
      const { message, cause, ...data } = _data;
      super(message ?? defaultMessage, { cause });
      this.name = type;
      Object.assign(this, data);
    }

    *[Symbol.iterator](): Generator<Err<this>, never, unknown> {
      yield err(this);
      throw new UnreachableError();
    }
  };
}
TypedError.is = (error: unknown): error is TypedError<string> => {
  return error instanceof Error && "type" in error && typeof error.type === "string";
};

interface Suspended {
  readonly type: "Suspended";
  readonly suspend: (signal: AbortSignal) => Promise<unknown>;
}

type Instruction<E> = Err<E> | Suspended;

export interface WithRetry<T, E, A extends readonly unknown[]> {
  /**
   * Returns an op that retries this op for each `run(...args)` or `yield*`.
   *
   * `shouldRetry` receives the root failure cause. When this op fails with
   * `UnexpectedError`, the predicate receives `error.cause`.
   *
   * @example
   * const op = Op.try(() => fetch("/api/x")).withRetry({
   *   maxAttempts: 3,
   *   shouldRetry: (cause) => cause instanceof Error,
   *   getDelay: () => 0,
   * });
   * const result = await op.run();
   * if (!result.ok) console.log(result.error);
   */
  withRetry(policy?: RetryPolicy): Op<T, E, A>;
}

export interface WithTimeout<T, E, A extends readonly unknown[]> {
  /**
   * Returns an op that fails with {@link TimeoutError} when `run(...args)` or `yield*` exceeds
   * `timeoutMs`.
   */
  withTimeout(timeoutMs: number): Op<T, E | TimeoutError, A>;
}

export interface WithSignal<T, E, A extends readonly unknown[]> {
  /**
   * Returns an op bound to an external {@link AbortSignal}. When the signal aborts, in-flight
   * `Op.try` callbacks and combinator children receive the cancellation through their own signal.
   */
  withSignal(signal: AbortSignal): Op<T, E, A>;
}

export interface OpBase<T, E> {
  type: "Op";
  [Symbol.iterator](): Generator<Instruction<E>, T, unknown>;
}

export interface OpNullary<T, E>
  extends OpBase<T, E>, WithRetry<T, E, []>, WithTimeout<T, E, []>, WithSignal<T, E, []> {
  (): OpBase<T, E>;
  run(): Promise<Result<T, E | UnexpectedError>>;
}

export interface OpArity<T, E, A extends readonly unknown[]>
  extends WithRetry<T, E, A>, WithTimeout<T, E, A>, WithSignal<T, E, A> {
  (...args: A): OpNullary<T, E>;
  run(...args: A): Promise<Result<T, E | UnexpectedError>>;
}

type _Op<T, E, A extends readonly unknown[]> = [] extends A ? OpNullary<T, E> : OpArity<T, E, A>;

export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A> & Typed<"Op">;

export type ExtractErr<Y> = Y extends Err<infer U> ? U : never;

/**
 * Lifts a value into an operation that always completes successfully.
 *
 * If `value` is not a `Promise`, the generator returns it immediately. If `value` is a
 * `Promise`, this uses the same suspension behavior as {@link _try}(`() => value`).
 *
 * @template T Value type, or `Promise` of a value.
 * @param value Success value or promise to await.
 * @returns An operation with success type `Awaited<T>` and no `Err` yields from this helper.
 *
 * @example
 * const r = await Op.of(69).run();
 * if (r.ok) console.log(r.value);
 *
 * @example
 * const r = await Op.of(Promise.resolve("done")).run();
 * if (r.ok) console.log(r.value);
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
 *
 * When run or `yield*`ed, the generator yields `Err` with `value` and does not return a success
 * value.
 *
 * @template E Error payload type.
 * @param value Error to attach to the failure branch.
 * @returns An operation with success type `never` and error type `E`.
 *
 * @example
 * const r = await Op.fail("not found").run();
 * if (!r.ok) console.log(r.error);
 *
 * @example
 * const op = Op(function* () {
 *   yield* Op.fail(new CustomError("failed"));
 *   return 1;
 * });
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
 *
 * `f` runs when the suspension runs (via a microtask so synchronous throws become rejections and
 * use the same path as async failures). The returned promise is awaited. On fulfillment, the
 * operation succeeds with that value. On rejection, if `onError` is provided, its return value is
 * the failure; otherwise the failure is {@link UnexpectedError} with the rejection on `cause`.
 *
 * `f` receives an {@link AbortSignal} that aborts when the surrounding `withTimeout` fires.
 * Forward it to cancellable APIs (such as `fetch`) so in-flight work stops instead of leaking.
 *
 * @template T Resolved value type.
 * @template E Error type when `onError` is provided. Defaults to {@link UnexpectedError} when omitted.
 * @param f Function returning the promise to await. Receives a cancellation signal.
 * @param onError Maps a rejection reason to `E` when provided.
 * @returns An operation that completes after the promise settles.
 *
 * @example
 * const r = await Op.try((signal) => fetch("/api/x", { signal })).run();
 *
 * @example
 * const r = await Op.try(
 *   () => Promise.reject("bad"),
 *   (e) => String(e),
 * ).run();
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
 * Executes a nullary operation and returns a settled {@link Result}.
 *
 * Use this as the low-level runner behind `.run()`. It never throws for operation failures:
 * failures are returned as `ok: false` (with unexpected throws wrapped as
 * {@link UnexpectedError}).
 *
 * @template E Error type from yielded `Err` values.
 * @template T Success return type from the generator.
 * @param op Nullary {@link Op} or zero-arg callable that returns one.
 * @returns A settled {@link Result}.
 *
 * @example
 * const r = await Op.run(Op.of(7));
 * if (r.ok) console.log(r.value);
 */
export function runOp<T, E>(op: Op<T, E, readonly []>): Promise<Result<T, E | UnexpectedError>> {
  return drive(op, new AbortController().signal);
}

async function drive<T, E>(
  op: Op<T, E, readonly []>,
  signal: AbortSignal,
): Promise<Result<T, E | UnexpectedError>> {
  try {
    const ef = typeof op === "function" ? op() : op;
    const iter = ef[Symbol.iterator]();
    let step = iter.next();
    while (!step.done) {
      try {
        if (step.value.type === "Err") return err(step.value.error);
        step = iter.next(await step.value.suspend(signal));
      } catch (cause) {
        return err(new UnexpectedError(cause));
      }
    }
    const value = await step.value;
    return ok(value);
  } catch (cause) {
    return err(new UnexpectedError(cause));
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

/**
 * Turns a generator function into an {@link Op}. The generator may `yield*` {@link Instruction}
 * values: failures (`Err`), async steps (`Suspended`, usually via {@link _try}), and sync
 * throws wrapped with {@link trySync}.
 *
 * The generator `return` expression is the success value. TypeScript infers `E` from `Err` yields
 * in the generator body ({@link ExtractErr}).
 *
 * Use a nullary generator for `fromGenFn(function* () { ... })`. Use a parameterized generator for
 * `fromGenFn(function* (a, b) { ... })`; call the result with `(a, b)` to fix the arguments, then
 * `.run()` on the inner op.
 *
 * @param f Generator implementing the operation.
 * @returns An operation with inferred `T`, `E`, and `A`.
 *
 * @example
 * const double = Op(function* () {
 *   const n = yield* Op.of(3);
 *   return n * 2;
 * });
 * const r = await double.run();
 *
 * @example
 * const greet = Op(function* (name: string) {
 *   return `Hello, ${name}`;
 * });
 * const r = await greet("Ada").run();
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
  return out;
};

/** Retry policy for `op.withRetry(policy)`. */
export interface RetryPolicy {
  /** Total tries, including the first attempt. */
  maxAttempts: number;
  /** Whether to retry after a failure (receives the root cause). */
  shouldRetry: (cause: unknown) => boolean;
  /** Delay in milliseconds before the next attempt (attempt starts at 1). */
  getDelay: (attempt: number) => number;
}

export function exponentialBackoff(opts?: {
  baseMs?: number;
  maxMs?: number;
  jitterMs?: number;
}): (attempt: number) => number {
  const { baseMs = 100, maxMs = 1000, jitterMs = 0 } = opts ?? {};
  return (attempt: number) => {
    const exponential = baseMs * Math.pow(2, attempt - 1);
    const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0;
    return Math.min(exponential + jitter, maxMs);
  };
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  shouldRetry: () => true,
  getDelay: exponentialBackoff(),
};

const mapFluentOp = <T, EIn, EOut, A extends readonly unknown[]>(
  op: Op<T, EIn, A>,
  mapNullary: (resolved: Op<T, EIn, readonly []>) => Op<T, EOut, readonly []>,
): Op<T, EOut, A> => {
  if (Symbol.iterator in op) {
    return mapNullary(op as Op<T, EIn, readonly []>) as never;
  }

  const g = (...args: A) => mapNullary((op as OpArity<T, EIn, A>)(...args) as never);
  const out = Object.assign(g, {
    run: (...args: A) => runOp(g(...args) as never),
    withRetry: (policy?: RetryPolicy) => withRetryOp(out as never, policy),
    withTimeout: (timeoutMs: number) => withTimeoutOp(out as never, timeoutMs),
    withSignal: (signal: AbortSignal) => withSignalOp(out as never, signal),
    type: "Op" as const,
  });

  return out as never;
};

const withRetryNullaryOp = <T, E>(
  op: Op<T, E, readonly []>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Op<T, E, readonly []> => {
  return makeNullaryOp<T, E | UnexpectedError>(function* () {
    let attempt = 1;

    while (true) {
      const attemptStep = (yield {
        type: "Suspended",
        suspend: (signal: AbortSignal) =>
          drive(op, signal).then((result) => ({ result, aborted: signal.aborted })),
      }) as { result: Result<T, E | UnexpectedError>; aborted: boolean };

      const result = attemptStep.result;
      if (result.ok) {
        return result.value;
      }

      const cause = result.error;
      const retryCause = cause instanceof UnexpectedError ? cause.cause : cause;
      const canRetry =
        !attemptStep.aborted && attempt < policy.maxAttempts && policy.shouldRetry(retryCause);
      if (!canRetry) {
        yield err(cause);
        throw new UnreachableError();
      }

      const delayMs = Math.max(0, policy.getDelay(attempt));
      if (delayMs > 0) {
        const delayAborted = (yield {
          type: "Suspended",
          suspend: (signal: AbortSignal) =>
            abortableDelay(delayMs, signal).then(() => signal.aborted),
        }) as boolean;
        if (delayAborted) {
          yield err(cause);
          throw new UnreachableError();
        }
      }

      attempt += 1;
    }
  }) as never;
};

const withTimeoutNullaryOp = <T, E>(
  op: Op<T, E, readonly []>,
  timeoutMs: number,
): Op<T, E | TimeoutError, readonly []> => {
  const clampedTimeoutMs = Math.max(0, timeoutMs);
  return makeNullaryOp<T, E | UnexpectedError | TimeoutError>(function* () {
    const result = (yield {
      type: "Suspended",
      suspend: (outerSignal: AbortSignal) =>
        raceTimeout((signal) => drive(op, signal), clampedTimeoutMs, outerSignal),
    }) as Result<T, E | UnexpectedError | TimeoutError>;
    if (!result.ok) {
      yield err(result.error);
      throw new UnreachableError();
    }
    return result.value;
  }) as never;
};

const withSignalNullaryOp = <T, E>(
  op: Op<T, E, readonly []>,
  signal: AbortSignal,
): Op<T, E, readonly []> => {
  return makeNullaryOp<T, E | UnexpectedError>(function* () {
    const result = (yield {
      type: "Suspended" as const,
      suspend: (outerSignal: AbortSignal) =>
        runWithBoundSignal((mergedSignal) => drive(op, mergedSignal), signal, outerSignal),
    }) as Result<T, E | UnexpectedError>;
    if (!result.ok) {
      yield err(result.error);
      throw new UnreachableError();
    }
    return result.value;
  }) as never;
};

/**
 * Implements `op.withRetry(policy)`.
 *
 * Attempts begin at 1 and continue while `attempt < policy.maxAttempts`.
 * After each failure, `policy.shouldRetry` decides whether to continue.
 * When retrying, `policy.getDelay(attempt)` controls the wait before the next attempt
 * (negative delays are clamped to 0).
 */
const withRetryOp = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Op<T, E, A> => {
  return mapFluentOp(op, (resolved) => withRetryNullaryOp(resolved, policy)) as never;
};

const withTimeoutOp = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  timeoutMs: number,
): Op<T, E | TimeoutError, A> => {
  return mapFluentOp(op, (resolved) => withTimeoutNullaryOp(resolved, timeoutMs)) as never;
};

const runWithBoundSignal = <T, E>(
  run: (signal: AbortSignal) => Promise<Result<T, E>>,
  boundSignal: AbortSignal,
  outerSignal: AbortSignal,
): Promise<Result<T, E>> => {
  const controller = new AbortController();
  const forwardBoundAbort = () => controller.abort(boundSignal.reason);
  const forwardOuterAbort = () => controller.abort(outerSignal.reason);

  if (boundSignal.aborted) forwardBoundAbort();
  else boundSignal.addEventListener("abort", forwardBoundAbort, { once: true });

  if (outerSignal.aborted) forwardOuterAbort();
  else outerSignal.addEventListener("abort", forwardOuterAbort, { once: true });

  return run(controller.signal).finally(() => {
    boundSignal.removeEventListener("abort", forwardBoundAbort);
    outerSignal.removeEventListener("abort", forwardOuterAbort);
  });
};

const withSignalOp = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  signal: AbortSignal,
): Op<T, E, A> => {
  return mapFluentOp(op, (resolved) => withSignalNullaryOp(resolved, signal)) as never;
};

const raceTimeout = <T, E>(
  run: (signal: AbortSignal) => Promise<Result<T, E>>,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<Result<T, E | TimeoutError>> => {
  const controller = new AbortController();
  const cascade = () => controller.abort(outerSignal.reason);
  if (outerSignal.aborted) cascade();
  else outerSignal.addEventListener("abort", cascade, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Result<T, E | TimeoutError>>((resolve) => {
    timeoutId = setTimeout(() => {
      const e = new TimeoutError({ timeoutMs });
      controller.abort(e);
      resolve(err(e));
    }, timeoutMs);
  });

  return Promise.race([run(controller.signal), timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    outerSignal.removeEventListener("abort", cascade);
  });
};

const abortableDelay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

type NullaryOp = Op<unknown, unknown, readonly []>;
type SuccessOf<O> = O extends Op<infer T, unknown, readonly []> ? T : never;
type ErrorOf<O> = O extends Op<unknown, infer E, readonly []> ? E : never;

/**
 * Runs every op concurrently with an `AbortController` per child, cascading aborts from
 * `outerSignal` to every child. Returns each child's in-flight promise, the controllers
 * (so callers can abort losers once an outcome is known), and a detach function to remove
 * the outer-signal listener once settled.
 */
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

/**
 * Wraps a generator in the standard fluent `Op` interface (`run`, `withRetry`, `withTimeout`,
 * `withSignal`).
 */
const makeNullaryOp = <T, E>(
  gen: () => Generator<Instruction<E>, T, unknown>,
): Op<T, E, readonly []> => {
  const self = {
    [Symbol.iterator]: gen,
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
 * Runs every op concurrently and succeeds with the tuple of their success values. Fails fast
 * on the first `Err`: remaining siblings receive an abort on their {@link AbortSignal} and the
 * combinator settles as soon as every in-flight child observes that cancellation.
 *
 * Empty input succeeds with `[]`.
 *
 * @example
 * const r = await Op.all([Op.of(1), Op.of("two")]).run();
 * if (r.ok) {
 *   const [n, s] = r.value; // number, string
 * }
 */
export const allOp = <const Ops extends readonly NullaryOp[]>(
  ops: Ops,
): Op<
  { [K in keyof Ops]: SuccessOf<Ops[K]> },
  ErrorOf<Ops[number]> | UnexpectedError,
  readonly []
> => {
  const snapshot = ops.slice();
  return makeNullaryOp(function* () {
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

/**
 * Runs every op concurrently and resolves to the tuple of each child's {@link Result}, in
 * input order. Never short-circuits, never aborts siblings on a failure, and never fails:
 * the failure channel is `never`.
 *
 * Empty input succeeds with `[]`.
 *
 * @example
 * const r = await Op.allSettled([Op.of(1), Op.fail("nope")]).run();
 * if (r.ok) {
 *   const [a, b] = r.value; // Result<number, never>, Result<never, string>
 * }
 */
export const allSettledOp = <const Ops extends readonly NullaryOp[]>(
  ops: Ops,
): Op<
  { [K in keyof Ops]: Result<SuccessOf<Ops[K]>, ErrorOf<Ops[K]> | UnexpectedError> },
  never,
  readonly []
> => {
  const snapshot = ops.slice();
  type V = { [K in keyof Ops]: Result<SuccessOf<Ops[K]>, ErrorOf<Ops[K]> | UnexpectedError> };
  return makeNullaryOp<V, never>(function* (): Generator<Instruction<never>, V, unknown> {
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

/**
 * Runs every op concurrently and succeeds with the first child to succeed. Remaining
 * siblings are aborted as soon as a winner is known. If every child fails, the combinator
 * fails with {@link ErrorGroup} whose `errors` array holds each child's failure in
 * input index order.
 *
 * `Op.any([])` fails with an {@link ErrorGroup} containing no child errors.
 *
 * @example
 * const r = await Op.any([Op.fail("a"), Op.of(42)]).run();
 * if (r.ok) console.log(r.value); // 42
 */
export const anyOp = <const Ops extends readonly NullaryOp[]>(
  ops: Ops,
): Op<SuccessOf<Ops[number]>, ErrorGroup<ErrorOf<Ops[number]> | UnexpectedError>, readonly []> => {
  const snapshot = ops.slice();
  type V = SuccessOf<Ops[number]>;
  type E = ErrorGroup<ErrorOf<Ops[number]> | UnexpectedError>;
  return makeNullaryOp<V, E>(function* (): Generator<Instruction<E>, V, unknown> {
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

/**
 * Runs every op concurrently and propagates whichever child settles first — success or
 * failure. Remaining siblings are aborted after a winner is known.
 *
 * `Op.race([])` fails fast with an {@link UnexpectedError}.
 *
 * @example
 * const r = await Op.race([slow(), fast()]).run();
 */
export const raceOp = <const Ops extends readonly NullaryOp[]>(
  ops: Ops,
): Op<SuccessOf<Ops[number]>, ErrorOf<Ops[number]> | UnexpectedError, readonly []> => {
  const snapshot = ops.slice();
  type V = SuccessOf<Ops[number]>;
  type E = ErrorOf<Ops[number]> | UnexpectedError;
  return makeNullaryOp<V, E>(function* (): Generator<Instruction<E>, V, unknown> {
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
