import { describe, expect, test, assert, vi } from "vitest";
import { fail, fromGenFn, succeed, _try } from "./builders.js";
import { TimeoutError, UnhandledException } from "./errors.js";
import type { RetryPolicy } from "./policies.js";

describe("withRetry", () => {
  class FetchError extends Error {
    readonly _tag = "FetchError";
  }

  const createFetcher = (maxRetries = 1) => {
    let attempt = 0;
    return async (url: string) => {
      if (attempt < maxRetries) {
        attempt++;
        throw new FetchError("couldn't fetch");
      }
      return { url };
    };
  };

  const retryFetchError: RetryPolicy = {
    maxAttempts: 3,
    shouldRetry: (cause) => cause instanceof FetchError,
    getDelay: () => 0,
  };

  const createFetchProgram = (
    fetcher: (url: string) => Promise<{ url: string }>,
    policy?: RetryPolicy,
  ) =>
    fromGenFn(function* (id: string) {
      return yield* _try(() => fetcher(`https://example.com/${id}`));
    }).withRetry(policy);

  test("retries on failure with default options", async () => {
    const fetcher = vi.fn(createFetcher());
    const program = createFetchProgram(fetcher);

    const result = await program.run("123");
    assert(result.isOk() === true, "result.ok should be true");
    expect(result.value).toEqual({ url: `https://example.com/123` });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("retries until success with custom retry predicate and delay", async () => {
    const fetcher = vi.fn(createFetcher());
    const policy: RetryPolicy = {
      maxAttempts: 3,
      shouldRetry: (cause) => cause instanceof FetchError,
      getDelay: (attempt) => attempt * 100,
    };
    const program = createFetchProgram(fetcher, policy);

    const result = await program.run("123");
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toEqual({ url: `https://example.com/123` });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("stops after maxAttempts and returns the last error", async () => {
    const fetcher = vi.fn(async (_url: string) => {
      throw new FetchError("always fails");
    });
    const program = createFetchProgram(fetcher, retryFetchError);

    const result = await program.run("123");
    assert(result.isErr() === true, "result should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test("does not retry when shouldRetry returns false", async () => {
    const fetcher = vi.fn(async (_url: string) => {
      throw new FetchError("retry denied");
    });

    const policy: RetryPolicy = {
      maxAttempts: 5,
      shouldRetry: () => false,
      getDelay: () => 0,
    };

    const program = createFetchProgram(fetcher, policy);

    const result = await program.run("123");
    assert(result.isErr() === true, "result should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("waits for configured delay before retrying", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(createFetcher());
      const policy: RetryPolicy = {
        maxAttempts: 2,
        shouldRetry: () => true,
        getDelay: () => 100,
      };
      const program = createFetchProgram(fetcher, policy);

      const runPromise = program.run("123");

      await Promise.resolve();
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      const result = await runPromise;
      assert(result.isOk() === true, "result should be Ok");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("works when wrapping _try directly", async () => {
    let attempts = 0;
    const program = _try(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new FetchError("transient failure");
      }
      return { ok: true as const };
    }).withRetry({
      maxAttempts: 3,
      shouldRetry: (cause) => cause instanceof FetchError,
      getDelay: () => 0,
    });

    const result = await program.run();
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  test("wrapping _try directly can retry UnhandledException causes", async () => {
    let attempts = 0;
    const transient = new Error("temporary outage");
    const program = _try(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw transient;
      }
      return "done";
    }).withRetry({
      maxAttempts: 3,
      shouldRetry: (cause) => cause === transient,
      getDelay: () => 0,
    });

    const result = await program.run();
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toBe("done");
    expect(attempts).toBe(3);
  });

  test("retries a child op inside a parent op", async () => {
    let attempts = 0;
    const transient = new FetchError("intermittent");
    const child = () =>
      _try(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw transient;
        }
        return 19;
      });

    const parent = fromGenFn(function* () {
      const base = yield* succeed(50);
      const fetched = yield* child().withRetry({
        maxAttempts: 3,
        shouldRetry: (cause) => cause instanceof FetchError,
        getDelay: () => 0,
      });
      return base + fetched;
    });

    const result = await parent.run();
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toBe(69);
    expect(attempts).toBe(2);
  });

  test("retries Op.try(async fn) with fluent API", async () => {
    let attempts = 0;
    const transient = new Error("temporary");
    const program = fromGenFn(function* (id: string) {
      attempts += 1;
      if (attempts === 1) {
        throw transient;
      }
      return yield* _try(() => Promise.resolve({ url: `https://example.com/${id}` }));
    }).withRetry({
      maxAttempts: 3,
      shouldRetry: (cause: unknown) => cause === transient,
      getDelay: () => 0,
    });

    const result = await program.run("123");
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toEqual({ url: "https://example.com/123" });
    expect(attempts).toBe(2);
  });

  test("retries generator ops with fluent API", async () => {
    let attempts = 0;
    const program = fromGenFn(function* (id: string) {
      attempts += 1;
      if (attempts === 1) {
        return yield* fail(new FetchError("first attempt failed"));
      }
      return { url: `https://example.com/${id}` };
    }).withRetry({
      maxAttempts: 3,
      shouldRetry: (cause) => cause instanceof FetchError,
      getDelay: () => 0,
    });

    const result = await program.run("123");
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toEqual({ url: "https://example.com/123" });
    expect(attempts).toBe(2);
  });
});

describe("withTimeout", () => {
  test("succeeds when the operation completes before timeout", async () => {
    const program = _try(() => Promise.resolve(69)).withTimeout(100);
    const result = await program.run();
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toBe(69);
  });

  test("fails with TimeoutError when operation exceeds timeout", async () => {
    vi.useFakeTimers();
    try {
      const program = _try(
        () =>
          new Promise<number>((resolve) => {
            setTimeout(() => resolve(69), 200);
          }),
      ).withTimeout(100);
      const runPromise = program.run();
      await vi.advanceTimersByTimeAsync(100);

      const result = await runPromise;
      assert(result.isErr() === true, "result should be Err");
      expect(result.error).toBeInstanceOf(TimeoutError);
      if (result.error instanceof TimeoutError) {
        expect(result.error.timeoutMs).toBe(100);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("timeout wraps the entire retried run when chained outside retry", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const transient = new Error("transient");
      const program = _try(
        () =>
          new Promise<number>((resolve, reject) => {
            attempts += 1;
            setTimeout(() => {
              if (attempts === 1) {
                reject(transient);
                return;
              }
              resolve(69);
            }, 75);
          }),
      )
        .withRetry({
          maxAttempts: 3,
          shouldRetry: (cause) => cause === transient,
          getDelay: () => 0,
        })
        .withTimeout(100);

      const runPromise = program.run();
      await vi.advanceTimersByTimeAsync(100);

      const result = await runPromise;
      assert(result.isErr() === true, "result should be Err");
      expect(result.error).toBeInstanceOf(TimeoutError);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("timeout applies per-attempt when chained inside retry", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const program = _try(
        () =>
          new Promise<number>((resolve) => {
            attempts += 1;
            const delay = attempts === 1 ? 120 : 50;
            setTimeout(() => resolve(69), delay);
          }),
      )
        .withTimeout(100)
        .withRetry({
          maxAttempts: 2,
          shouldRetry: (cause) => cause instanceof TimeoutError,
          getDelay: () => 0,
        });

      const runPromise = program.run();
      await vi.advanceTimersByTimeAsync(150);

      const result = await runPromise;
      assert(result.isOk() === true, "result should be Ok");
      expect(result.value).toBe(69);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("withSignal", () => {
  test("passes a live signal into Op.try by default", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const program = _try((signal) => {
      seenSignal = signal;
      return Promise.resolve(69);
    }).withSignal(controller.signal);

    const result = await program.run();
    assert(result.isOk() === true, "result should be Ok");
    expect(result.value).toBe(69);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });

  test("aborting the bound signal cancels in-flight Op.try work", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const program = _try(
        (signal) =>
          new Promise<number>((resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            const id = setTimeout(() => resolve(69), 500);
            signal.addEventListener("abort", () => {
              clearTimeout(id);
              reject(signal.reason);
            });
          }),
        (cause) => String(cause instanceof Error ? cause.message : cause),
      ).withSignal(controller.signal);

      const runPromise = program.run();
      controller.abort(new Error("request cancelled"));
      await vi.advanceTimersByTimeAsync(0);

      const result = await runPromise;
      assert(result.isErr() === true, "result should be Err");
      expect(result.error).toBe("request cancelled");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AbortSignal", () => {
  test("Op.try callback receives a signal that is not aborted by default", async () => {
    let seen: AbortSignal | undefined;
    const program = _try((signal) => {
      seen = signal;
      return Promise.resolve("ok");
    });
    const result = await program.run();
    assert(result.isOk() === true, "result should be Ok");
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  test("timeout aborts the signal passed to Op.try", async () => {
    vi.useFakeTimers();
    try {
      let seenSignal: AbortSignal | undefined;
      const program = _try(
        (signal) =>
          new Promise<number>((resolve, reject) => {
            seenSignal = signal;
            const id = setTimeout(() => resolve(69), 500);
            signal.addEventListener("abort", () => {
              clearTimeout(id);
              reject(signal.reason);
            });
          }),
      ).withTimeout(100);

      const runPromise = program.run();
      await vi.advanceTimersByTimeAsync(100);
      const result = await runPromise;

      assert(result.isErr() === true, "result should be Err");
      expect(result.error).toBeInstanceOf(TimeoutError);
      expect(seenSignal?.aborted).toBe(true);
      expect(seenSignal?.reason).toBeInstanceOf(TimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  test("timeout cascades into retry-wrapped ops so inner fetch is aborted", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let aborted = false;

      const program = _try(
        (signal) =>
          new Promise<number>((_, reject) => {
            attempts += 1;
            const id = setTimeout(() => reject(new Error("transient")), 50);
            signal.addEventListener("abort", () => {
              aborted = true;
              clearTimeout(id);
              reject(signal.reason);
            });
          }),
      )
        .withRetry({
          maxAttempts: 10,
          shouldRetry: () => true,
          getDelay: () => 10,
        })
        .withTimeout(120);

      const runPromise = program.run();
      await vi.advanceTimersByTimeAsync(200);

      const result = await runPromise;
      assert(result.isErr() === true, "result should be Err");
      expect(result.error).toBeInstanceOf(TimeoutError);
      expect(aborted).toBe(true);
      expect(attempts).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("timeout stops the retry loop instead of racing zombie attempts", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const transient = new Error("transient");
      const program = _try(() => {
        attempts += 1;
        return Promise.reject(transient);
      })
        .withRetry({
          maxAttempts: 5,
          shouldRetry: () => true,
          getDelay: () => 1000,
        })
        .withTimeout(50);

      const runPromise = program.run();
      await vi.advanceTimersByTimeAsync(200);

      const result = await runPromise;
      assert(result.isErr() === true, "result should be Err");
      expect(result.error).toBeInstanceOf(TimeoutError);
      // Only one attempt ran before the timeout aborted the delay and halted the loop.
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
