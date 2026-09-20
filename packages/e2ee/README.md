# Codex Plus E2EE

Pure Web Crypto implementation of the R3 pairing and encrypted-channel boundary.

This package has no socket, filesystem, IndexedDB, environment, Codex, Relay, or platform key-store access. Callers provide `CryptoKey` handles and persist authorization/generation/sequence state through platform-specific adapters. The normative design is [`docs/E2EE.md`](../../docs/E2EE.md).
