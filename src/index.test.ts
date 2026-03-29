import { assert, describe, expect, expectTypeOf, test } from "vitest";
import { Op, UnexpectedError, TypedError, type Op as OpT } from "./index.js";

describe("public API (index)", () => {
  describe("OpFactory", () => {
    test("type is 'OpFactory'", () => {
      expect(Op.type).toBe("OpFactory");
    });
    test("run is a function", () => {
      expect(Op.run).toBeInstanceOf(Function);
    });
    test("pure is a function", () => {
      expect(Op.pure).toBeInstanceOf(Function);
    });
  });
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
      class SmokeError extends TypedError("SmokeError", "default smoke") {}
      const e = new SmokeError({ message: "x" });
      expectTypeOf(e).toEqualTypeOf<TypedError<"SmokeError", {}>>();
      expect(e.type).toBe("SmokeError");
      expect(e.name).toBe("SmokeError");
      expect(e.message).toBe("x");
      expect(e.data).toEqual({});
      expectTypeOf(e.data).toEqualTypeOf<{}>();
    });
  });

  describe("Op.pure / Op.fail", () => {
    test("pure does not yield errors; fail does not", async () => {
      const okR = await Op.pure(7).run();
      assert(okR.ok === true, "okR.ok");
      expect(okR.value).toBe(7);

      const errR = await Op.fail("no").run();
      assert(errR.ok === false, "errR.ok");
      expect(errR.error).toBe("no");
    });
  });

  describe("Op.suspend", () => {
    test("resolve and mapped reject", async () => {
      const okR = await Op.suspend(
        () => Promise.resolve(3),
        () => "mapped",
      ).run();
      assert(okR.ok === true, "okR.ok");
      expect(okR.value).toBe(3);

      const errR = await Op.suspend(
        () => (Math.random() > 1 ? Promise.resolve(3) : Promise.reject("boom")),
        (e) => ({ mappedError: String(e) }),
      ).run();
      assert(errR.ok === false, "errR.ok should be false");
      expect(errR.error).toEqual({ mappedError: "boom" });
    });
  });

  describe("Op (generator)", () => {
    test("yield* Op.pure composes", async () => {
      const program = Op(function* () {
        const a = yield* Op.pure(10);
        const b = yield* Op.pure(2);
        return a + b;
      });
      const r = await program.run();
      assert(r.ok === true, "r.ok");
      expect(r.value).toBe(12);
    });
    test("yield* Op.fail composes", async () => {
      const program = Op(function* () {
        const a = yield* Op.fail("boom");
        const b = yield* Op.pure(2);
        const c = yield* Op.pure(Promise.resolve(3));
        return a + b + c;
      });
      const r = await program.run();
      assert(r.ok === false, "r.ok");
      expect(r.error).toBe("boom");
      expectTypeOf(r.error).toEqualTypeOf<UnexpectedError | string>();
    });
  });

  describe("Op.run", () => {
    test("free-function run executes nullary ops", async () => {
      const r1 = await Op.run(Op.pure(69));
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
    test("Op.type is 'OpFactory'", () => {
      expect(Op.type).toBe("OpFactory");
    });
    test('callable Op has type discriminant Typed<"Op">', () => {
      const p = Op(function* () {
        return yield* Op.pure(1);
      });
      expect(p.type).toBe("Op");
    });
  });
});

/** Monadic bind `(>>=)` for nullary {@link Op}s, expressed with `yield*`. */
function bind<A, E1, B, E2>(m: OpT<A, E1, []>, f: (a: A) => OpT<B, E2, []>): OpT<B, E1 | E2, []> {
  return Op(function* () {
    const x = yield* m();
    return yield* f(x)();
  });
}

async function expectSameResult<T, E>(a: Op<T, E, []>, b: Op<T, E, []>) {
  expect(await Op.run(a)).toEqual(await Op.run(b));
}

describe("Op monad laws (via bind / run)", () => {
  test("left identity", async () => {
    const a = 7;
    const f = (x: number) => Op.pure(x * 2);
    await expectSameResult(bind(Op.pure(a), f), f(a));
  });

  test("left identity (failure in f)", async () => {
    const f = (_x: number) => Op.fail("boom" as const);
    await expectSameResult(bind(Op.pure(1), f), f(1));
  });

  test("right identity (pure)", async () => {
    const m = Op.pure(42);
    await expectSameResult(bind(m, Op.pure), m);
  });

  test("right identity (fail)", async () => {
    const m = Op.fail("e");
    await expectSameResult(bind(m, Op.pure), m);
  });

  test("right identity (suspend)", async () => {
    const m = Op.suspend(() => Promise.resolve(9));
    await expectSameResult(bind(m, Op.pure), m);
  });

  test("associativity (success path)", async () => {
    const m = Op.pure(1);
    const f = (x: number) => Op.pure(x + 1);
    const g = (y: number) => Op.pure(y * 2);
    await expectSameResult(
      bind(bind(m, f), g),
      bind(m, (x) => bind(f(x), g)),
    );
  });

  test("associativity (failure in f)", async () => {
    const m = Op.pure(1);
    const f = (_x: number) => Op.fail("mid");
    const g = (_y: number) => Op.pure(999);
    await expectSameResult(
      bind(bind(m, f), g),
      bind(m, (x) => bind(f(x), g)),
    );
  });

  test("associativity (failure in m)", async () => {
    const m = Op.fail("start");
    const f = (_x: number) => Op.pure(1);
    const g = (_y: number) => Op.pure(2);
    await expectSameResult(
      bind(bind(m, f), g),
      bind(m, (x) => bind(f(x), g)),
    );
  });
});
