# Repository-specific deployment mechanics

Run commands from the user's selected checkout unless a server deployment directory is explicitly named. Resolve and validate paths first; example Origins below are placeholders, never author-operated endpoints.

## Source and image

The source uses Node.js 26 / pnpm 10 for Windows development. `Dockerfile` defines its own Linux runtime. Inspect the current files before changing pins.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm codex-web:build
```

The real Web build is `.tmp/codex-web`, with a DSH boundary check. The independent mobile/Windows visual previews are not production entry points.

Build a project-local image with the root Dockerfile, for example `docker build -t fardock-gateway:local .`. The optional build argument is `CODEX_PLUS_NPM_REGISTRY`; use a registry chosen by the user when needed. A restricted-network server can receive an image produced by `docker save` and load it with `docker load`; transfer the opaque file rather than unpacking/repacking it. Do not publish an external image unless requested.

Prepare the Windows CLI at the location expected by `scripts/start-windows-companion.ps1` and `scripts/build-windows-companion-release.mjs`. Read their current pin and use the official platform package; do not borrow or update the Codex App installation. Release builds also require the upstream CLI license material used by the packaging script. If it is missing, fetch the corresponding official license files or stop packaging; a source/UI preview can still be verified.

## Private files and initial identity

Check whether `.data/windows-companion/identity.dpapi` already exists. For an existing installation, preserve it and the action database/anchor. Do not run `create` just to repair a connection.

For a new installation, the existing helper creates the identity and an opaque, ACL-restricted bootstrap export:

```powershell
$repo = (Resolve-Path .).Path
$identity = Join-Path $repo '.data/windows-companion/identity.dpapi'
$bootstrap = Join-Path $repo '.tmp/windows-companion/relay-bootstrap'
pnpm --filter @codex-plus/windows-agent exec tsx src/bootstrap-cli.ts create --workspace-root "$repo" --identity-file "$identity" --export-file "$bootstrap"
```

`bootstrap-cli.ts` is the authoritative argument parser. The export is a base64url secret file, not a JSON config. Copy it unchanged through the approved SSH/SCP channel to the deployment directory's `secrets/relay-bootstrap`; never read, echo, decode into chat, or place it in a command argument. If a prior export exists, do not overwrite or rotate it without determining whether registration already succeeded.

The Owner helper is `scripts/create-owner-verifier.ps1`. Have the user enter their username/password privately in that helper's terminal. It writes `.tmp/windows-companion/owner-verifier.json`. Copy the file as an opaque artifact to `secrets/owner-verifier.json`, outside the Web root; do not inspect its contents. No password belongs in `.env`.

## Server Compose and proxy

Copy `compose.yaml`, `compose.bootstrap.yaml`, and `.env.example` to the user-approved runtime directory, separate from the source checkout. Put private configuration in that directory's `.env`:

- `CODEX_PLUS_GATEWAY_IMAGE`: the image actually built/loaded.
- `CODEX_PLUS_PUBLIC_ORIGIN`: one exact HTTPS Origin without credentials, path, query or fragment.
- `CODEX_PLUS_TRUSTED_PROXY_IPS`: exact IP literals for the real reverse-proxy hop; no wildcard, CIDR, hostname, or forwarded-header self-report. Do not assume the sample address matches Docker on this host.
- `CODEX_PLUS_LOG_LEVEL`: normally `info`.

The service listens on host loopback `127.0.0.1:8787`, runs as UID/GID 10001, and mounts `data/` plus the read-only verifier. `scripts/init-gateway-host.sh <deployment-root> <gateway-image>` prepares ownership and modes using the project image. Its deployment directory must be absolute, contain `compose.yaml`, and must not itself be a Git checkout. Read the helper before using it on an existing deployment.

Validate `docker compose config` with bounded output before startup. For a **new** registration, from the runtime directory:

```sh
docker compose -f compose.yaml -f compose.bootstrap.yaml up -d gateway
```

Use the existing reverse proxy for the selected domain with WebSocket upgrade forwarding and the required trusted Host/proto headers. Preserve unrelated virtual hosts. Never expose the Vite development server as the real app.

Start the Windows Host with its own Origin after its runtime/identity are prepared. The public starter supports:

```powershell
.\scripts\start-windows-companion.ps1 -Origin https://gateway.example.com
```

For a GUI package, set `CODEX_PLUS_PUBLIC_ORIGIN` before `pnpm companion:release`; the resulting package remains a local installation artifact. The packager can include local operating paths, so do not upload a personal package as a generic release.

After authenticated registration and persisted registration closure, return the Gateway to normal configuration:

```sh
docker compose -f compose.yaml up -d --force-recreate gateway
```

This recreates only the named project service. Confirm it remains healthy and the Host reconnects without the override, then remove only the now-unneeded bootstrap export files. The production runner clears its local bootstrap material on authenticated registration; do not call `mark-registered` based solely on container health. Never delete `data/relay-state.json` to reopen registration.

## Acceptance and rollback

Check TLS, `healthz`, container health/restart state, Host authentication, and the user's real browser flow. Account login, E2EE authorization and task authority are separate checks. A successful pairing code is single-use and expires within five minutes; no QR camera or manual SAS confirmation is part of the current production flow.

For an upgrade, retain the prior project image/config and state before replacing only `gateway`. Roll back that image/config if startup or the authenticated connection fails; preserve authorization and action state. Never use a global Docker prune, daemon restart, server reboot, or unowned process kill as an automatic fallback.
