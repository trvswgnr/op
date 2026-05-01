# Contributing

## Contributor Runtime

- Node `>=24.14.0` is required for local development and release tasks.
- This requirement is for contributors/tooling only; the library API is runtime-agnostic for consumers.

## Local Quality Gate

Run the same checks used before publishing:

```bash
npm run check
```

The quality gate includes a consumer-level smoke test that installs the package from an `npm pack`
tarball via `examples/`.

Pull requests and pushes to `main` run the same gate in `.github/workflows/ci.yml`.

All examples are consumer-level and live under `examples/*`.

## Type Cast Policy

- Every remaining cast must carry an inline comment describing the concrete TypeScript limitation.
- Treat casts as a last resort after trying type-level restructuring first.

## Source Layout

- Public package entrypoint stays at `src/index.ts`.
- Re-exports from dependencies must be explicit named exports in `src/index.ts` (never `export *`).
- Internal runtime concerns are split into focused modules under `src/`:
  - `core.ts` (core operation contracts and execution)
  - `builders.ts` (primitive operation constructors)
  - `policies.ts` (retry, timeout, and signal policies)
  - `combinators.ts` (all/any/race combinators)
  - `errors.ts`, `result.ts`, `typed.ts` (shared domain contracts)
- Test layout follows intent:
  - `src/index.test.ts` for public API contract coverage
  - `src/errors.test.ts` for typed error contracts
  - `src/builders.test.ts` for operation builders, runtime composition, and builder type-inference contracts
  - `src/policies.test.ts` for retry/timeout/signal behavior
  - `src/core.test.ts` for core execution invariants

You can run consumer install path checks directly:

```bash
npm run examples:test:pack
npm run examples:test:github
npm run examples:test:npm
npm run test
```

## Release Workflow (Recommended)

1. Run local release checks:

```bash
npm run release:prepare
```

1. Bump package version (`patch`, `minor`, or `major`):

```bash
npm version patch
```

1. Push commit and tag:

```bash
git push && git push --tags
```

1. Pushing tags like `v0.1.1` triggers `.github/workflows/release.yml`, which:

- installs with `npm ci`
- publishes with npm trusted publishing (OIDC) and provenance (`npm publish --provenance --access public`)

## Manual Publish Fallback

```bash
npm run release:prepare
npm publish --access public --provenance
```
