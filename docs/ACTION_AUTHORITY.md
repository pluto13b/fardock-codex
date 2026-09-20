# Durable action authority

> Status: the durable send/steer path and D5 Companion-owned interrupt/live request authority are implemented and verified with repository fake children. D8 is adding the required DPAPI fingerprint key, SQLite rollback anchor and production runner; until those pass, production write remains closed and no running Codex App/VS Code process is attached or controlled.

## 1. Purpose and boundary

The durable action authority is the local fail-closed boundary between an authenticated E2EE application request and a mutating official app-server RPC. It prevents a Relay receipt, a decoded DTO, a TypeScript brand, a runtime compatibility record, or a caller-provided boolean from becoming write authority by itself.

The first vertical slice supports only:

- an existing authorized task;
- `turn.send` containing exactly one text input;
- exact `thread/resume({ threadId })` followed by exact `turn/start`;
- later, after the send path is verified, `turn.interrupt` for the active turn created by that path.

The current action path supports task creation, bounded images/files, `turn.send`, same-turn `turn.steer`, exact active-turn interrupt, approve-once/deny and non-secret question answers. Generic supervisor `request()` remains read-only; only the four fixed server-request methods may enter the D5 live broker.

The first package-private E2EE bridge is intentionally narrower than the general application protocol: it accepts only an authenticated `turn.send` whose input array contains one `{ type: "text" }` item and whose model, effort and permission settings exactly match the locally expected snapshot. Every other operation, attachment, empty input, multi-part input or settings mismatch receives no action lease or app-server dispatch. Because rejecting from the private inbound commit invalidates the active E2EE channel, the bridge reports `session-closed` rather than pretending that generation remains usable; the peer must establish a fresh session before another frame. The bridge itself owns the `openEstablishedApplication` commit callback; only that callback may turn a genuine established-channel frame into a durable reservation, and only a returned opaque claimed lease may enter the action controller.

## 2. Required authority chain

A write dispatch is eligible only while all of these independent facts are current:

1. an opaque `EstablishedSessionChannel` authenticated and decrypted the canonical inbound envelope;
2. the E2EE inbound commit transaction rechecked the active authorization epoch, committed the exact next `seq/ack`, removed acknowledged raw outbound frames, and reserved the action id;
3. the action's host, client device, authorization id/epoch, task id, expected revision, operation and locally keyed canonical request fingerprint exactly match the durable record;
4. an opaque `RuntimeCompatibility` issued for the same live owned supervisor is still `write-bound` at the same supervisor generation;
5. the task remains locally authorized and is not blocked by an indeterminate earlier dispatch;
6. the one-shot durable action lease is still current and has not already been consumed.

The integration entry point owns the callback passed to `openEstablishedApplication`. It is not returned as a generic commit function. A plain `InboundFrameCommitRequest`, `{ authorized: true }`, copied action record, fabricated receipt or structurally similar lease cannot call the write dispatcher.

## 3. Canonical action identity

The idempotency key is scoped by:

```text
hostId + authorizationId + clientDeviceId + actionId
```

The durable action record additionally binds:

```text
taskId
operation
expected task revision
keyed fingerprint of the canonical protocol request body
```

The fingerprint is a domain-separated HMAC-SHA-256 over the already validated canonical application request bytes. It is produced inside the high-level inbound bridge by a platform adapter backed by a DPAPI/CNG-protected local key; it is not a bare hash, an ad-hoc reconstruction, or a value accepted from the remote client. Until that platform adapter exists, production write dispatch remains disabled. The database stores the opaque fingerprint, identifiers, bounded receipts and the exact canonical **encrypted outbound** E2EE frames required for retransmission. It never stores the user text, decrypted application body, prompt, tool output, absolute workspace path, inbound raw frame, symmetric session key or credential.

`authorizationEpoch`, `connectionGeneration`, inbound `keyId`/sequence and supervisor generation are retained as first-seen or dispatch provenance, not as part of same-action identity. The current epoch must still be active before any replay or dispatch, but an active key/session rotation cannot make the same action id executable again. A legitimate idempotent retry may arrive in a later authenticated session or after a supervisor restart. Current session and supervisor authority are always rechecked before a lease is issued or dispatched; old provenance never grants authority. A genuinely new pairing receives a new authorization id.

