## Evergreen Maintenance Protocol

- Treat this file as living memory: update it whenever durable user preferences or stable workspace facts become clear.
- Capture only durable signals; do not add task-specific notes, temporary debugging details, or one-off preferences.
- If a new signal contradicts an existing bullet, replace the old bullet instead of adding both.
- Keep bullets short and decision-relevant so future agents can scan this file quickly.
- Review this file before major edits and after finishing major tasks to keep memory fresh.

## Learned User Preferences

- Prefers principal-level technical reasoning with clear tradeoffs and long-term system impact.
- Prefers `.run(...args)` to stay args-only; cancellation/config should compose fluently (for example via `.withSignal(...)`) rather than be passed to `run`.
- Prefers user-facing docs and comments to emphasize outcomes and usage over internal implementation details.
- When requesting commit message drafts, prefers why-focused messages grounded in the actual staged/unstaged diff.
- Prefers commit message drafts to use the simplest fitting body shape (none, one sentence, or bullets) rather than forcing multiple bullets.
- Prefers file relocations to be done with move operations first (for example `mv`) followed by minimal targeted edits, not full-file rewrites.
- Wants `npm run check` run after completing work, before considering anything "done".

## Learned Workspace Facts

- This library supports Node >=20 for consumers; contributors need Node >=24.14.0.
- npm publishing is configured with GitHub Actions trusted publishing (OIDC + provenance), not long-lived `NPM_TOKEN` auth.
- The library is designed to be runtime-agnostic, not Node-specific in behavior.
- The project is currently alpha-stage with no production users, so intentional breaking changes are acceptable.
