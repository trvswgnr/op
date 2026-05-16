# Contributing

## Setup

- Use Node `>=24.14.0` and `pnpm@10` (validated in CI on `10.11.0`).
- Run commands from the repo root unless noted otherwise.

```bash
pnpm install
```

## Monorepo Orientation

- This repository is a pnpm workspace monorepo orchestrated by Turborepo (`turbo`).
- Root scripts (`pnpm run build|test|lint|typecheck|gate`) run across the workspace graph.
- Publishable libraries today: **`@prodkit/op`** and **`@prodkit/std`** (see `packages/op`, `packages/std`).
- Supporting workspaces: **`@prodkit/examples`** (`examples/`), **`@prodkit/tools`** (`tools/`), **`@prodkit/op-benchmarks`** (`benchmarks/op`).
- `@prodkit/op` landed first historically; the repo is intentionally multi-package.
- Package-scoped scripts stay in the owning workspace `package.json`; invoke them with `pnpm --filter <workspace> run <script>`.

## Contributor Runtime

- Node `>=24.14.0` is required for local development and release tasks.
- This requirement is for contributors/tooling only; the library API is runtime-agnostic for consumers.

## Local Quality Gate

Run the same checks used before publishing:

```bash
pnpm run gate
```

The quality gate includes a consumer-level smoke test that installs `@prodkit/op` and `@prodkit/std`
from `npm pack` tarballs via `examples/` in an isolated temp workspace.

Pull requests and pushes to `main` run the same gate in `.github/workflows/ci.yml`.
CI also publishes the `@prodkit/op` Vitest coverage report as a workflow artifact so reviewers
can audit unit, integration, type, and property-law coverage evidence from the run.

All runnable consumer examples and smoke entrypoints live in the **`examples/`** workspace (`@prodkit/examples`): Op-oriented samples under [`examples/op/`](examples/op/), std/di samples under [`examples/std/`](examples/std/), with root [`examples/smoke.ts`](examples/smoke.ts) running both suites.

## Benchmarking

Use the benchmark harness when you need to validate runtime overhead or package-size drift against a baseline:

```bash
pnpm run bench
```

- Default baseline is latest commit on `main`.
- For latest published package comparison, run `pnpm --filter @prodkit/op-benchmarks run bench -- --baseline=npm`.
- Keep benchmark interpretation directional; rely on relative deltas and rerun unexpected regressions before acting.

Detailed benchmark scenarios and authoring guidance live in `benchmarks/op/README.md`.

## Type Cast Policy

- Every remaining cast must carry an inline comment describing the concrete TypeScript limitation.
- Treat casts as a last resort after trying type-level restructuring first.
- New casts should be called out in PR descriptions so reviewers can audit the tradeoff.

## Testing Strategy

Use a strict two-tier model so behavior has one clear home. **`@prodkit/op`** uses:

- Unit tests (`packages/op/src/<module>.test.ts`) verify module-local invariants, edge cases, and implementation details by importing the module under test directly.
- Integration tests (`packages/op/src/index.test.ts`) verify public API shape, re-exports, and cross-module composition contracts by importing only from `./index.js`.
- If a behavior is an internal invariant of one module, keep it in the unit test; if it is a public composition/API contract, keep it in integration.
- Avoid duplicate assertions across tiers unless each tier validates meaningfully different risk.

**`@prodkit/std`** uses Vitest alongside implementation under `packages/std/src/` (for example `packages/std/src/di/index.test.ts`).

## Source Layout (`@prodkit/op`)

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

## Source layout (`@prodkit/std`)

- Source under `packages/std/src/`; published entrypoints are `@prodkit/std` and `@prodkit/std/di`.
- Package docs: [`packages/std/README.md`](packages/std/README.md). Ship changelog: [`packages/std/CHANGELOG.md`](packages/std/CHANGELOG.md).

You can run consumer install path checks directly. Each mode builds a temporary mini-pnpm workspace (reusing the repo `catalog:` from `pnpm-workspace.yaml`), installs `@prodkit/op` and `@prodkit/std` from the chosen source, then runs `examples/` smoke:

```bash
pnpm --filter @prodkit/tools run examples:smoke:pack
pnpm --filter @prodkit/tools run examples:smoke:github
pnpm --filter @prodkit/tools run examples:smoke:npm
pnpm --filter @prodkit/op run test
pnpm --filter @prodkit/std run test
```

## Release Workflow (Recommended)

Use this flow for **`@prodkit/op`** releases. Pushing the `v*` tag created in step 3 triggers `.github/workflows/release.yml`, which publishes **`@prodkit/op`** only (not `@prodkit/std`).

1. Keep `packages/op/CHANGELOG.md` updated under `## [Unreleased]` as work lands.

2. Cut a release (this promotes `Unreleased`, bumps npm version in
   `packages/op/package.json`, runs release checks, commits, and
   creates git tag `vX.Y.Z`):

```bash
pnpm --filter @prodkit/op run release:patch
```

*Note:* `release:minor` and `release:major` will be added when needed.

If `Unreleased` is empty, the cut script writes a minimal
"No user-facing changes" note for the new version.
The changelog/version updates must be committed before tag creation because
release validation runs against the tagged commit.

3. Push commit and tag:

```bash
pnpm --filter @prodkit/op run release:push
```

4. The workflow (for tags like `v0.1.1`) then:

   - installs with `pnpm install --frozen-lockfile`
   - publishes with npm trusted publishing (OIDC) and provenance (`pnpm --filter @prodkit/op publish --provenance --access public --no-git-checks`)

For **`@prodkit/std`**, bump `packages/std/package.json`, update `packages/std/CHANGELOG.md`, run `pnpm run gate`, and publish manually (`pnpm --filter @prodkit/std publish --access public --provenance --no-git-checks`) when you cut a std release—there is no shared tag workflow for it yet.

## Release Failure Recovery

If a release tag is pushed but the release workflow fails (for example,
changelog/version mismatch), use a forward-fix workflow:

1. Leave the failed tag as-is (do not rewrite tag history by default).
2. Add the missing changelog note under `packages/op/CHANGELOG.md` under `## [Unreleased]`.
3. Cut the next patch release:

```bash
pnpm --filter @prodkit/op run release:patch
```

4. Push commit and tag:

```bash
pnpm --filter @prodkit/op run release:push
```

The failed run remains red in history, but the next tag should publish cleanly.

Only use tag deletion/force-retagging when absolutely necessary and explicitly
approved.

## Manual Publish Fallback

`@prodkit/op`:

```bash
pnpm --filter @prodkit/op run release:prepare
pnpm --filter @prodkit/op publish --access public --provenance --no-git-checks
```

`@prodkit/std` (after version + changelog updates):

```bash
pnpm --filter @prodkit/std run release:prepare
pnpm --filter @prodkit/std publish --access public --provenance --no-git-checks
```
