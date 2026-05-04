// oxlint-disable no-unused-vars
import { Op, exponentialBackoff } from "@prodkit/op";
import { TaggedError } from "better-result";

{
  // plain TS - error handling
  async function getTodo(
    id: number,
  ): Promise<{ ok: true; todo: unknown } | { ok: false; error: "InvalidJson" | "RequestFailed" }> {
    try {
      const response = await fetch(`/todos/${id}`);
      if (!response.ok) throw new Error("Not OK!");
      try {
        const todo = await response.json();
        return { ok: true, todo };
      } catch {
        return { ok: false, error: "InvalidJson" };
      }
    } catch {
      return { ok: false, error: "RequestFailed" };
    }
  }
}

/*
// with Effect - error handling
const getTodo = (id: number): Effect.Effect<unknown, HttpClientError> =>
  httpClient.get(`/todos/${id}`).pipe(Effect.andThen((response) => response.json));
*/

{
  // with Op - error handling
  class RequestFailed extends TaggedError("RequestFailed")() {}
  class InvalidJson extends TaggedError("InvalidJson")() {}

  const getTodo = Op(function* (id: number) {
    const response = yield* Op.try(
      () => fetch(`/todos/${id}`),
      () => new RequestFailed(),
    );

    if (!response.ok) return yield* Op.fail(new RequestFailed());

    return yield* Op.try(
      () => response.json(),
      () => new InvalidJson(),
    );
  });

  const result = await getTodo.run(1);
}

{
  // plain TS - error handling + retry
  function getTodo(
    id: number,
    { retries = 3, retryBaseDelay = 1000 }: { retries?: number; retryBaseDelay?: number },
  ): Promise<{ ok: true; todo: unknown } | { ok: false; error: "InvalidJson" | "RequestFailed" }> {
    async function execute(
      attempt: number,
    ): Promise<
      { ok: true; todo: unknown } | { ok: false; error: "InvalidJson" | "RequestFailed" }
    > {
      try {
        const response = await fetch(`/todos/${id}`);
        if (!response.ok) throw new Error("Not OK!");
        try {
          const todo = await response.json();
          return { ok: true, todo };
        } catch (jsonError) {
          if (attempt < retries) {
            throw jsonError; // jump to retry
          }
          return { ok: false, error: "InvalidJson" };
        }
      } catch (error) {
        if (attempt < retries) {
          const delayMs = retryBaseDelay * 2 ** attempt;
          return new Promise((resolve) => setTimeout(() => resolve(execute(attempt + 1)), delayMs));
        }
        return { ok: false, error: "RequestFailed" };
      }
    }

    return execute(0);
  }
}

/*
// with Effect - error handling + retry
const getTodo = (id: number): Effect.Effect<unknown, HttpClientError> =>
  httpClient.get(`/todos/${id}`).pipe(
    Effect.andThen((response) => response.json),
    Effect.retry({
      schedule: Schedule.exponential(1000),
      times: 3,
    }),
  );
*/

{
  // with Op - error handling + retry
  class RequestFailed extends TaggedError("RequestFailed")() {}
  class InvalidJson extends TaggedError("InvalidJson")() {}

  const getTodo = Op(function* (id: number) {
    const response = yield* Op.try(
      () => fetch(`/todos/${id}`),
      () => new RequestFailed(),
    );

    if (!response.ok) return yield* Op.fail(new RequestFailed());

    return yield* Op.try(
      () => response.json(),
      () => new InvalidJson(),
    );
  });

  const result = await getTodo // same as before
    .withRetry({
      maxAttempts: 3,
      shouldRetry: RequestFailed.is,
      getDelay: exponentialBackoff.DEFAULT,
    })
    .run(1);
}

// plain TS - error handling + retry + interruption
{
  function getTodo(
    id: number,
    {
      retries = 3,
      retryBaseDelay = 1000,
      signal,
    }: {
      retries?: number;
      retryBaseDelay?: number;
      signal?: AbortSignal;
    },
  ): Promise<
    | { ok: true; todo: unknown }
    | {
        ok: false;
        error: "InvalidJson" | "RequestFailed" | "Timeout";
      }
  > {
    async function execute(attempt: number): Promise<
      | { ok: true; todo: unknown }
      | {
          ok: false;
          error: "InvalidJson" | "RequestFailed" | "Timeout";
        }
    > {
      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 1000);
        signal?.addEventListener("abort", () => controller.abort());
        const response = await fetch(`/todos/${id}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Not OK!");
        try {
          const todo = await response.json();
          return { ok: true, todo };
        } catch (jsonError) {
          if (attempt < retries) {
            throw jsonError; // jump to retry
          }
          return { ok: false, error: "InvalidJson" };
        }
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          return { ok: false, error: "Timeout" };
        } else if (attempt < retries) {
          const delayMs = retryBaseDelay * 2 ** attempt;
          return new Promise((resolve) => setTimeout(() => resolve(execute(attempt + 1)), delayMs));
        }
        return { ok: false, error: "RequestFailed" };
      }
    }

    return execute(0);
  }
}

/*
// with Effect - error handling + retry + interruption
const getTodo = (id: number): Effect.Effect<unknown, HttpClientError | TimeoutException> =>
  httpClient.get(`/todos/${id}`).pipe(
    Effect.andThen((response) => response.json),
    Effect.timeout("1 second"),
    Effect.retry({
      schedule: Schedule.exponential(1000),
      times: 3,
    }),
  );
*/

{
  // with Op - error handling + retry + interruption
  class RequestFailed extends TaggedError("RequestFailed")() {}
  class InvalidJson extends TaggedError("InvalidJson")() {}

  const getTodo = Op(function* (id: number) {
    const response = yield* Op.try(
      (signal) => fetch(`/todos/${id}`, { signal }),
      () => new RequestFailed(),
    );

    if (!response.ok) return yield* Op.fail(new RequestFailed());

    return yield* Op.try(
      () => response.json(),
      () => new InvalidJson(),
    );
  });

  {
    const result = await getTodo
      .withTimeout(1000)
      .withRetry({
        maxAttempts: 3,
        shouldRetry: RequestFailed.is,
        getDelay: exponentialBackoff.DEFAULT,
      })
      .run(1);
  }
}
