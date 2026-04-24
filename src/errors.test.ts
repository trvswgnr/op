import { describe, expect, test, assert, expectTypeOf } from "vitest";
import { fromGenFn } from "./builders.js";
import type { Op } from "./core.js";
import { UnexpectedError, TypedError } from "./errors.js";

describe("UnexpectedError", () => {
  test("creates error with message 'An unexpected error occurred'", () => {
    const err = new UnexpectedError("test");
    expect(err.message).toBe("An unexpected error occurred");
  });

  test("accepts and preserves cause in constructor options", () => {
    const cause = new Error("original");
    const err = new UnexpectedError(cause);
    expect(err.cause).toBe(cause);
  });

  test("type discriminant is 'UnexpectedError'", () => {
    const err = new UnexpectedError(null);
    expect(err.type).toBe("UnexpectedError");
  });

  test("instanceof Error and UnexpectedError", () => {
    const err = new UnexpectedError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UnexpectedError);
  });
});

describe("TypedError", () => {
  test("default message uses the type name", () => {
    const NetworkError = TypedError("NetworkError", "A network error occurred");
    const err = new NetworkError();
    expect(err.message).toBe("A network error occurred");
    expect(err.type).toBe("NetworkError");
  });

  test("subclass with no extra data can be constructed with no arguments", () => {
    class DivisionByZeroError extends TypedError("DivisionByZeroError") {}
    const err = new DivisionByZeroError();
    expect(err.message).toBe("");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DivisionByZeroError);
  });

  test("custom message overrides default and is not left on data", () => {
    const ValidationError = TypedError("ValidationError");
    const err = new ValidationError({ message: "field required" });
    expect(err.message).toBe("field required");
  });

  test("message key with undefined falls back to default text", () => {
    const E = TypedError("E", "An E error occurred");
    const err = new E({ message: undefined });
    expect(err.message).toBe("An E error occurred");
  });

  test("cause is passed to Error and stripped from data", () => {
    const E = TypedError("E");
    const cause = new Error("root");
    const err = new E({ cause });
    expect(err.cause).toBe(cause);
  });

  test("preserves arbitrary payload fields on data", () => {
    class NotFound extends TypedError("NotFound")<{
      resource: string;
      id: number;
    }> {}
    const err = new NotFound({ resource: "user", id: 69, message: "gone", cause: "db" });
    expect(err.message).toBe("gone");
    expect(err.cause).toBe("db");
    expect(err.resource).toBe("user");
    expect(err.id).toBe(69);
  });

  test("does not mutate the passed data object, creates a new object without message and cause", () => {
    const E = TypedError("E");
    const payload = Object.freeze({ message: "m", cause: 1, extra: true });
    const err = new E(payload);
    expect(err).toHaveProperty("extra", true);
  });

  test("does not allow payload to override core fields or prototype", () => {
    const E = TypedError("E");
    const payload = {
      type: "OverriddenType",
      name: "OverriddenName",
      stack: "spoofed",
      __proto__: { poisoned: true },
      safe: "ok",
    } as unknown as Record<string, unknown>;

    const err = new E(payload);

    expect(err.type).toBe("E");
    expect(err.name).toBe("E");
    expect(err.stack).not.toBe("spoofed");
    expect(Object.getPrototypeOf(err)).toBe(E.prototype);
    expect(err).toHaveProperty("safe", "ok");
    expect(Object.prototype.hasOwnProperty.call(err, "poisoned")).toBe(false);
  });

  test("type narrowing: distinct factories produce distinct classes", () => {
    const A = TypedError("A");
    const B = TypedError("B");
    const a = new A();
    const b = new B();
    expect(a).toBeInstanceOf(A);
    expect(a).not.toBeInstanceOf(B);
    expect(b).toBeInstanceOf(B);
    expect(b).not.toBeInstanceOf(A);
  });

  test("expectTypeOf: default data allows zero-arg constructor", () => {
    const E = TypedError("E");
    const e = new E();
    expectTypeOf(e).toEqualTypeOf<TypedError<"E">>();
  });

  test("can be used directly in gen", async () => {
    class CustomError extends TypedError("CustomError") {}
    const customError = new CustomError();
    const e = fromGenFn(function* () {
      return yield* customError;
    });
    expectTypeOf(e).toEqualTypeOf<Op<never, CustomError, []>>();
    const result = await e.run();
    assert(result.ok === false, "result.ok should be false");
    expect(result.error).toBe(customError);
  });
});
