---
name: fardock-deploy
description: Deploy or update FarDock (fardock-codex) on a user's Windows host and self-hosted Docker Gateway, including private configuration, initial pairing, and verification. Use for FarDock installation or deployment assistance; UI-only preview requests do not need a real deployment.
---

# FarDock deployment assistant

Help the user reach a working Windows → Docker Gateway → Android browser connection. Reuse the repository's deployment helpers and protocol; do not invent another authentication or relay design.

## Establish the target

Locate the user's FarDock checkout and read its `AGENTS.md`, `README.md`, `compose.yaml`, `compose.bootstrap.yaml`, and `.env.example`. The skill may be installed outside the checkout: resolve repository files from the chosen checkout, not from the skill directory.

Use values already supplied in the conversation. Ask only for missing deployment inputs: the checkout/Windows host, an existing SSH connection alias or other approved server access, the project deployment directory, the HTTPS Origin, and whether this is a fresh installation or an upgrade. These are private operating inputs, not source defaults. Do not ask for passwords, SSH keys, API tokens or Codex credentials in chat.

Reuse existing state when upgrading. Do read-only preflight first: Node/pnpm versions, Docker/Compose availability, free disk space, relevant port use, the named project's existing containers, and file existence/permissions. Do not enumerate unrelated processes or manage Codex App/VS Code. Keep local artifacts in the checkout's `.cache`, `.tmp`, or `.data`.

Read [references/deployment.md](references/deployment.md) before initial bootstrap, Compose changes or a release build. Read the checkout's `docs/DOCKER_GATEWAY.md` and `docs/WINDOWS_AGENT.md` for current field definitions; dated development notes are not proof that the user's environment is configured.

## Carry out the authorized work

- Continue routine project setup, build and validation within the user's deployment authorization; do not request confirmation again for each reversible step. Changing unrelated sites, server-wide services, DNS/TLS outside the requested domain, or deleting data/caches needs its own applicable authorization.
- Keep source and server runtime directories separate. Copy Compose templates into the chosen deployment directory; its `data/`, `secrets/`, and private `.env` are not source artifacts. Replace example domains with the user's Origin in private configuration only.
- Choose an available build route. Build locally or on the authorized Docker host; if the server cannot reach dependencies, use an approved registry or transfer a locally built image through the user's secure channel. Do not disable TLS verification, silently install a proxy, or use a stranger's preconfigured service.
- Have the user run the Owner verifier helper in their own interactive terminal. The agent can verify the output file's existence/permissions and copy it through the approved secure channel without opening or printing it. Official Codex login is likewise completed by the user through the normal official flow; never read `auth.json` or create a second Codex profile to evade login.
- For initial Host registration, use the existing Windows bootstrap helper, transfer its exported secret as a file, and remove the bootstrap Compose override only after authenticated Host registration and persisted closure. An upgrade must not recreate identity, reset relay state, or reopen registration.
- Use only production Web output for real deployment. `mobile-ui:preview`, simulated tasks, and the displayed 48 ms latency are UI demonstrations and are not health or security evidence.

If a step fails, diagnose the specific failure and preserve the last working project configuration. Stop a retry that repeats the same error without new evidence. Disk exhaustion is not permission to prune other containers, volumes, global caches or restart Docker/the server.

## Verify and hand off

Verify the configured HTTPS endpoint and certificate, loopback-only Gateway binding, container health, and the authenticated Host connection using bounded status output. Do not dump environment variables, secret files or unrestricted container logs. Sanitize user-specific addresses and paths from any report intended for GitHub.

Let the user log in to Owner and enter the short-lived code shown by Windows “连接手机”; do not collect the code in chat. Check task listing, reading, and one user-authorized harmless message in a test task, then a browser return-to-foreground check. Keep a busy external task read-only if ownership is uncertain.

Report what was actually deployed and tested, the private operating paths the user needs, unresolved blockers, and how to stop/roll back only this project's service. Distinguish a completed UI preview, a healthy Gateway, and a verified end-to-end installation. Do not claim a fully working deployment from `healthz` alone.
