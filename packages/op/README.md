# @prodkit/op

A runtime-agnostic, composable, and predictable library for writing operations in TypeScript, built on top of [`better-result`](https://github.com/dmmulroy/better-result).

This README documents the `@prodkit/op` package API and usage.
For monorepo/workspace orientation, see the repo root [`README.md`](https://github.com/trvswgnr/prodkit/blob/main/README.md).
For tradeoffs against Effect, neverthrow, `fp-ts`, native `Promise`, and `ResultAsync`, see
[`COMPARISON.md`](https://github.com/trvswgnr/prodkit/blob/main/packages/op/COMPARISON.md).

> [!WARNING]
> This library is currently in alpha. The API will almost certainly change between releases while it stabilizes.

Write code that stays readable as it grows and keep predictable
behavior in production. Compose steps top-to-bottom, apply retry, timeout, and cancellation as
policy, and run parallel work without scattering reliability logic across your app.

## Why this exists

Async TypeScript has two huge flaws: you can't see from a function's type what it might fail with, and the standard concurrency helpers happily let sibling tasks keep running after one of them blows up. `@prodkit/op` fixes both. It builds on `better-result`'s `Result` model, generator composition, and typed error inference, then adds an async runtime with suspend/resume semantics, structured resource cleanup, cancellation-aware concurrency, and composable retry/timeout policies on top. Concurrency combinators thread cancellation through every child, so when one fails the rest actually stop instead of burning quota in the background. Retry, timeout, and external cancellation are one chained method each. Minimal runtime dependencies, a small footprint, and an API that's easy to learn and use.

## Installation

```bash
npm i @prodkit/op
```

Runtime support for consumers: any JavaScript runtime with `Promise` and `AbortController`.
For Node consumers specifically, this package is tested on Node `24.14.0`. CI also runs
packed-package smoke checks on Bun `1.3.13`, Deno `2.7.14`, and a Cloudflare Workers-like
Miniflare environment.

This project is designed to be runtime-agnostic: no Node-specific APIs are required by the public
operation model.

CI publishes a Vitest coverage artifact for this package. The test suite includes unit,
integration, type-level, and property-based law checks, plus separate packed-package smoke checks
for Node, Bun, Deno, and a Cloudflare Workers-like runtime.

`@prodkit/op` pairs naturally with `better-result` and declares it as a peer dependency.

<sub>If your package manager does not auto-install peers, install it explicitly:
`npm i better-result`.
Import `Result`/`TaggedError`/`UnhandledException` directly from `better-result`.</sub>

## Quick start

```ts
import { Op } from "@prodkit/op";
import { TaggedError } from "better-result";

class DivisionByZeroError extends TaggedError("DivisionByZeroError")() {}

const divide = Op(function* (a: number, b: number) {
  if (b === 0) return yield* new DivisionByZeroError();
  return a / b;
});

const sqrt = Op(function* (n: number) {
  // any value can be passed to Op.fail, but it should be discriminative
  if (n < 0) return yield* Op.fail("Negative");
  return Math.sqrt(n);
});

const program = Op(function* () {
  const quotient = yield* divide(10, 2);
  const rooted = yield* sqrt(quotient);
  return rooted * 2;
});

const result = await program.run();
//    ^? Result<number, DivisionByZeroError | "Negative" | UnhandledException>
if (result.isOk()) {
  console.log(result.value);
} else {
  console.error(result.error);
}
```

## Core API

### `Op(fn)`

Turns a generator into a composable operation.
Inside the generator, `yield*` another op to unwrap success or short-circuit on failure.
Parameterized ops must be invoked before composition: use `yield* loadUser(id)`, not
`yield* loadUser`.

### `Op.of(value)`

Creates an op that succeeds with `value`.
If `value` is a promise, it is awaited and converted into the same `Result` model.

### `Op.fail(error)`

Creates an op that always fails with `error`.

### `Op.defer(finalize)`

Registers cleanup for the **current** op run inside a generator. **`finalize(ctx)`** receives **`ExitContext`**:
the run `AbortSignal`, runtime **`args`**, plus **`result`**: the operation's pre-finalizer settlement result (from `better-result`, so use `.isOk()` / `.isErr()` as usual).

Deferred callbacks share one stack
with `.withRelease` / `.on("exit", ...)`: they run in **LIFO** order when the run unwinds (success, typed
failure, `UnhandledException`, timeout, or external cancellation). **All** scheduled finalizers run;
even if one throws, the **remaining** callbacks in the stack **still run**. If a single finalizer throws, `.run()` returns
`Err(UnhandledException)` with `cause` set to that fault. If **multiple** finalizers throw, `cause`
is a nested **`Error` chain**: the outer error matches the **first** failure during teardown
(last-registered callback runs first, so it fails first; read the chain outer-to-inner that way); each
`.cause` is the next fault in unwind order. Only **throwing** callbacks appear in the chain: cleanups that finish
without throwing add no links. `finalize` can
be sync or async.

Use `Op.defer`/`.withRelease`/`.on("exit", ...)` for effectful cleanup. Native generator
`finally` blocks are only best-effort synchronous finalization; yielded or async work inside
`finally` is not driven during early exit.

`.withRelease` still invokes only `release(successValue)` (no context parameter); its stack slot is invoked with the
same **`ExitContext`** as other finalizers for this run, but the release function ignores it.

Use this for step-local teardown that reads better than chaining `.withRelease` on every producer,
or for "always run" cleanup before a risky step.

```ts
const runQuery = Op(function* () {
  const conn = yield* acquireConnection;
  yield* Op.defer(() => conn.release());

  return yield* getActiveUsers(conn);
});
```

```ts
const risky = Op(function* () {
  yield* Op.defer(() => invalidateTempFiles());
  return yield* commitTransaction();
});
```

`Op.defer` is only meaningful inside an `Op(function* () { ... })` body (compose with `yield*`).
For releasing the **success value** of a single op, `.withRelease` on that op is often clearer.
For lifecycle hooks at op boundaries, `.on("enter", fn)` runs setup when a wrapper starts and
`.on("exit", fn)` runs teardown when the run unwinds.

### `Op.sleep(ms)`

Creates an op that waits for `ms` milliseconds and then succeeds with `void`.
Negative durations are normalized to `0`. Non-finite durations fail at run time with
`UnhandledException`.

`Op.sleep` observes surrounding cancellation policy. If a run is cancelled by `.withSignal(...)`,
`.withTimeout(...)`, or a combinator abort while sleeping, the sleep stops early and the run surfaces
the cancellation through the normal `UnhandledException` channel.

```ts
const poll = Op(function* () {
  while (true) {
    const job = yield* loadJob;
    if (job.ready) return job;
    yield* Op.sleep(250);
  }
});
```

### `Op.try(f, onError?)`

Runs an async or sync function and converts failures into `Err`.
If `onError` is omitted, failures become `UnhandledException`.
`onError` returns the error value `Op.try` should emit (or a `Promise` of that value). If it
returns an `Op`/generator object, `Op.try` treats that object as the error value and does not run
it.

`f` receives an `AbortSignal` tied to surrounding cancellation policy (`withTimeout`, `withSignal`,
and combinator cancellation). Forward it to cancellable APIs so in-flight work (e.g. `fetch`, DB queries) actually stops instead of
leaking after a timeout.

```ts
const fetchUser = Op.try((signal) => fetch("/api/users/1", { signal }));
const result = await fetchUser.withTimeout(1000).run();
// when the 1s budget elapses, the fetch is aborted.
```

```ts
const mapped = await Op.try(
  () => Promise.reject("boom"),
  (cause) => `mapped: ${String(cause)}`,
).run();
// Result<never, "mapped: boom" | UnhandledException>
```

### `Op.run(op, ...args)`

Static runner for ops. This is equivalent to `op.run(...args)`, and is useful when you want to
execute an op value passed around as data.
`Op.run(op, ...args)` does not expose a cancel handle; if the caller needs external cancellation, compose
the op with `.withSignal(signal)` before running it.

```ts
const result = await Op.run(Op.of(7));

const add = Op(function* (a: number, b: number) {
  return a + b;
});
const sum = await Op.run(add, 2, 5);
```

### `Op.empty`

Reusable no-op that succeeds with `void`.

```ts
const result = await Op.empty.run();
```

### `.run(...args)`

Executes the operation and returns `Result<T, E | UnhandledException>` from `better-result`.

```ts
const result = await op.run(...args);
if (result.isOk()) {
  console.log(result.value);
} else {
  console.error(result.error);
}
```

### `.map(f)`

Transforms an op's success value while preserving the same error channel and argument list.
Use this when you want a one-step value transformation without writing a generator.

```ts
const userId = Op.of({ id: 69, name: "Marissa" }).map((user) => user.id);
const result = await userId.run(); // Result<number, UnhandledException>
```

### `.flatMap(f)`

Chains to the next op using the previous success value. This is the monadic bind operation:
the next op only runs after the first one succeeds, and both error channels are preserved.

```ts
const getUserTodos = getUser(69).flatMap((user) => getTodos(user.id));
const result = await getUserTodos.run();
```

### `.tap(f)`

Observes a successful value without changing it. This is useful for logging, metrics, tracing,
or debugging in the middle of a pipeline without restructuring into a generator.

If `f` returns a plain value, that value is ignored and the original success value passes through.
If `f` returns a nullary `Op`, that op is sequenced and its result is discarded. If `f` throws, or
if the returned op fails, that failure propagates.

```ts
const withLog = Op.try(() => fetch("https://example.com/user/69"))
  .tap((response) => {
    console.log("status", response.status);
  })
  .map((response) => response.status);
```

### `.tapErr(f)`

Observes typed failures without changing which error is returned. This is useful for error metrics,
structured logging, and alert hooks while preserving existing control flow.

If `f` returns a plain value, that value is ignored and the original typed error passes through.
If `f` returns a nullary `Op`, that op is sequenced and its result is discarded. If `f` throws, or
if the returned op fails, that failure propagates. `UnhandledException` bypasses `tapErr`.

```ts
const withErrorMetric = Op.try(
  () => fetch("https://example.com/user/69"),
  (cause) => new FetchError({ cause }),
).tapErr((error) => {
  console.error("user lookup failed", error.message);
});
```

### `.mapErr(f)`

Transforms an op's typed error channel while preserving the success value and argument list.
Use this when you want to normalize or enrich domain failures without restructuring into a
generator.

`UnhandledException` is part of the runtime channel and bypasses `mapErr`; only tracked typed
errors are passed to `f`.

```ts
const normalizeFetchError = Op.try(
  () => fetch("https://example.com/user/69"),
  (cause) => new FetchError({ cause }),
).mapErr((e) => (FetchError.is(e) ? new UserLookupError({ cause: e }) : e));
```

### `.recover(predicate, handler)`

Recovers from selected typed failures while preserving the rest of the error channel.
For `TaggedError` classes, pass the error class directly for concise typed recovery.
For other error types, use a predicate (including a type guard) to select what to handle.
`handler` can return either a fallback value or another nullary `Op`.

`UnhandledException` is intentionally not recoverable through this method; unexpected throws
still surface so bugs are not silently converted into success paths.

```ts
class NotFoundError extends TaggedError("NotFoundError")() {}
class PermissionError extends TaggedError("PermissionError")() {}

const lookup = Op(function* (id: string) {
  if (id === "missing") return yield* new NotFoundError();
  if (id === "forbidden") return yield* new PermissionError();
  return { id };
}).recover(NotFoundError, () => ({ id: "fallback" }));

// lookup: Op<{ id: string }, PermissionError, [string]>
```

### `.withRetry(policy?)`

Wraps an operation with retries.
Useful for transient IO failures while preserving typed control flow.

```ts
const policy = {
  maxAttempts: 3,
  shouldRetry: (cause: unknown) => cause instanceof Error,
  getDelay: (attempt: number) => attempt * 100,
};

const fetchWithRetry = Op.try(() => fetch("https://example.com")).withRetry(policy);
```

### `.withTimeout(timeoutMs)`

Wraps an operation with a timeout and fails with `TimeoutError` when the wrapped operation does not
finish before `timeoutMs`.

Composition order determines semantics:

```ts
// timeout applies to the ENTIRE retried run
const totalBudget = Op.try(() => fetch("https://example.com"))
  .withRetry(policy)
  .withTimeout(5000);

// timeout applies to EACH attempt
const perAttempt = Op.try(() => fetch("https://example.com"))
  .withTimeout(5000)
  .withRetry(policy);
```

### `.withSignal(signal)`

Binds an operation to an external `AbortSignal` so you can cancel in-flight work (for example when
an HTTP request is aborted or a job is shut down).

```ts
const controller = new AbortController();
const fetchUser = Op.try((signal) => fetch("/api/users/1", { signal })).withSignal(
  controller.signal,
);

const runPromise = fetchUser.run();
controller.abort(new Error("request cancelled"));
const result = await runPromise;
```

### Cooperative cancellation contract

Cancellation is cooperative, not preemptive. `@prodkit/op` guarantees that it raises abort
signals at the right points, but your operation code must observe those signals for work to
stop quickly.

Runtime guarantees:

- `.withTimeout(...)`, `.withSignal(...)`, and short-circuiting combinators (`Op.all`, `Op.any`,
  `Op.race`) propagate abort through `AbortSignal`.
- `Op.sleep(ms)` observes abort signals and stops waiting early when its enclosing run is cancelled.
- When a combinator decides its final result early, in-flight siblings are aborted and the
  combinator waits for them to settle before returning.
- Scheduled teardown still runs (`Op.defer`, `.withRelease`, `.on("exit", ...)`) even when a run
  ends via timeout or external abort.

Caller responsibilities:

- Build side-effecting work with `Op.try((signal) => ...)` and pass `signal` to cancellable APIs
  (`fetch`, DB clients, queue clients, etc.).
- Keep composed child ops signal-aware so branch-level cancellation in combinators can stop
  downstream IO.
- Treat cancellation as a stop request: if an underlying dependency ignores `AbortSignal`, that
  dependency can continue running after the op settles.

Recommended composed-run wiring:

```ts
const controller = new AbortController();

const fetchJson = (url: string) =>
  Op.try(async (signal) => {
    const res = await fetch(url, { signal });
    return res.json();
  });

const loadDashboard = Op.all([
  fetchJson("/api/users/1"),
  fetchJson("/api/alerts"),
  fetchJson("/api/settings"),
])
  .withTimeout(1_500)
  .withSignal(controller.signal);

const runPromise = loadDashboard.run();

// for example: HTTP disconnect, worker shutdown, or route transition
controller.abort(new Error("caller aborted dashboard load"));

const result = await runPromise;
```

### `.withRelease(release)`

Registers resource release logic that runs after a successful resource-producing step settles.

```ts
const runQuery = Op(function* () {
  const conn = yield* acquireDbConnection.withRelease((conn) => conn.release());
  return yield* getActiveUsers(conn);
});

const result = await runQuery.withTimeout(1000).run();
// conn.release() runs even if the run times out or is externally aborted.
```

`release` can be sync or async. `withRelease` only schedules `release` after the wrapped op
**succeeds**, so a failing inner op does not call `release`. If `release` throws, the run fails
with `UnhandledException` and `cause` set to that fault (other registered finalizers **still run**
afterward in LIFO order; multiple faults become a **nested `Error.cause` chain**, same as `Op.defer`).

### `.on("exit", finalize)`

Registers unconditional finalization when the enclosing run settles (success or failure), on the same LIFO stack as `Op.defer` and `.withRelease`. **`finalize(ctx)`** receives **`ExitContext`** with run `args` and the pre-finalizer **`ctx.result`**. If `finalize` throws, `.run()` fails with `UnhandledException` and `cause` set to that fault (or a nested **`error.cause` chain** if several finalizers fault).

```ts
const result = await doWork.on("exit", (ctx) => telemetry.record(ctx)).run();
```

### `.on("enter", initialize)`

Registers run-start initialization before the wrapped op body is driven. `initialize(ctx)`
receives `EnterContext` with the run `signal` and runtime `args`.

```ts
const result = await doWork
  .on("enter", ({ signal, args }) =>
    telemetry.startSpan({ aborted: signal.aborted, key: String(args[0]) }),
  )
  .on("exit", (ctx) => telemetry.finishSpan({ args: ctx.args, result: ctx.result }))
  .run();
```

Ordering/composition rules:

- Enter handlers run in wrapper order (last chained runs first).
- Exit handlers keep the current unwind ordering.
- Enter handlers run once per wrapper run; retry attempts happen inside that wrapper regardless
  of whether `.withRetry(...)` is chained before or after `.on("enter", fn)`.

## Typed errors

Use `TaggedError("Name")` for discriminated domain errors that still behave like real `Error` objects.
You can fail with one directly with `yield* new MyError()` inside an op.

```ts
import { Op } from "@prodkit/op";
import { TaggedError } from "better-result";

class ValidationError extends TaggedError("ValidationError")<{
  field: string;
}>() {}

const validate = Op(function* (name: string) {
  if (name.trim().length === 0) {
    yield* new ValidationError({ field: "name", message: "Name is required" });
  }
  return name;
});
```

## Retry defaults

`withRetry()` with no policy uses:

- `maxAttempts: 3`
- `shouldRetry: () => true`
- exponential backoff from `1000ms` up to `30000ms` with full jitter (`1.0`)

You can also build your own delay function with `exponentialBackoff({ base, max, jitter })`.
`exponentialBackoff.DEFAULT` is the pre-built delay function used by the default retry policy.

```ts
import { exponentialBackoff } from "@prodkit/op";

const policy = {
  maxAttempts: 5,
  shouldRetry: (cause: unknown) => cause instanceof Error,
  getDelay: exponentialBackoff({ base: 200, max: 2_000, jitter: 0.5 }),
};
```

## Built-in errors

- `UnhandledException`: default wrapper when a thrown/rejected value is not mapped to a domain error.
- `TimeoutError`: produced by `.withTimeout(timeoutMs)` when the budget expires.
- `ErrorGroup`: produced by `Op.any` when all children fail.
- **Teardown chains:** if several of `Op.defer`, `.withRelease`, or `.on("exit", ...)` callbacks throw in one run, `UnhandledException.cause` may be an `Error` whose `.cause` links onward (**first failure in LIFO execution order is the outermost message**).

## Concurrent combinators

Run multiple ops concurrently and compose them back into one `Op`.
When a result is decided early (`all` after a failure, `any` after a success, `race` on first
settle), remaining work is cancelled through `AbortSignal`.

### `Op.all(ops, concurrency?)`

Runs ops concurrently and succeeds with a tuple of their success values. Fails fast on the first
failure; in-flight siblings receive an abort and the combinator waits for them to settle before
returning. Empty input succeeds with `[]`.

Pass a positive integer `concurrency` to cap how many children run at once. Without it, every child
starts immediately. With a cap, `Op.all` stops launching queued children after the first failure.

```ts
const r = await Op.all([Op.of(1), Op.of("two"), Op.of(true)]).run();
if (r.isOk()) {
  const [n, s, b] = r.value; // [number, string, boolean]
}

const bounded = await Op.all(fetchOps, 5).run(); // at most 5 active children
```

### `Op.allSettled(ops, concurrency?)`

Waits for every op and returns a tuple of their `Result`s in input order. For valid inputs it does
not fail and does not short-circuit siblings on child failure.

Pass a positive integer `concurrency` to cap how many children run at once. Unlike `Op.all`,
`Op.allSettled` keeps launching queued children after failures so every input gets a `Result`.
If `concurrency` is not a positive integer, the run fails with `UnhandledException`.

```ts
const r = await Op.allSettled([Op.of(1), Op.fail("nope")]).run();
if (r.isOk()) {
  const [a, b] = r.value; // Result<number, ...>, Result<never, "nope" | ...>
}
```

### `Op.settle(op)`

Runs one op and returns its settled `Result` as a success value. This never fails, which makes it
useful for optional/best-effort reads where fallback logic should continue in the same generator.

```ts
const loadPolicy = Op(function* () {
  const settled = yield* Op.settle(loadPolicyVersion);
  return settled.isOk() ? settled.value : "unknown";
});
```

### `Op.any(ops)`

Succeeds with the first op to succeed; remaining siblings are aborted. If every op fails,
the combinator fails with `ErrorGroup` whose `errors` array holds each child failure
in input index order. Empty input fails with an empty `ErrorGroup` and the message
`"Op.any requires at least one operation"`.

```ts
import { ErrorGroup } from "@prodkit/op";

const r = await Op.any([Op.fail("a"), Op.of(69)]).run();
if (r.isOk()) console.log(r.value); // 69
if (r.isErr() && r.error instanceof ErrorGroup) console.log(r.error.errors);
```

### `Op.race(ops)`

Propagates whichever op settles first: success or failure. Remaining siblings are
aborted with no library-specific reason. `Op.race([])` fails fast with
`UnhandledException`.

```ts
const r = await Op.race([slow, fast]).run();
```

## Webhook consumer example

See the repository example at
[`examples/op/webhook.ts`](https://github.com/trvswgnr/prodkit/blob/main/examples/op/webhook.ts)
for a complete order webhook pipeline
that demonstrates:

- input validation with typed domain errors
- idempotency checks
- risk scoring with provider fallback via `Op.any`
- cache/config policy lookup via `Op.race`
- concurrent inventory/payment orchestration via `Op.all`
- best-effort side effects via `Op.allSettled`
- retry + timeout budgets with `withRetry`/`withTimeout`
- abort propagation into in-flight calls through `AbortSignal`

Run the consumer-level checks (repo contributors, from monorepo root):

```bash
pnpm --filter @prodkit/op-scripts run examples:smoke:pack
```

Run all cross-runtime smoke checks for Bun, Deno, and a Cloudflare Workers-like runtime
when both `bun` and `deno` are on `PATH`:

```bash
pnpm --filter @prodkit/op-scripts run runtime:smoke
```

You can also run one runtime at a time with `runtime:smoke:bun`, `runtime:smoke:deno`,
or `runtime:smoke:edge`.

## More examples

- [`examples/op/simple.ts`](https://github.com/trvswgnr/prodkit/blob/main/examples/op/simple.ts):
  minimal composition and typed error walkthrough.
- [`examples/op/smoke.ts`](https://github.com/trvswgnr/prodkit/blob/main/examples/op/smoke.ts):
  consumer-level scenario assertions for simple + webhook flows.

## Contributing

For monorepo setup, local development, release flow, and publish procedures, see
[`CONTRIBUTING.md`](https://github.com/trvswgnr/prodkit/blob/main/CONTRIBUTING.md).

## Publishing

Contributor requirement: Node `>=24.14.0`.
