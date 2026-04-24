# Contributing

## Contributor Runtime

- Node `>=24.14.0` is required for local development and release tasks.

## Local Quality Gate

Run the same checks used before publishing:

```bash
npm run check
```

The quality gate includes a consumer-level smoke test that installs the package from an `npm pack`
tarball via `examples/`.

All examples are consumer-level and live under `examples/*`.

## Source Layout

- Public package entrypoint stays at `src/index.ts`.
- Internal runtime concerns are split into focused modules under `src/`:
  - `core-op.ts` (core operation contracts and execution)
  - `op-builders.ts` (primitive operation constructors)
  - `op-policies.ts` (retry, timeout, and signal policies)
  - `op-combinators.ts` (all/any/race combinators)
  - `errors.ts`, `result.ts`, `typed.ts` (shared domain contracts)
- Test layout follows intent:
  - `src/index.test.ts` for public API contract coverage
  - `src/core-op.test.ts` for internal runtime behavior

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
- runs `npm run check`
- publishes with provenance (`npm publish --provenance --access public`)

## Manual Publish Fallback

```bash
npm run release:prepare
npm publish --access public --no-provenance
```
