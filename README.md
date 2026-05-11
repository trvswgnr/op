# prodkit monorepo

This repository is the `prodkit` monorepo, managed with pnpm workspaces and Turborepo (`turbo`).
It is organized for multiple publishable packages plus dedicated top-level workspaces for apps,
examples, benchmarks, and maintainer tooling.

## canonical package docs

Use each package README under `packages/*/README.md` as the source of truth for that package's:

- installation
- API reference and semantics
- usage examples
- consumer smoke commands

Example: `@prodkit/op` docs live at [`packages/op/README.md`](packages/op/README.md), and that README is shipped with the published npm package.

## workspace layout

- `packages/*`: publishable library packages
- `apps/*`: runnable product/demo applications
- `examples/*`: consumer-style example and smoke workspaces
- `benchmarks/*`: performance benchmark harnesses
- `tools/*`: maintainer tooling workspaces
- `.github/workflows`: CI and release automation

## development

- contributor guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- runtime/design notes: [`packages/op/DESIGN.md`](packages/op/DESIGN.md)
- package changelog: [`packages/op/CHANGELOG.md`](packages/op/CHANGELOG.md)

Primary quality gate:

```bash
pnpm run gate
```

## release flow

Release commands live in package workspace scripts and are executed from repo root via pnpm filters.

Example (`@prodkit/op`):

```bash
pnpm --filter @prodkit/op run release:patch
pnpm --filter @prodkit/op run release:push
```

Pushing the version tag triggers `.github/workflows/release.yml`, which performs trusted npm publishing.

## license

[MIT](LICENSE)
