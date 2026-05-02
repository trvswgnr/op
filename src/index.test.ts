import { assert, describe, expect, expectTypeOf, test, vi } from "vitest";
import {
  Op,
  TimeoutError,
  UnhandledException,
  TaggedError,
  ErrorGroup,
  exponentialBackoff,
  type ExitContext,
  type Result,
  type TaggedErrorInstance,
} from "./index.js";
import { SuspendInstruction } from "./core/instructions.js";

describe("public API (index)", () => {
  describe("OpFactory", () => {
    test("type is 'OpFactory'", () => {
      expect(Op._tag).toBe("OpFactory");
    });
    test("run is a function", () => {
      expect(Op.run).toBeInstanceOf(Function);
    });
    test("pure is a function", () => {
      expect(Op.of).toBeInstanceOf(Function);
    });
    test("empty is a stable singleton op", async () => {
      expectTypeOf(Op.empty).toEqualTypeOf<Op<void, never, []>>();
      expect(Op.empty).toBe(Op.empty);

      const result = await Op.empty.run();
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBeUndefined();
    });
  });
  describe("exponentialBackoff", () => {
    test("is exported and produces exponential delays", () => {
      const getDelay = exponentialBackoff({ base: 100, max: 1000, jitter: 0 });
      expect(getDelay(1)).toBe(100);
      expect(getDelay(2)).toBe(200);
      expect(getDelay(3)).toBe(400);
      expect(getDelay(5)).toBe(1000); // clamped by maxMs
    });

    test("default is exported", () => {
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
      try {
        expect(exponentialBackoff.DEFAULT).toBeInstanceOf(Function);
        expect(exponentialBackoff.DEFAULT(1)).toBe(1_000);
        expect(exponentialBackoff.DEFAULT(2)).toBe(2_000);
        expect(exponentialBackoff.DEFAULT(5)).toBe(16_000);
        expect(exponentialBackoff.DEFAULT(6)).toBe(30_000);
      } finally {
        randomSpy.mockRestore();
      }
    });

    test("produces random delays with jitter", () => {
      const getDelay = exponentialBackoff({ base: 100, max: 1000, jitter: 0.5 });
      const delay = getDelay(1);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThan(1000);
    });

    test("normalizes invalid options instead of throwing", () => {
      expect(() => exponentialBackoff({ base: 0, max: 1000, jitter: 0.5 })).not.toThrow();
      expect(() => exponentialBackoff({ base: 100, max: 0, jitter: 0.5 })).not.toThrow();
      expect(() => exponentialBackoff({ base: 100, max: 1000, jitter: -0.5 })).not.toThrow();
      expect(() => exponentialBackoff({ base: 100, max: 1000, jitter: 1.5 })).not.toThrow();

      const baseFallback = exponentialBackoff({ base: 0, max: 1000, jitter: 0 });
      expect(baseFallback(1)).toBe(1000);

      const maxClampedToBase = exponentialBackoff({ base: 100, max: 0, jitter: 0 });
      expect(maxClampedToBase(1)).toBe(100);
      expect(maxClampedToBase(5)).toBe(100);

      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        const jitterFloor = exponentialBackoff({ base: 100, max: 1000, jitter: -0.5 });
        expect(jitterFloor(1)).toBe(100);

        const jitterCeiling = exponentialBackoff({ base: 100, max: 1000, jitter: 1.5 });
        expect(jitterCeiling(1)).toBe(0);
      } finally {
        randomSpy.mockRestore();
      }
    });
  });
  describe("UnhandledException", () => {
    test("discriminant and cause", () => {
      const cause = new Error("root");
      const e = new UnhandledException({ cause });
      expect(e._tag).toBe("UnhandledException");
      expect(e.message).toBe("Unhandled exception: root");
      expect(e.cause).toBe(cause);
    });
  });

  describe("TaggedError", () => {
    test("factory produces typed errors", () => {
      const SmokeError = TaggedError("SmokeError")<{ message: string }>();
      const e = new SmokeError({ message: "x" });
      expectTypeOf(e).toEqualTypeOf<TaggedErrorInstance<"SmokeError", { message: string }>>();
      expect(e._tag).toBe("SmokeError");
      expect(e.name).toBe("SmokeError");
      expect(e.message).toBe("x");
    });
  });

  describe("Op.of / Op.fail", () => {
    test("pure does not yield errors; fail does not", async () => {
      const okR = await Op.of(7).run();
      assert(okR.isOk(), "should be Ok");
      expect(okR.value).toBe(7);

      const errR = await Op.fail("no").run();
      assert(errR.isErr(), "should be Err");
      expect(errR.error).toBe("no");
    });
  });

  describe("operator combinators", () => {
    describe("op.map", () => {
      test("map transforms success values and preserves arity", async () => {
        const op = Op(function* (n: number) {
          return n + 1;
        }).map((value) => `v:${value}`);

        expectTypeOf(op).toEqualTypeOf<Op<string, never, [number]>>();

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

        expectTypeOf(op).toEqualTypeOf<Op<number, { code: "negative" }, [number]>>();

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
        expectTypeOf(op).toEqualTypeOf<Op<`ok:${number}`, "too-small", []>>();

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

        expectTypeOf(op).toEqualTypeOf<Op<number, "retry", [number]>>();

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

        expectTypeOf(op).toEqualTypeOf<Op<number, never, [number]>>();

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

        expectTypeOf(op).toEqualTypeOf<Op<number, never, []>>();

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

        expectTypeOf(op).toEqualTypeOf<Op<number, "bad-input", ["bad" | "ok"]>>();

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
        }).recover(
          (error): error is AErr => error instanceof AErr,
          () => Op.fail(new RecoveryErr()),
        );

        expectTypeOf(op).toEqualTypeOf<Op<never, BErr | RecoveryErr, ["a" | "b"]>>();

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
        }).recover(
          (error): error is MissingConfigError => error instanceof MissingConfigError,
          () => "fallback" as const,
        );

        expectTypeOf(recovered).toEqualTypeOf<Op<"fallback", never, []>>();

        const result = await recovered.run();
        assert(result.isOk(), "should be Ok");
        expect(result.value).toBe("fallback");
      });

      test("recover can sequence a recovery op", async () => {
        class MissingConfigError extends TaggedError("MissingConfigError")() {}

        const recovered = Op(function* () {
          return yield* new MissingConfigError();
        }).recover(
          (error): error is MissingConfigError => error instanceof MissingConfigError,
          () => Op.of(69),
        );

        const result = await recovered.run();
        assert(result.isOk(), "should be Ok");
        expect(result.value).toBe(69);
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
          if (Infinity) {
            return yield* new TestError();
          }
          return 69; // will never actually happen
        }).recover(TestError, () => "fallback");

        expectTypeOf(recovered).toEqualTypeOf<Op<string | number, never, []>>();

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

        expectTypeOf(recovered).toEqualTypeOf<Op<string | number, never, [number]>>();

        const result = await recovered.run(-1);
        assert(result.isOk(), "should be Ok");
        expect(result.value).toBe("fallback");
      });

      test("recover with constructor predicate allows only errors from the Op to be recovered", async () => {
        class E1 extends TaggedError("E1")() {}
        class E2 extends TaggedError("E2")() {}
        class E3 extends TaggedError("E3")() {}
        const op = Op(function* () {
          if (Infinity > 0) {
            return yield* new E1();
          }
          return yield* new E2();
        });

        const recovered1 = op.recover(E1, () => "fallback");
        expectTypeOf(recovered1).toEqualTypeOf<Op<string, E2, []>>();

        const result1 = await recovered1.run();
        assert(result1.isOk(), "should be Ok");
        expect(result1.value).toBe("fallback");

        const recovered2 = op.recover(E2, () => "fallback1");
        expectTypeOf(recovered2).toEqualTypeOf<Op<string, E1, []>>();

        const result2 = await recovered2.run();
        assert(result2.isErr(), "should be Err");
        expect(result2.error).toBeInstanceOf(E1);

        // @ts-expect-error - E3 is not a valid error type
        const _recovered3 = op.recover(E3, () => "fallback2");
      });
    });
  });

  describe("Op.try", () => {
    test("resolve and mapped reject", async () => {
      const okR = await Op.try(
        () => Promise.resolve(3),
        () => "mapped",
      ).run();
      assert(okR.isOk(), "should be Ok");
      expect(okR.value).toBe(3);

      const errR = await Op.try(
        () => (Math.random() > 1 ? Promise.resolve(3) : Promise.reject("boom")),
        (e) => ({ mappedError: String(e) }),
      ).run();
      assert(errR.isErr(), "should be Err");
      expect(errR.error).toEqual({ mappedError: "boom" });
    });

    test("works synchronously", async () => {
      // default maps to UnhandledException
      {
        const result = await Op.try(async () => {
          await Promise.reject("failed");
        }).run();
        assert(result.isErr(), "should be Err");
        expect(result.error).toBeInstanceOf(UnhandledException);
        expect(result.error.cause).toBe("failed");
      }
      // explicitly mapped
      {
        const result = await Op.try(
          async () => {
            await Promise.reject(69);
          },
          (e) => ({ mappedError: String(e) }),
        ).run();
        assert(result.isErr(), "should be Err");
        expect(result.error).toEqual({ mappedError: "69" });
      }
      // sync throw defaults maps to UnhandledException
      {
        const syncThrow = new Error("failed");
        const result = await Op.try(async () => {
          throw syncThrow;
        }).run();
        assert(result.isErr(), "should be Err");
        expect(result.error).toBeInstanceOf(UnhandledException);
        expect(result.error.cause).toBe(syncThrow);
      }
      // explicitly mapped
      {
        const result = await Op.try(
          async () => {
            throw 69;
          },
          (e) => ({ mappedError: String(e) }),
        ).run();
        assert(result.isErr(), "should be Err");
        expect(result.error).toEqual({ mappedError: "69" });
      }
      // success path
      {
        const result = await Op.try(async () => {
          return 69;
        }).run();
        assert(result.isOk(), "result should be Ok");
        expect(result.value).toBe(69);
      }
    });
  });

  describe("op.withRetry", () => {
    const immediateRetry = (cause: unknown) => ({
      maxAttempts: 3,
      shouldRetry: (e: unknown) => e === cause,
      getDelay: () => 0,
    });

    test("retries and succeeds through index exports", async () => {
      let attempts = 0;
      const transient = new Error("transient");
      const child = Op.try(async () => {
        attempts += 1;
        if (attempts < 2) {
          throw transient;
        }
        return 60;
      }).withRetry(immediateRetry(transient));

      const program = Op(function* () {
        const a = yield* Op.of(9);
        const b = yield* child;
        return a + b;
      });

      const result = await program.run();
      assert(result.isOk(), "result should be Ok");
      expect(result.value).toBe(69);
      expect(attempts).toBe(2);
    });

    test("retries async and generator ops through index exports", async () => {
      let asyncAttempts = 0;
      const transient = new Error("transient");
      const asyncProgram = Op(function* (id: string) {
        asyncAttempts += 1;
        if (asyncAttempts === 1) {
          throw transient;
        }
        return id.length;
      }).withRetry(immediateRetry(transient));
      const asyncResult = await asyncProgram.run("abcd");
      assert(asyncResult.isOk(), "should be Ok");
      expect(asyncResult.value).toBe(4);
      expect(asyncAttempts).toBe(2);

      let genAttempts = 0;
      const generatorProgram = Op(function* (id: string) {
        genAttempts += 1;
        if (genAttempts === 1) {
          return yield* Op.fail("retry me");
        }
        return id.toUpperCase();
      }).withRetry(immediateRetry("retry me"));
      const genResult = await generatorProgram.run("ok");
      assert(genResult.isOk(), "should be Ok");
      expect(genResult.value).toBe("OK");
      expect(genAttempts).toBe(2);
    });

    test("retries failures raised from flatMap stage", async () => {
      let attempts = 0;
      const transient = new Error("transient");
      const program = Op.of("seed")
        .flatMap(() =>
          Op.try(
            () => {
              attempts += 1;
              if (attempts < 3) {
                throw transient;
              }
              return attempts;
            },
            (cause) => cause,
          ),
        )
        .withRetry({
          maxAttempts: 3,
          shouldRetry: (cause) => cause === transient,
          getDelay: () => 0,
        });

      const result = await program.run();
      assert(result.isOk(), "result should be Ok");
      expect(result.value).toBe(3);
      expect(attempts).toBe(3);
    });
  });

  describe("op.withTimeout", () => {
    test("times out through index exports", async () => {
      vi.useFakeTimers();
      try {
        const child = Op.try(
          () =>
            new Promise<number>((resolve) => {
              setTimeout(() => resolve(69), 200);
            }),
        ).withTimeout(100);

        const runPromise = child.run();
        await vi.advanceTimersByTimeAsync(100);
        const result = await runPromise;

        assert(result.isErr(), "should be Err");
        expect(result.error).toBeInstanceOf(TimeoutError);
      } finally {
        vi.useRealTimers();
      }
    });

    test("timeout+retry chain order controls semantics through index exports", async () => {
      vi.useFakeTimers();
      try {
        let attempts = 0;
        const program = Op.try(
          () =>
            new Promise<number>((resolve) => {
              attempts += 1;
              const delay = attempts === 1 ? 120 : 50;
              setTimeout(() => resolve(69), delay);
            }),
        )
          .withTimeout(100)
          .withRetry({
            maxAttempts: 2,
            shouldRetry: (cause) => cause instanceof TimeoutError,
            getDelay: () => 0,
          });

        const runPromise = program.run();
        await vi.advanceTimersByTimeAsync(150);
        const result = await runPromise;
        assert(result.isOk(), "result should be Ok");
        expect(result.value).toBe(69);
        expect(attempts).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("op.withSignal", () => {
    test("supports caller-driven cancellation through index exports", async () => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const op = Op.try(
          (signal) =>
            new Promise<number>((resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              const id = setTimeout(() => resolve(69), 200);
              signal.addEventListener("abort", () => {
                clearTimeout(id);
                reject(signal.reason);
              });
            }),
          (cause) => String(cause instanceof Error ? cause.message : cause),
        ).withSignal(controller.signal);

        expectTypeOf(op.run()).toEqualTypeOf<
          Promise<Result<number, string | UnhandledException>>
        >();

        const runPromise = op.run();
        controller.abort(new Error("cancelled"));
        await vi.advanceTimersByTimeAsync(0);

        const result = await runPromise;
        assert(result.isErr(), "should be Err");
        expect(result.error).toBe("cancelled");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("op.withRelease", () => {
    test("runs registered cleanup after a successful run", async () => {
      const events: string[] = [];
      const release = vi.fn((conn: { id: number }) => {
        events.push(`release:${conn.id}`);
      });

      const program = Op(function* () {
        const conn = yield* Op.of({ id: 7 }).withRelease(release);
        events.push(`query:${conn.id}`);
        return conn.id;
      });

      const result = await program.run();
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe(7);
      expect(events).toEqual(["query:7", "release:7"]);
      expect(release).toHaveBeenCalledTimes(1);
    });

    test("runs cleanup when downstream logic fails with a typed error", async () => {
      const release = vi.fn();
      const result = await Op(function* () {
        yield* Op.of({ id: 1 }).withRelease(() => {
          release();
        });
        return yield* Op.fail("boom" as const);
      }).run();

      assert(result.isErr(), "should be Err");
      expect(result.error).toBe("boom");
      expect(release).toHaveBeenCalledTimes(1);
    });

    test("runs cleanup when withTimeout aborts inner work", async () => {
      vi.useFakeTimers();
      try {
        const release = vi.fn();
        const op = Op(function* () {
          yield* Op.of({ close: release }).withRelease((conn) => conn.close());
          return yield* Op.try(
            (signal) =>
              new Promise<number>((_resolve, reject) => {
                if (signal.aborted) {
                  reject(signal.reason);
                  return;
                }
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          ).withTimeout(10);
        });

        const runPromise = op.run();
        await vi.advanceTimersByTimeAsync(10);
        const result = await runPromise;
        assert(result.isErr(), "should be Err");
        expect(result.error).toBeInstanceOf(TimeoutError);
        expect(release).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    test("fails with UnhandledException when cleanup throws after success", async () => {
      const cleanupFault = new Error("cleanup failed");
      const result = await Op.of(1)
        .withRelease(() => {
          throw cleanupFault;
        })
        .run();

      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(UnhandledException);
      if (result.error instanceof UnhandledException) {
        expect(result.error.cause).toBe(cleanupFault);
      }
    });

    test("preserves primary error when cleanup throws after typed failure", async () => {
      const result = await Op.fail("boom" as const)
        .withRelease(() => {
          throw new Error("cleanup failed");
        })
        .run();

      assert(result.isErr(), "should be Err");
      expect(result.error).toBe("boom");
    });

    test("preserves inferred op shapes", async () => {
      const p1 = Op.of({ id: 1 }).withRelease((value) => {
        expectTypeOf(value).toEqualTypeOf<{ id: number }>();
      });
      const p2 = Op(function* (name: string) {
        return name.length;
      }).withRelease((len) => {
        expectTypeOf(len).toEqualTypeOf<number>();
      });

      expectTypeOf(p1).toEqualTypeOf<Op<{ id: number }, never, []>>();
      expectTypeOf(p2).toEqualTypeOf<Op<number, never, [string]>>();
      expectTypeOf(p2.run).parameter(0).toEqualTypeOf<string>();
    });
  });

  describe('op.on("exit")', () => {
    test('.on("exit") runs finalizer after success', async () => {
      const finalize = vi.fn();
      const result = await Op.of(123)
        .on("exit", () => {
          finalize();
        })
        .run();

      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe(123);
      expect(finalize).toHaveBeenCalledTimes(1);
    });

    test('chains .on("exit") in LIFO order with inner registration running first', async () => {
      const order: string[] = [];
      await Op.of(1)
        .on("exit", () => {
          order.push("a");
        })
        .on("exit", () => {
          order.push("b");
        })
        .run();
      expect(order).toEqual(["a", "b"]);
    });

    test('.on("exit") preserves fluent combinators', async () => {
      const finalize = vi.fn();
      const result = await Op.of(1).withRetry().on("exit", finalize).run();
      assert(result.isOk());
      expect(finalize).toHaveBeenCalledTimes(1);
    });

    test("runs finalizer after typed failure", async () => {
      const finalize = vi.fn();
      const result = await Op.fail("boom" as const)
        .on("exit", () => {
          finalize();
        })
        .run();

      assert(result.isErr(), "should be Err");
      expect(result.error).toBe("boom");
      expect(finalize).toHaveBeenCalledTimes(1);
    });

    test("preserves inferred op shapes", () => {
      const p1 = Op.of({ id: 1 }).on("exit", () => {});
      const p2 = Op(function* (name: string) {
        return name.length;
      }).on("exit", () => {});

      expectTypeOf(p1).toEqualTypeOf<Op<{ id: number }, never, []>>();
      expectTypeOf(p2).toEqualTypeOf<Op<number, never, [string]>>();
      expectTypeOf(p2.run).parameter(0).toEqualTypeOf<string>();
    });

    test('.on("exit") ExitContext.result is the same Result as .run()', async () => {
      let okCtx!: ExitContext<number, never>;
      const ok = await Op.of(99)
        .on("exit", (c) => {
          expectTypeOf(c).toEqualTypeOf<ExitContext<number, never>>();
          expectTypeOf(c.result).toEqualTypeOf<Result<number, UnhandledException>>();
          okCtx = c;
        })
        .run();
      assert(ok.isOk());
      assert(okCtx !== undefined);
      expect(okCtx.result).toBe(ok);
      expect(okCtx.signal.aborted).toBe(false);

      let typedCtx!: ExitContext<never, string>;
      const typedErr = await Op.fail("no")
        .on("exit", (c) => {
          expectTypeOf(c).toEqualTypeOf<ExitContext<never, string>>();
          expectTypeOf(c.result).toEqualTypeOf<Result<never, string | UnhandledException>>();
          typedCtx = c;
        })
        .run();
      assert(typedErr.isErr());
      assert(typedCtx !== undefined);
      expect(typedCtx.result).toBe(typedErr);

      let throwCtx!: ExitContext<never, never>;
      const boom = new Error("sync");
      const syncThrowOp = Op(function* () {
        throw boom;
      });
      expectTypeOf(syncThrowOp).toEqualTypeOf<Op<never, never, []>>();
      const threw = await syncThrowOp
        .on("exit", (c) => {
          expectTypeOf(c).toEqualTypeOf<ExitContext<never, never>>();
          expectTypeOf(c.result).toEqualTypeOf<Result<never, UnhandledException>>();
          throwCtx = c;
        })
        .run();
      assert(threw.isErr());
      expect(throwCtx).toBeDefined();
      expect(throwCtx.result).toBe(threw);
    });

    test('.on("exit") ExitContext.result matches run after withTimeout', async () => {
      vi.useFakeTimers();
      try {
        let timedCtx!: ExitContext<number, UnhandledException | TimeoutError>;
        const runPromise = Op.try((_signal) => new Promise<number>(() => {}))
          .withTimeout(10)
          .on("exit", (c) => {
            expectTypeOf(c).toEqualTypeOf<ExitContext<number, UnhandledException | TimeoutError>>();
            expectTypeOf(c.result).toEqualTypeOf<
              Result<number, UnhandledException | TimeoutError>
            >();
            timedCtx = c;
          })
          .run();
        await vi.advanceTimersByTimeAsync(10);
        const timed = await runPromise;

        assert(timed.isErr());
        expect(timedCtx).toBeDefined();
        expect(timedCtx.result).toBe(timed);
        expect(timed.error).toBeInstanceOf(TimeoutError);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Op (generator)", () => {
    test("yield* Op.pure composes", async () => {
      {
        const program = Op(function* () {
          const a = yield* Op.of(10);
          const b = yield* Op.of(2);
          return a + b;
        });
        const r = await program.run();
        assert(r.isOk(), "should be Ok");
        expect(r.value).toBe(12);
      }
      {
        const program = Op(function* () {
          const a = yield* Op.of(10);
          const b = yield* Op.of((async () => 20)());
          return a + b;
        });
        const r = await program.run();
        assert(r.isOk(), "should be Ok");
        expect(r.value).toBe(30);
      }
      {
        const program = Op(function* () {
          const a = yield* Op.of(10);
          const b = yield* Op.of<number>(Promise.reject("boom"));
          return a + b;
        });
        const r = await program.run();
        assert(r.isErr(), "should be Err");
        expect(r.error).toBeInstanceOf(UnhandledException);
        expectTypeOf(r.error).toEqualTypeOf<UnhandledException>();
        expect(r.error.cause).toBe("boom");
      }
      {
        const error = new Error("boom");
        const program = Op(function* () {
          return yield* Op.of(
            (async () => {
              throw error;
            })(),
          );
        });
        const r = await program.run();
        assert(r.isErr(), "should be Err");
        expect(r.error).toBeInstanceOf(UnhandledException);
        expectTypeOf(r.error).toEqualTypeOf<UnhandledException>();
        expect(r.error.cause).toBe(error);
      }
    });
    test("yield* Op.fail composes", async () => {
      {
        const program = Op(function* () {
          const a = yield* Op.fail("boom");
          const b = yield* Op.of(2);
          const c = yield* Op.of(Promise.resolve(3));
          return a + b + c;
        });
        const r = await program.run();
        assert(r.isErr(), "should be Err");
        expect(r.error).toBe("boom");
        expectTypeOf(r.error).toEqualTypeOf<UnhandledException | string>();
      }
    });

    test("Op generator stays deterministic across arg tuple forms", async () => {
      type InferOpArgs<T> = T extends Op<unknown, unknown, infer A> ? A : never;

      const op1 = Op(function* (a: number, b: number) {
        return a + b;
      });
      expect(Symbol.iterator in op1).toBe(false);
      expectTypeOf<InferOpArgs<typeof op1>>().toEqualTypeOf<[a: number, b: number]>();
      await expect(op1.run(1, 2)).resolves.toMatchObject({ value: 3 });

      const op2 = Op(function* () {
        return 1;
      });
      expect(Symbol.iterator in op2).toBe(false); // fromGenFn always returns an arity wrapper
      type Op2Args = InferOpArgs<typeof op2>;
      expectTypeOf<Op2Args>().toEqualTypeOf<[]>();
      await expect(op2.run()).resolves.toMatchObject({ value: 1 });

      const op3 = Op(function* (a?: number) {
        return (a ?? 0) * 2;
      });
      expect(Symbol.iterator in op3).toBe(false);
      expectTypeOf<InferOpArgs<typeof op3>>().toEqualTypeOf<[a?: number]>();
      await expect(op3.run()).resolves.toMatchObject({ value: 0 });
      await expect(op3.run(1)).resolves.toMatchObject({ value: 2 });

      const op4 = Op(function* (a: number, b?: number) {
        return (a + (b ?? 0)) * 2;
      });
      expect(Symbol.iterator in op4).toBe(false);
      expectTypeOf<InferOpArgs<typeof op4>>().toEqualTypeOf<[a: number, b?: number]>();
      await expect(op4.run(1)).resolves.toMatchObject({ value: 2 });
      await expect(op4.run(1, 2)).resolves.toMatchObject({ value: 6 });

      const op5 = Op(function* (a: number = 1) {
        return a * 2;
      });
      expect(Symbol.iterator in op5).toBe(false);
      expectTypeOf<InferOpArgs<typeof op5>>().toEqualTypeOf<[a?: number]>();
      await expect(op5.run()).resolves.toMatchObject({ value: 2 });
      await expect(op5.run(3)).resolves.toMatchObject({ value: 6 });

      const op6 = Op(function* (...args: [a: number, b: number]) {
        return args.reduce((acc, curr) => acc + curr, 0);
      });
      expect(Symbol.iterator in op6).toBe(false);
      expectTypeOf<InferOpArgs<typeof op6>>().toEqualTypeOf<[a: number, b: number]>();
      await expect(op6.run(1, 2)).resolves.toMatchObject({ value: 3 });

      const wrappedOptional = op3.withRetry();
      await expect(wrappedOptional.run()).resolves.toMatchObject({ value: 0 });
      await expect(wrappedOptional(5).run()).resolves.toMatchObject({ value: 10 });

      const wrappedDefault = op5.withTimeout(100);
      expectTypeOf(wrappedDefault).toEqualTypeOf<Op<number, TimeoutError, [a?: number]>>();
      await expect(wrappedDefault.run()).resolves.toMatchObject({ value: 2 });

      const wrappedDefaultNullary = wrappedDefault(4);
      expectTypeOf(wrappedDefaultNullary).toEqualTypeOf<Op<number, TimeoutError, []>>();
      await expect(wrappedDefaultNullary.run()).resolves.toMatchObject({ value: 8 });
    });

    describe("generator finalization on early exit", () => {
      test("runs finally when the body yields an Err instruction", async () => {
        const events: string[] = [];
        const program = Op(function* () {
          try {
            events.push("start");
            yield* Op.fail("boom");
            return "unreachable";
          } finally {
            events.push("finally");
          }
        });

        const result = await program.run();

        assert(result.isErr(), "should be Err");
        expect(result.error).toBe("boom");
        expect(events).toEqual(["start", "finally"]);
      });

      test("runs finally when a suspended instruction throws", async () => {
        const events: string[] = [];
        const cause = new Error("suspend failed");
        const program = Op(function* () {
          try {
            events.push("start");
            yield new SuspendInstruction(async () => {
              throw cause;
            });
            return 1;
          } finally {
            events.push("finally");
          }
        });

        const result = await program.run();

        assert(result.isErr(), "should be Err");
        expect(result.error).toBeInstanceOf(UnhandledException);
        expect(result.error.cause).toBe(cause);
        expect(events).toEqual(["start", "finally"]);
      });

      test("runs finally when withTimeout aborts inner work", async () => {
        vi.useFakeTimers();
        try {
          let finalized = false;
          const program = Op(function* () {
            try {
              yield* Op.try(
                (signal) =>
                  new Promise<number>((_resolve, reject) => {
                    if (signal.aborted) {
                      reject(signal.reason);
                      return;
                    }
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                  }),
              ).withTimeout(10);
              return 1;
            } finally {
              finalized = true;
            }
          });

          const runPromise = program.run();
          await vi.advanceTimersByTimeAsync(10);
          const result = await runPromise;

          assert(result.isErr(), "should be Err");
          expect(result.error).toBeInstanceOf(TimeoutError);
          expect(finalized).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      });

      test("preserves original Err result when cleanup throws during iter.return()", async () => {
        const cleanupFault = new Error("cleanup failed");
        const failCleanup = () => {
          throw cleanupFault;
        };
        const program = Op(function* () {
          try {
            yield* Op.fail("boom");
            return "unreachable";
          } finally {
            failCleanup();
          }
        });

        const result = await program.run();

        assert(result.isErr(), "should be Err");
        expect(result.error).toBe("boom");
      });
    });
  });

  describe("Op.run", () => {
    test("free-function run executes nullary ops", async () => {
      const r1 = await Op.run(Op.of(69));
      assert(r1.isOk(), "should be Ok");
      expect(r1.value).toBe(69);

      const nullary = Op(function* () {
        return 1;
      });
      const r2 = await Op.run(nullary);
      assert(r2.isOk(), "should be Ok");
      expect(r2.value).toBe(1);
    });
  });

  describe("Op namespace value", () => {
    test("Op._tag is 'OpFactory'", () => {
      expect(Op._tag).toBe("OpFactory");
    });
    test('callable Op has type discriminant Typed<"Op">', () => {
      const p = Op(function* () {
        return yield* Op.of(1);
      });
      expect(p._tag).toBe("Op");
    });
  });
});

/** Monadic bind `(>>=)` for nullary {@link Op}s, expressed with `yield*`. */
function bind<A, E1, B, E2>(m: Op<A, E1, []>, f: (a: A) => Op<B, E2, []>): Op<B, E1 | E2, []> {
  return Op(function* () {
    const x = yield* m();
    return yield* f(x)();
  });
}

async function expectSameResult<T, E>(a: Op<T, E, []>, b: Op<T, E, []>) {
  const left = await Op.run(a);
  const right = await Op.run(b);

  expect(left.isOk()).toBe(right.isOk());
  if (left.isOk() && right.isOk()) {
    expect(left.value).toEqual(right.value);
    return;
  }
  if (left.isErr() && right.isErr()) {
    expect(left.error).toEqual(right.error);
  }
}

describe("Op monad laws (via bind / run)", () => {
  test("left identity", async () => {
    const a = 7;
    const f = (x: number) => Op.of(x * 2);
    await expectSameResult(bind(Op.of(a), f), f(a));
  });

  test("left identity (failure in f)", async () => {
    const f = (_x: number) => Op.fail("boom" as const);
    await expectSameResult(bind(Op.of(1), f), f(1));
  });

  test("right identity (pure)", async () => {
    const m = Op.of(69);
    await expectSameResult(bind(m, Op.of), m);
  });

  test("right identity (fail)", async () => {
    const m = Op.fail("e");
    await expectSameResult(bind(m, Op.of), m);
  });

  test("right identity (suspend)", async () => {
    const m = Op.try(() => Promise.resolve(9));
    await expectSameResult(bind(m, Op.of), m);
  });

  test("associativity (success path)", async () => {
    const m = Op.of(1);
    const f = (x: number) => Op.of(x + 1);
    const g = (y: number) => Op.of(y * 2);
    await expectSameResult(
      bind(bind(m, f), g),
      bind(m, (x) => bind(f(x), g)),
    );
  });

  test("associativity (failure in f)", async () => {
    const m = Op.of(1);
    const f = (_x: number) => Op.fail("mid");
    const g = (_y: number) => Op.of(999);
    await expectSameResult(
      bind(bind(m, f), g),
      bind(m, (x) => bind(f(x), g)),
    );
  });

  test("associativity (failure in m)", async () => {
    const m = Op.fail("start");
    const f = (_x: number) => Op.of(1);
    const g = (_y: number) => Op.of(2);
    await expectSameResult(
      bind(bind(m, f), g),
      bind(m, (x) => bind(f(x), g)),
    );
  });
});

const resolveAfter = <T>(value: T, ms: number) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

const rejectAfter = (reason: unknown, ms: number) =>
  new Promise<never>((_, reject) => setTimeout(() => reject(reason), ms));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const trackAbortListeners = (signal: AbortSignal) => {
  type AbortListener = Parameters<AbortSignal["addEventListener"]>[1];
  type Registration = { listener: AbortListener; once: boolean };

  const registrations: Registration[] = [];
  const originalAdd: AbortSignal["addEventListener"] = signal.addEventListener.bind(signal);
  const originalRemove: AbortSignal["removeEventListener"] =
    signal.removeEventListener.bind(signal);

  const patchedAdd: AbortSignal["addEventListener"] = (type, listener, options) => {
    if (type === "abort") {
      const once = typeof options === "object" && options !== null ? options.once === true : false;
      registrations.push({ listener, once });
    }
    return originalAdd(type, listener, options);
  };

  const patchedRemove: AbortSignal["removeEventListener"] = (type, listener) => {
    if (type === "abort") {
      const idx = registrations.findIndex((registration) => registration.listener === listener);
      if (idx >= 0) registrations.splice(idx, 1);
    }
    return originalRemove(type, listener);
  };

  Object.assign(signal, {
    addEventListener: patchedAdd,
    removeEventListener: patchedRemove,
  });

  const clearOnceRegistrations: AbortListener = () => {
    for (let i = registrations.length - 1; i >= 0; i -= 1) {
      if (registrations[i]?.once) registrations.splice(i, 1);
    }
  };
  originalAdd("abort", clearOnceRegistrations);

  return {
    get activeAbortListeners() {
      return registrations.length;
    },
    restore() {
      Object.assign(signal, {
        addEventListener: originalAdd,
        removeEventListener: originalRemove,
      });
      originalRemove("abort", clearOnceRegistrations);
    },
  };
};

const invalidConcurrencies = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

describe("Op.all", () => {
  test("tuple of successes in input order", async () => {
    const r = await Op.all([Op.of(1), Op.of("two"), Op.of(true)]).run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toEqual([1, "two", true]);
    const [n, s, b] = r.value;
    expectTypeOf(n).toEqualTypeOf<number>();
    expectTypeOf(s).toEqualTypeOf<string>();
    expectTypeOf(b).toEqualTypeOf<boolean>();
  });

  test("empty input succeeds with []", async () => {
    const r = await Op.all([]).run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toEqual([]);
  });

  test.each(invalidConcurrencies)(
    "invalid concurrency %s returns UnhandledException",
    async (concurrency) => {
      const r = await Op.all([Op.of(1)], concurrency).run();
      assert(r.isErr(), "should be Err");
      expect(r.error).toBeInstanceOf(UnhandledException);
      if (r.error instanceof UnhandledException) {
        expect(r.error.cause).toEqual(new RangeError("concurrency must be a positive integer"));
      }
    },
  );

  test("fails fast on first Err and aborts siblings", async () => {
    let siblingAborted = false;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          const t = setTimeout(() => resolve(1), 50);
          signal.addEventListener("abort", () => {
            siblingAborted = true;
            clearTimeout(t);
            resolve(-1);
          });
        }),
    );
    const fast = Op.fail("boom" as const);

    const r = await Op.all([slow, fast]).run();
    assert(r.isErr(), "should be Err");
    expect(r.error).toBe("boom");
    expect(siblingAborted).toBe(true);
  });

  test("union error type across children", async () => {
    class AErr extends TaggedError("AErr")() {}
    class BErr extends TaggedError("BErr")() {}
    const n: number = 1;
    const s: string = "x";
    const a = Op(function* () {
      if (Math.random() > 2) return yield* new AErr();
      return n;
    });
    const b = Op(function* () {
      if (Math.random() > 2) return yield* new BErr();
      return s;
    });
    const combined = Op.all([a, b]);
    const r = await combined.run();
    if (r.isErr()) {
      expectTypeOf(r.error).toEqualTypeOf<AErr | BErr | UnhandledException>();
    }
  });

  test("awaits every child before returning after a failure", async () => {
    let slowObservedAbort = false;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          signal.addEventListener("abort", () => {
            slowObservedAbort = true;
            // Delay acknowledgment so we can verify `Op.all` waits for it.
            setTimeout(() => resolve(-1), 5);
          });
        }),
    );
    const fast = Op.fail("boom" as const);

    await Op.all([slow, fast]).run();
    expect(slowObservedAbort).toBe(true);
  });

  test("limits active children while preserving input order", async () => {
    const firstGate = deferred<number>();
    const secondGate = deferred<number>();
    const thirdGate = deferred<number>();
    const fourthGate = deferred<number>();
    const gates = [firstGate, secondGate, thirdGate, fourthGate];
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;

    const ops = gates.map((gate, i) =>
      Op.try(async () => {
        started.push(i);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await gate.promise;
        } finally {
          active -= 1;
        }
      }),
    );

    const run = Op.all(ops, 2).run();
    await Promise.resolve();

    expect(started).toEqual([0, 1]);
    expect(maxActive).toBe(2);

    secondGate.resolve(1);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    expect(active).toBe(2);

    firstGate.resolve(0);
    thirdGate.resolve(2);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));

    fourthGate.resolve(3);
    const r = await run;

    assert(r.isOk(), "should be Ok");
    expect(r.value).toEqual([0, 1, 2, 3]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test("does not start queued children after bounded failure", async () => {
    let slowObservedAbort = false;
    let queuedStarted = false;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          signal.addEventListener("abort", () => {
            slowObservedAbort = true;
            resolve(-1);
          });
        }),
    );
    const fast = Op.fail("boom" as const);
    const queued = Op.try(() => {
      queuedStarted = true;
      return 3;
    });

    const r = await Op.all([slow, fast, queued], 2).run();

    assert(r.isErr(), "should be Err");
    expect(r.error).toBe("boom");
    expect(slowObservedAbort).toBe(true);
    expect(queuedStarted).toBe(false);
  });
});

describe("Op.allSettled", () => {
  test("returns tuple of Result in input order", async () => {
    const r = await Op.allSettled([Op.of(1), Op.fail("no" as const), Op.of("ok")]).run();
    assert(r.isOk(), "should be Ok");
    const [a, b, c] = r.value;
    assert(a.isOk() && b.isErr() && c.isOk(), "branches");
    expect(a.value).toBe(1);
    expect(b.error).toBe("no");
    expect(c.value).toBe("ok");
  });

  test("empty input succeeds with []", async () => {
    const r = await Op.allSettled([]).run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toEqual([]);
  });

  test.each(invalidConcurrencies)(
    "invalid concurrency %s returns UnhandledException",
    async (concurrency) => {
      const r = await Op.allSettled([Op.of(1)], concurrency).run();
      assert(r.isErr(), "should be Err");
      expect(r.error).toBeInstanceOf(UnhandledException);
      if (r.error instanceof UnhandledException) {
        expect(r.error.cause).toEqual(new RangeError("concurrency must be a positive integer"));
      }
    },
  );

  test("never fails", async () => {
    const combined = Op.allSettled([Op.fail(1), Op.fail("two" as const)]);
    const r = await combined.run();
    // Even a `never`-failing op still widens to UnhandledException after .run() since the
    // runtime can always throw in user code. What matters: .ok is always true here.
    assert(r.isOk(), "should be Ok");
    const [a, b] = r.value;
    expectTypeOf(a).toEqualTypeOf<Result<never, number | UnhandledException>>();
    expectTypeOf(b).toEqualTypeOf<Result<never, "two" | UnhandledException>>();
  });

  test("does not abort siblings on failure", async () => {
    let siblingAborted = false;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          const t = setTimeout(() => resolve(1), 10);
          signal.addEventListener("abort", () => {
            siblingAborted = true;
            clearTimeout(t);
            resolve(-1);
          });
        }),
    );
    const r = await Op.allSettled([slow, Op.fail("boom")]).run();
    assert(r.isOk(), "should be Ok");
    expect(siblingAborted).toBe(false);
    const [first] = r.value;
    assert(first.isOk(), "slow sibling completed normally");
    expect(first.value).toBe(1);
  });

  test("limits active children and keeps draining after failures", async () => {
    const started: number[] = [];
    const first = Op(function* () {
      started.push(0);
      return yield* Op.fail("boom" as const);
    });
    const second = Op(function* () {
      started.push(1);
      return yield* Op.of("ok" as const);
    });

    const r = await Op.allSettled([first, second], 1).run();

    assert(r.isOk(), "should be Ok");
    expect(started).toEqual([0, 1]);
    const [a, b] = r.value;
    assert(a.isErr() && b.isOk(), "branches");
    expect(a.error).toBe("boom");
    expect(b.value).toBe("ok");
  });
});

describe("Op.settle", () => {
  test("wraps success in a settled Result", async () => {
    const r = await Op.settle(Op.of(69)).run();
    assert(r.isOk(), "should be Ok");
    const settled = r.value;
    assert(settled.isOk(), "inner op succeeded");
    expect(settled.value).toBe(69);
  });

  test("wraps failure in a settled Result", async () => {
    const r = await Op.settle(Op.fail("nope" as const)).run();
    assert(r.isOk(), "should be Ok");
    const settled = r.value;
    assert(settled.isErr(), "inner op failed");
    expect(settled.error).toBe("nope");
  });

  test("preserves child result typing", async () => {
    const combined = Op.settle(Op.fail(1));
    const r = await combined.run();
    assert(r.isOk(), "should be Ok");
    expectTypeOf(r.value).toEqualTypeOf<Result<never, number | UnhandledException>>();
  });
});

describe("Op.any", () => {
  test("returns first success and aborts siblings", async () => {
    let slowAborted = false;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          const t = setTimeout(() => resolve(99), 50);
          signal.addEventListener("abort", () => {
            slowAborted = true;
            clearTimeout(t);
            resolve(-1);
          });
        }),
    );
    const r = await Op.any([slow, Op.of(69)]).run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toBe(69);
    expect(slowAborted).toBe(true);
  });

  test("all-fail surfaces ErrorGroup with errors in input order", async () => {
    const r = await Op.any([
      Op.fail("a" as const),
      Op.fail("b" as const),
      Op.fail("c" as const),
    ]).run();
    assert(r.isErr(), "should be Err");
    assert(r.error instanceof ErrorGroup, "ErrorGroup");
    expect(r.error.errors).toEqual(["a", "b", "c"]);
  });

  test("empty input fails with empty ErrorGroup", async () => {
    const r = await Op.any([]).run();
    assert(r.isErr(), "should be Err");
    assert(r.error instanceof ErrorGroup, "ErrorGroup");
    expect(r.error.errors).toEqual([]);
  });

  test("error type is ErrorGroup<union of child errors>", async () => {
    const combined = Op.any([Op.fail(1), Op.fail("two" as const)]);
    const r = await combined.run();
    if (r.isErr() && r.error instanceof ErrorGroup) {
      expectTypeOf(r.error.errors).toEqualTypeOf<(number | "two" | UnhandledException)[]>();
    }
  });

  test("preserves index order when failures settle out of order", async () => {
    const toTag =
      <T extends string>(tag: T) =>
      (_: unknown): T =>
        tag;
    const r = await Op.any([
      Op.try(() => rejectAfter("slow", 10), toTag("slow")),
      Op.try(() => rejectAfter("fast", 0), toTag("fast")),
    ]).run();
    assert(r.isErr(), "should be Err");
    assert(ErrorGroup.is(r.error), "ErrorGroup");
    expect(r.error.errors).toEqual(["slow", "fast"]);
  });
});

