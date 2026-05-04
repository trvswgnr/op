# Benchmarks

This harness exists to answer two questions:

1. Did this branch regress vs the latest commit on `main`?
2. How does this branch compare to the latest published npm release?

## What is measured

Runtime scenarios (via `tinybench`):

- Single-op overhead (`Op.of(...).run()` vs raw async resolve)
- Parallel aggregation (`Op.all` vs `Promise.all`)
- Retry overhead (`withRetry` vs a hand-rolled retry loop)
- Timeout overhead (`withTimeout` vs `Promise.race` + `setTimeout`)

Bundle-size scenario:

- package ESM entrypoint minified bytes
- package ESM entrypoint minified+gzip bytes

## Commands

From repo root:

```bash
npm run bench
npm run bench:main
npm run bench:npm
```

- `npm run bench` defaults to `--baseline=main`.
- Use `bench:npm` when you want drift against the latest published package.

## Contributor guidance

- Treat all numbers as directional and machine-dependent.
- Compare runs on the same machine and similar background load.
- Focus on relative deltas more than absolute ops/sec.
- If a regression appears, rerun once before concluding.
- Keep benchmark scenario semantics equivalent when adding/changing tests.
