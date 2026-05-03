import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import { Op, Result, type Op as OpType, type Result as ResultType } from "./index.js";

function bind<A, E1, B, E2>(
  m: OpType<A, E1, []>,
  f: (a: A) => OpType<B, E2, []>,
): OpType<B, E1 | E2, []> {
  return Op(function* () {
    const x = yield* m();
    return yield* f(x)();
  });
}

function serializeResult<T, E>(result: ResultType<T, E>) {
  return Result.serialize(result);
}

async function expectSameOpResult<T, E>(a: OpType<T, E, []>, b: OpType<T, E, []>) {
  const left = await Op.run(a);
  const right = await Op.run(b);
  expect(serializeResult(left)).toEqual(serializeResult(right));
}

function expectSameResult<T, E>(left: ResultType<T, E>, right: ResultType<T, E>) {
  expect(serializeResult(left)).toEqual(serializeResult(right));
}

const opFnArb: fc.Arbitrary<(value: number) => OpType<number, string, []>> = fc.constantFrom(
  (value) => Op.of(value + 1),
  (value) => Op.of(value * 2),
  (value) => (value % 2 === 0 ? Op.of(value / 2) : Op.fail("odd")),
  (value) => Op.fail(`e:${Math.abs(value % 5)}`),
);

const opArb: fc.Arbitrary<OpType<number, string, []>> = fc.oneof(
  fc.integer().map((value) => Op.of(value)),
  fc.string().map((error) => Op.fail(error)),
);

const resultArb: fc.Arbitrary<ResultType<number, string>> = fc.oneof(
  fc.integer().map((value) => Result.ok<number, string>(value)),
  fc.string().map((error) => Result.err<number, string>(error)),
);

describe("Op monad laws (property-based)", () => {
  test("left identity", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), opFnArb, async (value, f) => {
        await expectSameOpResult(bind(Op.of(value), f), f(value));
      }),
    );
  });

  test("right identity", async () => {
    await fc.assert(
      fc.asyncProperty(opArb, async (op) => {
        await expectSameOpResult(bind(op, Op.of), op);
      }),
    );
  });

  test("associativity", async () => {
    await fc.assert(
      fc.asyncProperty(opArb, opFnArb, opFnArb, async (op, f, g) => {
        await expectSameOpResult(
          bind(bind(op, f), g),
          bind(op, (value) => bind(f(value), g)),
        );
      }),
    );
  });
});

describe("Result algebra laws (property-based)", () => {
  test("map identity", () => {
    fc.assert(
      fc.property(resultArb, (result) => {
        expectSameResult(
          Result.map(result, (value) => value),
          result,
        );
      }),
    );
  });

  test("map composition", () => {
    const valueFnArb = fc.constantFrom<(value: number) => number>(
      (value) => value + 1,
      (value) => value * 2,
      (value) => value - 3,
    );

    fc.assert(
      fc.property(resultArb, valueFnArb, valueFnArb, (result, f, g) => {
        const left = Result.map(Result.map(result, f), g);
        const right = Result.map(result, (value) => g(f(value)));
        expectSameResult(left, right);
      }),
    );
  });

  test("andThen associativity", () => {
    const resultFnArb = fc.constantFrom<(value: number) => ResultType<number, string>>(
      (value) => Result.ok(value + 1),
      (value) => Result.ok(value * 2),
      (value) => (value % 2 === 0 ? Result.ok(value / 2) : Result.err("odd")),
      (value) => Result.err(`e:${Math.abs(value % 7)}`),
    );

    fc.assert(
      fc.property(resultArb, resultFnArb, resultFnArb, (result, f, g) => {
        const left = Result.andThen(Result.andThen(result, f), g);
        const right = Result.andThen(result, (value) => Result.andThen(f(value), g));
        expectSameResult(left, right);
      }),
    );
  });
});
