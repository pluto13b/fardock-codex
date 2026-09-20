# Codex Serve Client boundary

This package is the only data/action boundary consumed by the Codex Plus Web UI. It contains transport-neutral DTOs plus an in-memory fixture client; it does not open sockets, call a model API, or import a DSH runtime.

## Authoritative state

Every `TaskSnapshot` is an authoritative projection and carries:

- the owning host and its connection generation;
- a monotonically increasing task revision, event sequence, and opaque resume cursor;
- the active turn id, when one exists;
- an explicit capability map. Missing or false capabilities deny the action.

Every task mutation includes a client-generated `actionId` and the expected host id, connection generation, and task revision. A stale or ambiguous expectation is rejected locally before a transport implementation sends anything. `sendTurn` also carries the exact model, reasoning effort, and permission settings selected for that turn.

Approval and question requests carry their task/turn owner, host generation, expiry, and a single-use nonce. A response must echo all of those fields. Reusing the nonce under a different action, resolving an expired or already-resolved request, or resolving a request from a stale snapshot fails closed.

## Fixture client

`createFixtureCodexServeClient()` clones the exported fixture data into an isolated in-memory client. It implements the same query, resumable event, turn, interrupt, approval, and question methods as a future Relay client. It performs no I/O. All mutations are checked against authoritative capabilities, ownership, generation, revision, expiry, and idempotency before changing local state.

The exported `fixtureWorkspaces`, `fixtureTasks`, and `fixtureSnapshots` remain immutable seed data for visual previews. Production code should depend on a `CodexServeClient` instance rather than importing those seeds directly.
