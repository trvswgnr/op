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
 * const e = new UnexpectedError({ cause: original });
 *
 * @example
 * const result = await Op.suspend(() => Promise.reject("oops")).run();
 * if (!result.ok && result.error.type === "UnexpectedError") {
 *   console.error(result.error.cause);
 * }
 */
export class UnexpectedError extends Error implements Typed<"UnexpectedError"> {
  readonly type = "UnexpectedError";
  constructor({ cause }: { cause: unknown }) {
    super("An unexpected error occurred", { cause });
  }
}

export class NotImplementedError extends Error implements Typed<"NotImplementedError"> {
  readonly type = "NotImplementedError";
  constructor() {
    super("Not implemented");
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
export interface TypedError<
  TypeName extends string,
  Data extends Record<string, unknown> & { message?: string | undefined; cause?: unknown } = {},
> extends Error {
  readonly type: TypeName;
  readonly data: Omit<Data, "cause" | "message">;
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
    readonly data: Omit<Data, "cause" | "message">;
    constructor(...args: TypedErrorCtorParams<Data>) {
      // oxlint-disable-next-line typescript/consistent-type-assertions
      const _data = args[0] ?? ({} as Data);
      const { message, cause, ...data } = _data;
      super(message ?? defaultMessage, { cause });
      this.name = type;
      // oxlint-disable-next-line typescript/consistent-type-assertions
      this.data = Object.freeze(data) as Omit<Data, "cause" | "message">;
    }

    *[Symbol.iterator](): Generator<Err<this>, never, unknown> {
      yield err(this);
      throw "unreachable";
    }
  };
}

interface Suspended {
  readonly type: "Suspended";
  readonly promise: Promise<unknown>;
}

export type Instruction<E> = Err<E> | Suspended;

export interface OpBase<T, E> {
  type: "Op";
  [Symbol.iterator](): Generator<Instruction<E>, T, unknown>;
}

export interface OpNullary<T, E> extends OpBase<T, E> {
  (): OpBase<T, E>;
  run(): Promise<Result<T, E | UnexpectedError>>;
}

type OpArity<T, E, A extends readonly unknown[]> = {
  (...args: A): OpNullary<T, E>;
  run(...args: A): Promise<Result<T, E | UnexpectedError>>;
};

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
 * const r = await succeed(69).run();
 * if (r.ok) console.log(r.value);
 *
 * @example
 * const r = await succeed(Promise.resolve("done")).run();
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
    // oxlint-disable-next-line typescript/consistent-type-assertions
    run: () => runOp(self as never),
    type: "Op",
  };
  const op = () => self;
  // oxlint-disable-next-line typescript/consistent-type-assertions
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
 * const r = await fail("not found").run();
 * if (!r.ok) console.log(r.error);
 *
 * @example
 * const op = Op(function* () {
 *   yield* fail(new Error("abort"));
 *   return 1;
 * });
 */
