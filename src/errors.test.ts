import { describe, expect, test } from "vitest";
import { ErrorGroup, TaggedError, TimeoutError, UnhandledException } from "./errors.js";

describe("UnhandledException", () => {
  test("derives message from cause", () => {
    const err = new UnhandledException({ cause: new Error("test") });
    expect(err.message).toBe("Unhandled exception: test");
  });

  test("accepts and preserves cause in constructor options", () => {
    const cause = new Error("original");
    const err = new UnhandledException({ cause });
    expect(err.cause).toBe(cause);
  });

  test("type discriminant is 'UnhandledException'", () => {
    const err = new UnhandledException({ cause: null });
    expect(err._tag).toBe("UnhandledException");
  });

  test("instanceof Error and UnhandledException", () => {
    const err = new UnhandledException({ cause: new Error("x") });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UnhandledException);
  });
});

describe("TimeoutError", () => {
  test("sets timeout metadata and formatted message", () => {
    const timeoutError = new TimeoutError({ timeoutMs: 250 });
    expect(timeoutError.timeoutMs).toBe(250);
    expect(timeoutError.message).toBe("Operation timed out after 250ms");
  });

  test("has TimeoutError discriminant and instance shape", () => {
    const timeoutError = new TimeoutError({ timeoutMs: 10 });
    expect(timeoutError._tag).toBe("TimeoutError");
    expect(timeoutError).toBeInstanceOf(Error);
    expect(timeoutError).toBeInstanceOf(TimeoutError);
  });
});

describe("ErrorGroup", () => {
  test("preserves message and errors array", () => {
    const e1 = new Error("one");
    const e2 = "two";
    const grouped = new ErrorGroup([e1, e2], "group failed");
    expect(grouped.message).toBe("group failed");
    expect(grouped.errors).toEqual([e1, e2]);
  });

  test("has discriminant, name, and Error inheritance", () => {
    const grouped = new ErrorGroup([new Error("boom")], "group failed");
    expect(grouped._tag).toBe("ErrorGroup");
    expect(grouped.name).toBe("ErrorGroup");
    expect(grouped).toBeInstanceOf(Error);
    expect(grouped).toBeInstanceOf(AggregateError);
  });

  test("ErrorGroup.is narrows instances only", () => {
    const grouped = new ErrorGroup([new Error("boom")], "group failed");
    expect(ErrorGroup.is(grouped)).toBe(true);
    expect(ErrorGroup.is(new AggregateError([], "group failed"))).toBe(false);
    expect(ErrorGroup.is({ _tag: "ErrorGroup" })).toBe(false);
  });

  test("iterator yields an error result carrying the group", () => {
    const grouped = new ErrorGroup([new Error("boom")], "group failed");
    function* iterateGroup() {
      return yield* grouped;
    }
    const first = iterateGroup().next();
    expect(first.done).toBe(false);
    expect(first.value.status).toBe("error");
    expect(first.value.error).toBe(grouped);
  });
});

describe("TaggedError factory", () => {
  test("creates tagged subclasses with expected runtime shape", () => {
    class ValidationError extends TaggedError("ValidationError")<{
      message: string;
      field: string;
    }>() {}

    const validationError = new ValidationError({
      message: "invalid email",
      field: "email",
    });

    expect(validationError._tag).toBe("ValidationError");
    expect(validationError.name).toBe("ValidationError");
    expect(validationError.field).toBe("email");
    expect(validationError).toBeInstanceOf(Error);
    expect(validationError).toBeInstanceOf(ValidationError);
    expect(ValidationError.is(validationError)).toBe(true);
    expect(ValidationError.is(new Error("x"))).toBe(false);
  });
});
