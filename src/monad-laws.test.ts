import { describe, expect, test } from "vitest";
import { Op, type Op as OpType } from "./index.js";

// Scope: integration checks for monad law behavior.
function bind<A, E1, B, E2>(
  m: OpType<A, E1, []>,
  f: (a: A) => OpType<B, E2, []>,
): OpType<B, E1 | E2, []> {
  return Op(function* () {
    const x = yield* m();
    return yield* f(x)();
  });
}

async function expectSameResult<T, E>(a: OpType<T, E, []>, b: OpType<T, E, []>) {
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
