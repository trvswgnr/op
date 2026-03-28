import { assert, describe, expect, expectTypeOf, test } from "vitest";
import { Op, UnexpectedError, TypedError } from "./index.js";

describe("public API (index)", () => {
  describe("UnexpectedError", () => {
    test("discriminant and cause", () => {
      const cause = new Error("root");
      const e = new UnexpectedError({ cause });
      expect(e.type).toBe("UnexpectedError");
      expect(e.message).toBe("An unexpected error occurred");
      expect(e.cause).toBe(cause);
    });
  });

  describe("TypedError", () => {
    test("factory produces typed errors", () => {
      const E = TypedError("SmokeError", "default smoke");
      const e = new E({ message: "x" });
      expectTypeOf(e).toEqualTypeOf<TypedError<"SmokeError", {}>>();
      expect(e.type).toBe("SmokeError");
      expect(e.message).toBe("x");
      expect(e.data).toEqual({});
      expectTypeOf(e.data).toEqualTypeOf<{}>();
    });
  });

  describe("Op.ok / Op.err", () => {
    test("ok succeeds; err fails with payload", async () => {
      const okR = await Op.ok(7).run();
      assert(okR.ok === true, "okR.ok");
      expect(okR.value).toBe(7);

      const errR = await Op.err("no").run();
      assert(errR.ok === false, "errR.ok");
      expect(errR.error).toBe("no");
    });
  });

  describe("Op.fromPromise", () => {
    test("resolve and mapped reject", async () => {
      const okR = await Op.fromPromise(
        () => Promise.resolve(3),
        () => "mapped",
      ).run();
      assert(okR.ok === true, "okR.ok");
      expect(okR.value).toBe(3);

      const errR = await Op.fromPromise(
        () => Promise.reject("boom"),
        (e) => ({ e }),
      ).run();
      assert(errR.ok === false, "errR.ok");
      expect(errR.error).toEqual({ e: "boom" });
    });
  });

  describe("Op (generator)", () => {
    test("yield* Op.ok composes", async () => {
      const program = Op(function* () {
        const a = yield* Op.ok(10);
        const b = yield* Op.ok(2);
        return a + b;
      });
      const r = await program.run();
      assert(r.ok === true, "r.ok");
      expect(r.value).toBe(12);
    });
  });

  describe("Op.run", () => {
    test("free-function run executes nullary ops", async () => {
      const r1 = await Op.run(Op.ok(69));
      assert(r1.ok === true, "r1.ok");
      expect(r1.value).toBe(69);

      const nullary = Op(function* () {
        return 1;
      });
      const r2 = await Op.run(nullary);
      assert(r2.ok === true, "r2.ok");
      expect(r2.value).toBe(1);
    });
  });

  describe("Op namespace value", () => {
    test('callable Op has type discriminant Typed<"Op">', () => {
      const p = Op(function* () {
        return yield* Op.ok(1);
      });
      expect(p.type).toBe("Op");
    });
  });
});
