# Vendored UI sources

This directory contains a fixed, source-level UI snapshot used to build the Codex Plus Web/PWA shell. It is deliberately not a runnable copy of DeepSeek Harness Desktop.

## Official DeepSeek Harness UI

- Repository: https://github.com/deepseek-ai/deepseek-harness
- Commit: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Package version: `0.1.1-rc.2`
- License: MIT; see `official/LICENSE`
- Copied scope: selected `packages/client/ui-*` packages only
- Explicitly omitted: `ui-brand-official`, Host/Agent/LLM/server/runtime/connection/boot code and all product branding assets

The files under `official/` are unchanged upstream source snapshots. Codex Plus imports only visual styles or ports selected components into ordinary React props. Nothing in this directory may be used to boot a DSH Host or contact a DSH server.

## Anywhere Labs Desktop composition

- Repository: https://github.com/anywhere-labs/deepseek-harness-desktop
- Reviewed branch commit: `48c8ea7e471dfcdf8c1cac06ab0ead79de8886e4`
- Reviewed release: `v2.0.2`
- License: MIT; see `anywhere-labs/LICENSE`
- Copied scope: `AdvancedFrame.tsx`, `layout-state.ts`, and `styles.ts` as layout references
- Third-party notice: `anywhere-labs/THIRD_PARTY_NOTICES.md`

Anywhere Labs' desktop repository delegates its sidebar, conversation, details, and most product UI to the official DSH submodule above. Its copied files are references for composition only and are not part of the production dependency graph unless explicitly adapted later.

## Product boundary

Codex Plus is not DeepSeek Harness and does not use DeepSeek's Agent, model providers, credentials, profile, telemetry, marketplace, update service, filesystem service, shell, or Host transport. The execution path remains:

`Codex Plus Web/PWA -> Relay -> Windows Companion -> official codex app-server`.

See `docs/DSH_UI_ADOPTION.md` for the complete adoption and exclusion policy.
