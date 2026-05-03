# Execution invariants

This document captures correctness-critical runtime invariants for `Op` execution.
It focuses on semantics that should remain stable across refactors.

## Scope and model

`Op.run()` is driven by `drive()` in `src/core/runtime.ts`.
That runtime executes generator instructions, tracks registered exit finalizers, and settles to a single `Result`.
Combinators (`Op.all`, `Op.allSettled`, `Op.any`, `Op.race`) compose multiple `drive()` calls in `src/combinators.ts`.

## Invariant 1: cleanup ordering is deterministic and LIFO

When multiple exit finalizers are registered, unwind order is last-in-first-out. Every registered finalizer is attempted, even if earlier unwind steps throw.

Why this matters:

- resource scopes are stack-shaped, so teardown must run in reverse acquisition order
- cleanup side effects must be predictable for debugging and auditing

Enforced by code paths:

- `src/core/runtime.ts` (`runFinalizersSafely`): iterates `finalizers` from tail to head and keeps unwinding after faults
- `src/core/runtime.ts` (`chainCleanupFaults`): folds multiple cleanup faults into a nested `Error.cause` chain in unwind order

Representative tests:

- `src/core.test.ts` (`registerExitFinalizer runs all handlers in LIFO order`)
- `src/core.test.ts` (`multiple throwing finalizers are folded into a cause chain`)
- `src/lifecycle.test.ts` (`runs multiple defers in LIFO order on success`)
- `src/lifecycle.test.ts` (`shares LIFO stack with withRelease (release runs before defer registered earlier)`)

## Invariant 2: registered exit-finalizer faults take precedence at settlement

After the body reaches a terminal `Result`, exit finalizers run. If any registered exit finalizer fails, the final outcome becomes `Err(UnhandledException)` with cleanup fault cause (or chained causes for multiple faults), regardless of prior body success/failure.

Why this matters:

- prevents silent teardown corruption
- makes cleanup failures explicit at call sites and observability boundaries

Enforced by code paths:

- `src/core/runtime.ts` (`settleWithCleanup`): finalizer faults override settled body result
- `src/core/runtime.ts` (`runFinalizersSafely`): returns first unwind fault (or cause chain) for wrapping

Representative tests:

- `src/core.test.ts` (`finalizer throw after successful body converts to UnhandledException`)
- `src/core.test.ts` (`cleanup fault takes precedence over typed body error`)
- `src/lifecycle.test.ts` (`when op fails, cleanup throws: UnhandledException with cleanup error as cause`)

Important edge distinction:

- generator finalization via `iter.return()` uses `closeGenerator()`, which intentionally swallows `return()` cleanup faults to preserve the original body result/error
- this behavior is separate from registered exit finalizers and is intentionally less intrusive

Representative test:

- `src/lifecycle.test.ts` (`preserves original Err result when cleanup throws during iter.return()`)

## Invariant 3: chain-order semantics in combinators are stable

Combinators preserve deterministic ordering guarantees while still using concurrency:

- `Op.all` / `Op.allSettled`: output ordering follows input ordering, even when completions occur out of order
- `Op.any`: when all fail, `ErrorGroup.errors` keeps input index order
- `Op.race` and `Op.any`: winner selection has precedence, but resolution waits for aborted losers to settle so their cleanup/finalizers finish before `run()` resolves

Why this matters:

- caller expectations should not depend on scheduler timing
- deterministic ordering keeps retries, logs, and assertions stable

Enforced by code paths:

- `src/combinators.ts` (`driveAll`, `driveAllSettled`, `driveAny`, `driveRace`)
- `src/combinators.ts` (`fanOut`): isolates child cancellation and detaches parent abort listeners on settle

Representative tests:

- `src/combinators.test.ts` (`tuple of successes in input order`)
- `src/combinators.test.ts` (`returns tuple of Result in input order`)
- `src/combinators.test.ts` (`preserves index order when failures settle out of order`)
- `src/combinators.test.ts` (`waits for loser finalization before returning the winner`)
- `src/combinators.test.ts` (`waits for loser finalization before returning winner result`)

## Guardrails for future changes

Before changing runtime/combinator internals, preserve these properties:

1. LIFO unwind and "run all finalizers" behavior.
2. Registered finalizer failure precedence at final settlement.
3. Stable input-order semantics for combinator outputs and grouped errors.
4. Wait-for-loser-finalization semantics after winner selection.

Any intentional semantic change should include:

- explicit test updates in `src/core.test.ts`, `src/lifecycle.test.ts`, and/or `src/combinators.test.ts`
- an accompanying update to this document explaining the new invariant

