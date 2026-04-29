# @prodkit/op

A simple, composable, and predictable library for writing operations in TypeScript, built on top of [`better-result`](https://github.com/dmmulroy/better-result).

> [!WARNING]
> This library is currently in alpha. The API will almost certainly change between releases while it stabilizes.

Write code that stays readable as it grows and keep predictable
behavior in production. Compose steps top-to-bottom, apply retry, timeout, and cancellation as
policy, and run parallel work without scattering reliability logic across your app.

## Why this exists

Async TypeScript has two huge flaws: you can't see from a function's type what it might fail with, and the standard concurrency helpers happily let sibling tasks keep running after one of them blows up. `@prodkit/op` fixes both. It builds on `better-result` for the core `Result` model, then adds generator-based composition, typed error inference, and cancellation-aware concurrency on top. Concurrency combinators thread cancellation through every child, so when one fails the rest actually stop instead of burning quota in the background. Retry, timeout, and external cancellation are one chained method each. Minimal runtime dependencies, a small footprint, no runtime to bootstrap, and an API that's easy to learn and use.

## Installation

```bash
npm install @prodkit/op
```

Runtime requirement for consumers: Node `>=20`.

## Quick start

```ts
import { Op, TaggedError } from "@prodkit/op";

class DivisionByZeroError extends TaggedError("DivisionByZeroError")() {}

const divide = Op(function* (a: number, b: number) {
  if (b === 0) yield* new DivisionByZeroError();
  return a / b;
});

const sqrt = Op(function* (n: number) {
  // any value can be passed to Op.fail, but it should be discriminative
  if (n < 0) yield* Op.fail("Negative");
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

### `Op.of(value)`

Creates an op that succeeds with `value`.
If `value` is a promise, it is awaited and converted into the same `Result` model.

### `Op.fail(error)`

Creates an op that always fails with `error`.

### `Op.try(f, onError?)`

Runs an async or sync function and converts failures into `Err`.
If `onError` is omitted, failures become `UnhandledException`.

`f` receives an `AbortSignal` tied to surrounding cancellation policy (`withTimeout`, `withSignal`,
and combinator cancellation). Forward it to cancellable APIs so in-flight work (e.g. `fetch`, DB queries) actually stops instead of
leaking after a timeout.

```ts
const fetchUser = Op.try((signal) => fetch("/api/users/1", { signal }));
const result = await fetchUser.withTimeout(1000).run();
// when the 1s budget elapses, the fetch is aborted.
```

### `Op.run(op)`

Static runner for nullary ops. This is equivalent to `op.run()`, and is useful when you want to
execute an op value passed around as data.

```ts
const result = await Op.run(Op.of(7));
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
const userId = Op.of({ id: 42, name: "Ada" }).map((user) => user.id);
const result = await userId.run(); // Result<number, UnhandledException>
```

### `.flatMap(f)`

Chains to the next op using the previous success value. This is the monadic bind operation:
the next op only runs after the first one succeeds, and both error channels are preserved.

```ts
const getUserTodos = getUser(42).flatMap((user) => getTodos(user.id));
const result = await getUserTodos.run();
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

## Typed errors

Use `TaggedError("Name")` for discriminated domain errors that still behave like real `Error` objects.
You can fail with one directly with `yield* new MyError()` inside an op.

```ts
import { TaggedError, Op } from "@prodkit/op";

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
- exponential backoff from `100ms` up to `1000ms`

You can also build your own delay function with `exponentialBackoff({ baseMs, maxMs, jitterMs })`.

```ts
import { exponentialBackoff } from "@prodkit/op";

const policy = {
  maxAttempts: 5,
  shouldRetry: (cause: unknown) => cause instanceof Error,
  getDelay: exponentialBackoff({ baseMs: 200, maxMs: 2_000, jitterMs: 100 }),
};
```

## Built-in errors

- `UnhandledException`: default wrapper when a thrown/rejected value is not mapped to a domain error.
- `TimeoutError`: produced by `.withTimeout(timeoutMs)` when the budget expires.
- `ErrorGroup`: produced by `Op.any` when all children fail.
- `UnreachableError`: internal sentinel used by control flow; exported for completeness, but most
  consumers should not instantiate it directly.

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

Waits for every op and returns a tuple of their `Result`s in input order. Never fails and does not
short-circuit siblings on child failure.

Pass a positive integer `concurrency` to cap how many children run at once. Unlike `Op.all`,
`Op.allSettled` keeps launching queued children after failures so every input gets a `Result`.

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
const settled = yield * Op.settle(loadPolicyVersion);
const policy = settled.isOk() ? settled.value : "unknown";
```

### `Op.any(ops)`

Succeeds with the first op to succeed; remaining siblings are aborted. If every op fails,
the combinator fails with `ErrorGroup` whose `errors` array holds each child failure
in input index order. Empty input fails with an empty `ErrorGroup`.

```ts
import { ErrorGroup } from "@prodkit/op";

const r = await Op.any([Op.fail("a"), Op.of(42)]).run();
if (r.isOk()) console.log(r.value); // 42
if (r.isErr() && r.error instanceof ErrorGroup) console.log(r.error.errors);
```

### `Op.race(ops)`

Propagates whichever op settles first — success or failure. Remaining siblings are
aborted with no library-specific reason. `Op.race([])` fails fast with
`UnhandledException`.

```ts
const r = await Op.race([slow, fast]).run();
```

## Flagship production example: webhook consumer

See `examples/webhook.ts` for a complete order webhook pipeline
that demonstrates:

- input validation with typed domain errors
- idempotency checks
- risk scoring with provider fallback via `Op.any`
- cache/config policy lookup via `Op.race`
- concurrent inventory/payment orchestration via `Op.all`
- best-effort side effects via `Op.allSettled`
- retry + timeout budgets with `withRetry`/`withTimeout`
- abort propagation into in-flight calls through `AbortSignal`

Run the consumer-level checks:

```bash
npm run examples:test:pack
```

## More examples

- `examples/simple.ts`: minimal composition and typed error walkthrough.
- `examples/smoke.ts`: consumer-level scenario assertions for simple + webhook flows.

## Consumer smoke project

`examples/` verifies this package the way a consumer would install and execute it.

Prefer the tarball smoke test for release confidence (it validates the exact files that would be
published):

```bash
npm run examples:test:pack
```

You can also validate alternative install paths:

```bash
# install directly from GitHub repo
npm run examples:test:github

# install from latest published npm package
npm run examples:test:npm
```

## Scripts

```bash
npm run test
npm run typecheck
npm run lint
npm run build
npm run examples:test:pack
```

## Contributing

For local development, release flow, and publish procedures, see `CONTRIBUTING.md`.

## Publishing

Contributor requirement: Node `>=24.14.0`.
