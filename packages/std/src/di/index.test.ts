import { assert, describe, expect, expectTypeOf, test } from "vitest";
import ts from "typescript";
import { Op, TimeoutError } from "@prodkit/op";
import { UnhandledException } from "better-result";
import * as std from "../index.js";
import { InferContextRequirements, MissingContextError, type Value } from "./internal.js";
import { Ctx } from "./index.js";

class DatabaseError extends Error {
  readonly _tag = "DatabaseError";
}

interface User {
  readonly id: string;
}

interface Database {
  query: Op<User, DatabaseError, [sql: string, params: unknown[]]>;
}

class DatabaseService extends Ctx.Service("DatabaseService")<Database> {}

describe("Ctx", () => {
  test("keeps service names as discriminators", () => {
    expectTypeOf(DatabaseService).toExtend<Ctx<Database, "DatabaseService">>();
    expectTypeOf<Value<typeof DatabaseService>>().toEqualTypeOf<Database>();
  });

  test("exports dependency injection helpers from the root namespace", () => {
    expect(std.di.Ctx).toBe(Ctx);
    expect(std.di.Ctx.Service).toBe(Ctx.Service);
  });

  test("infers context requirements from yielded services", () => {
    const op = Ctx.Op(function* () {
      const db = yield* Ctx.require(DatabaseService);
      return yield* db.query("select * from users where id = ?", ["1"]);
    });

    expectTypeOf(op).toEqualTypeOf<Ctx.Op<User, DatabaseError, [], DatabaseService>>();

    const provided = op.use(
      DatabaseService.of({
        query: Op(function* (_sql: string, _params: unknown[]) {
          return { id: "1" };
        }).mapErr((error): DatabaseError => error),
      }),
    );

    expectTypeOf(provided).toEqualTypeOf<Ctx.Op<User, DatabaseError, [], never>>();
    expectTypeOf(provided.run()).toEqualTypeOf<ReturnType<Op<User, DatabaseError, []>["run"]>>();
  });

  test("runs with provided services", async () => {
    const calls: string[] = [];
    const db: Database = {
      query: Op(function* (sql: string, params: unknown[]) {
        calls.push(`${sql}:${params[0]}`);
        return { id: String(params[0]) };
      }).mapErr((error): DatabaseError => error),
    };
    const op = Ctx.Op(function* (id: string) {
      const service = yield* Ctx.require(DatabaseService);
      return yield* service.query("user", [id]);
    }).use(DatabaseService.of(db));

    const result = await op.run("123");

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toEqual({ id: "123" });
    expect(calls).toEqual(["user:123"]);
  });

  test("defaulted generator params still receive explicit run args", async () => {
    const op = Ctx.Op(function* (id: string = "default") {
      return id;
    }) satisfies Ctx.Op<string, never, [id?: string | undefined], never>;

    const result = await op.run("explicit");

    expect(result.unwrap()).toBe("explicit");
  });

  test("rest-parameter generators preserve all run args", async () => {
    const op = Ctx.Op(function* (...values: number[]) {
      return values.reduce((sum, value) => sum + value, 0);
    });

    expectTypeOf(op).toEqualTypeOf<Ctx.Op<number, never, number[], never>>();

    const result = await op.run(1, 2, 3, 4);

    expect(result.unwrap()).toBe(10);
  });

  test("composes context-aware operations", async () => {
    const findUser = Ctx.Op(function* (id: string) {
      const db = yield* Ctx.require(DatabaseService);
      return yield* db.query("user", [id]);
    });
    const greet = Ctx.Op(function* (id: string) {
      const user = yield* findUser(id);
      return `hello ${user.id}`;
    });
    const runnable = greet.use(
      DatabaseService.of({
        query: Op(function* (_sql: string, params: unknown[]) {
          return { id: String(params[0]) };
        }).mapErr((error): DatabaseError => error),
      }),
    );

    const result = await runnable.run("abc");

    expect(result.unwrap()).toBe("hello abc");
  });

  test("fluent callbacks can return context-aware operations", async () => {
    const findUser = Ctx.Op(function* (id: string) {
      const db = yield* Ctx.require(DatabaseService);
      return yield* db.query("user", [id]);
    });
    const greet = Ctx.Op(function* () {
      return "abc";
    })
      .flatMap((id) => findUser(id))
      .map((user) => `hello ${user.id}`);

    expectTypeOf(greet).toEqualTypeOf<Ctx.Op<string, DatabaseError, [], DatabaseService>>();

    const result = await greet
      .use(
        DatabaseService.of({
          query: Op(function* (_sql: string, params: unknown[]) {
            return { id: String(params[0]) };
          }).mapErr((error): DatabaseError => error),
        }),
      )
      .run();

    expect(result.unwrap()).toBe("hello abc");
  });

  test("policy wrappers can be configured before or after provisioning", async () => {
    const db: Database = {
      query: Op(function* (_sql: string, params: unknown[]) {
        return { id: String(params[0]) };
      }).mapErr((error): DatabaseError => error),
    };
    const findUser = Ctx.Op(function* (id: string) {
      const service = yield* Ctx.require(DatabaseService);
      return yield* service.query("user", [id]);
    });

    const policyBeforeProvisioning = findUser.withTimeout(1_000).use(DatabaseService.of(db));
    expectTypeOf(policyBeforeProvisioning).toEqualTypeOf<
      Ctx.Op<User, DatabaseError | TimeoutError, [id: string], never>
    >();

    const policyAfterProvisioning = findUser.use(DatabaseService.of(db)).withTimeout(1_000);
    expectTypeOf(policyAfterProvisioning).toEqualTypeOf<
      Ctx.Op<User, DatabaseError | TimeoutError, [id: string], never>
    >();

    const before = await policyBeforeProvisioning.run("before");
    const after = await policyAfterProvisioning.run("after");

    expect(before.unwrap()).toEqual({ id: "before" });
    expect(after.unwrap()).toEqual({ id: "after" });
  });

  test("all services are required", async () => {
    class TestService1 extends Ctx.Service("TestService1")<{}> {}
    class TestService2 extends Ctx.Service("TestService2")<{}> {}
    class TestService3 extends Ctx.Service("TestService3")<{}> {}

    const op = Ctx.Op(function* () {
      yield* Ctx.require(TestService1);
      yield* Ctx.require(TestService2);
      yield* Ctx.require(TestService3);
    });

    expectTypeOf(op).toEqualTypeOf<
      Ctx.Op<void, never, [], TestService1 | TestService2 | TestService3>
    >();

    type OpRequirements = InferContextRequirements<typeof op>;
    expectTypeOf<OpRequirements>().toEqualTypeOf<TestService1 | TestService2 | TestService3>();

    const provided = op.use(TestService1.of({}));
    expectTypeOf(provided).toEqualTypeOf<Ctx.Op<void, never, [], TestService2 | TestService3>>();

    type ProvidedRequirements = InferContextRequirements<typeof provided>;
    expectTypeOf<ProvidedRequirements>().toEqualTypeOf<TestService2 | TestService3>();

    // @ts-expect-error - still missing TestService2 and TestService3
    void (await provided.run());

    const provided2 = op.use(TestService1.of({}), TestService2.of({}));
    expectTypeOf(provided2).toEqualTypeOf<Ctx.Op<void, never, [], TestService3>>();
    type Provided2Requirements = InferContextRequirements<typeof provided2>;
    expectTypeOf<Provided2Requirements>().toEqualTypeOf<TestService3>();

    // @ts-expect-error - still missing TestService3
    void (await provided2.run());

    const provided3 = provided2.use(TestService3.of({}));
    expectTypeOf(provided3).toEqualTypeOf<Ctx.Op<void, never, [], never>>();

    const result = await provided3.run();
    expect(result.isOk()).toBe(true);
  });

  test("missing services surface as unhandled runtime failures", async () => {
    const op = Ctx.Op(function* () {
      yield* Ctx.require(DatabaseService);
      return "unreachable";
    });

    const runnable = op as unknown as Op<string, never, []>;
    const result = await runnable.run();

    expect(result.isErr()).toBe(true);
    const error = result.match({
      ok: () => undefined,
      err: (err) => err,
    });
    assert(UnhandledException.is(error));
    assert(MissingContextError.is(error.cause));
    expect(error.cause.key).toBe("DatabaseService");
  });

  test("yielding a context class without Ctx.require surfaces the static iterator guard", async () => {
    const op = Ctx.Op(function* () {
      // @ts-expect-error - DatabaseService does not have a [Symbol.iterator] method
      const _db = yield* DatabaseService;
      return "unreachable";
    });

    // @ts-expect-error - requirements are unknown
    const result = await op.run();

    expect(result.isErr()).toBe(true);
    const error = result.match({
      ok: () => undefined,
      err: (err: unknown) => err,
    });
    assert(UnhandledException.is(error));
    // @ts-expect-error - console is not defined in the test environment
    // oxlint-disable-next-line no-console
    console.log(error.cause);
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(String(error.cause)).toContain("Use Ctx.require(service) to require a context binding");
  });
});

describe("Ctx implementation hygiene", () => {
  test("does not inspect generator Function.length", () => {
    const source = ts.sys.readFile(`${ts.sys.getCurrentDirectory()}/src/di/index.ts`);

    expect(source).not.toContain("f.length");
  });
});
