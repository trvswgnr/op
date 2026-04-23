# @prodkit/op

`@prodkit/op` is a small TypeScript library for composing effectful workflows with generator functions.
It gives you predictable `Ok`/`Err` results, typed error unions across `yield*` boundaries, async suspension with `Op.try`, retry policies with `withRetry`, and execution budgets with `withTimeout`.

If you like writing workflows that read top to bottom without throwing exceptions through your app layer, this library is built for that.

## Why this exists

JavaScript async control flow often spreads error handling across `try/catch`, rejected promises, and ad hoc return shapes.
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

### `.run(...args)`

Executes the operation and returns:

```ts
type Result<T, E> = { type: "Ok"; ok: true; value: T } | { type: "Err"; ok: false; error: E };
```

### `.withRetry(strategy?)`

Wraps an operation with retries.
Useful for transient IO failures while preserving typed control flow.

```ts
const strategy = {
  maxAttempts: 3,
  shouldRetry: (cause: unknown) => cause instanceof Error,
  getDelay: (attempt: number) => attempt * 100,
};

const fetchWithRetry = Op.try(() => fetch("https://example.com")).withRetry(strategy);
```

### `.withTimeout(timeoutMs)`

Wraps an operation with a timeout and fails with `TimeoutError` when the wrapped operation does not
finish before `timeoutMs`.

Composition order determines semantics:

```ts
// timeout applies to the ENTIRE retried run
const totalBudget = Op.try(() => fetch("https://example.com"))
  .withRetry(strategy)
  .withTimeout(5000);

// timeout applies to EACH attempt
const perAttempt = Op.try(() => fetch("https://example.com"))
  .withTimeout(5000)
  .withRetry(strategy);
```

## Typed errors

Use `TypedError("Name")` for discriminated domain errors that still behave like real `Error` objects.
Instances are iterable, which lets `yield* new MyError()` short-circuit like `Op.fail`.

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

`withRetry()` with no strategy uses:

- `maxAttempts: 3`
- `shouldRetry: () => true`
- exponential backoff from `100ms` up to `1000ms`

You can also build your own delay function with `exponentialBackoff({ baseMs, maxMs, jitterMs })`.

## Concurrent combinators

Fan multiple ops out and collapse their results back into a single `Op`. Each combinator
returns a nullary `Op` that preserves per-slot success types and unions child error types.
When the combinator's outcome is decided early (`all` after a failure, `any` after a
success, `race` on first settle), siblings are cancelled via `AbortSignal`.

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
in input index order. Empty input fails with `new ErrorGroup({ errors: [] })`.

```ts
import { ErrorGroup } from "@prodkit/op";

const r = await Op.any([Op.fail("a"), Op.of(42)]).run();
if (r.ok) console.log(r.value); // 42
if (!r.ok && r.error instanceof ErrorGroup) console.log(r.error.errors);
```

### `Op.race(ops)`

Propagates whichever op settles first — success or failure. Remaining siblings are
aborted with no library-specific reason. `Op.race([])` never settles (same as
`Promise.race([])`); compose `.withTimeout(ms)` if you need a deadline.

```ts
const r = await Op.race([slow, fast]).run();
```

## Scripts

```bash
npm run test
npm run typecheck
npm run lint
npm run build
```

Contributor requirement: Node `>=24.14.0`.
