import { Typed } from "./types";


export interface WithData<T> {
  readonly data: T;
}

export interface TypedError<T = unknown, D extends BaseErrorData = {}>
  extends Typed<T>, WithData<{} extends D ? {} : Omit<ErrorData<D>, "message" | "cause">>, Error {}

type BaseErrorData = Record<PropertyKey, unknown> & { message?: never; cause?: never };
type ErrorData<D extends BaseErrorData = {}> = D & {
  message?: string;
  cause?: unknown;
};
type ErrorDataInput<D extends BaseErrorData = {}> = {} extends D
  ? [data?: ErrorData<D>]
  : [data: ErrorData<D>];
type TypedErrorCtor<T> = {
  new <D extends BaseErrorData = {}>(...args: ErrorDataInput<D>): TypedError<T, D>;
};

export function TypedError<const T>(type: T): TypedErrorCtor<T> {
  return class<D extends BaseErrorData = {}> extends Error {
    readonly type = type;
    readonly data: any;
    constructor(...args: ErrorDataInput<D>) {
      const { message, cause, ...rest } = args[0] ?? {};
      super(message, { cause });
      this.data = rest;
    }
  };
}
