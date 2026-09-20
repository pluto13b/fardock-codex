# R5 in-memory pairing and ready-session runtime

> Production D9 update: this document preserves the original R5 loopback acceptance history. The current production UI no longer scans QR codes or asks the user to compare SAS. An already-authorized E2EE management session creates an invitation, Gateway exposes only an eight-character in-memory pairing code to the logged-in owner, and Windows auto-approves that exact invitation. Direct/bootstrap invitations retain the fail-closed local-decision path.

## First usable boundary

The first runnable pairing slice reuses the checked-in signed pairing and session APIs without inventing another handshake. It is intentionally ephemeral: browser refresh or either process restart destroys all private keys, authorization material, generation state, sequence state, and ready channels, so the user must scan a new two-minute invitation. No private key or rendezvous secret is written to localStorage, IndexedDB, logs, URLs outside the fragment, or Relay state.

The exact route is:

1. authenticated Windows Host opens `pair.open` on the R3 Relay;
2. Web parses the invitation fragment in memory and immediately clears it from browser history, creates one `pair.join`, and sends it as the anonymous socket's first frame;
3. Host strictly opens the join and obtains the opaque local confirmation capability;
4. an injected **local Windows decision callback** displays the device label, SAS, signing fingerprint, and expiry; only an explicit local `approve` may continue, while timeout/error defaults to deny;
5. Host claims the exact join, durably applies the authorization to the Relay through the existing Host carrier, creates the signed encrypted result, and closes the one-shot pair session;
6. the approved Web device challenge-authenticates to Relay, sends signed `session.init`, receives signed `session.accept`, performs key confirmation, and receives Host ready;
7. only then may the existing ready-channel carrier/transport and Windows ready-session handler be created.

Relay receipts and pair/session carrier acknowledgements never authorize an app-server action. The Host local confirmation capability, signed grant, current authorization record, signed session handshake, confirm/ready, and durable action lease remain separate gates.

## Deferred work

This slice does not add automatic approval, browser persistence, Windows DPAPI/CNG storage, reconnect, public WSS, UI redesign, stream, interrupt, approval/question handling, or attachments. Ephemeral re-pairing is a deliberate shortcut for the first loopback product; production deployment remains blocked until platform key and generation persistence exist.

## Acceptance

- a real R3 loopback Relay carries `pair.open -> join -> claim -> approved result -> close`;
- no approved result or authorization exists without an explicit injected local Windows approval;
- the approved Client completes Relay challenge plus signed session init/accept and E2EE confirm/ready;
- the resulting Host/Client channels have the same authority and complementary key ids, then successfully carry one encrypted application request;
- fragment clearing, denial, timeout, route mismatch, and malformed frames fail closed without logging secrets.

## Local runnable entry

The checked-in local runner intentionally uses fixed loopback ports only:

```powershell
# terminal 1: owned official app-server, loopback Relay, and Companion
pnpm --filter @codex-plus/windows-agent local -- --codex-executable <absolute-codex-executable> --workspace <absolute-authorized-workspace>

# terminal 2: existing formal React UI at http://127.0.0.1:5173
pnpm codex-web:formal
```

The Companion prints one local pairing link as a user-facing terminal display; it does not write that fragment to a file or structured log. Open the link, compare the SAS/device details with the local terminal, and type the exact word `APPROVE` locally. Any other input denies. The formal page clears the fragment synchronously before loading pairing code, keeps keys and raw retransmission frames only in memory, and then renders the existing `App` with the real `CodexServeClient`—no fixture or alternate UI.

The runner puts Relay state and SQLite data under a new workspace `.tmp/remote-runtime-*` directory, owns only the child it launches, and closes its Relay, child, store, and in-memory keys on `Ctrl+C`. It is not a deployment command and cannot connect to a public hostname.