Rules:

- same scoped action id and same semantic binding/fingerprint returns the already persisted terminal result without another RPC;
- same scoped action id with a different fingerprint, task, operation or expected revision fails as `action-id-conflict`;
- a replay of `reserved` may return the same opaque live lease only inside the owning process; after reopen it does not recreate dispatch authority automatically;
- `dispatching` is never retried automatically;
- Relay `relayed` and protocol `queued` do not imply app-server acceptance.

## 4. Durable state machine

Each action moves monotonically:

```text
reserved -> rejected
        -> dispatching -> accepted
                       -> rejected
                       -> indeterminate
```

- `reserved`: authenticated frame and sequence commit succeeded, but no mutating RPC has been written.
- `dispatching`: the store durably recorded intent immediately before the exact RPC write.
- `accepted`: the strict app-server response and required response/body bindings passed, then the accepted receipt was durably committed.
- `rejected`: a definite pre-dispatch policy failure or definite app-server rejection was durably committed. A rejection never carries committed revision/sequence/cursor fields.
- `indeterminate`: the RPC might have crossed the child boundary but no unique accepted/rejected result can be proven. This state blocks further writes to the task until an explicit local recovery procedure proves exactly one matching upstream user message or an operator resolves it.

`accepted`, `rejected` and `indeterminate` are terminal. A process restart converts every persisted `dispatching` record to `indeterminate` before the store becomes usable. A restart does not convert `reserved` into a callable lease; the authenticated endpoint must re-establish current authority and explicitly reclaim only a still-identical reservation.

## 5. Persistence and concurrency

The Windows implementation uses one `node:sqlite` database below the configured workspace-local `.data/` directory so seq/ack, action reservation and encrypted outbound-frame deletion can share one real transaction. Tests use workspace-local `.tmp/`; they never use the system temporary directory. A separate JSON action file and raw-frame file are forbidden because they cannot satisfy the atomic inbound-commit contract after a crash.

Required persistence behavior:

