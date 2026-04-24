import type { Err } from "./result.js";
import { err } from "./result.js";
import type { Typed } from "./typed.js";

/**
 * Built-in typed error for failures that are not mapped to a domain-specific error.
 */
export class UnexpectedError extends Error implements Typed<"UnexpectedError"> {
  readonly type = "UnexpectedError";
  constructor(cause: unknown, message?: string) {
    super(message ?? "An unexpected error occurred", { cause });
  }
}

/**
 * Built-in typed error emitted when an operation exceeds a timeout budget.
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
 */
export class UnreachableError extends Error implements Typed<"UnreachableError"> {
  readonly type = "UnreachableError";
  constructor() {
    super("Unreachable code path");
  }
}

/**
 * Instance type for classes created by {@link TypedError}.
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
 */
export interface ErrorGroup<E> extends AggregateError, Typed<"ErrorGroup"> {
  readonly errors: E[];
}

/**
 * Runtime constructor for {@link ErrorGroup}.
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

/**
 * Creates a new typed error class with the given type name and optional default message.
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
