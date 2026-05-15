import { describe, expect, expectTypeOf, test } from "vitest";
import { Op } from "@prodkit/op";
import {
  Context,
  InferContextRequirements,
  withContext,
  type ContextValue,
  type WithContext,
} from "./index.js";

class DatabaseError extends Error {
  readonly _tag = "DatabaseError";
}

interface User {
  readonly id: string;
}

interface Database {
  query: Op<User, DatabaseError, [sql: string, params: unknown[]]>;
}

class DatabaseService extends Context("DatabaseService")<Database> {}

describe("withContext", () => {
  test("keeps service names as discriminators", () => {
    const service: Context<Database, "DatabaseService"> = DatabaseService;
    expectTypeOf(service).toEqualTypeOf<Context<Database, "DatabaseService">>();
    expectTypeOf<ContextValue<typeof DatabaseService>>().toEqualTypeOf<Database>();
  });

  test("infers context requirements from yielded services", () => {
    const op = withContext(function* () {
      const db = yield* Context.require(DatabaseService);
      return yield* db.query("select * from users where id = ?", ["1"]);
    });

    expectTypeOf(op).toEqualTypeOf<WithContext<Op<User, DatabaseError, []>, DatabaseService>>();

    const provided = op.provide(DatabaseService, {
      query: Op(function* (_sql: string, _params: unknown[]) {
        return { id: "1" };
      }).mapErr((error): DatabaseError => error),
    });

    expectTypeOf(provided).toEqualTypeOf<WithContext<Op<User, DatabaseError, []>, never>>();
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
    const op = withContext(function* (id: string) {
      const service = yield* Context.require(DatabaseService);
      return yield* service.query("user", [id]);
    }).provide(DatabaseService, db);

    const result = await op.run("123");

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toEqual({ id: "123" });
    expect(calls).toEqual(["user:123"]);
  });

  test("composes context-aware operations", async () => {
    const findUser = withContext(function* (id: string) {
      const db = yield* Context.require(DatabaseService);
      return yield* db.query("user", [id]);
    });
    const greet = withContext(function* (id: string) {
      const user = yield* findUser(id);
      return `hello ${user.id}`;
    });
    const runnable = greet.provide(DatabaseService, {
      query: Op(function* (_sql: string, params: unknown[]) {
        return { id: String(params[0]) };
      }).mapErr((error): DatabaseError => error),
    });

    const result = await runnable.run("abc");

    expect(result.unwrap()).toBe("hello abc");
  });

  test("all services are required", async () => {
    class TestService1 extends Context("TestService1")<{}> {}
    class TestService2 extends Context("TestService2")<{}> {}
    class TestService3 extends Context("TestService3")<{}> {}

    const op = withContext(function* () {
      yield* Context.require(TestService1);
      yield* Context.require(TestService2);
      yield* Context.require(TestService3);
    });

    expectTypeOf(op).toEqualTypeOf<
      WithContext<Op<void, never, []>, TestService1 | TestService2 | TestService3>
    >();

    type OpRequirements = InferContextRequirements<typeof op>;
    expectTypeOf<OpRequirements>().toEqualTypeOf<TestService1 | TestService2 | TestService3>();

    const provided = op.provide(TestService1, {});
    expectTypeOf(provided).toEqualTypeOf<
      WithContext<Op<void, never, []>, TestService2 | TestService3>
    >();

    type ProvidedRequirements = InferContextRequirements<typeof provided>;
    expectTypeOf<ProvidedRequirements>().toEqualTypeOf<TestService2 | TestService3>();

    // @ts-expect-error - still missing TestService2 and TestService3
    void (await provided.run());

    const provided2 = provided.provide(TestService2, {});
    expectTypeOf(provided2).toEqualTypeOf<WithContext<Op<void, never, []>, TestService3>>();
    type Provided2Requirements = InferContextRequirements<typeof provided2>;
    expectTypeOf<Provided2Requirements>().toEqualTypeOf<TestService3>();

    // @ts-expect-error - still missing TestService3
    void (await provided2.run());

    const provided3 = provided2.provide(TestService3, {});
    expectTypeOf(provided3).toEqualTypeOf<WithContext<Op<void, never, []>, never>>();

    const result = await provided3.run();
    expect(result.isOk()).toBe(true);
  });

  test("missing services surface as unhandled runtime failures", async () => {
    const op = withContext(function* () {
      yield* Context.require(DatabaseService);
      return "unreachable";
    });

    const runnable = op as unknown as Op<string, never, []>;
    const result = await runnable.run();

    expect(result.isErr()).toBe(true);
    const error = result.match({
      ok: () => undefined,
      err: (err) => err,
    });
    expect(String(error?.cause)).toContain("Missing context: DatabaseService");
  });
});
