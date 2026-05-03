import { assert, describe, expect, expectTypeOf, test, vi } from "vitest";
import {
  Op,
  TaggedError,
  TimeoutError,
  UnhandledException,
  exponentialBackoff,
  type TaggedErrorInstance,
} from "./index.js";
import { resolveAfter } from "./test-utils.js";

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
      expect(getDelay(5)).toBe(1000);
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

    test("normalizes invalid options instead of throwing", () => {
      expect(() => exponentialBackoff({ base: 0, max: 1000, jitter: 0.5 })).not.toThrow();
      expect(() => exponentialBackoff({ base: 100, max: 0, jitter: 0.5 })).not.toThrow();
      expect(() => exponentialBackoff({ base: 100, max: 1000, jitter: -0.5 })).not.toThrow();
      expect(() => exponentialBackoff({ base: 100, max: 1000, jitter: 1.5 })).not.toThrow();
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
    test('callable Op has type discriminant Typed<"Op">', () => {
      const p = Op(function* () {
        return yield* Op.of(1);
      });
      expect(p._tag).toBe("Op");
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
});
