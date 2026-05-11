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

type Span = {
  setStatus: (status: { code: number; message?: string }) => void;
  end: () => void;
};

type Otel = {
  trace: {
    getTracer: (name: string) => {
      startActiveSpan: <T>(
        spanName: string,
        options: { attributes?: Record<string, unknown> },
        run: (span: {
          setStatus: (status: { code: number; message?: string }) => void;
          end: () => void;
        }) => Promise<T> | T,
      ) => Promise<T>;
      startSpan: <T>(spanName: string, options: { attributes?: Record<string, unknown> }) => Span;
    };
  };
  SpanStatusCode: {
    OK: number;
    ERROR: number;
  };
};
const Otel: Otel = {
  trace: {
    getTracer: () => ({
      startActiveSpan: async (_spanName, _options, run) => {
        const span = {
          setStatus: () => {},
          end: () => {},
        };
        return await run(span);
      },
      startSpan: (async (_spanName: string, _options: { attributes?: Record<string, unknown> }) => {
        const span: Span = {
          setStatus: () => {},
          end: () => {},
        };
        return span;
      }) as never,
    }),
  },
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
  },
};

const tracer = Otel.trace.getTracer("todos");

{
  // plain TS - error handling + retry + interruption + observability

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
    return tracer.startActiveSpan("getTodo", { attributes: { id } }, async (span) => {
      try {
        const result = await execute(0);
        if (result.ok) {
          span.setStatus({ code: Otel.SpanStatusCode.OK });
        } else {
          span.setStatus({
            code: Otel.SpanStatusCode.ERROR,
            message: result.error,
          });
        }
        return result;
      } finally {
        span.end();
      }
    });

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
  }
}

/*
// with Effect - error handling + retry + interruption + observability
const getTodo = (id: number): Effect.Effect<unknown, HttpClientError | TimeoutException> =>
  httpClient.get(`/todos/${id}`).pipe(
    Effect.andThen((response) => response.json),
    Effect.timeout("1 second"),
    Effect.retry({
      schedule: Schedule.exponential(1000),
      times: 3,
    }),
    Effect.withSpan("getTodo", { attributes: { id } }),
  );
*/

{
  // with Op - error handling + retry + interruption + observability
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

  let span: Span | undefined;
  const result = await getTodo
    .withTimeout(1000)
    .withRetry({
      maxAttempts: 3,
      shouldRetry: RequestFailed.is,
      getDelay: exponentialBackoff.DEFAULT,
    })
    .on("enter", ({ args: [id] }) => {
      span = tracer.startSpan("getTodo", { attributes: { id } });
    })
    .on("exit", (ctx) => {
      ctx.result.match({
        ok: () => span?.setStatus({ code: Otel.SpanStatusCode.OK }),
        err: (error) =>
          span?.setStatus({ code: Otel.SpanStatusCode.ERROR, message: error.message }),
      });
      span?.end();
      span = undefined;
    })
    .run(1);
}