- state and lock paths are absolute, drive-qualified, non-device Windows paths and must remain below the configured workspace root;
- the database uses a fixed `user_version`, `STRICT` tables, foreign keys, checked state enums, bounded identifiers and explicit row/byte ceilings;
- startup requires `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `trusted_schema=OFF` and a zero busy timeout. Any pragma mismatch fails closed;
- every mutation runs in `BEGIN IMMEDIATE` with no child RPC or other external await inside the transaction; SQLite's lock is the cross-process writer boundary and lock contention becomes backpressure/read-only;
- DB, `-wal` and `-shm` files remain beside the configured database. Controlled checkpoints and database/page limits keep them bounded;
- corrupt, oversized, unknown-version, symlink/reparse-ambiguous, missing-after-initialization or concurrently replaced state fails closed and never recreates an empty authority store;
- temporary files and test data are cleaned only inside the verified workspace-local test directory;
- logs use a fixed event whitelist and may include only event, operation, non-secret reason, counts, byte length and duration. They never spread raw records or errors.

Hard ceilings for the first slice:

- database main file: 32 MiB; WAL budget: 32 MiB with controlled checkpoints;
- authorization lineages: 64;
- tasks: 256;
- retained actions: 2,048;
- unacknowledged encrypted outbound frames per direction/generation: 16 frames, matching the E2EE channel; all lineages together share one 8 MiB raw-frame byte budget;
- identifier: the protocol's exact 1–128 character ASCII `OpaqueIdentifier` grammar;
- canonical keyed fingerprint: exactly 32 decoded bytes / 43 unpadded base64url characters;
- stored rejection message: 512 UTF-8 bytes.

The implementation cannot compact an action tombstone while its authorization lineage remains active: v1 has no monotonic action counter/floor, so deleting even an old accepted/rejected record would permit a cross-generation replay. Capacity exhaustion therefore becomes read-only/backpressure. Records may be removed only after the lineage is durably and permanently revoked, with the revocation tombstone itself retained so the authorization cannot be resurrected. An indeterminate record is never discarded merely to make space.

The first slice distinguishes an exclusive create operation from open-existing. Open-existing on a missing database fails closed. SQLite crash/corruption recovery and concurrent writers are in scope; replacement by a malicious but structurally valid historical database is not yet detectable from the database alone. Before production, a DPAPI/CNG-protected `storeId + stateRevision/action-floor` anchor must detect whole-database rollback. Until that adapter exists, the action store remains local-test only.

For D8, `stateRevision` is the action floor because every mutating SQLite transaction increments it and active authorization action tombstones are not compacted. A current-user DPAPI anchor stores only strict `version + storeId + stateRevision`; normal reopen performs the one expected recovery increment, verifies it against the prior anchor, then replaces the anchor. After every externally completed inbound/dispatch boundary the runner replaces the anchor with the current revision. A crash between DB commit and anchor replacement deliberately fails closed on next start rather than guessing whether an action crossed the boundary. Runner shutdown must first stop the carrier/app-server, then await every already-entered anchored request boundary before closing the action store. A separate explicit local recovery may advance an older anchor only when the validated database has the same `storeId`, a strictly newer revision, and an empty `actions` table; any reserved, dispatching, accepted, rejected or indeterminate action keeps recovery closed.

## 6. Atomic inbound commit

For an application action request, the callback used by `openEstablishedApplication` performs one durable transaction:

1. compare the full session authority with the active authorization and current connection generation;
2. require the exact next inbound sequence and a non-regressing, non-ahead peer ack;
3. delete only persisted outbound raw frames covered by that authenticated ack;
4. parse the already authenticated application message and require its envelope task/request bindings;
5. evaluate the operation, task revision and task write state. A definite stale/capability/policy failure becomes a persisted `rejected` action in this same transaction;
6. compute the canonical request-body keyed fingerprint locally through the protected platform adapter;
7. reserve or replay the scoped action id according to section 3;
8. atomically persist sequence, ack and action reservation;
9. only then issue an opaque, store-owned one-shot lease to the controller.

Schema, AEAD, header/body binding, route or session-authority failures before the atomic commit consume neither sequence nor action id. Once a request is authenticated and attributable, a definite stale revision/capability/policy failure atomically commits seq/ack, deletes authenticated acknowledged raw frames, and persists the rejected action receipt; it cannot become executable later merely because policy or revision changed. Any failure after the E2EE transaction committed returns a persisted rejection/replay/indeterminate result; it never reopens the frame for a second interpretation.

Non-action messages can commit seq/ack without producing a write lease. Unknown or ambiguous application kinds fail closed.

## 7. One-shot lease

An action lease is an immutable opaque object backed by module-private `WeakMap` state. At reservation it is bound to the exact store instance and action row version. `beginDispatch` then binds it to the current supervisor object and supervisor generation. The caller cannot construct, clone, serialize or revive it.

Transitions require the original live lease:

- `beginDispatch(lease, supervisor, compatibility)` atomically rechecks all authority and persists `dispatching` before exposing the exact RPC request;
- the package-private controller itself consumes the lease, calls the capability-gated supervisor, validates the result and persists accepted/rejected/indeterminate exactly once. A public caller cannot pass a plain `strictResult` to manufacture success;
- any stale, copied, consumed, wrong-store, wrong-supervisor or wrong-generation lease fails closed.

Dropping a lease does not roll back its record. Closing/restarting the supervisor invalidates every live lease for that generation. Revocation invalidates pending and established E2EE sessions and every reserved/dispatching lease for that authorization; a dispatch already marked `dispatching` becomes `indeterminate`, not rejected or retryable.

## 8. First `turn.send` dispatch

2026-09-05 correction: model ids and reasoning efforts come from the owned runtime's bounded `model/list` catalog, not UI display-name aliases. `thread/resume` requests `excludeTurns: true`, because the adapter needs identity/live state and already reads bounded history separately. Runtime errors must retain a fixed stage and whether the turn RPC may have been submitted. Catalog/input failures, preparation failures before `turn/start`, and a strictly correlated upstream JSON-RPC rejection produce durable rejected evidence; only an ambiguous turn dispatch/response remains indeterminate. No existing indeterminate tombstone is erased or replayed. This supersedes the older rule that every failure after beginning preparation becomes indeterminate.

The controller registers its bounded notification listener before making any write call and serializes writes per task. The exact order is:

1. receive the opaque action lease from the authenticated durable inbound commit;
2. recheck current runtime binding, authorization epoch, task revision and task idle state;
3. persist `dispatching` before the first app-server RPC, including `thread/resume`; from this point any ambiguous failure is indeterminate;
4. call the official read-only `thread/loaded/list({ limit: 256 })` through the same package-private runtime binding. Only an exact thread-id match in a complete page counts as loaded; malformed, truncated or non-matching results fall back to step 5;
5. when the thread is not proven loaded, call `thread/resume({ threadId })` and strictly validate the resumed thread id. A proven-loaded thread skips this redundant resume; no persistent or guessed loaded-state cache is used;
6. call only:

```ts
turn/start({
  threadId,
  clientUserMessageId: actionId,
  input: input.map(({ text }) => ({
    type: "text",
    text,
    text_elements: []
  })),
  model: authenticatedSettings.model,
  effort: authenticatedSettings.effort,
  ...(authenticatedSettings.permission === "read-only" ? {
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false }
  } : {})
})
```

7. strictly validate a new non-empty in-progress turn id. Official `0.144.1` may return an empty initial `turn.items` view even though the request has already been accepted; that exact empty variant is accepted because the fixed request already bound `clientUserMessageId` and text. If the response includes items, it must contain exactly one matching user message whose `clientId` is the action id and whose text is exact;
8. persist `accepted` before returning an encrypted `ActionReceipt.state=accepted`;
9. process the bounded pre-registered notification stream in order.

If loaded-list/resume validation fails, `turn/start` is never sent. Once the `turn/start` frame may have been written, timeout, child exit, malformed response, stream ambiguity or persistence failure becomes indeterminate. `clientUserMessageId` helps later recovery but is not assumed to be an upstream exactly-once guarantee.

### 8.1 Minimal encrypted action response

After the durable controller returns a stored terminal result, the package-private E2EE response boundary maps it to exactly one successful protocol `turn.send` response for the original `requestId` and `taskId`. `accepted` retains only its optional revision, `rejected` must pass the protocol rejection schema unchanged, and local `queued/recoveryRequired` maps to the protocol's plain `{ actionId, state: "queued" }`; the recovery-only flag is never placed on the wire.

The inbound bridge first returns the package-private context `{ state: "action-receipt", requestId, taskId, receipt }`, where `receipt` is the durable local result. A separate package-private sealer accepts only that context and the same genuine established **host** channel, then returns `{ state: "encrypted-response", requestId, taskId, wireText }`. Its outbound sequence is reserved from the current durable channel row, and the exact encrypted raw frame is committed through the action store before it can be returned for Relay forwarding. A mapping, role, authority, sequence, persistence or schema mismatch fails closed and returns no plaintext or unpersisted success response. This slice does not open a socket, interpret a Relay receipt, or export either boundary from the Windows Agent root.

## 9. Core stream and approvals

The first stable notification path is:

```text
turn/started
  -> item/started
  -> matching bounded delta/update events
  -> item/completed
  -> turn/completed
