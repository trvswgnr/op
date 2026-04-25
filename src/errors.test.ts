import { describe, expect, test } from "vitest";
import { UnhandledException } from "./errors.js";

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
