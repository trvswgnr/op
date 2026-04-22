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

`f` receives `{ signal }` — an `AbortSignal` that fires when the surrounding `withTimeout` expires
or when a signal passed to `run({ signal })` is aborted. Forward it to cancellable APIs so
in-flight work (e.g. `fetch`, DB queries) actually stops instead of leaking after a timeout.

```ts
const fetchUser = Op.try(({ signal }) => fetch("/api/users/1", { signal }));

// Aborts the fetch when the 1s budget elapses:
const result = await fetchUser.withTimeout(1000).run();

// External cancellation:
const controller = new AbortController();
const p = fetchUser.run({ signal: controller.signal });
controller.abort();
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

## Scripts

```bash
npm run test
npm run typecheck
npm run lint
npm run build
```

Contributor requirement: Node `>=24.14.0`.
