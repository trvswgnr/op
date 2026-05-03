import { assert, describe, expect, test, vi } from "vitest";
import { ErrorGroup, Op, TaggedError, UnhandledException } from "./index.js";
import {
  deferred,
  invalidConcurrencies,
  rejectAfter,
  resolveAfter,
  trackAbortListeners,
} from "./test-utils.js";

// Scope: integration behavior for Op combinators and combinator-policy interplay.
describe("Op.all", () => {
  test("tuple of successes in input order", async () => {
    const r = await Op.all([Op.of(1), Op.of("two"), Op.of(true)]).run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toEqual([1, "two", true]);
  });

  test("empty input succeeds with []", async () => {
    const r = await Op.all([]).run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toEqual([]);
  });

  test.each(invalidConcurrencies)(
    "invalid concurrency %s returns UnhandledException",
    async (concurrency) => {
      const r = await Op.all([Op.of(1)], concurrency).run();
      assert(r.isErr(), "should be Err");
      expect(r.error).toBeInstanceOf(UnhandledException);
      if (r.error instanceof UnhandledException) {
        expect(r.error.cause).toEqual(new RangeError("concurrency must be a positive integer"));
      }
    },
  );

  test("fails fast on first Err and aborts siblings", async () => {
    let siblingAborted = false;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          const t = setTimeout(() => resolve(1), 50);
          signal.addEventListener("abort", () => {
            siblingAborted = true;
            clearTimeout(t);
            resolve(-1);
          });
        }),
    );
    const fast = Op.fail("boom" as const);

    const r = await Op.all([slow, fast]).run();
    assert(r.isErr(), "should be Err");
    expect(r.error).toBe("boom");
    expect(siblingAborted).toBe(true);
  });

  test("union error type across children", async () => {
    class AErr extends TaggedError("AErr")() {}
    class BErr extends TaggedError("BErr")() {}
    const n: number = 1;
    const s: string = "x";
    const a = Op(function* () {
      if (Math.random() > 2) return yield* new AErr();
      return n;
    });
    const b = Op(function* () {
      if (Math.random() > 2) return yield* new BErr();
      return s;
    });
    const combined = Op.all([a, b]);
    const r = await combined.run();
    if (r.isErr()) {
      expect(r.error).toBeInstanceOf(AErr);
    }
  });

  test("awaits every child before returning after a failure", async () => {
    let slowObservedAbort = false;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          signal.addEventListener("abort", () => {
            slowObservedAbort = true;
            setTimeout(() => resolve(-1), 5);
          });
        }),
    );
    const fast = Op.fail("boom" as const);

    await Op.all([slow, fast]).run();
    expect(slowObservedAbort).toBe(true);
  });

  test("limits active children while preserving input order", async () => {
    const firstGate = deferred<number>();
    const secondGate = deferred<number>();
    const thirdGate = deferred<number>();
    const fourthGate = deferred<number>();
    const gates = [firstGate, secondGate, thirdGate, fourthGate];
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;

    const ops = gates.map((gate, i) =>
      Op.try(async () => {
        started.push(i);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          return await gate.promise;
        } finally {
          active -= 1;
        }
      }),
    );

    const run = Op.all(ops, 2).run();
    await Promise.resolve();

    expect(started).toEqual([0, 1]);
    expect(maxActive).toBe(2);

    secondGate.resolve(1);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    expect(active).toBe(2);

    firstGate.resolve(0);
    thirdGate.resolve(2);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));

    fourthGate.resolve(3);
    const r = await run;

    assert(r.isOk(), "should be Ok");
    expect(r.value).toEqual([0, 1, 2, 3]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test("does not start queued children after bounded failure", async () => {
    let slowObservedAbort = false;
    let queuedStarted = false;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          signal.addEventListener("abort", () => {
            slowObservedAbort = true;
            resolve(-1);
          });
        }),
    );
    const fast = Op.fail("boom" as const);
    const queued = Op.try(() => {
      queuedStarted = true;
      return 3;
    });

    const r = await Op.all([slow, fast, queued], 2).run();

    assert(r.isErr(), "should be Err");
    expect(r.error).toBe("boom");
    expect(slowObservedAbort).toBe(true);
    expect(queuedStarted).toBe(false);
  });
});

