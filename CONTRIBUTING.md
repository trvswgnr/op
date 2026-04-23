# Contributing

## Contributor Runtime

- Node `>=24.14.0` is required for local development and release tasks.

## Local Quality Gate

Run the same checks used before publishing:

```bash
npm run check
```

## Release Workflow (Recommended)

1. Run local release checks:

```bash
npm run release:prepare
```

2. Bump package version (`patch`, `minor`, or `major`):

```bash
npm version patch
```

3. Push commit and tag:

```bash
git push && git push --tags
```

4. Pushing tags like `v0.1.1` triggers `.github/workflows/release.yml`, which:
   - installs with `npm ci`
   - runs `npm run check`
   - publishes with provenance (`npm publish --provenance --access public`)

## Manual Publish Fallback

```bash
npm run release:prepare
npm publish --access public --no-provenance
```
