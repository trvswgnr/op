# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added `src/test-utils.ts` to centralize shared integration-test helpers
  (`deferred`, abort-listener tracking, async timing helpers, and invalid
  concurrency fixtures) so new test files can reuse one source of truth.
- Added focused `core` runtime unit coverage for `drive` internals (signal
  handoff, instruction validation, finalizer LIFO ordering, and cleanup-fault
  precedence), plus direct tests for internal helper/type-guard behavior.
- Added `DESIGN.md` documenting execution invariants (cleanup ordering, error
  precedence, and combinator chain-order guarantees) with direct links to
  representative runtime paths and tests to reduce semantic drift risk.

### Changed

- Documented the cooperative cancellation contract in `README.md`, including
  explicit runtime guarantees, caller responsibilities, and a composed
  `Op.all(...).withTimeout(...).withSignal(...)` wiring example.
- Locked `Op.any`/`Op.race` loser semantics so aborted branches now finish
  cleanup/finalizers before `run()` returns, while preserving first-settler
  result precedence to keep outcome behavior stable.
- Added inline concurrency-contract comments for combinator drivers and policy
  signal/timeout helpers so contributors can reason about abort propagation,
  cleanup timing, and settle precedence without rediscovering edge cases.
- Clarified contributor testing governance with an explicit two-tier strategy in
  `CONTRIBUTING.md`, including unit vs integration scope boundaries and a
  no-duplication decision rule for placing assertions.
- Consolidated compile-time API contracts into a dedicated `src/types.test.ts`
  file and removed scattered `expectTypeOf` assertions from runtime behavior
  tests so type regressions can be audited in one place.
- Strengthened algebraic correctness checks by replacing fixed-case monad law
  assertions with property-based tests and adding randomized `Result` algebra
  coverage for `map` and `andThen` composition laws.

## [0.1.53] - 2026-05-02

### Changed

- Hardened release cut automation so changelog promotion is formatted before
  validation checks run.
- Kept release behavior consistent when `Unreleased` is empty by generating a
  minimal release note automatically.
- Consolidated release scripts so cuts promote changelog entries, bump version,
  and tag in one flow.
- Aligned CONTRIBUTING release guidance with the automated cut path.
- Captured and validated intermediate release-candidate behavior that
  previously failed changelog/version gating.

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