```

Thread, turn, item id and item type must match at every transition. A delta before start, duplicate lifecycle edge, event after completion, unknown bound notification, wrong owner or buffer overflow marks the task read-only and requires a full read resync. Raw reasoning body is not forwarded; only the existing bounded summary projection is eligible.

Before D5, command/file/permission approval and experimental question server requests were fixed `-32601`. D5 now enables only the live request id, task/turn ownership, nonce, expiry, exact source display and one-shot decisions described below; all other methods/shapes remain fixed `-32601`.

### D5 live request authority

D5 把上述“later slice”限定为 Companion 自己持有的 app-server child：supervisor 只把四个固定 server-request method 交给 live broker，broker strict 解析 task/turn/item 和问题/批准字段后生成不透明 request id/nonce，并在最长两分钟内等待一次 E2EE `request.resolve`。未知 shape、secret question、没有 Companion-owned active turn 或没有当前 E2EE Host authority 时仍回复固定安全错误。

浏览器响应必须逐字段匹配当前 pending 记录、authoritative task revision，以及首次读取该请求的 client device/authorization。broker 在向 app-server 交付结果前原子标记 consumed；第二次、跨设备、过期、跨 generation 或错 task/turn 的响应拒绝。command/file 只能 `accept` 或 `decline`，permission 只能 exact requested profile + `scope=turn` 或空权限，question 只能返回已声明 id 的合法 answers。不会出现 `acceptForSession`、任意 JSON-RPC、离线批准队列或跨进程恢复旧请求。

`turn.interrupt` 复用现有 SQLite action lease/terminal evidence，并只对 Companion 自己创建且 `activeTurnId` 精确匹配的 turn 开放。它调用当前 supervisor 自己持有的 child 的 `turn/interrupt`，绝不查找、终止或操作 Codex App/VS Code 进程。

## 10. Crash and recovery matrix

| Last durable state | Safe recovery |
| --- | --- |
| no reservation | endpoint may retransmit the exact raw envelope |
| `reserved` and no RPC write | reclaim only after the same authenticated authority/session/action binding is re-established; otherwise remain read-only |
| `dispatching` | convert to `indeterminate`; never auto-resend |
| `accepted` | replay the exact stored accepted receipt; never repeat RPC |
| `rejected` | replay the exact stored rejection; never repeat RPC |
| `indeterminate` | replay maps only to protocol `queued` plus a local recovery-required status; it never maps to accepted/rejected. Block task writes until explicit local recovery proves a unique upstream match or an operator resolves it |

`blocked-indeterminate` 只阻止该任务后续写动作，不阻止只读历史。`task.read` 必须保留 durable blocked state、返回 `canSend/canInterrupt=false` 的快照；不得尝试用新投影覆盖阻塞，也不得因为覆盖被拒而让任务无法打开。

本机 operator 可以明确“放弃重试”历史 indeterminate action：只解除与该 indeterminate action 精确绑定的 task block并降为 read-only，action tombstone 永久保留，原 `actionId` 重放仍返回 queued/indeterminate；下一次权威 read确认任务 completed 后才可为新的 actionId 开放 send。该恢复不把旧动作改写成 accepted/rejected，也不自动发送任何内容。

正式状态恢复必须在 Companion 停止后运行 `scripts/recover-windows-companion-writes.ps1`。该入口先验证当前用户 DPAPI 锚点、持有 lifetime lock，再在同一受锚边界内解除 block并同步新 revision；禁止直接打开或修改 `action.sqlite`，否则下一次启动必须失败关闭。

历史窗口因有界分页或消息显示预算被截断时，不等于当前 task authority 不明。只要 metadata/最新窗口明确任务处于可继续的终态、没有兼容性缺口、runtime binding/current authorization 有效且 task 未 blocked，可以开放一个新的 send action；UI 仍只展示有界最近历史。active、unknown 与没有 turn 终态证据的 system error 不能据此开放。

官方 thread 已为 `idle/notLoaded` 且最近持久 turn 明确 `interrupted/failed` 时，该 turn 是终态，即使上游没有逐项 `completedAt` 也不能永久显示 syncing。此类任务可以开放新的 send，但仍必须在写路径用 exact `thread/resume`/loaded-list 和新 `turn/start` 复核；`systemError`、active 或无最近 turn证据的 unknown 继续禁用。
| corrupt/missing/oversized state | fail closed; do not create a replacement store |
| authorization revoked | reject new claims, invalidate leases/sessions; dispatching becomes indeterminate |
| supervisor generation changed | invalidate leases; reserved records require a new authenticated claim and current binding |

## 11. Acceptance order

R4d is delivered in small verified slices:

1. strict workspace-local SQLite schema, transaction/locking/resource ceilings, encrypted raw-frame retention and restart conversion;
2. opaque lease state machine with same-id replay, different-binding conflict, one-shot transitions and revoke/generation invalidation;
3. high-level E2EE inbound bridge that atomically commits seq/ack plus action reservation and never exports its commit callback;
4. package-private capability-gated `thread/resume` + text-only `turn/start` against a deterministic schema-shaped fake child;
5. bounded core stream normalization and accepted/indeterminate recovery tests;
6. D5 adds exact active-turn `turn.interrupt`, then approve-once/deny and non-secret questions through live authority.

Every slice updates `docs/PROGRESS.md`, runs the Windows Agent typecheck and focused tests, records exact results, and receives a security review. Root typecheck/tests run at each completed vertical checkpoint. No real Codex process, task, credential, DNS, Relay deployment or external state is touched without a later explicit gate.