describe("Op.allSettled", () => {
  test("returns tuple of Result in input order", async () => {
    const r = await Op.allSettled([Op.of(1), Op.fail("no" as const), Op.of("ok")]).run();
    assert(r.isOk(), "should be Ok");
    const [a, b, c] = r.value;
    assert(a.isOk() && b.isErr() && c.isOk(), "branches");
    expect(a.value).toBe(1);
    expect(b.error).toBe("no");
    expect(c.value).toBe("ok");
  });

  test("empty input succeeds with []", async () => {
    const r = await Op.allSettled([]).run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toEqual([]);
  });

  test.each(invalidConcurrencies)(
    "invalid concurrency %s returns UnhandledException",
    async (concurrency) => {
      const r = await Op.allSettled([Op.of(1)], concurrency).run();
      assert(r.isErr(), "should be Err");
      expect(r.error).toBeInstanceOf(UnhandledException);
      if (r.error instanceof UnhandledException) {
        expect(r.error.cause).toEqual(new RangeError("concurrency must be a positive integer"));
      }
    },
  );

  test("never fails", async () => {
    const combined = Op.allSettled([Op.fail(1), Op.fail("two" as const)]);
    const r = await combined.run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toHaveLength(2);
  });

  test("does not abort siblings on failure", async () => {
    let siblingAborted = false;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          const t = setTimeout(() => resolve(1), 10);
          signal.addEventListener("abort", () => {
            siblingAborted = true;
            clearTimeout(t);
            resolve(-1);
          });
        }),
    );
    const r = await Op.allSettled([slow, Op.fail("boom")]).run();
    assert(r.isOk(), "should be Ok");
    expect(siblingAborted).toBe(false);
    const [first] = r.value;
    assert(first.isOk(), "slow sibling completed normally");
    expect(first.value).toBe(1);
  });

  test("limits active children and keeps draining after failures", async () => {
    const started: number[] = [];
    const first = Op(function* () {
      started.push(0);
      return yield* Op.fail("boom" as const);
    });
    const second = Op(function* () {
      started.push(1);
      return yield* Op.of("ok" as const);
    });

    const r = await Op.allSettled([first, second], 1).run();

    assert(r.isOk(), "should be Ok");
    expect(started).toEqual([0, 1]);
    const [a, b] = r.value;
    assert(a.isErr() && b.isOk(), "branches");
    expect(a.error).toBe("boom");
    expect(b.value).toBe("ok");
  });
});

describe("Op.settle", () => {
  test("wraps success in a settled Result", async () => {
    const r = await Op.settle(Op.of(69)).run();
    assert(r.isOk(), "should be Ok");
    const settled = r.value;
    assert(settled.isOk(), "inner op succeeded");
    expect(settled.value).toBe(69);
  });

  test("wraps failure in a settled Result", async () => {
    const r = await Op.settle(Op.fail("nope" as const)).run();
    assert(r.isOk(), "should be Ok");
    const settled = r.value;
    assert(settled.isErr(), "inner op failed");
    expect(settled.error).toBe("nope");
  });

  test("preserves child result typing", async () => {
    const combined = Op.settle(Op.fail(1));
    const r = await combined.run();
    assert(r.isOk(), "should be Ok");
    expect(r.value.isErr()).toBe(true);
  });
});

describe("Op.any", () => {
  test("returns first success and aborts siblings", async () => {
    let slowAborted = false;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          const t = setTimeout(() => resolve(99), 50);
          signal.addEventListener("abort", () => {
            slowAborted = true;
            clearTimeout(t);
            resolve(-1);
          });
        }),
    );
    const r = await Op.any([slow, Op.of(69)]).run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toBe(69);
    expect(slowAborted).toBe(true);
  });

  test("all-fail surfaces ErrorGroup with errors in input order", async () => {
    const r = await Op.any([
      Op.fail("a" as const),
      Op.fail("b" as const),
      Op.fail("c" as const),
    ]).run();
    assert(r.isErr(), "should be Err");
    assert(r.error instanceof ErrorGroup, "ErrorGroup");
    expect(r.error.errors).toEqual(["a", "b", "c"]);
  });

  test("empty input fails with empty ErrorGroup", async () => {
    const r = await Op.any([]).run();
    assert(r.isErr(), "should be Err");
    assert(r.error instanceof ErrorGroup, "ErrorGroup");
    expect(r.error.errors).toEqual([]);
  });

  test("error type is ErrorGroup<union of child errors>", async () => {
    const combined = Op.any([Op.fail(1), Op.fail("two" as const)]);
    const r = await combined.run();
    if (r.isErr() && r.error instanceof ErrorGroup) {
      expect(r.error.errors).toEqual([1, "two"]);
    }
  });

  test("preserves index order when failures settle out of order", async () => {
    const toTag =
      <T extends string>(tag: T) =>
      (_: unknown): T =>
        tag;
    const r = await Op.any([
      Op.try(() => rejectAfter("slow", 10), toTag("slow")),
      Op.try(() => rejectAfter("fast", 0), toTag("fast")),
    ]).run();
    assert(r.isErr(), "should be Err");
    assert(ErrorGroup.is(r.error), "ErrorGroup");
    expect(r.error.errors).toEqual(["slow", "fast"]);
  });
});

