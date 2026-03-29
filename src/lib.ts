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
 * // produced by `fromPromise` when the promise rejects and no `onError` is given
 * const result = await fromPromise(() => Promise.reject("oops"));
 * if (!result.ok && result.error.type === "UnexpectedError") {
 *   console.error(result.error.cause); // "oops"
 * }
 */
export class UnexpectedError extends Error implements Typed<"UnexpectedError"> {
  readonly type = "UnexpectedError";
  constructor({ cause }: { cause: unknown }) {
    super("An unexpected error occurred", { cause });
  }
}

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
 * @example
 * // basic
 * const NetworkError = TypedError("NetworkError");
 * const op = Op(function* () {
 *   yield* new NetworkError();
 * });
 *
 * // with default message
 * const ValidationError = TypedError("ValidationError", "A validation error occurred");
 * const op = Op(function* () {
 *   yield* new ValidationError();
 * });
 *
 * // with data
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

export const succeed = <T>(value: T): Op<Awaited<T>, never, []> => {
  if (value instanceof Promise) {
    return fromPromise(() => value);
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

export const fail = <E>(value: E): Op<never, E, []> => {
  const self = {
    *[Symbol.iterator]() {
      yield err(value);
      throw "unreachable";
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions
    run: () => runOp(self as never),
    type: "Op",
  };
  const op = () => self;
  // oxlint-disable-next-line typescript/consistent-type-assertions
  return Object.assign(op, self) as never;
};

export const fromPromise = <T, E = UnexpectedError>(
  f: () => Promise<T>,
  onError?: (e: unknown) => E,
): Op<T, E, []> => {
  const self = {
    *[Symbol.iterator]() {
      const result: Result<T, E> = yield {
        type: "Suspended" as const,
        promise: f().then(
          (a) => ok(a),
          (e) => err(onError ? onError(e) : new UnexpectedError({ cause: e })),
        ),
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
