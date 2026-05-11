# Contributing

## Setup

- Use Node `>=24.14.0` and `pnpm@10.11.0`.
- Run commands from the repo root unless noted otherwise.

```bash
pnpm install
```

## Contributor Runtime

- Node `>=24.14.0` is required for local development and release tasks.
- This requirement is for contributors/tooling only; the library API is runtime-agnostic for consumers.

## Local Quality Gate

Run the same checks used before publishing:

```bash
pnpm run gate
```

The quality gate includes a consumer-level smoke test that installs the package from an `npm pack`
tarball via `apps/op/examples/` in an isolated temp workspace.

Pull requests and pushes to `main` run the same gate in `.github/workflows/ci.yml`.

All examples are consumer-level and live under `apps/op/examples/*`.

## Benchmarking

Use the benchmark harness when you need to validate runtime overhead or package-size drift against a baseline:

```bash
pnpm run bench
```

- Default baseline is latest commit on `main`.
- For latest published package comparison, run `pnpm --filter @prodkit/op-benchmarks run bench -- --baseline=npm`.
- Keep benchmark interpretation directional; rely on relative deltas and rerun unexpected regressions before acting.

Detailed benchmark scenarios and authoring guidance live in `apps/op/benchmarks/README.md`.

## Type Cast Policy

- Every remaining cast must carry an inline comment describing the concrete TypeScript limitation.
- Treat casts as a last resort after trying type-level restructuring first.
- New casts should be called out in PR descriptions so reviewers can audit the tradeoff.

## Testing Strategy

Use a strict two-tier model so behavior has one clear home.

- Unit tests (`packages/op/src/<module>.test.ts`) verify module-local invariants, edge cases, and implementation details by importing the module under test directly.
- Integration tests (`packages/op/src/index.test.ts`) verify public API shape, re-exports, and cross-module composition contracts by importing only from `./index.js`.
- If a behavior is an internal invariant of one module, keep it in the unit test; if it is a public composition/API contract, keep it in integration.
- Avoid duplicate assertions across tiers unless each tier validates meaningfully different risk.

## Source Layout

- Public package entrypoint stays at `packages/op/src/index.ts`.
- Re-exports from dependencies must be explicit named exports in `packages/op/src/index.ts` (never `export *`).
- Internal runtime concerns are split into focused modules under `packages/op/src/`:
  - `core/` (core operation contracts and execution runtime pieces)
  - `builders.ts` (primitive operation constructors)
  - `policies.ts` (retry, timeout, and signal policies)
  - `combinators.ts` (all/any/race combinators)
  - `errors.ts`, `result.ts`, `tagged.ts` (shared domain contracts)
  - `shared.ts` (small shared type/runtime helpers)
  - `test-utils.ts` (shared test helpers)
  - `platform-globals.d.ts` (runtime-global typing support for tests/build)
- Test layout follows intent:
  - `packages/op/src/index.test.ts` for public API contract coverage
  - `packages/op/src/errors.test.ts` for typed error contracts
  - `packages/op/src/builders.test.ts` for operation builders, runtime composition, and builder type-inference contracts
  - `packages/op/src/policies.test.ts` for retry/timeout/signal behavior
  - `packages/op/src/core.test.ts` for core execution invariants
  - `packages/op/src/lifecycle.test.ts` for lifecycle/finalizer behavior
  - `packages/op/src/operators.test.ts` for fluent operator semantics
  - `packages/op/src/monad-laws.test.ts` for algebraic contract checks
  - `packages/op/src/types.test.ts` for compile-time type contracts
- Runtime invariants and execution semantics are documented in `packages/op/DESIGN.md`.

You can run consumer install path checks directly:

```bash
pnpm --filter @prodkit/op run examples:smoke:pack
pnpm --filter @prodkit/op run examples:smoke:github
pnpm --filter @prodkit/op run examples:smoke:npm
pnpm --filter @prodkit/op run test
```

## Release Workflow (Recommended)

Use this flow every time:

1. Keep `packages/op/CHANGELOG.md` updated under `## [Unreleased]` as work lands.

1. Cut a release (this promotes `Unreleased`, bumps npm version in
   `packages/op/package.json`, runs release checks, commits, and
   creates git tag `vX.Y.Z`):

```bash
pnpm --filter @prodkit/op run release:patch
```

_note:_ `release:minor` and `release:major` will be added when needed.

If `Unreleased` is empty, the cut script writes a minimal
"No user-facing changes" note for the new version.
The changelog/version updates must be committed before tag creation because
release validation runs against the tagged commit.

1. Push commit and tag:

```bash
pnpm --filter @prodkit/op run release:push
```

1. Pushing tags like `v0.1.1` triggers `.github/workflows/release.yml`, which:

- installs with `pnpm install --frozen-lockfile`
- publishes with npm trusted publishing (OIDC) and provenance (`pnpm --filter @prodkit/op publish --provenance --access public --no-git-checks`)

## Release Failure Recovery

If a release tag is pushed but the release workflow fails (for example,
changelog/version mismatch), use a forward-fix workflow:

1. Leave the failed tag as-is (do not rewrite tag history by default).
1. Add the missing changelog note under `packages/op/CHANGELOG.md` under `## [Unreleased]`.
1. Cut the next patch release:

```bash
pnpm --filter @prodkit/op run release:patch
```

1. Push commit and tag:

```bash
pnpm --filter @prodkit/op run release:push
```

The failed run remains red in history, but the next tag should publish cleanly.

Only use tag deletion/force-retagging when absolutely necessary and explicitly
approved.

## Manual Publish Fallback

```bash
pnpm --filter @prodkit/op run release:prepare
pnpm --filter @prodkit/op publish --access public --provenance --no-git-checks
```