describe("Op.race", () => {
  test("first settler wins (Ok)", async () => {
    let loserAborted = false;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          const t = setTimeout(() => resolve(-1), 50);
          signal.addEventListener("abort", () => {
            loserAborted = true;
            clearTimeout(t);
            resolve(-1);
          });
        }),
    );
    const fast = Op.try(() => resolveAfter(7, 0));
    const r = await Op.race([slow, fast]).run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toBe(7);
    expect(loserAborted).toBe(true);
  });

  test("first settler wins (Err)", async () => {
    const slow = Op.try(() => resolveAfter(1, 20));
    const fast = Op.fail("quick" as const);
    const r = await Op.race([slow, fast]).run();
    assert(r.isErr(), "should be Err");
    expect(r.error).toBe("quick");
  });

  test("losers are aborted with no library-specific reason", async () => {
    let observedReason: unknown;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          signal.addEventListener("abort", () => {
            observedReason = signal.reason;
            resolve(-1);
          });
        }),
    );
    const fast = Op.of(1);
    await Op.race([slow, fast]).run();
    assert(observedReason instanceof DOMException, "should be a DOMException");
    expect(observedReason.name).toBe("AbortError");
  });

  test("union type across children", async () => {
    const combined = Op.race([Op.of(1), Op.fail("two" as const)]);
    const r = await combined.run();
    if (r.isOk()) expectTypeOf(r.value).toEqualTypeOf<number>();
    if (r.isErr()) expectTypeOf(r.error).toEqualTypeOf<"two" | UnhandledException>();
  });
});

