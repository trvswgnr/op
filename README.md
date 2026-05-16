# prodkit monorepo

This repository is the `prodkit` monorepo, managed with pnpm workspaces and Turborepo (`turbo`).
It is organized for multiple publishable packages plus dedicated top-level workspaces for apps,
examples, benchmarks, and maintainer tooling.

## canonical package docs

Use each publishable package README under `packages/*/README.md` as the source of truth for that package's installation, API reference, usage examples, and consumer-facing commands:

- [`@prodkit/op`](packages/op/README.md) (published to npm with the package)
- [`@prodkit/std`](packages/std/README.md), including the `@prodkit/std/di` entrypoint

Other workspace roots are maintainer- or CI-oriented: [`examples`](examples/) (`@prodkit/examples`), [`tools`](tools/) (`@prodkit/tools`), and [`benchmarks`](benchmarks/).

## workspace layout

- `packages/*`: publishable library packages
- `apps/*`: runnable product/demo applications
- `examples`: consumer examples and smoke workspace (`@prodkit/examples`)
- `benchmarks/*`: performance benchmark harnesses
- `tools`: maintainer tooling workspace (`@prodkit/tools`)
- `.github/workflows`: CI and release automation

## development

- contributor guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- `@prodkit/op` runtime/design notes: [`packages/op/DESIGN.md`](packages/op/DESIGN.md)
- `@prodkit/op` changelog: [`packages/op/CHANGELOG.md`](packages/op/CHANGELOG.md)
- `@prodkit/std` changelog: [`packages/std/CHANGELOG.md`](packages/std/CHANGELOG.md)

Primary quality gate:

```bash
pnpm run gate
```

## release flow

Pushing a semver tag (`v*`) triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which today publishes **`@prodkit/op`** only (trusted publishing + provenance). Release helpers live on that package:

```bash
pnpm --filter @prodkit/op run release:patch
pnpm --filter @prodkit/op run release:push
```

`@prodkit/std` can be published manually from a clean `main` when needed (`pnpm --filter @prodkit/std publish ...` after version bump and changelog); there is no separate tag-driven workflow for it yet.

## license

[MIT](LICENSE)