# Execution invariants

If you change the scheduler, combinators, or policy wrappers, these are the behaviors worth
holding steady. Stuff that reads like a micro-optimization can still blow up determinism or
what callers see when something fails.

The references here are `src/core/runtime.ts`, `src/core/nullary-ops.ts`, and `src/combinators.ts`,
plus the tests named inline so regressions stay obvious.

## Single-run driver (`drive`)

Running an `Op` is walking an iterator over `Instruction`s. `drive` in `src/core/runtime.ts`
passes the same `AbortSignal` into suspended work (`src/core.test.ts` "resumeSuspended path
passes the bound signal"). A typed shortcut via `yield* Result.err` settles to `Err` and still
runs exit teardown along the usual path. Yield something that isn't a known instruction shape
and you get `Err(UnhandledException(TypeError))` ("invalid yielded instructions...").

### Exit finalizers (`RegisterExitFinalizerInstruction`)

Cleanup hooks go through `RegisterExitFinalizerInstruction`. For each `drive` invocation the
registered finalizers unwind last-in-first-out: `runFinalizersSafely` walks the array from the
tail (`src/core/runtime.ts`). In one generator body, multiple defers unwind in reverse yield order
(second defer runs before the first).

Chained `.on("exit", ...)` builds wrappers (`onExitNullaryOp` in `src/core/nullary-ops.ts`) where the
hand you attach first behaves like the inner scope, so at exit time the inner-most handler runs
before the outer ones (`src/lifecycle.test.ts`, "chains `.on("exit")` in LIFO order with inner
registration running first"). That matches how people think about stacking defer-like behavior.

Every registered finalizer still runs after a sibling throws (`runFinalizersSafely`). Several throws
collapse into nested `cause` links via `chainCleanupFaults` in LIFO order (`src/core.test.ts`,
"multiple throwing finalizers are folded into a cause chain").

Once the body has picked a settlement `Result`, a fault in exit finalizers wins the observable
outcome as `Err(UnhandledException)`, including folded `cause` chains, even when the body had
already settled to typed `Err` ("cleanup fault takes precedence over typed body error"). Same for
successful bodies where a finalizer throws ("finalizer throw after successful body converts to
`UnhandledException`").

`withRelease` / `withCleanupNullaryOp` is different (`src/core/nullary-ops.ts`). The release hook
arms only after a successful inner completion. Typed failure short-circuits without scheduling that
release, so primary errors stay intact (`src/lifecycle.test.ts`, "preserves primary error..." on
`Op.fail` with `withRelease`). That isn't swapping semantics with exit finalizers registered while
the run is unwinding inside `drive`.

### Generator finalization (`closeGenerator`)

`drive` touches `iterator.return` through `closeGenerator` so native `finally` in generator code
actually runs (`src/core/runtime.ts`). Throws from `return` are swallowed on purpose
(`src/lifecycle.test.ts`, "preserves original Err result when cleanup throws during `iter.return()`").

## Concurrency (`Op.any`, `Op.race`)

Combinator contracts live in `src/combinators.ts` alongside the fuller comment block.

`Op.any` runs children together under one outer abort umbrella. First success picks the winner and
abort-signals the losers, but `.run()` still waits until those aborted branches finish so cleanup
sticks ("waits for loser finalization before returning the winner"). If everyone fails you get an
`ErrorGroup` listing errors in declaration order regardless of settle order ("preserves index order
when failures settle out of order"). A loser failing while reacting to abort does not trump the
winner's success ("winner success keeps precedence over loser abort-time failures").

`Op.race` is simpler: whoever settles first, ok or err, picks the outcome and triggers abort for
everyone else, with the same promise that losers finish teardown before `.run()` returns ("waits
for loser finalization before returning winner result"). The losing branch still can't override the
chosen error ("winner error keeps precedence over loser abort-time failures").

## Policy ordering (retry and timeout)

Method order chooses what's inside which wrapper. Putting retry first and timeout second means one
overall clock around the retry loop ("timeout wraps the entire retried run when chained outside
retry"). Putting timeout inside retry means timeout applies independently per retry attempt
(`src/policies.test.ts`, "timeout applies per-attempt when chained inside retry", also the converse
scenario in the sibling test quoted there).

## Where else to read

Cancellation and cooperative `AbortSignal` behavior show up wherever `SuspendInstruction` binds a
signal, plus README's `Op.defer` / `.on("exit")` notes and checks in `src/policies.test.ts` and
`src/lifecycle.test.ts`. Type-level contracts collected in `src/types.test.ts`.
