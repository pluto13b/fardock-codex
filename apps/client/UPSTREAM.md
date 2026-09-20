# Upstream provenance

This client is derived from [`slopus/happy`](https://github.com/slopus/happy),
commit `eb980a5c9eea25b1c145c06cd6241a0a365c2b6d`, package
`packages/happy-app`, under the MIT License in `LICENSE`.

Codex Plus intentionally omits upstream deployment credentials/configuration
and will progressively remove hosted Happy services, analytics, purchases,
social features, voice features, and non-Codex agent paths. Product-specific
changes are documented in the repository history and `docs/PROGRESS.md`.

The desktop conversation message anchor rail is adapted from
[`iOfficeAI/AionUi`](https://github.com/iOfficeAI/AionUi), commit
`573927d46d3681182bbea36f8b9aa6dbc7296648`, directory
`packages/desktop/src/renderer/pages/conversation/Messages/anchorRail`, under
the Apache License 2.0. It was rewritten for React Native Web and the existing
inverted `FlatList`; the Electron, database, search, and full-history loading
paths were not copied.
The complete upstream Apache-2.0 license is distributed alongside this client
as [`LICENSE-AIONUI-APACHE-2.0`](./LICENSE-AIONUI-APACHE-2.0).