export const fail = <E>(value: E): Op<never, E, []> => {
  const self = {
    *[Symbol.iterator]() {
      yield err(value);
      throw "unreachable";
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions
    run: () => runOp(self as never),
    type: "Op" as const,
  };
  const op = () => self;
  // oxlint-disable-next-line typescript/consistent-type-assertions
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
 * @template T Resolved value type.
 * @template E Error type when `onError` is provided. Defaults to {@link UnexpectedError} when omitted.
 * @param f Zero-arg function returning the promise to await.
 * @param onError Maps a rejection reason to `E` when provided.
 * @returns An operation that completes after the promise settles.
 *
 * @example
 * const r = await _try(() => fetch("/api/x")).run();
 *
 * @example
 * const r = await _try(
 *   () => Promise.reject("bad"),
 *   (e) => String(e),
 * ).run();
 */
export const _try = <T, E = UnexpectedError>(
  f: () => T,
  onError?: (e: unknown) => E,
): Op<Awaited<T>, E, []> => {
  const self = {
    *[Symbol.iterator]() {
      const result: Result<T, E> = yield {
        type: "Suspended" as const,
        promise: Promise.resolve()
          .then(() => f())
          .then(
            (a) => ok(a),
            (e) => err(onError ? onError(e) : new UnexpectedError({ cause: e })),
            // oxlint-disable-next-line typescript/consistent-type-assertions
          ) as Promise<Result<T, E>>,
      };
      if (result.type === "Err") {
        yield result;
        throw "unreachable";
      }
      return result.value;
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions
    run: () => runOp(self as never),
    type: "Op" as const,
  };
  const op = () => self;
  // oxlint-disable-next-line typescript/consistent-type-assertions
  return Object.assign(op, self) as never;
};

/**
 * Drives a nullary operation to completion and returns a {@link Result} (this function does not
 * throw; failures are `ok: false`).
 *
 * If `op` is a function, it is called once to get the iterable (same as `op()` before iterating).
 * Each yielded `Err` becomes an error result. Each `Suspended` step awaits `promise` and resumes
 * the generator. If the iterator throws, or awaiting the suspension promise throws, the result is
 * `Err` with {@link UnexpectedError}.
 *
 * @template E Error type from yielded `Err` values.
 * @template T Success return type from the generator.
 * @param op Nullary {@link Op} or zero-arg callable that returns one.
 * @returns A settled {@link Result}.
 *
 * @example
 * const r = await runOp(succeed(7));
 * if (r.ok) console.log(r.value);
 */
export async function runOp<E, T>(
  op: Op<T, E, readonly []>,
): Promise<Result<T, E | UnexpectedError>> {
  try {
    const ef = typeof op === "function" ? op() : op;
    const iter = ef[Symbol.iterator]();
    let step = iter.next();
    while (!step.done) {
      try {
        if (step.value.type === "Err") return err(step.value.error);
        step = iter.next(await step.value.promise);
      } catch (cause) {
        return err(new UnexpectedError({ cause }));
      }
    }
    const value = await step.value;
    return ok(value);
  } catch (cause) {
    return err(new UnexpectedError({ cause }));
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
 * const double = fromGenFn(function* () {
 *   const n = yield* succeed(3);
 *   return n * 2;
 * });
 * const r = await double.run();
 *
 * @example
 * const greet = fromGenFn(function* (name: string) {
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
      // oxlint-disable-next-line typescript/consistent-type-assertions
      run: () => runOp(inner as never),
      type: "Op",
    };
    const _op = () => inner;
    return Object.assign(_op, inner);
  };
  // oxlint-disable-next-line typescript/consistent-type-assertions
  const out: Op<unknown, unknown, unknown[]> = Object.assign(g, {
    // oxlint-disable-next-line typescript/consistent-type-assertions
    run: (...args: unknown[]) => runOp(g(...args) as never),
    type: "Op" as const,
  }) as never;
  return out;
};

export class RetryableError extends Error implements Typed<"RetryableError"> {
  readonly type = "RetryableError";
  constructor(cause: unknown) {
    super("Retryable error", { cause });
  }
  static isRetryable(cause: unknown): cause is RetryableError {
    return cause instanceof RetryableError;
  }
}

export interface RetryStrategy {
  maxAttempts: number;
  shouldRetry: (cause: unknown) => boolean;
  getDelay: (attempt: number) => number;
}

export function exponentialBackoff(opts: {
  baseMs: number;
  maxMs: number;
  jitterMs?: number;
}): (attempt: number) => number {
  const { baseMs, maxMs, jitterMs = 0 } = opts;
  return (attempt: number) => {
    const exponential = baseMs * Math.pow(2, attempt - 1);
    const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0;
    return Math.min(exponential + jitter, maxMs);
  };
}

export const DEFAULT_RETRY_STRATEGY: RetryStrategy = {
  maxAttempts: 3,
  shouldRetry: () => true,
  getDelay: exponentialBackoff({ baseMs: 100, maxMs: 1000 }),
};

export const withRetry = <T, E, A extends readonly unknown[]>(
  op: Op<T, E, A>,
  strategy: RetryStrategy = DEFAULT_RETRY_STRATEGY,
): Op<T, E, A> => {
  if (Symbol.iterator in op) {
    const self = {
      *[Symbol.iterator](): Generator<
        Instruction<E | UnexpectedError>,
        T,
        Result<T, E | UnexpectedError>
      > {
        let attempt = 1;

        while (true) {
          const result: Result<T, E | UnexpectedError> = yield {
            type: "Suspended",
            promise: op.run(),
          };

          if (result.ok) {
            return result.value;
          }

          const cause = result.error;
          const canRetry = attempt < strategy.maxAttempts && strategy.shouldRetry(cause);
          if (!canRetry) {
            yield err(cause);
            throw "unreachable";
          }

          const delayMs = Math.max(0, strategy.getDelay(attempt));
          if (delayMs > 0) {
            yield {
              type: "Suspended",
              promise: new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
            };
          }

          attempt += 1;
        }
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions
      run: () => runOp(self as never),
      type: "Op" as const,
    };
    const _op = () => self;
    // oxlint-disable-next-line typescript/consistent-type-assertions
    return Object.assign(_op, self) as never;
  }

  const g = (...args: A) => {
    const inner = {
      *[Symbol.iterator](): Generator<
        Instruction<E | UnexpectedError>,
        T,
        Result<T, E | UnexpectedError>
      > {
        let attempt = 1;

        while (true) {
          const result: Result<T, E | UnexpectedError> = yield {
            type: "Suspended",
            promise: op.run(...args),
          };

          if (result.ok) {
            return result.value;
          }

          const cause = result.error;
          const canRetry = attempt < strategy.maxAttempts && strategy.shouldRetry(cause);
          if (!canRetry) {
            yield err(cause);
            throw "unreachable";
          }

          const delayMs = Math.max(0, strategy.getDelay(attempt));
          if (delayMs > 0) {
            yield {
              type: "Suspended",
              promise: new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
            };
          }

          attempt += 1;
        }
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions
      run: () => runOp(inner as never),
      type: "Op" as const,
    };
    const _op = () => inner;
    return Object.assign(_op, inner);
  };

  const out = Object.assign(g, {
    // oxlint-disable-next-line typescript/consistent-type-assertions
    run: (...args: A) => runOp(g(...args) as never),
    type: "Op" as const,
  });

  // oxlint-disable-next-line typescript/consistent-type-assertions
  return out as never;
};
