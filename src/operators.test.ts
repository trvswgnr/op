import { assert, describe, expect, test, vi } from "vitest";
import { Op } from "./index.js";
import { TaggedError, UnhandledException } from "./errors.js";
import { TRUE } from "./test-utils.js";

// Scope: integration tests for fluent operator behavior
describe("operator combinators", () => {
  describe("op.map", () => {
    test("map transforms success values and preserves arity", async () => {
      const op = Op(function* (n: number) {
        return n + 1;
      }).map((value) => `v:${value}`);

      const result = await op.run(2);
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe("v:3");
    });

    test("map does not transform failures", async () => {
      const result = await Op.fail("boom" as const)
        .map(() => 69)
        .run();
      assert(result.isErr(), "should be Err");
      expect(result.error).toBe("boom");
    });
  });

  describe("op.mapErr", () => {
    test("mapErr transforms failures and preserves arity", async () => {
      const op = Op(function* (n: number) {
        if (n < 0) {
          return yield* Op.fail("negative" as const);
        }
        return n;
      }).mapErr((error) => ({ code: error }));

      const errResult = await op.run(-1);
      assert(errResult.isErr(), "should be Err");
      expect(errResult.error).toEqual({ code: "negative" });

      const okResult = await op.run(2);
      assert(okResult.isOk(), "should be Ok");
      expect(okResult.value).toBe(2);
    });

    test("mapErr does not transform unhandled exceptions", async () => {
      const op = Op(function* () {
        throw new Error("boom");
      }).mapErr(() => "mapped" as const);

      const result = await op.run();
      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(UnhandledException);
    });

    test("mapErr withRetry retries against original error channel", async () => {
      let attempts = 0;
      const mapped = Op(function* () {
        attempts += 1;
        if (attempts < 2) {
          return yield* Op.fail("retryable" as const);
        }
        return 69;
      })
        .mapErr((error) => ({ code: error }))
        .withRetry({
          maxAttempts: 2,
          shouldRetry: (cause) => cause === "retryable",
          getDelay: () => 0,
        });

      const result = await mapped.run();
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe(69);
      expect(attempts).toBe(2);
    });
  });

  describe("op.flatMap", () => {
    test("flatMap chains operations and merges error channels", async () => {
      const op = Op.of(5).flatMap((value) =>
        value > 3 ? Op.of(`ok:${value}` as const) : Op.fail("too-small" as const),
      );
      const okResult = await op.run();
      assert(okResult.isOk(), "should be Ok");
      expect(okResult.value).toBe("ok:5");

      const errResult = await Op.of(1)
        .flatMap((value) => (value > 3 ? Op.of(value) : Op.fail("too-small" as const)))
        .run();
      assert(errResult.isErr(), "should be Err");
      expect(errResult.error).toBe("too-small");
    });

    test("flatMap on parameterized ops preserves arity and policy chaining", async () => {
      let attempts = 0;
      const op = Op(function* (n: number) {
        attempts += 1;
        if (attempts === 1) {
          return yield* Op.fail("retry" as const);
        }
        return n;
      })
        .flatMap((value) => Op.of(value * 2))
        .withRetry({
          maxAttempts: 2,
          shouldRetry: (cause) => cause === "retry",
          getDelay: () => 0,
        });

      const result = await op.run(4);
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe(8);
      expect(attempts).toBe(2);
    });
  });

  describe("op.tap", () => {
    test("tap observes successful values and preserves the original value", async () => {
      const seen: number[] = [];
      const op = Op(function* (n: number) {
        return n + 1;
      }).tap((value) => {
        seen.push(value);
        return "ignored";
      });

      const result = await op.run(2);
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe(3);
      expect(seen).toEqual([3]);
    });

    test("tap sequences an Op-returning observer and discards observer output", async () => {
      const seen: string[] = [];
      const op = Op.of(4).tap((value) =>
        Op.of(`observed:${value}`).map((payload) => {
          seen.push(payload);
          return 69;
        }),
      );

      const result = await op.run();
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe(4);
      expect(seen).toEqual(["observed:4"]);
    });

    test("tap propagates observer Op failures", async () => {
      const result = await Op.of(4)
        .tap(() => Op.fail("tap-failed" as const))
        .run();
      assert(result.isErr(), "should be Err");
      expect(result.error).toBe("tap-failed");
    });

    test("tap drives Op(function*) observers that succeed", async () => {
      const seen: string[] = [];
      const result = await Op.of(4)
        .tap((value) =>
          Op(function* () {
            seen.push(`observed:${value}`);
            return 69;
          }),
        )
        .run();

      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe(4);
      expect(seen).toEqual(["observed:4"]);
    });

    test("tap propagates failures from Op(function*) observers", async () => {
      const result = await Op.of(4)
        .tap(() =>
          Op(function* () {
            return yield* Op.fail("tap-gen-failed" as const);
          }),
        )
        .run();

      assert(result.isErr(), "should be Err");
      expect(result.error).toBe("tap-gen-failed");
    });

    test("tap turns thrown observer errors into UnhandledException", async () => {
      const cause = new Error("observer-boom");
      const result = await Op.of(4)
        .tap(() => {
          throw cause;
        })
        .run();

      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(UnhandledException);
      expect(result.error.cause).toBe(cause);
    });

    test("tap does not run observer when source op fails", async () => {
      const observer = vi.fn();
      const result = await Op.fail("boom" as const)
        .tap(observer)
        .run();
      assert(result.isErr(), "should be Err");
      expect(result.error).toBe("boom");
      expect(observer).not.toHaveBeenCalled();
    });
  });

  describe("op.tapErr", () => {
    test("tapErr observes failures and preserves the original error", async () => {
      const seen: string[] = [];
      const op = Op(function* (kind: "bad" | "ok") {
        if (kind === "bad") {
          return yield* Op.fail("bad-input" as const);
        }
        return 69;
      }).tapErr((error) => {
        seen.push(error);
        return "ignored";
      });

      const errResult = await op.run("bad");
      assert(errResult.isErr(), "should be Err");
      expect(errResult.error).toBe("bad-input");
      expect(seen).toEqual(["bad-input"]);

      const okResult = await op.run("ok");
      assert(okResult.isOk(), "should be Ok");
      expect(okResult.value).toBe(69);
      expect(seen).toEqual(["bad-input"]);
    });

    test("tapErr sequences an Op-returning observer and discards observer output", async () => {
      const seen: string[] = [];
      const result = await Op.fail("bad-input" as const)
        .tapErr((error) =>
          Op.of(error.toUpperCase()).map((payload) => {
            seen.push(payload);
            return 69;
          }),
        )
        .run();

      assert(result.isErr(), "should be Err");
      expect(result.error).toBe("bad-input");
      expect(seen).toEqual(["BAD-INPUT"]);
    });

    test("tapErr propagates observer Op failures", async () => {
      const result = await Op.fail("bad-input" as const)
        .tapErr(() => Op.fail("observer-failed" as const))
        .run();
      assert(result.isErr(), "should be Err");
      expect(result.error).toBe("observer-failed");
    });

    test("tapErr drives Op(function*) observers that succeed", async () => {
      const seen: string[] = [];
      const result = await Op.fail("bad-input" as const)
        .tapErr((error) =>
          Op(function* () {
            seen.push(error.toUpperCase());
            return 69;
          }),
        )
        .run();

      assert(result.isErr(), "should be Err");
      expect(result.error).toBe("bad-input");
      expect(seen).toEqual(["BAD-INPUT"]);
    });

    test("tapErr propagates failures from Op(function*) observers", async () => {
      const result = await Op.fail("bad-input" as const)
        .tapErr(() =>
          Op(function* () {
            return yield* Op.fail("tap-err-gen-failed" as const);
          }),
        )
        .run();

      assert(result.isErr(), "should be Err");
      expect(result.error).toBe("tap-err-gen-failed");
    });

    test("tapErr turns thrown observer errors into UnhandledException", async () => {
      const cause = new Error("observer-boom");
      const result = await Op.fail("bad-input" as const)
        .tapErr(() => {
          throw cause;
        })
        .run();

      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(UnhandledException);
      if (result.error instanceof UnhandledException) {
        expect(result.error.cause).toBe(cause);
      }
    });

    test("tapErr does not run observer on success", async () => {
      const observer = vi.fn();
      const result = await Op.of(69).tapErr(observer).run();
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe(69);
      expect(observer).not.toHaveBeenCalled();
    });

    test("tapErr bypasses UnhandledException values", async () => {
      const observer = vi.fn();
      const result = await Op(function* () {
        throw new Error("boom");
      })
        .tapErr(observer)
        .run();
      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(UnhandledException);
      expect(observer).not.toHaveBeenCalled();
    });
  });

  describe("op.recover", () => {
    test("recover narrows handled error type via type guard predicate", async () => {
      class AErr extends TaggedError("AErr")() {}
      class BErr extends TaggedError("BErr")() {}
      class RecoveryErr extends TaggedError("RecoveryErr")() {}

      const op = Op(function* (kind: "a" | "b") {
        if (kind === "a") {
          return yield* new AErr();
        }
        return yield* new BErr();
      }).recover(AErr.is, () => Op.fail(new RecoveryErr()));

      const recovered = await op.run("a");
      assert(recovered.isErr(), "should be Err");
      expect(recovered.error).toBeInstanceOf(RecoveryErr);

      const passthrough = await op.run("b");
      assert(passthrough.isErr(), "should be Err");
      expect(passthrough.error).toBeInstanceOf(BErr);
    });

    test("recover can return a plain fallback value", async () => {
      class MissingConfigError extends TaggedError("MissingConfigError")() {}

      const recovered = Op(function* () {
        return yield* new MissingConfigError();
      }).recover(MissingConfigError.is, () => "fallback" as const);

      const result = await recovered.run();
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe("fallback");
    });

    test("recover can sequence a recovery op", async () => {
      class MissingConfigError extends TaggedError("MissingConfigError")() {}

      const recovered = Op(function* () {
        return yield* new MissingConfigError();
      }).recover(MissingConfigError.is, () => Op.of(69));

      const result = await recovered.run();
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe(69);
    });

    test("recover drives Op(function*) handlers that succeed", async () => {
      class MissingConfigError extends TaggedError("MissingConfigError")() {}

      const recovered = Op(function* () {
        return yield* new MissingConfigError();
      }).recover(MissingConfigError.is, () =>
        Op(function* () {
          return 42;
        }),
      );

      const result = await recovered.run();
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe(42);
    });

    test("recover propagates failures from Op(function*) handlers", async () => {
      class MissingConfigError extends TaggedError("MissingConfigError")() {}
      class RecoveryErr extends TaggedError("RecoveryErr")() {}

      const recovered = Op(function* () {
        return yield* new MissingConfigError();
      }).recover(MissingConfigError.is, () =>
        Op(function* () {
          return yield* new RecoveryErr();
        }),
      );

      const result = await recovered.run();
      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(RecoveryErr);
    });

    test("recover bypasses UnhandledException even when predicate matches", async () => {
      const recovered = Op(function* () {
        throw new Error("boom");
      }).recover(
        () => true,
        () => "fallback" as const,
      );

      const result = await recovered.run();
      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(UnhandledException);
    });

    test("recover can handle typed errors with explicit constructor", async () => {
      class TestError extends TaggedError("TestError")() {}
      const recovered = Op(function* () {
        if (TRUE) {
          return yield* new TestError();
        }
        return 69;
      }).recover(TestError, () => "fallback");

      const result = await recovered.run();
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe("fallback");
    });

    test("recover with constructor predicate preserves arity", async () => {
      class TestError extends TaggedError("TestError")() {}
      const recovered = Op(function* (n: number) {
        if (n < 0) {
          return yield* new TestError();
        }
        return n;
      }).recover(TestError, () => "fallback");

      const result = await recovered.run(-1);
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe("fallback");
    });

    test("recover with constructor predicate allows only errors from the Op to be recovered", async () => {
      class E1 extends TaggedError("E1")() {}
      class E2 extends TaggedError("E2")() {}
      class E3 extends TaggedError("E3")() {}
      const op = Op(function* () {
        if (TRUE) {
          return yield* new E1();
        }
        return yield* new E2();
      });

      const recovered1 = op.recover(E1, () => "fallback");

      const result1 = await recovered1.run();
      assert(result1.isOk(), "should be Ok");
      expect(result1.value).toBe("fallback");

      const recovered2 = op.recover(E2, () => "fallback1");

      const result2 = await recovered2.run();
      assert(result2.isErr(), "should be Err");
      expect(result2.error).toBeInstanceOf(E1);

      void E3;
    });
  });
});
