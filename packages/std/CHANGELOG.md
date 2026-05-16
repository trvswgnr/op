# Changelog

## Unreleased

- Renamed DI yield and wrapper types for clarity (`RequireContext`, `EmbedCtxOp`, `CtxOpBase`, `ContextReq`), aligned runtime `_tag` / brand with `Ctx.Op`, and renamed internal helpers (`toPlainOp`, `createContextOp`, `resolveIfCtxOp`, etc.).
- Removed the local abort-signal stub; `.withSignal` uses `AbortSignalLike` from `@prodkit/op/internal`.
- Replaced local `unsafeCoerce` usage with `@prodkit/op/internal` so helpers stay centralized.
- Changed `@prodkit/op` to a peer dependency so consumers install a single compatible `@prodkit/op` alongside `@prodkit/std`.
- Added the initial `@prodkit/std` package with `@prodkit/std/di` helpers for yieldable context tokens and context-aware `Op` wrappers.
- Added DI regression coverage for defaulted and rest-parameter context operations.
- Changed DI provisioning to use `Ctx.Service(...)`, `Service.of(value)` provider values, and variadic `.use(...)` calls.
- Changed DI operation construction to avoid inspecting generator `Function.length`.
