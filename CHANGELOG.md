# Changelog

All notable changes to this project are documented in this file.

This format follows Keep a Changelog and the project remains in alpha, so
breaking changes may occur between minor releases.

## [Unreleased]

### Added

- No entries yet.

## [0.1.53] - 2026-05-02

### Changed

- No user-facing changes in this release.

## [0.1.52] - 2026-05-02

### Changed

- No user-facing changes in this release.

## [0.1.51] - 2026-05-02

### Changed

- No user-facing changes in this release.

## [0.1.50] - 2026-05-02

### Added

- Added a release guard that requires a changelog heading matching the current
  package version before publish steps run.

## [0.1.49] - 2026-05-02

### Added

- Added the first project changelog and captured the pre-changelog release
  history to establish a stable baseline for future release notes.

## [0.1.1 - 0.1.48] - 2026-05-02

### Added

- Established the core `Op` model with typed `Result` outcomes, generator-first
  composition, and fluent operation chaining.
- Added policy primitives and composition APIs, including retry, timeout,
  signal-aware execution, and core combinators (`all`, `allSettled`, `any`,
  `race`).
- Added lifecycle and cleanup capabilities across operation runs, including
  release/finalizer hooks and generator-scoped deferred cleanup.
- Expanded examples and smoke coverage for realistic consumer install paths.

### Changed

- Evolved API naming and ergonomics over time (for example `Op.pure` -> `Op.of`,
  `suspend` -> `Op.try`, and lifecycle hook API updates) to improve clarity and
  consistency.
- Standardized outcomes on `better-result` and aligned public re-exports around
  explicit API surface decisions.
- Reworked internal architecture to reduce wiring drift, centralize fluent op
  construction, and improve maintainability of core execution paths.
- Strengthened type safety and typing clarity, including cast policy guidance,
  tighter inference behavior, and explicit handling of unavoidable TypeScript
  limitations.
- Hardened release, CI, and smoke workflows around trusted publishing and
  consumer-style verification.

### Fixed

- Improved cleanup and cancellation reliability across error, timeout, and abort
  paths, including generator finalization behavior.
- Tightened combinator and policy behavior in edge cases (listener teardown,
  retry timing, and composed operation semantics).
- Improved examples and parsing validation in places where earlier behavior
  could produce weaker diagnostics or drift from production expectations.
