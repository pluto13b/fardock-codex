# Codex Plus protocol

Strict, versioned DTOs and state guards shared by the Web client, Relay, and Windows Companion.

This package does not open sockets, persist state, perform Codex RPC, or call Web Crypto. R1 fixed the carrier and application boundaries; R2 added strict Relay control codecs; R3a adds the strict signed invitation, pair join/result, authorization grant, daily session handshake, key-confirm control DTOs, and every deterministic signature/AAD/transcript/KDF input encoder.

Pairing ciphertext is independently capped at 8 KiB inside a 16 KiB frame. Hashes, challenges, and secrets are exactly 32 bytes after base64url decoding; P-256 raw signatures are exactly 64 bytes. Invitation decoding requires the expected deployment origin and fails on any mismatch before a caller performs network or crypto work.

The normative designs are [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md), [`docs/RELAY.md`](../../docs/RELAY.md), and [`docs/E2EE.md`](../../docs/E2EE.md).
