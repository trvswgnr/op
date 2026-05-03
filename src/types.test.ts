import { describe, expectTypeOf, test } from "vitest";
import {
  ErrorGroup,
  Op,
  TaggedError,
  TimeoutError,
  UnhandledException,
  type ExitContext,
  type Op as OpType,
  type Result,
  type TaggedErrorInstance,
} from "./index.js";

describe("type inference contracts", () => {
  test("builders infer Op shape and run() output", () => {
    const p1 = Op.of(1);
    expectTypeOf(p1).toEqualTypeOf<OpType<number, never, []>>();
    expectTypeOf(p1.run()).toEqualTypeOf<Promise<Result<number, UnhandledException>>>();

    const p2 = Op(function* (a: number) {
      return a + 1;
    });
    expectTypeOf(p2).toEqualTypeOf<OpType<number, never, [a: number]>>();
    expectTypeOf(p2.run(1)).toEqualTypeOf<Promise<Result<number, UnhandledException>>>();

    const p3 = Op.fail("error");
    expectTypeOf(p3).toEqualTypeOf<OpType<never, string, []>>();
    expectTypeOf(p3.run()).toEqualTypeOf<Promise<Result<never, string | UnhandledException>>>();

    // @ts-expect-error - nullary run does not accept arguments
    p1.run(1);
    // @ts-expect-error - parameterized run requires argument
    p2.run();
    // @ts-expect-error - parameterized run does not accept extra args
    p2.run(1, 2);
  });

  test("policy chaining preserves arity and widens error channels", () => {
    const retryNullary = Op.try(() => Promise.resolve(1)).withRetry();
    expectTypeOf(retryNullary).toEqualTypeOf<OpType<number, UnhandledException, []>>();
    expectTypeOf(retryNullary.run()).toEqualTypeOf<Promise<Result<number, UnhandledException>>>();

    const retryMapped = Op.try(
      () => Promise.resolve(1),
      () => "mapped",
    ).withRetry();
    expectTypeOf(retryMapped).toEqualTypeOf<OpType<number, string, []>>();
    expectTypeOf(retryMapped.run()).toEqualTypeOf<
      Promise<Result<number, string | UnhandledException>>
    >();

    const timeout = Op(function* (id: string) {
      return id.length;
    }).withTimeout(10);
    expectTypeOf(timeout).toEqualTypeOf<OpType<number, TimeoutError, [id: string]>>();
    expectTypeOf(timeout.run("abc")).toEqualTypeOf<
      Promise<Result<number, TimeoutError | UnhandledException>>
    >();

    const withSignal = Op(function* (id: string) {
      return id.length;
    }).withSignal(new AbortController().signal);
    expectTypeOf(withSignal).toEqualTypeOf<OpType<number, never, [id: string]>>();
    expectTypeOf(withSignal.run("abc")).toEqualTypeOf<
      Promise<Result<number, UnhandledException>>
    >();

    // @ts-expect-error - parameterized timeout op requires argument
    timeout.run();
    // @ts-expect-error - parameterized timeout op does not accept extra args
    timeout.run("abc", "extra");
    // @ts-expect-error - parameterized withSignal op requires argument
    withSignal.run();
  });

  test("operator combinators transform success and error channels correctly", () => {
    const mapOp = Op(function* (n: number) {
      return n + 1;
    }).map((value) => `v:${value}`);
    expectTypeOf(mapOp).toEqualTypeOf<OpType<string, never, [number]>>();

    const mapErrOp = Op(function* (n: number) {
      if (n < 0) {
        return yield* Op.fail("negative" as const);
      }
      return n;
    }).mapErr((error) => ({ code: error }));
    expectTypeOf(mapErrOp).toEqualTypeOf<OpType<number, { code: "negative" }, [number]>>();

    const flatMapOp = Op.of(5).flatMap((value) =>
      value > 3 ? Op.of(`ok:${value}` as const) : Op.fail("too-small" as const),
    );
    expectTypeOf(flatMapOp).toEqualTypeOf<OpType<`ok:${number}`, "too-small", []>>();

    const tapOp = Op(function* (n: number) {
      return n + 1;
    }).tap((value) => value.toString());
    expectTypeOf(tapOp).toEqualTypeOf<OpType<number, never, [number]>>();

    const tapErrOp = Op(function* (kind: "bad" | "ok") {
      if (kind === "bad") {
        return yield* Op.fail("bad-input" as const);
      }
      return 69;
    }).tapErr((error) => error.toUpperCase());
    expectTypeOf(tapErrOp).toEqualTypeOf<OpType<number, "bad-input", ["bad" | "ok"]>>();
  });

  test("recover narrows handled errors and preserves unhandled variants", () => {
    class AErr extends TaggedError("AErr")() {}
    class BErr extends TaggedError("BErr")() {}
    class RecoveryErr extends TaggedError("RecoveryErr")() {}
    class E3 extends TaggedError("E3")() {}

    const op = Op(function* (kind: "a" | "b") {
      if (kind === "a") {
        return yield* new AErr();
      }
      return yield* new BErr();
    }).recover(
      (error): error is AErr => error instanceof AErr,
      () => Op.fail(new RecoveryErr()),
    );
    expectTypeOf(op).toEqualTypeOf<OpType<never, BErr | RecoveryErr, ["a" | "b"]>>();

    const base = Op(function* () {
      if (Infinity > 0) {
        return yield* new AErr();
      }
      return yield* new BErr();
    });
    const recoveredA = base.recover(AErr, () => "fallback");
    const recoveredB = base.recover(BErr, () => "fallback");
    expectTypeOf(recoveredA).toEqualTypeOf<OpType<string, BErr, []>>();
    expectTypeOf(recoveredB).toEqualTypeOf<OpType<string, AErr, []>>();

    // @ts-expect-error - E3 is not a valid error type for this op
    base.recover(E3, () => "fallback");
  });

  test("combinators infer tuples and error unions", () => {
    const all = Op.all([Op.of(1), Op.of("two"), Op.of(true)]);
    type AllRun = Awaited<ReturnType<typeof all.run>>;
    expectTypeOf<AllRun>().toEqualTypeOf<
      Result<readonly [number, string, boolean], UnhandledException>
    >();

    const allSettled = Op.allSettled([Op.fail(1), Op.fail("two" as const)]);
    type AllSettledRun = Awaited<ReturnType<typeof allSettled.run>>;
    expectTypeOf<AllSettledRun>().toEqualTypeOf<
      Result<
        readonly [
          Result<never, number | UnhandledException>,
          Result<never, "two" | UnhandledException>,
        ],
        UnhandledException
      >
    >();

    const settled = Op.settle(Op.fail(1));
    expectTypeOf(settled).toEqualTypeOf<
      OpType<Result<never, number | UnhandledException>, never, []>
    >();

    const anyOp = Op.any([Op.fail(1), Op.fail("two" as const)]);
    expectTypeOf(anyOp).toEqualTypeOf<
      OpType<never, ErrorGroup<number | "two" | UnhandledException>, []>
    >();

    const race = Op.race([Op.of(1), Op.fail("two" as const)]);
    const raceRun = race.run();
    expectTypeOf(raceRun).toEqualTypeOf<Promise<Result<number, "two" | UnhandledException>>>();
  });

  test("lifecycle helpers preserve op shape and expose exit context", () => {
    const withRelease = Op.of({ id: 1 }).withRelease((value) => value.id);
    expectTypeOf(withRelease).toEqualTypeOf<OpType<{ id: number }, never, []>>();

    const onExit = Op(function* (name: string) {
      return name.length;
    }).on("exit", (ctx) => {
      expectTypeOf(ctx).toEqualTypeOf<ExitContext<number, never>>();
      expectTypeOf(ctx.result).toEqualTypeOf<Result<number, UnhandledException>>();
    });
    expectTypeOf(onExit).toEqualTypeOf<OpType<number, never, [string]>>();
    expectTypeOf(onExit.run).parameter(0).toEqualTypeOf<string>();
  });

  test("public API typing contracts remain stable", () => {
    expectTypeOf(Op.empty).toEqualTypeOf<OpType<void, never, []>>();

    const SmokeError = TaggedError("SmokeError")<{ message: string }>();
    const e = new SmokeError({ message: "x" });
    expectTypeOf(e).toEqualTypeOf<TaggedErrorInstance<"SmokeError", { message: string }>>();
  });
});