describe("Op combinators compose with withTimeout / withRetry", () => {
  test("Op.all().withTimeout() times out the whole fan-out", async () => {
    vi.useFakeTimers();
    try {
      const slow = Op.try(() => resolveAfter(1000, 1000));
      const promise = Op.all([slow, slow]).withTimeout(10).run();
      await vi.advanceTimersByTimeAsync(15);
      const r = await promise;
      assert(r.isErr(), "should be Err");
      expect(r.error).toBeInstanceOf(TimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  test("Op.any().withRetry() retries the whole combinator", async () => {
    let attempts = 0;
    const flaky = Op(function* () {
      attempts += 1;
      if (attempts < 2) return yield* Op.fail("nope" as const);
      return yield* Op.of(11);
    });
    const r = await Op.any([flaky])
      .withRetry({ maxAttempts: 3, shouldRetry: () => true, getDelay: () => 0 })
      .run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toBe(11);
    expect(attempts).toBe(2);
  });
});

describe("combinator abort listener cleanup", () => {
  test("pre-aborted outer signal does not leave abort listeners behind", async () => {
    const outer = new AbortController();
    outer.abort(new Error("already aborted"));
    const tracked = trackAbortListeners(outer.signal);
    try {
      await Op.all([Op.of(1), Op.of(2)])
        .withSignal(outer.signal)
        .run();
      expect(tracked.activeAbortListeners).toBe(0);
    } finally {
      tracked.restore();
    }
  });

  test("unbounded all detaches abort listener after children settle", async () => {
    const outer = new AbortController();
    const tracked = trackAbortListeners(outer.signal);
    try {
      const r = await Op.all([Op.of(1), Op.of(2)])
        .withSignal(outer.signal)
        .run();
      assert(r.isOk(), "should be Ok");
      expect(r.value).toEqual([1, 2]);
      expect(tracked.activeAbortListeners).toBe(0);

      outer.abort(new Error("too late"));
      expect(tracked.activeAbortListeners).toBe(0);
    } finally {
      tracked.restore();
    }
  });

  test("bounded all detaches abort listener after children settle", async () => {
    const outer = new AbortController();
    const tracked = trackAbortListeners(outer.signal);
    try {
      const r = await Op.all([Op.of(1), Op.of(2)], 1)
        .withSignal(outer.signal)
        .run();
      assert(r.isOk(), "should be Ok");
      expect(r.value).toEqual([1, 2]);
      expect(tracked.activeAbortListeners).toBe(0);

      outer.abort(new Error("too late"));
      expect(tracked.activeAbortListeners).toBe(0);
    } finally {
      tracked.restore();
    }
  });

  test("bounded all cleans up outer abort listeners when aborted mid-flight after partial completion", async () => {
    const outer = new AbortController();
    const tracked = trackAbortListeners(outer.signal);
    const secondGate = deferred<number>();
    try {
      const run = Op.all(
        [
          Op.of(1),
          Op.try(
            (signal) =>
              new Promise<number>((resolve, reject) => {
                if (signal.aborted) {
                  reject(signal.reason);
                  return;
                }
                signal.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                });
                secondGate.promise.then(resolve);
              }),
          ),
        ],
        1,
      )
        .withSignal(outer.signal)
        .run();

      await Promise.resolve();
      outer.abort(new Error("cancel"));

      const r = await run;
      assert(r.isErr(), "should be Err");
      expect(tracked.activeAbortListeners).toBe(0);
    } finally {
      tracked.restore();
      secondGate.resolve(2);
    }
  });

  test("any cleans up outer abort listeners when aborted mid-flight after partial completion", async () => {
    const outer = new AbortController();
    const tracked = trackAbortListeners(outer.signal);
    try {
      const run = Op.any([
        Op.fail("fast-fail" as const),
        Op.try(
          (signal) =>
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
        ),
      ])
        .withSignal(outer.signal)
        .run();

      await Promise.resolve();
      outer.abort(new Error("cancel"));

      const r = await run;
      assert(r.isErr(), "should be Err");
      assert(r.error instanceof ErrorGroup, "ErrorGroup");
      expect(r.error.errors.length).toBeGreaterThan(0);
      expect(tracked.activeAbortListeners).toBe(0);
    } finally {
      tracked.restore();
    }
  });
});

describe("Op.defer error handling", () => {
  test("when op succeeds, cleanup throws: UnhandledException with cleanup error as cause", async () => {
    const cleanupError = new Error("cleanup failed");
    const cleanup = () => {
      throw cleanupError;
    };
    const safeOp = Op.of(69);
    const op = Op(function* () {
      yield* Op.defer(() => cleanup());
      const r = yield* safeOp;
      return r;
    });
    const r = await op.run();
    assert(r.isErr(), "should be Err");
    expect(r.error).toBeInstanceOf(UnhandledException);
    if (r.error instanceof UnhandledException) {
      expect(r.error.cause).toBe(cleanupError);
    }
  });

  test("when op fails, cleanup throws: UnhandledException with cleanup error as cause", async () => {
    const cleanupError = new Error("cleanup failed");
    const cleanup = () => {
      throw cleanupError;
    };
    const riskyOp = Op.fail("boom");
    const op = Op(function* () {
      yield* Op.defer(() => cleanup());
      yield* riskyOp;
    });
    const r = await op.run();
    assert(r.isErr(), "should be Err");
    assert(r.error instanceof UnhandledException, "should be UnhandledException");
    expect(r.error.cause).toBe(cleanupError);
  });

  test("when op fails, cleanup succeeds: failure is preserved", async () => {
    const cleanup = () => {
      return;
    };
    const riskyOp = Op.fail("boom");
    const op = Op(function* () {
      yield* Op.defer(() => cleanup());
      yield* riskyOp;
    });
    const r = await op.run();
    assert(r.isErr(), "should be Err");
    expect(r.error).toBe("boom");
  });

  test("when op succeeds, cleanup succeeds: value is preserved", async () => {
    const cleanup = () => {
      return;
    };
    const safeOp = Op.of(69);
    const op = Op(function* () {
      yield* Op.defer(() => cleanup());
      return yield* safeOp;
    });
    const r = await op.run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toBe(69);
  });
});

describe("Op.defer ordering and policies", () => {
  test("runs multiple defers in LIFO order on success", async () => {
    const events: string[] = [];
    const op = Op(function* () {
      yield* Op.defer(() => {
        events.push("first");
      });
      yield* Op.defer(() => {
        events.push("second");
      });
      return yield* Op.of(1);
    });
    const r = await op.run();
    assert(r.isOk(), "should be Ok");
    expect(events).toEqual(["second", "first"]);
  });

  test("runs earlier-registered finalizers after a later defer throws", async () => {
    const earlier = vi.fn();
    const stop = new Error("stop");
    const op = Op(function* () {
      yield* Op.defer(() => {
        earlier();
      });
      yield* Op.defer(() => {
        throw stop;
      });
      return yield* Op.of(1);
    });
    const r = await op.run();
    assert(r.isErr(), "should be Err");
    expect(earlier).toHaveBeenCalledTimes(1);
    expect(r.error).toBeInstanceOf(UnhandledException);
    if (r.error instanceof UnhandledException) {
      expect(r.error.cause).toBe(stop);
    }
  });

  test("chains multiple cleanup throws via nested Error.cause", async () => {
    const boomFourth = new Error("boom from defer fourth");
    const boomSecond = new Error("boom from defer second");
    const events: string[] = [];
    const op = Op(function* () {
      yield* Op.defer(() => {
        events.push("first");
      });
      yield* Op.defer(() => {
        events.push("second");
        throw boomSecond;
      });
      yield* Op.defer(() => {
        events.push("third");
      });
      yield* Op.defer(() => {
        events.push("fourth");
        throw boomFourth;
      });
      return yield* Op.of(1);
    });
    const r = await op.run();
    assert(r.isErr(), "should be Err");
    expect(events).toEqual(["fourth", "third", "second", "first"]);
    assert(r.error instanceof UnhandledException);
    const ue = r.error;
    assert(ue.cause instanceof Error);
    expect(ue.cause.message).toBe(boomFourth.message);
    expect(ue.cause.name).toBe(boomFourth.name);
    expect(ue.cause.cause).toBe(boomSecond);
  });

  test("chains three throws among five defers (only throwing cleanups in cause chain)", async () => {
    const boomFifth = new Error("boom from defer fifth");
    const boomFourth = new Error("boom from defer fourth");
    const boomSecond = new Error("boom from defer second");
    const events: string[] = [];
    const op = Op(function* () {
      yield* Op.defer(() => {
        events.push("first");
      });
      yield* Op.defer(() => {
        events.push("second");
        throw boomSecond;
      });
      yield* Op.defer(() => {
        events.push("third");
      });
      yield* Op.defer(() => {
        events.push("fourth");
        throw boomFourth;
      });
      yield* Op.defer(() => {
        events.push("fifth");
        throw boomFifth;
      });
      return yield* Op.of(1);
    });
    const r = await op.run();
    assert(r.isErr(), "should be Err");
    expect(events).toEqual(["fifth", "fourth", "third", "second", "first"]);
    assert(r.error instanceof UnhandledException);
    const head = r.error.cause;
    assert(head instanceof Error);
    expect(head.message).toBe(boomFifth.message);
    const mid = head.cause;
    assert(mid instanceof Error);
    expect(mid.message).toBe(boomFourth.message);
    expect(mid.cause).toBe(boomSecond);
  });

  test("shares LIFO stack with withRelease (release runs before defer registered earlier)", async () => {
    const events: string[] = [];
    const op = Op(function* () {
      yield* Op.defer(() => {
        events.push("defer");
      });
      yield* Op.of(2).withRelease(() => {
        events.push("release");
      });
      return 3;
    });
    const r = await op.run();
    assert(r.isOk(), "should be Ok");
    expect(events).toEqual(["release", "defer"]);
  });

  test("runs Op.defer cleanup when withTimeout aborts inner work", async () => {
    vi.useFakeTimers();
    try {
      const cleanup = vi.fn();
      const op = Op(function* () {
        yield* Op.defer(() => cleanup());
        return yield* Op.try(
          (signal) =>
            new Promise<number>((_resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        ).withTimeout(10);
      });

      const runPromise = op.run();
      await vi.advanceTimersByTimeAsync(10);
      const result = await runPromise;
      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(TimeoutError);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("runs Op.defer cleanup when withSignal aborts inner work", async () => {
    vi.useFakeTimers();
    try {
      const cleanup = vi.fn();
      const controller = new AbortController();
      const op = Op(function* () {
        yield* Op.defer(() => cleanup());
        return yield* Op.try(
          (signal) =>
            new Promise<number>((_resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        ).withSignal(controller.signal);
      });

      const runPromise = op.run();
      controller.abort("cancelled");
      await vi.advanceTimersByTimeAsync(0);
      const result = await runPromise;
      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(UnhandledException);
      if (result.error instanceof UnhandledException) {
        expect(result.error.cause).toBe("cancelled");
      }
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
