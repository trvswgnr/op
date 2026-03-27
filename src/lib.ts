export interface Typed<TypeName extends string> {
  readonly type: TypeName;
}

export class UnexpectedError extends Error implements Typed<"UnexpectedError"> {
  readonly type = "UnexpectedError";
  constructor({ cause }: { cause: unknown }) {
    super("An unexpected error occurred", { cause });
  }
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

interface Suspended {
  readonly type: "Suspended";
  readonly promise: Promise<unknown>;
}

type Instruction<E> = Err<E> | Suspended;

interface OpBase<T, E> {
  [Symbol.iterator](): Generator<Instruction<E>, T, unknown>;
}

interface OpNullary<T, E> extends OpBase<T, E> {
  (): OpBase<T, E>;
  run(): Promise<Result<T, E | UnexpectedError>>;
}

type OpArity<T, E, A extends readonly unknown[]> = {
  (...args: A): OpNullary<T, E>;
  run(...args: A): Promise<Result<T, E | UnexpectedError>>;
};

type _Op<T, E, A extends readonly unknown[]> = [] extends A ? OpNullary<T, E> : OpArity<T, E, A>;

export type Op<T, E, A extends readonly unknown[]> = _Op<T, E, A> & Typed<"Op">;

type ExtractErr<Y> = Y extends Err<infer U> ? U : never;

export const succeed = <T>(value: T): Op<T, never, []> => {
  const self = {
    *[Symbol.iterator]() {
      return value;
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions
    run: () => runImpl(self as never),
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
    run: () => runImpl(self as never),
    type: "Op",
  };
  const op = () => self;
  // oxlint-disable-next-line typescript/consistent-type-assertions
  return Object.assign(op, self) as never;
};

export const tryPromise = <T, E = UnexpectedError>(
  f: () => Promise<T>,
  onError?: (e: unknown) => E,
): Op<T, E, []> => {
  const self = {
    *[Symbol.iterator]() {
      const result: Result<T, E> = yield {
        type: "Suspended" as const,
        promise: f().then(
          (a) => ok(a),
          (e) => (onError ? err(onError(e)) : err(new UnexpectedError({ cause: e }))),
        ),
      };
      if (result.type === "Err") {
        yield result;
        throw "unreachable";
      }
      return result.value;
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions
    run: () => runImpl(self as never),
    type: "Op" as const,
  };
  const op = () => self;
  // oxlint-disable-next-line typescript/consistent-type-assertions
  return Object.assign(op, self) as never;
};

export const runSync = <E, T>(effect: Op<T, E, readonly []>): Result<T, E | UnexpectedError> => {
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions
    const ef = typeof effect === "function" ? (effect as Function)() : effect;
    const iter = ef[Symbol.iterator]();
    let step = iter.next();
    while (!step.done) {
      if (step.value.type === "Suspended") throw new Error("Cannot runSync an async effect");
      return err(step.value.error);
    }
    return ok(step.value);
  } catch (cause) {
    return err(new UnexpectedError({ cause }));
  }
};

async function runImpl<E, T>(
  effect: Op<T, E, readonly []>,
): Promise<Result<T, E | UnexpectedError>> {
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions
    const ef = typeof effect === "function" ? (effect as Function)() : effect;
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
    const value = await Promise.resolve(step.value);
    return ok(value);
  } catch (cause) {
    return err(new UnexpectedError({ cause }));
  }
}

export const run = runImpl;

export function gen<Y extends Instruction<unknown>, T>(
  f: () => Generator<Y, T, unknown>,
): Op<T, ExtractErr<Y>, []>;
export function gen<Y extends Instruction<unknown>, T, A extends readonly unknown[]>(
  f: (...args: A) => Generator<Y, T, unknown>,
): Op<T, ExtractErr<Y>, A>;
export function gen(
  f: (...args: unknown[]) => Generator<Instruction<unknown>, unknown, unknown>,
): Op<unknown, unknown, []> | Op<unknown, unknown, readonly unknown[]> {
  if (f.length === 0) {
    const g = () => {
      const inner = {
        [Symbol.iterator]: () => f(),
        // oxlint-disable-next-line typescript/consistent-type-assertions
        run: () => runImpl(inner as never),
        type: "Op",
      };
      const op = () => inner;
      return Object.assign(op, inner);
    };
    // oxlint-disable-next-line typescript/consistent-type-assertions
    const out: Op<unknown, unknown, unknown[]> = Object.assign(g, {
      // oxlint-disable-next-line typescript/consistent-type-assertions
      run: () => runImpl(g() as never),
      type: "Op" as const,
    }) as never;
    return out;
  }
  const g = (...args: unknown[]) => {
    const inner = {
      [Symbol.iterator]: () => f(...args),
      // oxlint-disable-next-line typescript/consistent-type-assertions
      run: () => runImpl(inner as never),
      type: "Op",
    };
    const op = () => inner;
    return Object.assign(op, inner);
  };
  // oxlint-disable-next-line typescript/consistent-type-assertions
  const out: Op<unknown, unknown, unknown[]> = Object.assign(g, {
    // oxlint-disable-next-line typescript/consistent-type-assertions
    run: (...args: unknown[]) => runImpl(g(...args) as never),
    type: "Op" as const,
  }) as never;
  return out;
}
