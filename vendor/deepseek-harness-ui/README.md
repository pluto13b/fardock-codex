# DeepSeek Harness UI snapshot

This is a vendored source reference, not a package workspace. Production applications must import an explicit allowlist of stateless styles/components and must pass `scripts/verify-dsh-ui-boundary.mjs`.

- `official/`: selected official DeepSeek Harness UI packages at the commit recorded in `UPSTREAM.md`.
- `anywhere-labs/`: the small Desktop frame/layout reference and its notices.

Do not run package scripts from this directory and do not add the copied package manifests to `pnpm-workspace.yaml`.