describe("Op.race", () => {
  test("first settler wins (Ok)", async () => {
    let loserAborted = false;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          const t = setTimeout(() => resolve(-1), 50);
          signal.addEventListener("abort", () => {
            loserAborted = true;
            clearTimeout(t);
            resolve(-1);
          });
        }),
    );
    const fast = Op.try(() => resolveAfter(7, 0));
    const r = await Op.race([slow, fast]).run();
    assert(r.isOk(), "should be Ok");
    expect(r.value).toBe(7);
    expect(loserAborted).toBe(true);
  });

  test("first settler wins (Err)", async () => {
    const slow = Op.try(() => resolveAfter(1, 20));
    const fast = Op.fail("quick" as const);
    const r = await Op.race([slow, fast]).run();
    assert(r.isErr(), "should be Err");
    expect(r.error).toBe("quick");
  });

  test("losers are aborted with no library-specific reason", async () => {
    let observedReason: unknown;
    const slow = Op.try(
      (signal) =>
        new Promise<number>((resolve) => {
          signal.addEventListener("abort", () => {
            observedReason = signal.reason;
            resolve(-1);
          });
        }),
    );
    const fast = Op.of(1);
    await Op.race([slow, fast]).run();
    assert(observedReason instanceof DOMException, "should be a DOMException");
    expect(observedReason.name).toBe("AbortError");
  });

  test("union type across children", async () => {
    const combined = Op.race([Op.of(1), Op.fail("two" as const)]);
    const r = await combined.run();
    expect(r.isOk() || r.isErr()).toBe(true);
  });
});

describe("combinator abort listener cleanup", () => {
  test("pre-aborted outer signal does not leave abort listeners behind", async () => {
    const outer = new AbortController();
    outer.abort(new Error("already aborted"));
    const tracked = trackAbortListeners(outer.signal);
    try {
      await Op.all([Op.of(1), Op.of(2)])
        .withSignal(outer.signal)
        .run();
      expect(tracked.activeAbortListeners).toBe(0);
    } finally {
      tracked.restore();
    }
  });

  test("unbounded all detaches abort listener after children settle", async () => {
    const outer = new AbortController();
    const tracked = trackAbortListeners(outer.signal);
    try {
      const r = await Op.all([Op.of(1), Op.of(2)])
        .withSignal(outer.signal)
        .run();
      assert(r.isOk(), "should be Ok");
      expect(r.value).toEqual([1, 2]);
      expect(tracked.activeAbortListeners).toBe(0);

      outer.abort(new Error("too late"));
      expect(tracked.activeAbortListeners).toBe(0);
    } finally {
      tracked.restore();
    }
  });

  test("bounded all detaches abort listener after children settle", async () => {
    const outer = new AbortController();
    const tracked = trackAbortListeners(outer.signal);
    try {
      const r = await Op.all([Op.of(1), Op.of(2)], 1)
        .withSignal(outer.signal)
        .run();
      assert(r.isOk(), "should be Ok");
      expect(r.value).toEqual([1, 2]);
      expect(tracked.activeAbortListeners).toBe(0);

      outer.abort(new Error("too late"));
      expect(tracked.activeAbortListeners).toBe(0);
    } finally {
      tracked.restore();
    }
  });

  test("bounded all cleans up outer abort listeners when aborted mid-flight after partial completion", async () => {
    const outer = new AbortController();
    const tracked = trackAbortListeners(outer.signal);
    const secondGate = deferred<number>();
    try {
      const run = Op.all(
        [
          Op.of(1),
          Op.try(
            (signal) =>
              new Promise<number>((resolve, reject) => {
                if (signal.aborted) {
                  reject(signal.reason);
                  return;
                }
                signal.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                });
                secondGate.promise.then(resolve);
              }),
          ),
        ],
        1,
      )
        .withSignal(outer.signal)
        .run();

      await Promise.resolve();
      outer.abort(new Error("cancel"));

      const r = await run;
      assert(r.isErr(), "should be Err");
      expect(tracked.activeAbortListeners).toBe(0);
    } finally {
      tracked.restore();
      secondGate.resolve(2);
    }
  });

  test("any cleans up outer abort listeners when aborted mid-flight after partial completion", async () => {
    const outer = new AbortController();
    const tracked = trackAbortListeners(outer.signal);
    try {
      const run = Op.any([
        Op.fail("fast-fail" as const),
        Op.try(
          (signal) =>
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
        ),
      ])
        .withSignal(outer.signal)
        .run();

      await Promise.resolve();
      outer.abort(new Error("cancel"));

      const r = await run;
      assert(r.isErr(), "should be Err");
      assert(r.error instanceof ErrorGroup, "ErrorGroup");
      expect(r.error.errors.length).toBeGreaterThan(0);
      expect(tracked.activeAbortListeners).toBe(0);
    } finally {
      tracked.restore();
    }
  });
});
