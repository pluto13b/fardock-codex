# Project working rules

These rules apply to all work in this repository.

## Documentation first

- Before a material implementation change, update the relevant Markdown design or requirement document.
- Keep `docs/PROGRESS.md` current in every work session: record completed work, active work, next steps, risks, and verification results.
- If implementation and documentation disagree, stop and resolve the drift instead of silently choosing one.

## Workspace locality

- Keep source, temporary files, generated artifacts, dependency caches, test data, and logs inside this workspace whenever tools allow it.
- Use workspace-local `.cache/`, `.data/`, and `.tmp/` directories. Do not intentionally create caches or project artifacts on `C:\`.
- Do not modify the user's Codex home, Codex installation, or session store. Read-only inspection is allowed only when needed for a documented compatibility test.

## Delivery style

- Optimize for a useful product and short feedback loops. Avoid work that exists only to perfect hashes, version numbers, release ceremony, or speculative abstraction.
- Use Git in this workspace. Preserve unrelated user changes and never commit credentials or local runtime data.
- Prefer a small verified spike before adopting a large framework or fork.

## Safety

- Treat remote control and approval actions as security-sensitive.
- Never transmit or log OpenAI tokens, `auth.json`, arbitrary environment variables, or unrestricted filesystem contents.
- Any ambiguous UI Automation or protocol state must fail closed and fall back to read-only mode.
