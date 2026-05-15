# `@prodkit/op` vs the usual options

Most TypeScript async code starts with `Promise`, maybe adds a `Result` type, then slowly grows a
private reliability framework around it. A retry helper here. A timeout race there. Some
`AbortController` wiring that only works if every caller remembers the ceremony. A few `finally`
blocks that look reassuring until cancellation and concurrent work get involved.

`@prodkit/op` exists for the point where that stops being cute.

An `Op` is a lazy, typed, runnable operation. It composes top-to-bottom with `yield*`, returns a
`Result`, carries retry and timeout as policy, threads cancellation through the run, and gives
concurrent combinators a real abort contract. The sales pitch is boring on purpose: fewer hidden
execution rules in production code.

## Op vs native `Promise`

Native `Promise` is good plumbing and a bad operation model.

Promises do not tell you what they can reject with. They start eagerly. They do not have a
first-class cancellation protocol. `Promise.all` rejects when one task rejects, but the other tasks
are still running unless you manually built cancellation into each one and remembered to call it.
That is the part people usually rediscover after the first weird double-write, leaked request, or
background API bill.

`Op` keeps the familiar edge:

```ts
const result = await program.run();
```

But inside the program, failure and execution policy are explicit:

```ts
const program = Op.all([
  fetchJson("/api/user"),
  fetchJson("/api/alerts"),
  fetchJson("/api/settings"),
])
  .withRetry({ maxAttempts: 2 })
  .withTimeout(1_500)
  .withSignal(request.signal);
```

That gives you the part `Promise` never tried to give you: one place to say what happens when the
operation fails, times out, gets cancelled, or has sibling work still in flight.

Use `Promise` for tiny local async code. Use `Op` when the thing is a real operation and production
behavior matters.

## Op vs neverthrow

neverthrow is excellent at making success and failure explicit. That solves one important problem:
the caller can see `Ok` or `Err` instead of guessing which exceptions might appear at runtime.

But a result type is not an async runtime.

Once the work is asynchronous, the hard questions are not only "what error type comes back?" They
are also "when does the work start?", "how is cancellation propagated?", "does cleanup wait before
the caller receives a result?", "what happens to the other requests when one branch fails?", and
"where do retry and timeout policy live?"

`Op` answers those questions directly. It uses `better-result` for the result boundary, then adds the
operation runtime around it:

```ts
const updateOrder = Op(function* (id: string) {
  const order = yield* loadOrder(id);
  yield* Op.defer(() => releaseOrderLock(id));
  const payment = yield* chargePayment(order).withRetry();
  return yield* persistOrder({ order, payment });
});
```

If you only need `Result<T, E>`, use a result library. If the work needs cancellation, cleanup,
retry, timeout, and composition that still reads like TypeScript, `Op` is the missing layer.

## Op vs `ResultAsync`

`ResultAsync` wraps a `Promise<Result<T, E>>` and gives it fluent result combinators. That is useful,
but the shape is still "an async result".

`Op` is "a runnable operation".

That distinction is the whole product. An `Op` is lazy until `.run(...)`. A run has scoped args and
an abort signal. Child ops compose through `yield*`. Finalizers register against the run and unwind
before settlement. `Op.all`, `Op.any`, and `Op.race` can abort work that no longer matters. Retry and
timeout are part of the operation graph rather than hand-rolled around a promise.

For a single request that should become `Ok` or `Err`, `ResultAsync` is smaller. For a workflow where
execution semantics are the product, `Op` gives you the model you were going to build around it
anyway.

## Op vs `fp-ts`

`fp-ts` `TaskEither` is powerful: lazy async work, typed failure, lots of combinators, and a serious
functional foundation. If your codebase already speaks `fp-ts`, you may already have the vocabulary
and conventions to make that work well.

Most TypeScript teams do not.

`Op` is aimed at teams that want the useful operational pieces without turning the whole codebase
into `pipe`, `chainW`, typeclass instances, and widening suffixes. Composition looks like normal
control flow:

```ts
const program = Op(function* () {
  const user = yield* loadUser(userId);
  const settings = yield* loadSettings(user.id);
  const billing = yield* loadBilling(user.id);
  return { user, settings, billing };
});
```

That matters because production workflows are usually read by more people than the person who wrote
them. `Op` keeps the code close to ordinary imperative TypeScript while preserving typed short
circuiting, lazy execution, and composed error inference.

Choose `fp-ts` when you want the broader FP toolkit and your team is bought in. Choose `Op` when you
want typed async operations to be readable by the whole application team.

## Op vs Effect

Effect is the big one. It has typed errors, fibers, interruption, scopes, schedules, services,
streams, observability, and a whole ecosystem. It can be the right answer when you want a full
application runtime.

`Op` is intentionally smaller.

That is not a weakness. It is the point. A lot of teams do not need a new application platform. They
need a better way to write the risky async workflows they already have: webhooks, payment flows,
provider calls, queue handlers, cache fallbacks, startup probes, teardown, retry budgets, timeouts,
and concurrent IO that should stop when the result is already decided.

Effect asks you to adopt the platform. `Op` asks you to wrap the operation.

```ts
const handleWebhook = Op(function* (event: WebhookEvent) {
  const order = yield* validateEvent(event);
  const risk = yield* Op.any([scoreWithPrimary(order), scoreWithFallback(order)]);
  const [inventory, payment] = yield* Op.all([reserveInventory(order), charge(order)]);

  yield* publishReceipt({ order, risk, inventory, payment });
});
```

That code has typed failures, cancellation-aware concurrency, retry/timeout policy where you need it,
and cleanup hooks when resources enter the picture. It does not require services, layers, fibers, or
a new standard library around the rest of your app.

Choose Effect when you want the platform. Choose `Op` when you want the production-grade operation
semantics without making the platform decision.

## Why Op wins its lane

`@prodkit/op` is not trying to be the biggest abstraction in the room. It is trying to be the one you
can drop into a TypeScript codebase when promises plus ad hoc helpers are no longer enough.

The value is the combination:

- typed failure without exception guessing
- generator composition that reads top-to-bottom
- lazy execution with a clear `.run(...args)` boundary
- retry and timeout as composable policy
- external cancellation through `.withSignal(...)`
- fail-fast concurrency that aborts siblings
- registered cleanup that unwinds before the result settles
- ordinary TypeScript at the edges

That combination is the reason to use `Op`. Not because `Promise`, neverthrow, `fp-ts`, or Effect are
bad. They each solve their own problem. `Op` solves the specific problem that shows up in production
TypeScript services: async workflows need explicit failure and predictable execution, and teams
should not have to invent that contract one call site at a time.

## References

The comparison above is based on each project's public documentation:
[`Promise`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Promise),
[`neverthrow`](https://github.com/supermacro/neverthrow),
[`ResultAsync`](https://supermacro-neverthrow-22.mintlify.app/api/result-async/from-promise),
[`fp-ts` `TaskEither`](https://gcanti.github.io/fp-ts/modules/TaskEither.ts.html), and
[`Effect`](https://effect.website/).
