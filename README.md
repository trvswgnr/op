# @prodkit/op

`@prodkit/op` is a small TypeScript library for composing effectful workflows with generator functions.
It gives you predictable `Ok`/`Err` results, typed error unions across `yield*` boundaries, async suspension with `Op.try`, retry policies with `withRetry`, and execution budgets with `withTimeout`.

If you like writing workflows that read top to bottom without throwing exceptions through your app layer, this library is built for that.

## Why this exists

JavaScript async control flow often spreads error handling across `try/catch`, rejected promises, and inconsistent return values.
`@prodkit/op` centralizes that into one model:

- describe a workflow as an `Op`
- compose child operations with `yield*`
- run once with `.run(...)`
- handle a discriminated `Result<T, E>`

The result is code that stays explicit under growth, including retry, timeout budgets, and typed domain errors.

## Install

```bash
npm install @prodkit/op
```

Runtime requirement for consumers: Node `>=20`.

## Quick start

```ts
import { Op, TypedError } from "@prodkit/op";

class DivisionByZeroError extends TypedError("DivisionByZeroError") {}
class NegativeError extends Error {
  readonly type = "NegativeError";
  constructor(readonly n: number) {
    super();
  }
}

const divide = Op(function* (a: number, b: number) {
  if (b === 0) return yield* new DivisionByZeroError();
  return a / b;
});

const sqrt = Op(function* (n: number) {
  if (n < 0) return yield* Op.fail(new NegativeError(n));
  return Math.sqrt(n);
});

const program = Op(function* () {
  const quotient = yield* divide(10, 2);
  const rooted = yield* sqrt(quotient);
  return rooted * 2;
});

const result = await program.run();
if (result.ok) {
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
If `onError` is omitted, failures become `UnexpectedError`.

`f` receives an `AbortSignal` that fires when the surrounding `withTimeout` expires. Forward it
to cancellable APIs so in-flight work (e.g. `fetch`, DB queries) actually stops instead of
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

Reusable no-op that succeeds with `undefined`.

```ts
const result = await Op.empty.run();
```

### `.run(...args)`

Executes the operation and returns:

```ts
type Result<T, E> = { type: "Ok"; ok: true; value: T } | { type: "Err"; ok: false; error: E };
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

Use `TypedError("Name")` for discriminated domain errors that still behave like real `Error` objects.
You can raise one directly with `yield* new MyError()` inside an op.

```ts
import { TypedError, Op } from "@prodkit/op";

class ValidationError extends TypedError("ValidationError")<{
  field: string;
}> {}

const validate = Op(function* (name: string) {
  if (name.trim().length === 0) {
    return yield* new ValidationError({ field: "name", message: "Name is required" });
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

- `UnexpectedError`: default wrapper when a thrown/rejected value is not mapped to a domain error.
- `TimeoutError`: produced by `.withTimeout(timeoutMs)` when the budget expires.
- `ErrorGroup`: produced by `Op.any` when all children fail.
- `UnreachableError`: internal sentinel used by control flow; exported for completeness, but most
  consumers should not instantiate it directly.

## Concurrent combinators

Run multiple ops concurrently and compose them back into one `Op`.
When a result is decided early (`all` after a failure, `any` after a success, `race` on first
settle), remaining work is cancelled through `AbortSignal`.

### `Op.all(ops)`

Runs every op concurrently and succeeds with a tuple of their success values. Fails fast
on the first failure; in-flight siblings receive an abort and the combinator waits for
them to settle before returning. Empty input succeeds with `[]`.

```ts
const r = await Op.all([Op.of(1), Op.of("two"), Op.of(true)]).run();
if (r.ok) {
  const [n, s, b] = r.value; // [number, string, boolean]
}
```

### `Op.allSettled(ops)`

Waits for every op and returns a tuple of their `Result`s in input order. Never fails and
never aborts siblings.

```ts
const r = await Op.allSettled([Op.of(1), Op.fail("nope")]).run();
if (r.ok) {
  const [a, b] = r.value; // Result<number, ...>, Result<never, "nope" | ...>
}
```

### `Op.any(ops)`

Succeeds with the first op to succeed; remaining siblings are aborted. If every op fails,
the combinator fails with `ErrorGroup` whose `errors` array holds each child failure
in input index order. Empty input fails with an empty `ErrorGroup`.

```ts
import { ErrorGroup } from "@prodkit/op";

const r = await Op.any([Op.fail("a"), Op.of(42)]).run();
if (r.ok) console.log(r.value); // 42
if (!r.ok && r.error instanceof ErrorGroup) console.log(r.error.errors);
```

### `Op.race(ops)`

Propagates whichever op settles first — success or failure. Remaining siblings are
aborted with no library-specific reason. `Op.race([])` fails fast with
`UnexpectedError`.

```ts
const r = await Op.race([slow, fast]).run();
```

## Flagship production example: webhook consumer

See `src/examples/webhook-flagship.ts` for a complete order webhook pipeline that demonstrates:

- input validation with typed domain errors
- idempotency checks
- risk scoring with provider fallback via `Op.any`
- cache/config policy lookup via `Op.race`
- concurrent inventory/payment orchestration via `Op.all`
- best-effort side effects via `Op.allSettled`
- retry + timeout budgets with `withRetry`/`withTimeout`
- abort propagation into in-flight calls through `AbortSignal`

Run the focused tests:

```bash
npm run test -- src/examples/webhook-flagship.test.ts
```

## Scripts

```bash
npm run test
npm run typecheck
npm run lint
npm run build
```

## Publishing

### Release workflow (recommended)

1. Run local release checks:

```bash
npm run release:prepare
```

2. Bump package version (patch/minor/major as needed):

```bash
npm version patch
```

3. Push commit and tag:

```bash
git push && git push --tags
```

4. Pushing tags like `v0.1.1` triggers `.github/workflows/release.yml`, which:
   - installs with `npm ci`
   - runs `npm run check`
   - publishes with provenance (`npm publish --provenance --access public`)

### Manual publish fallback

```bash
npm run release:prepare
npm publish --access public --no-provenance
```

Contributor requirement: Node `>=24.14.0`.
