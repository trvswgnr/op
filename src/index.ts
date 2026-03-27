export interface Typed<Type extends string> {
  readonly type: Type;
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
type Result<T, E> = Ok<T> | Err<E>;

const ok = <T>(value: T): Ok<T> => Object.freeze({ type: "Ok", ok: true, value });
const err = <E>(error: E): Err<E> => Object.freeze({ type: "Err", ok: false, error });

type Suspended = { readonly type: "Suspended"; readonly promise: Promise<unknown> };
type Instruction<E> = Err<E> | Suspended;

export interface Op<T, E> {
  [Symbol.iterator](): Generator<Instruction<E>, T, unknown>;
}

export const succeed = <T>(a: T): Op<T, never> => ({
  // oxlint-disable-next-line require-yield
  *[Symbol.iterator]() {
    return a;
  },
});

export const fail = <E>(e: E): Op<never, E> => ({
  *[Symbol.iterator]() {
    yield err(e);
    throw "unreachable";
  },
});

export const tryPromise = <A, E = UnexpectedError>(
  f: () => Promise<A>,
  onError?: (e: unknown) => E,
): Op<A, E> => ({
  *[Symbol.iterator]() {
    // oxlint-disable-next-line typescript/consistent-type-assertions
    const result = (yield {
      type: "Suspended",
      promise: f().then(
        (a) => ok(a),
        (e) => (onError ? err(onError(e)) : err(new UnexpectedError({ cause: e }))),
      ),
    }) as Result<A, E>;
    if (result.type === "Err") {
      yield result;
      throw "unreachable";
    }
    return result.value;
  },
});

type ExtractErr<Y> = Y extends Err<infer E> ? E : never;

export const gen = <Y extends Instruction<unknown>, A>(
  f: () => Generator<Y, A, unknown>,
  // oxlint-disable-next-line typescript/consistent-type-assertions
): Op<A, ExtractErr<Y>> => ({ [Symbol.iterator]: f as never });

export const runSync = <E, A>(effect: Op<A, E>): Result<A, E> => {
  const iter = effect[Symbol.iterator]();
  let step = iter.next();
  while (!step.done) {
    if (step.value.type === "Suspended") throw new Error("Cannot runSync an async effect");
    return err(step.value.error);
  }
  return ok(step.value);
};

export const run = async <E, A>(effect: Op<A, E>): Promise<Result<A, E | UnexpectedError>> => {
  const iter = effect[Symbol.iterator]();
  let step = iter.next();
  while (!step.done) {
    if (step.value.type === "Err") return err(step.value.error);
    let resolved: Result<A, E>;
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions
      resolved = (await step.value.promise) as Result<A, E>;
    } catch (e) {
      return err(new UnexpectedError({ cause: e }));
    }
    step = iter.next(resolved);
  }
  return ok(step.value);
};
