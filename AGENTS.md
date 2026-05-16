## Evergreen Maintenance Protocol

- Treat this file as living memory: update it whenever durable user preferences or stable workspace facts become clear.
- Capture only durable signals; do not add task-specific notes, temporary debugging details, or one-off preferences.
- If a new signal contradicts an existing bullet, replace the old bullet instead of adding both.
- Keep bullets short and decision-relevant so future agents can scan this file quickly.
- Review this file before major edits and after finishing major tasks to keep memory fresh.

## Learned User Preferences

- Prefers principal-level technical reasoning with clear tradeoffs and long-term system impact.
- Prefers agreeing on API/design direction before implementation when requirements are ambiguous.
- Prefers `.run(...args)` to stay args-only; cancellation/config should compose fluently (for example via `.withSignal(...)`) rather than be passed to `run`.
- Prefers user-facing docs and comments to emphasize outcomes and usage over internal implementation details.
- When requesting commit message drafts, prefers why-focused messages grounded in the actual staged/unstaged diff.
- Prefers commit message drafts to use the simplest fitting body shape (none, one sentence, or bullets) rather than forcing multiple bullets.
- Prefers file relocations to be done with move operations first (for example `mv`) followed by minimal targeted edits, not full-file rewrites.
- Wants `pnpm run gate` run after completing work, before considering anything "done".
- Does not want GitHub issues moved to `Done` without explicit approval first.
- For issue hierarchies, prefers real GitHub parent/sub-issue links over markdown-only checklists.
- Wants issue-work flows to keep `packages/op/CHANGELOG.md` `Unreleased` updated, but prefers to handle version/tag/publish release steps personally unless explicitly delegated.
- Prefers hard-cutover transitions, not gradual deprecations and migrations (this project is in alpha, so intentional breaking changes are acceptable)
- Prefers the library to avoid throws whenever possible (normalize when able, otherwise surface as `Err(UnhandledException)` at run time).

## Learned Workspace Facts

- `pnpm install` must be run outside the sandbox (request full permissions / non-sandbox); it hangs or fails reliably in the default sandbox.
- Run `pnpm run gate` outside the sandbox by default; its smoke step builds a temporary mini-pnpm workspace (reuses the repo `catalog:` block), runs `pnpm install` there, then `pnpm --filter @prodkit/examples run smoke`, which reliably times out or hangs in restricted/no-network sandboxes.
- Contributors need Node >=24.14.0.
- Contributors should use `pnpm@10` locally (CI/release stays pinned to `10.11.0`).
- Shared workspace dev-tool versions (`typescript`, `vitest`, `oxfmt`, `oxlint`, `tsdown`, `@vitest/coverage-v8`) are declared once under `catalog:` in `pnpm-workspace.yaml`; workspace packages (including `packages/*`, repo root, `examples`, `tools`, `benchmarks/*`) reference them as `"catalog:"`. Pack/runtime smoke harnesses also use `pnpm` so those manifests stay valid outside the main workspace checkout.
- npm publishing is configured with GitHub Actions trusted publishing (OIDC + provenance), not long-lived `NPM_TOKEN` auth.
- The library is designed to be runtime-agnostic, not Node-specific in behavior.
- CI verifies the runtime-agnostic claim with a separate Bun, Deno, and Miniflare runtime smoke matrix.
- The project is currently alpha-stage with no production users, so intentional breaking changes are acceptable.
- Workspace taxonomy: `packages/*` (publishable), `examples` (`@prodkit/examples`, consumer smoke workspace), `benchmarks/*` (performance harnesses), `tools` (`@prodkit/tools`, maintainer scripts), and `apps/*` reserved for runnable product/demo apps.
- `@prodkit/std` is the standard-library package; dependency-injection helpers are imported directly from `@prodkit/std/di` and exposed as `di` on root namespace imports.
- GitHub repository canonical path is `trvswgnr/prodkit` (renamed from `trvswgnr/op`).
