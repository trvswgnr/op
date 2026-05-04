import { assert, describe, expect, test, vi } from "vitest";
import { Op, TimeoutError, type EnterContext, type ExitContext } from "./index.js";
import { UnhandledException } from "./errors.js";
import { SuspendInstruction } from "./core/instructions.js";

// Scope: integration behavior for cleanup/finalization and lifecycle hooks
describe("op.withRelease", () => {
  test("runs registered cleanup after a successful run", async () => {
    const events: string[] = [];
    const release = vi.fn((conn: { id: number }) => {
      events.push(`release:${conn.id}`);
    });

    const program = Op(function* () {
      const conn = yield* Op.of({ id: 7 }).withRelease(release);
      events.push(`query:${conn.id}`);
      return conn.id;
    });

    const result = await program.run();
    assert(result.isOk(), "should be Ok");
    expect(result.value).toBe(7);
    expect(events).toEqual(["query:7", "release:7"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("runs cleanup when downstream logic fails with a typed error", async () => {
    const release = vi.fn();
    const result = await Op(function* () {
      yield* Op.of({ id: 1 }).withRelease(() => {
        release();
      });
      return yield* Op.fail("boom" as const);
    }).run();

    assert(result.isErr(), "should be Err");
    expect(result.error).toBe("boom");
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("runs cleanup when withTimeout aborts inner work", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn();
      const op = Op(function* () {
        yield* Op.of({ close: release }).withRelease((conn) => conn.close());
        return yield* Op.try(
          (signal) =>
            new Promise<number>((_resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        ).withTimeout(10);
      });

      const runPromise = op.run();
      await vi.advanceTimersByTimeAsync(10);
      const result = await runPromise;
      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(TimeoutError);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("fails with UnhandledException when cleanup throws after success", async () => {
    const cleanupFault = new Error("cleanup failed");
    const result = await Op.of(1)
      .withRelease(() => {
        throw cleanupFault;
      })
      .run();

    assert(result.isErr(), "should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    if (result.error instanceof UnhandledException) {
      expect(result.error.cause).toBe(cleanupFault);
    }
  });

  test("preserves primary error when cleanup throws after typed failure", async () => {
    const result = await Op.fail("boom" as const)
      .withRelease(() => {
        throw new Error("cleanup failed");
      })
      .run();

    assert(result.isErr(), "should be Err");
    expect(result.error).toBe("boom");
  });

  test("preserves inferred op shapes", async () => {
    const p1 = Op.of({ id: 1 }).withRelease((_value) => {});
    const p2 = Op(function* (name: string) {
      return name.length;
    }).withRelease((_len) => {});

    expect((await p1.run()).isOk()).toBe(true);
    expect((await p2.run("abc")).isOk()).toBe(true);
  });
});

describe('op.on("enter")', () => {
  test('.on("enter") runs initializer before success path starts', async () => {
    const events: string[] = [];
    let seenCtx!: EnterContext;
    const result = await Op(function* () {
      events.push("body");
      return 123;
    })
      .on("enter", (ctx) => {
        seenCtx = ctx;
        events.push("enter");
      })
      .run();

    assert(result.isOk(), "should be Ok");
    expect(result.value).toBe(123);
    expect(events).toEqual(["enter", "body"]);
    expect(seenCtx.signal).toBeInstanceOf(AbortSignal);
    expect(seenCtx.args).toEqual([]);
  });

  test('.on("enter") runs before body when downstream fails', async () => {
    const events: string[] = [];
    const result = await Op(function* () {
      events.push("body");
      return yield* Op.fail("boom" as const);
    })
      .on("enter", () => {
        events.push("enter");
      })
      .run();

    assert(result.isErr(), "should be Err");
    expect(result.error).toBe("boom");
    expect(events).toEqual(["enter", "body"]);
  });

  test('chained .on("enter") handlers run in wrapper/LIFO order', async () => {
    const order: string[] = [];
    const result = await Op.of(1)
      .on("enter", () => {
        order.push("a");
      })
      .on("enter", () => {
        order.push("b");
      })
      .run();

    assert(result.isOk(), "should be Ok");
    expect(order).toEqual(["b", "a"]);
  });

  test('composition with .on("exit") keeps enter-before-body and exit-after-settle ordering', async () => {
    const events: string[] = [];
    const result = await Op.of(1)
      .on("enter", () => {
        events.push("enter-a");
      })
      .on("enter", () => {
        events.push("enter-b");
      })
      .on("exit", () => {
        events.push("exit-a");
      })
      .on("exit", () => {
        events.push("exit-b");
      })
      .run();

    assert(result.isOk(), "should be Ok");
    expect(events).toEqual(["enter-b", "enter-a", "exit-a", "exit-b"]);
  });

  test("runs once regardless of position in chain", async () => {
    const policy = {
      maxAttempts: 3,
      shouldRetry: () => true,
      getDelay: () => 0,
    };
    const runCase = async (order: "before-retry" | "after-retry") => {
      let attempts = 0;
      const enter = vi.fn();
      const base = Op.try(() => {
        attempts += 1;
        if (attempts < 3) throw new Error(`fail-${attempts}`);
        return 42;
      });
      const op =
        order === "before-retry"
          ? base.on("enter", enter).withRetry(policy)
          : base.withRetry(policy).on("enter", enter);
      const result = await op.run();
      assert(result.isOk(), "should be Ok");
      expect(result.value).toBe(42);
      expect(enter).toHaveBeenCalledTimes(1);
    };

    await runCase("before-retry");
    await runCase("after-retry");
  });

  test('.on("enter") still runs when run later times out', async () => {
    vi.useFakeTimers();
    try {
      const enter = vi.fn();
      const runPromise = Op.try((_signal) => new Promise<number>(() => {}))
        .on("enter", enter)
        .withTimeout(10)
        .run();
      await vi.advanceTimersByTimeAsync(10);
      const result = await runPromise;

      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(TimeoutError);
      expect(enter).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('.on("enter") receives runtime args for arity ops', async () => {
    let seenCtx!: EnterContext<[string, number]>;
    const result = await Op(function* (name: string, retries: number) {
      return `${name}:${retries}`;
    })
      .on("enter", (ctx) => {
        seenCtx = ctx;
      })
      .run("cache", 3);

    assert(result.isOk(), "should be Ok");
    expect(result.value).toBe("cache:3");
    expect(seenCtx.args).toEqual(["cache", 3]);
  });
});

describe('op.on("exit")', () => {
  test('.on("exit") runs finalizer after success', async () => {
    const finalize = vi.fn();
    const result = await Op.of(123)
      .on("exit", () => {
        finalize();
      })
      .run();

    assert(result.isOk(), "should be Ok");
    expect(result.value).toBe(123);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  test('chains .on("exit") in LIFO order with inner registration running first', async () => {
    const order: string[] = [];
    await Op.of(1)
      .on("exit", () => {
        order.push("a");
      })
      .on("exit", () => {
        order.push("b");
      })
      .run();
    expect(order).toEqual(["a", "b"]);
  });

  test('.on("exit") preserves fluent combinators', async () => {
    const finalize = vi.fn();
    const result = await Op.of(1).withRetry().on("exit", finalize).run();
    assert(result.isOk());
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  test("runs finalizer after typed failure", async () => {
    const finalize = vi.fn();
    const result = await Op.fail("boom" as const)
      .on("exit", () => {
        finalize();
      })
      .run();

    assert(result.isErr(), "should be Err");
    expect(result.error).toBe("boom");
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  test("preserves inferred op shapes", () => {
    const p1 = Op.of({ id: 1 }).on("exit", () => {});
    const p2 = Op(function* (name: string) {
      return name.length;
    }).on("exit", () => {});
    expect(typeof p1.run).toBe("function");
    expect(typeof p2.run).toBe("function");
  });

  test('.on("exit") ExitContext.result is the same Result as .run()', async () => {
    let okCtx!: ExitContext<number, never>;
    const ok = await Op.of(99)
      .on("exit", (c) => {
        okCtx = c;
      })
      .run();
    assert(ok.isOk());
    assert(okCtx !== undefined);
    expect(okCtx.result).toBe(ok);
    expect(okCtx.signal.aborted).toBe(false);
    expect(okCtx.args).toEqual([]);

    let typedCtx!: ExitContext<never, string>;
    const typedErr = await Op.fail("no")
      .on("exit", (c) => {
        typedCtx = c;
      })
      .run();
    assert(typedErr.isErr());
    assert(typedCtx !== undefined);
    expect(typedCtx.result).toBe(typedErr);
    expect(typedCtx.args).toEqual([]);

    let throwCtx!: ExitContext<never, never>;
    const boom = new Error("sync");
    const syncThrowOp = Op(function* () {
      throw boom;
    });
    const threw = await syncThrowOp
      .on("exit", (c) => {
        throwCtx = c;
      })
      .run();
    assert(threw.isErr());
    expect(throwCtx).toBeDefined();
    expect(throwCtx.result).toBe(threw);
    expect(throwCtx.args).toEqual([]);
  });

  test('.on("exit") ExitContext.result matches run after withTimeout', async () => {
    vi.useFakeTimers();
    try {
      let timedCtx!: ExitContext<number, UnhandledException | TimeoutError>;
      const runPromise = Op.try((_signal) => new Promise<number>(() => {}))
        .withTimeout(10)
        .on("exit", (c) => {
          timedCtx = c;
        })
        .run();
      await vi.advanceTimersByTimeAsync(10);
      const timed = await runPromise;

      assert(timed.isErr());
      expect(timedCtx).toBeDefined();
      expect(timedCtx.result).toBe(timed);
      expect(timedCtx.args).toEqual([]);
      expect(timed.error).toBeInstanceOf(TimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  test('.on("exit") receives runtime args for arity ops', async () => {
    let seenCtx!: ExitContext<number, never, [string]>;
    const result = await Op(function* (name: string) {
      return name.length;
    })
      .on("exit", (ctx) => {
        seenCtx = ctx;
      })
      .run("gamma");

    assert(result.isOk(), "should be Ok");
    expect(result.value).toBe(5);
    expect(seenCtx.args).toEqual(["gamma"]);
    expect(seenCtx.result).toBe(result);
  });
});

describe("generator finalization on early exit", () => {
  test("runs finally when the body yields an Err instruction", async () => {
    const events: string[] = [];
    const program = Op(function* () {
      try {
        events.push("start");
        yield* Op.fail("boom");
        return "unreachable";
      } finally {
        events.push("finally");
      }
    });

    const result = await program.run();

    assert(result.isErr(), "should be Err");
    expect(result.error).toBe("boom");
    expect(events).toEqual(["start", "finally"]);
  });

  test("runs finally when a suspended instruction throws", async () => {
    const events: string[] = [];
    const cause = new Error("suspend failed");
    const program = Op(function* () {
      try {
        events.push("start");
        yield new SuspendInstruction(async () => {
          throw cause;
        });
        return 1;
      } finally {
        events.push("finally");
      }
    });

    const result = await program.run();

    assert(result.isErr(), "should be Err");
    expect(result.error).toBeInstanceOf(UnhandledException);
    expect(result.error.cause).toBe(cause);
    expect(events).toEqual(["start", "finally"]);
  });

  test("runs finally when withTimeout aborts inner work", async () => {
    vi.useFakeTimers();
    try {
      let finalized = false;
      const program = Op(function* () {
        try {
          yield* Op.try(
            (signal) =>
              new Promise<number>((_resolve, reject) => {
                if (signal.aborted) {
                  reject(signal.reason);
                  return;
                }
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          ).withTimeout(10);
          return 1;
        } finally {
          finalized = true;
        }
      });

      const runPromise = program.run();
      await vi.advanceTimersByTimeAsync(10);
      const result = await runPromise;

      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(TimeoutError);
      expect(finalized).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("preserves original Err result when cleanup throws during iter.return()", async () => {
    const cleanupFault = new Error("cleanup failed");
    const failCleanup = () => {
      throw cleanupFault;
    };
    const program = Op(function* () {
      try {
        yield* Op.fail("boom");
        return "unreachable";
      } finally {
        failCleanup();
      }
    });

    const result = await program.run();

    assert(result.isErr(), "should be Err");
    expect(result.error).toBe("boom");
  });
});

describe("Op.defer error handling", () => {
  test("when op succeeds, cleanup throws: UnhandledException with cleanup error as cause", async () => {
    const cleanupError = new Error("cleanup failed");
    const cleanup = () => {
      throw cleanupError;
    };
    const safeOp = Op.of(69);
    const op = Op(function* () {
      yield* Op.defer(() => cleanup());
      const r = yield* safeOp;
      return r;
    });
    const r = await op.run();
    assert(r.isErr(), "should be Err");
    expect(r.error).toBeInstanceOf(UnhandledException);
    if (r.error instanceof UnhandledException) {
      expect(r.error.cause).toBe(cleanupError);
    }
  });

  test("when op fails, cleanup throws: UnhandledException with cleanup error as cause", async () => {
    const cleanupError = new Error("cleanup failed");
    const cleanup = () => {
      throw cleanupError;
    };
    const riskyOp = Op.fail("boom");
    const op = Op(function* () {
      yield* Op.defer(() => cleanup());
      yield* riskyOp;
    });
    const r = await op.run();
    assert(r.isErr(), "should be Err");
    assert(r.error instanceof UnhandledException, "should be UnhandledException");
    expect(r.error.cause).toBe(cleanupError);
  });

  test("when op fails, cleanup succeeds: failure is preserved", async () => {
    const cleanup = () => {
      return;
    };
    const riskyOp = Op.fail("boom");
    const op = Op(function* () {
      yield* Op.defer(() => cleanup());
      yield* riskyOp;
    });
    const r = await op.run();
    assert(r.isErr(), "should be Err");
    expect(r.error).toBe("boom");
  });

  test("when op succeeds, cleanup succeeds: value is preserved", async () => {
    const cleanup = () => {
      return;
    };
    const safeOp = Op.of(69);
    const op = Op(function* () {
      yield* Op.defer(() => cleanup());
      return yield* safeOp;
    });
    const r = await op.run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toBe(69);
  });
});

describe("Op.defer ordering and policies", () => {
  test("runs multiple defers in LIFO order on success", async () => {
    const events: string[] = [];
    const op = Op(function* () {
      yield* Op.defer(() => {
        events.push("first");
      });
      yield* Op.defer(() => {
        events.push("second");
      });
      return yield* Op.of(1);
    });
    const r = await op.run();
    assert(r.isOk(), "should be Ok");
    expect(events).toEqual(["second", "first"]);
  });

  test("runs earlier-registered finalizers after a later defer throws", async () => {
    const earlier = vi.fn();
    const stop = new Error("stop");
    const op = Op(function* () {
      yield* Op.defer(() => {
        earlier();
      });
      yield* Op.defer(() => {
        throw stop;
      });
      return yield* Op.of(1);
    });
    const r = await op.run();
    assert(r.isErr(), "should be Err");
    expect(earlier).toHaveBeenCalledTimes(1);
    expect(r.error).toBeInstanceOf(UnhandledException);
    if (r.error instanceof UnhandledException) {
      expect(r.error.cause).toBe(stop);
    }
  });

  test("chains multiple cleanup throws via nested Error.cause", async () => {
    const boomFourth = new Error("boom from defer fourth");
    const boomSecond = new Error("boom from defer second");
    const events: string[] = [];
    const op = Op(function* () {
      yield* Op.defer(() => {
        events.push("first");
      });
      yield* Op.defer(() => {
        events.push("second");
        throw boomSecond;
      });
      yield* Op.defer(() => {
        events.push("third");
      });
      yield* Op.defer(() => {
        events.push("fourth");
        throw boomFourth;
      });
      return yield* Op.of(1);
    });
    const r = await op.run();
    assert(r.isErr(), "should be Err");
    expect(events).toEqual(["fourth", "third", "second", "first"]);
    assert(r.error instanceof UnhandledException);
    const ue = r.error;
    assert(ue.cause instanceof Error);
    expect(ue.cause.message).toBe(boomFourth.message);
    expect(ue.cause.name).toBe(boomFourth.name);
    expect(ue.cause.cause).toBe(boomSecond);
  });

  test("chains three throws among five defers (only throwing cleanups in cause chain)", async () => {
    const boomFifth = new Error("boom from defer fifth");
    const boomFourth = new Error("boom from defer fourth");
    const boomSecond = new Error("boom from defer second");
    const events: string[] = [];
    const op = Op(function* () {
      yield* Op.defer(() => {
        events.push("first");
      });
      yield* Op.defer(() => {
        events.push("second");
        throw boomSecond;
      });
      yield* Op.defer(() => {
        events.push("third");
      });
      yield* Op.defer(() => {
        events.push("fourth");
        throw boomFourth;
      });
      yield* Op.defer(() => {
        events.push("fifth");
        throw boomFifth;
      });
      return yield* Op.of(1);
    });
    const r = await op.run();
    assert(r.isErr(), "should be Err");
    expect(events).toEqual(["fifth", "fourth", "third", "second", "first"]);
    assert(r.error instanceof UnhandledException);
    const head = r.error.cause;
    assert(head instanceof Error);
    expect(head.message).toBe(boomFifth.message);
    const mid = head.cause;
    assert(mid instanceof Error);
    expect(mid.message).toBe(boomFourth.message);
    expect(mid.cause).toBe(boomSecond);
  });

  test("shares LIFO stack with withRelease (release runs before defer registered earlier)", async () => {
    const events: string[] = [];
    const op = Op(function* () {
      yield* Op.defer(() => {
        events.push("defer");
      });
      yield* Op.of(2).withRelease(() => {
        events.push("release");
      });
      return 3;
    });
    const r = await op.run();
    assert(r.isOk(), "should be Ok");
    expect(events).toEqual(["release", "defer"]);
  });

  test("runs Op.defer cleanup when withTimeout aborts inner work", async () => {
    vi.useFakeTimers();
    try {
      const cleanup = vi.fn();
      const op = Op(function* () {
        yield* Op.defer(() => cleanup());
        return yield* Op.try(
          (signal) =>
            new Promise<number>((_resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        ).withTimeout(10);
      });

      const runPromise = op.run();
      await vi.advanceTimersByTimeAsync(10);
      const result = await runPromise;
      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(TimeoutError);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("runs Op.defer cleanup when withSignal aborts inner work", async () => {
    vi.useFakeTimers();
    try {
      const cleanup = vi.fn();
      const controller = new AbortController();
      const op = Op(function* () {
        yield* Op.defer(() => cleanup());
        return yield* Op.try(
          (signal) =>
            new Promise<number>((_resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        ).withSignal(controller.signal);
      });

      const runPromise = op.run();
      controller.abort("cancelled");
      await vi.advanceTimersByTimeAsync(0);
      const result = await runPromise;
      assert(result.isErr(), "should be Err");
      expect(result.error).toBeInstanceOf(UnhandledException);
      if (result.error instanceof UnhandledException) {
        expect(result.error.cause).toBe("cancelled");
      }
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
