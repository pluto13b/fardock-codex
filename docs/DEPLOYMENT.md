# Self-hosted deployment entry

Use your own server, domain and Windows host. No author-operated endpoint or credentials are included. All domains ending in example.com, example.test or example.invalid and RFC 5737 addresses are placeholders.

## Preparation

1. Read [Docker Gateway](DOCKER_GATEWAY.md), [security](SECURITY.md), and [Windows Agent](WINDOWS_AGENT.md).
2. Prepare a Linux Docker server and a TLS reverse proxy for your own domain. Forward HTTPS/WSS only to the Gateway; do not expose Vite development ports.
3. Copy the tracked configuration examples into private local configuration. Set your own public Origin, trusted proxy addresses and state paths. The loopback trusted-proxy example is not a substitute for determining the actual proxy hop in your deployment.
4. Create the Owner verifier interactively using `scripts/create-owner-verifier.ps1`. Keep the verifier, TLS keys and Host bootstrap exports out of Git. Never put Owner or SSH passwords in command lines or README examples.
5. Prepare the official Codex CLI and Host bootstrap identity according to the Windows instructions. The Companion reuses the normal Windows user's Codex environment without reading or exporting OpenAI credentials.
6. Start the Gateway and connect the Windows Companion with your own explicit Origin. The public starter accepts `-Origin https://gateway.example.com` as a placeholder; replace it before use.
7. Log in to Owner in the mobile browser. Use Windows “连接手机” for the first short-lived pairing code, then verify task reading and a harmless test message in your own test task.

## Packaging

The Windows build is a source-oriented candidate workflow, not a turnkey deployment installer. Set `CODEX_PLUS_PUBLIC_ORIGIN` to your own Origin before `pnpm companion:release`. Prepare the pinned official CLI and its license material as described in [Windows Release](WINDOWS_RELEASE.md). No public binary assets are attached to this initial source publication.

Runtime state, logs, generated files and caches live under .data, .tmp and .cache and are ignored. Keep them private. Operational SSH configuration is outside this source distribution.

Detailed configuration fields and health/authorization checks are documented in [Docker Gateway](DOCKER_GATEWAY.md). The older internal hosting records have been removed from this public snapshot.
