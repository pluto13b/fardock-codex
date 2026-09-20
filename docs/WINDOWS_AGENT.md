# Windows Companion / official app-server boundary

2026-09-09 用户限定本项目只负责自有链路。官方 Codex 到模型服务的网络、重试和生成交由用户/官方处理；provider 别名与 respect_system_proxy 覆盖均已撤下，保持精确 codex app-server 命令和正常用户环境，不更改 Codex Home 或代理。

自有性能基线见 LATENCY_ANALYSIS.md：使用生产 Gateway/端点协议、真实 SQLite/DPAPI 和确定性 fake app-server，分开报告客户端加密业务往返与 Host 后置 anchor 完成的处理周期。基准不接入真实用户授权、任务或模型。白名单诊断保留 request.boundary、app-server.request、turn.first-text、text.first-snapshot，禁止记录请求标识、文本、模型响应、路径或凭据；上游首字指标不得冒充本项目转发速度。

2026-09-06 全项目会话：生产与显式全会话本地模式共用 `allowAllLocalThreads`，依次分页读取非归档/归档任务，不提交 cwd/provider 限制，并显式包含当前 schema 支持的全部来源类型。原有配置工作区和从官方 thread.cwd 发现的工作区使用同一 Windows 内存目录表；发现目录的 opaque id 由规范化路径确定，跨重启及不同发现顺序保持相同，避免与现有 durable task.workspaceId 冲突；不同路径不因同名而合并，公开投影只有短名称。读取复核目标 taskId，续聊沿用其原始 thread，无浏览器指定 cwd、文件遍历或会话底层文件读写。默认受限 projection 继续拒绝未配置目录；production 明确启用用户授权的全会话范围。

> Status: R4a–R4d are locally verified, 2026-08-24. The minimal text-turn path now crosses genuine E2EE and a real R3 loopback WebSocket Relay, but still uses deterministic schema-shaped fake children and does not read credentials or open a real Codex task. The generic request surface remains read-only; only the package-private controller can consume a durable lease and current binding for fixed resume/start.

## 1. Purpose

The Windows Companion is the only component allowed to launch and speak to the current user's official `codex app-server`. It translates a narrow, authenticated Codex Plus request set into official app-server JSONL requests and translates official notifications back into protocol events. It never calls a model API and never reads or writes Codex session storage directly.

## 2. Process ownership

- The Companion launches exactly one child that it owns, using an explicitly configured `codex` executable/arguments. Production uses the exact `codex app-server` stdio command.
- It does not set or replace `CODEX_HOME`, create a second profile, inspect `auth.json`, enumerate the environment, attach to Codex App/VS Code processes, or terminate any process it did not create.
- The child receives the normal current-user environment by ordinary process inheritance. Environment values, prompts, source text, full workspace paths and stderr are never copied into normal logs.
- Shutdown first stops new requests, rejects in-flight work, closes the owned child's stdin, waits a bounded grace period, then terminates only that child if necessary. Spawn failure, malformed JSONL, duplicate/unknown response id, stdout overflow, protocol error or ambiguous lifecycle state fails closed.

## 3. JSONL state machine

```text
idle -> starting -> initializing -> ready -> closing -> closed
                         \-> failed ---------^
```

The first request is official `initialize` with Codex Plus client metadata; only after its successful response does the Companion send `initialized`. Application requests are rejected before `ready`. Request ids are locally monotonic safe integers and are never reused in one child generation. Each stdout line has a hard byte limit and must be one complete JSON object; binary output, arrays, primitives, duplicate response ids and malformed frames close the generation.

The transport recognizes four directions without guessing:

- client request: `{ id, method, params }`;
- server response: `{ id, result }` or `{ id, error }`;
- server notification: `{ method, params }`;
- server request: `{ id, method, params }`, recognized and bounded by id/method but currently answered only with the fixed safe method-not-supported error. No handler is invoked and no request can be approved until the later live approval/question authority adapter exists.

## 4. Narrow public surface

R4a exposes a typed supervisor plus generic request/notification plumbing only for these planned official method families:

- `thread/list`, `thread/read`, `thread/start`, `thread/resume`;
- `turn/start`, `turn/steer`, `turn/interrupt`;
- explicit server questions and one-shot approval decisions.

The generic public runtime currently dispatches only `thread/list` and `thread/read`, even though it recognizes the planned write method names for later internal adapters. Callers cannot use the generic `request()` entry point to send `thread/start`, `thread/resume`, any `turn/*` method or another arbitrary app-server method. Until the live server-request authority adapter exists, every server approval/question request is answered with the fixed safe rejection; a caller-supplied handler cannot emit a positive result. A later capability-gated adapter maps the write methods to `CodexServeClient` DTOs and rechecks task/turn/request authority immediately before every mutating RPC. Relay delivery receipts never become app-server acceptance.

## 5. Resource and logging limits

- stdout/stderr line bytes, pending request count, notification subscribers and buffered event count have non-disableable hard caps;
- request timeout and initialization timeout are bounded;
- stderr is drained with a byte cap but is not emitted as normal logs or returned to remote clients;
- structured logs are allowlisted to lifecycle event, child generation, safe method tag, request id, outcome and duration; no raw JSON frame or error object spreading.

All fake children, logs and test output stay below workspace `.tmp/`, `.data/` or `.cache/`.

R4a fixes the absolute ceilings at 1 MiB per JSONL line, 128 pending client requests, 32 pending server requests, 32 notification subscribers, 512 buffered notifications and 1 MiB/128 frames in the stdin write queue. Tests may configure smaller positive limits, but callers cannot raise them. Initialization is limited to 30 seconds, ordinary requests to 120 seconds, server-request handling to 120 seconds and owned-child shutdown grace to 10 seconds; construction rejects zero, negative, non-finite or over-ceiling values. The implementation inherits the environment without enumerating it and never retains stderr content.

The generic supervisor currently does not invoke the reserved server-request handler at all. Every known or unknown server request receives the same fixed `-32601` safe rejection. Request ids are tracked only while that response is in flight: a concurrent duplicate is ambiguous and fails closed, while bounded sequential requests and a later id reuse remain valid JSON-RPC. R4c will replace this fixed-reject boundary only after a live request authority adapter can bind the exact task, turn, request id, expiry and one-shot local decision.

## 6. R4a acceptance

- deterministic fake child proves initialize/initialized order, concurrent request correlation and notification delivery;
- malformed/oversized output, unknown/duplicate response id, timeout, early exit and shutdown races fail closed and leave no owned child;
- server approval/question requests never receive an automatic positive decision;
- exact Unicode/whitespace input survives the JSONL request boundary unchanged;
- captured logs do not contain bait prompt text, paths, tokens, environment values or raw stderr.

R4a completion does not mean the remote product is live. Real app-server compatibility, durable action idempotency, E2EE attachment storage and Relay-to-Companion composition remain later gates.

## 7. R4b generated schema and read-only projection

R4b starts from the installed `codex app-server generate-ts` and `generate-json-schema` commands. Inspection output goes only to workspace `.tmp/app-server-schema/`; the implementation records the narrow stable method/type compatibility it actually consumes instead of checking in or executing an unrestricted generated client. Schema generation must not read credential files directly, alter Codex Home, or start a real turn.

The first vertical slice is strictly read-only:

- validate the current generated `thread/list` and `thread/read` request/result shapes;
- map only the fields required by `CodexServeClient` task summaries and timelines;
- preserve unknown item payloads only as non-actionable/read-only compatibility records; a structurally identifiable future item must not make the whole timeline unreadable, but it must close write capability and never guess approval/task authority;
- keep full workspace paths, raw prompts and generated schema payloads out of logs;
- test with schema-shaped fake child frames before any real app-server smoke check.

R4b stops at the verified read-only boundary. R4c may add `thread/resume`, exact `turn/start`, streaming notifications and interrupt only after the generated compatibility target is bound to the real child and an unforgeable durable action-authority adapter exists. Approval/question mapping remains last and must bind the live server-request id plus task/turn authority; a generic supervisor response or Relay receipt is never an approval capability.

### 7.1 Narrow compatibility contract

The first compatibility target is the locally installed `codex-cli 0.144.1` schema generated on 2026-08-24. Generated files remain disposable evidence under `.tmp/app-server-schema/`; checked-in runtime code validates only this bounded subset:

- `thread/list` sends an opaque cursor, a bounded page size, `archived: false`, `useStateDbOnly: true`, and the exact absolute paths from the local authorized-workspace registry. The last flag is mandatory in this strictly read-only stage because the generated schema says omitted/false may scan rollouts and repair Codex metadata. A response must contain `data`; missing/nullable `nextCursor` and `backwardsCursor` normalize to `null`. Every returned thread must resolve back to one configured workspace before it can leave the Windows boundary.
- `thread/read` sends `{ threadId, includeTurns: true }`. The returned thread id must equal the requested id and its `cwd` must match an authorized workspace.
- list/read accept and preserve only the generated thread status variants `notLoaded`, `idle`, `systemError`, and `active`, including the two generated active flags. R4b does not coerce them into `TaskStatus`: `notLoaded` is not proof that a shared task is offline, `idle` is not a durable completion receipt, and `systemError` is not a connection state. A later live-state layer must make that mapping with generation and turn evidence.
- read accepts only generated turn statuses and bounded turns/items. Known text, agent, reasoning, command, file-change, web-search and official tool/status items are projected from explicit allowlisted fields. Unsupported but structurally identifiable future item kinds become read-only compatibility markers containing only item id/type, never the raw payload, and the sanitized timeline remains readable with all write capabilities closed. Unknown status/shape, duplicate ids, partial turn item views, task-id mismatch, path escape or resource overflow still rejects the whole projection.
- Demo pagination unwraps its synthetic active/archived cursor before calling app-server, including preserving an explicit `null` cursor when switching to the first archived page. Task-list titles are bounded to the public protocol's 256-character limit. A historical thread may have a much longer app-server preview; only its list label is truncated, while `task.read` continues to project the bounded timeline. Other unknown status/shape, duplicate ids, path violations and resource overflow remain fail-closed.
- The local full-Demo compatibility target follows the runtime used by the current Codex desktop. For cross-process history it reads metadata with `thread/read(includeTurns:false)` and obtains the newest 32 turns through bounded descending `thread/turns/list` pages using `itemsView:summary` and one turn per upstream response, then restores chronological display order. Each page is sanitized before the next is retained. Summary attachment references expose only a bounded basename even when the original file lived outside that thread's cwd; no absolute path or payload crosses the Host. Cross-process summary history is marked partial/read-only and the public snapshot keeps a deterministic newest-message window within a conservative 384 KiB budget. Only a task created by this same Demo runtime may use the existing full-view read path and recover its live send/steer authority. While 0.150 returns `-32603` for full reads of that still-active owned task, the projection may return a bounded active shell created solely from the already-accepted local `thread/start -> turn/start` receipt: exact task/turn/action ids, original user text and fixed workspace. The shell is removed as soon as official read succeeds. External history can never use this fallback, claim live ownership, or enable send/steer/interrupt. Unknown cursor/shape, duplicate turn/item ids, page/turn/byte limits, or runtime mismatch fail closed.
- absolute workspace paths are used only in the local app-server request and authorization comparison. They are replaced by configured workspace ids/path labels before returning a projection and are never logged.
- workspace authorization uses normalized ordinal-exact path matching for thread `cwd`, file-change paths, and rename/move targets. It deliberately does not case-fold: NTFS per-directory case sensitivity and case-sensitive SMB can make differently cased paths distinct. Configuration rejects case-only duplicate entries, while a response path whose spelling falls outside that exact boundary fails closed.
- generated ThreadItem history has no per-item timestamp, so item `createdAt` remains `null`; only generated turn start/completion timestamps are exposed. Reasoning `summary` is projected for the client, while the unnecessary raw reasoning `content` body is validated for bounds and then discarded.

This stage deliberately returns a non-authoritative read projection, not a `CodexServeClient` implementation: app-server list/read does not provide Codex Plus connection generation, durable revision, sequence, cursor authority, model/permission snapshot, or action capability. R4b must not invent those fields or set `authoritative: true`. The later endpoint composition layer may promote a validated projection only after durable generation/sequence/revision state and live authority checks exist.

### 7.2 R4b acceptance

- The installed `codex-cli 0.144.1` generated 598 TypeScript and 267 JSON schema files under workspace `.tmp/app-server-schema/`; none are checked in or treated as an unrestricted client.
- The checked-in adapter sends `thread/list` with `useStateDbOnly: true` and exact authorized workspace paths, and sends `thread/read` with `includeTurns: true`.
- Projection tests cover exact Unicode/whitespace, optional cursors, upstream status preservation, full-view enforcement, duplicate ids, unknown item minimization, reasoning-body omission, move paths, Windows device/rooted/escape paths, case-sensitive NTFS/SMB boundaries, sparse/accessor/Proxy inputs and all hard caps.
- Windows Agent typecheck passes; supervisor and read-projection tests pass as `2 files / 52 tests` (`35` supervisor and `17` projection). Independent final review found no remaining P0/P1.
- No real app-server process, existing task, credential file or Codex state store was opened by this acceptance run. A real smoke remains a later controlled compatibility check; the fixed write path exists only behind the package-private durable controller and fake child.

## 8. R4c runtime compatibility binding

R4c first binds one owned supervisor generation to the exact app-server compatibility target before exposing any write capability. This is a verified local compatibility binding, not server-negotiated capability discovery: the current `InitializeResponse` has no method-capability list, so a hard-coded schema version or a successful generic JSONL handshake alone never authorizes writes.

The current D8 runtime binding targets `0.151.0`. Its initialize request enables only the experimental app-server API needed for the read-only `thread/turns/list` pagination method; attestation and MCP form elicitation remain disabled:

```json
{
  "clientInfo": {
    "name": "codex_plus",
    "title": "Codex Plus",
    "version": "<build>"
  },
  "capabilities": {
    "experimentalApi": true,
    "requestAttestation": false,
    "mcpServerOpenaiFormElicitation": false,
    "optOutNotificationMethods": []
  }
}
```

The compatibility probe and initialize response obey these fail-closed rules:

- the configured app-server executable must be an absolute local drive-qualified, non-device Windows path and the write-binding child command must be exactly `app-server`; the production version probe invokes that same immutable configured executable directly with the fixed argument `--version`, never through a shell. Tests inject a package-private probe runner rather than making production probe arguments configurable;
- the probe has a 5 second hard timeout and 4 KiB stdout/stderr ceilings, must exit successfully, and must yield exactly one canonical line: `codex-cli 0.151.0`;
- the initialize result must be a strict four-field object containing `userAgent`, `codexHome`, `platformFamily` and `platformOs`; unknown or accessor-backed fields are rejected;
- `userAgent` must begin with the pinned official `codex_cli_rs/0.151.0` or `Codex Desktop/0.151.0` product token, and both platform fields must equal `windows`; the separate exact `codex.exe --version` probe remains mandatory;
- `codexHome` is validated only as a safe absolute Windows path and then discarded. It is never logged, returned to a remote client, read, copied or used to override the inherited Codex environment;
- a successful binding is scoped to the exact supervisor generation. Restart, child exit, probe mismatch, malformed response, unsupported platform or ambiguous state removes write eligibility and leaves the generation read-only;
- the public generic request path remains read-only even when compatibility is `write-bound`; later write dispatch must consume an unforgeable runtime-binding capability and a separate one-shot durable action lease. Until then, server requests cannot receive a positive result;
- the binding advertises only the locally implemented subset. The minimal package-private controller now consumes the durable lease and current binding for exact `thread/resume` + text-only `turn/start`; core stream, interrupt and request resolution are still disabled.

The binding result is an owned, immutable local record with either `write-bound` plus the exact schema version/generation/capability subset, or `read-only` plus a stable non-secret reason. It never contains the executable path, Codex home, raw probe output, environment values or child error objects. Fake-child tests cover the happy path and every mismatch; a later user-controlled real smoke may validate the installed executable without opening a task or sending a turn.

### 8.1 R4c runtime-binding acceptance

- The initialize request carries the exact capability object with only `experimentalApi:true`; the strict response parser requires four plain data fields and discards `codexHome` after lexical validation.
- The production binder accepts only a local drive-qualified executable configured as `app-server`, invokes that same configured path with fixed `--version`, and makes every mismatch sticky read-only for the supervisor generation.
- The public generic request entry point rejects all write methods, and all server requests receive fixed `-32601`; compatibility success alone cannot dispatch or approve anything.
- Windows Agent typecheck passes and `3 files / 101 tests` pass (`45` runtime binding, `39` supervisor, `17` read projection). Independent security reviews closed strict client metadata snapshot, asynchronous probe kill/error/termination ownership, sequential server-request capacity/reuse and JSONL BOM edges; final review found no remaining P0/P1.
- No real Codex child, task or credential was used. The R4d write tests use only a deterministic fake child; real E2EE/Relay/app-server composition remains a later gate.

The 2026-08-29 local full-Demo migration separately verified the current `0.150.0-alpha.8` binding against the real owned child: all 55 listed tasks returned bounded encrypted snapshots, a real browser switched between independently running tasks without transport rejection, and a new Demo-owned task retained its accepted active-turn steer authority. This migration did not read Codex storage files or modify the desktop-owned app-server.

## 9. R4d durable action authority

The implementation follows [`ACTION_AUTHORITY.md`](ACTION_AUTHORITY.md). The workspace-local SQLite journal, opaque leases and package-private exact `thread/resume` + text-only `turn/start` controller are complete against a schema-shaped fake child. Genuine authenticated E2EE input and encrypted action responses are now connected locally; the active slice composes them with the loopback Relay transport.

The durable transaction binds authorization/session/task/action state and retains only encrypted outbound retransmission frames plus an opaque keyed request fingerprint, never user text. `reserved -> dispatching -> accepted|rejected|indeterminate` is monotonic; restart converts dispatching to indeterminate. Generic `request()` and all positive server-request replies remain unavailable.

## 10. R3 loopback Relay Host transport

The original Relay client slice remains runtime-pinned to `r3-local-test`. D2 adds a separate production WSS Host profile with platform CA validation, and D3 adds `WindowsIdentityStore`: current-user DPAPI-protected binary identity/anchor blobs, durable authorization/generation replay records, revoked lineage, and a create-new bootstrap export CLI. Private bytes and bootstrap input travel only through bounded stdin/stdout to the DPAPI adapter; they never enter command arguments, environment variables or logs.

The Relay client is not an E2EE or action-authority boundary. It preserves routed frame bytes for a later authenticated E2EE consumer and does not decrypt, interpret or approve their application content. A Relay `relayed` receipt means only that the Relay accepted the transport route; it is never app-server acceptance, an `ActionReceipt`, an approval capability or permission to dispatch a durable action.

## 11. R5 minimal authenticated read bridge

The first R5 Host endpoint is package-private and accepts only authenticated `workspace.list`, `task.list`, and `task.read` requests on a genuine Host `EstablishedSessionChannel`. One private `openEstablishedApplication` commit callback validates the operation and envelope/body task binding, then calls `ActionStateStore.commitInboundReadOnly`; that SQLite transaction rechecks the active authorization/channel, commits contiguous inbound `seq/ack`, and deletes acknowledged encrypted outbound frames. The app-server projection is never called before that commit succeeds.

Responses use `sealEstablishedApplication` and the same durable outbound sequence/raw-frame retention pattern as text-action receipts. `workspace.list` advertises only configured workspace labels, the genuine channel generation, online connection state rechecked by the E2EE/store boundaries, and `startTask: false`. After a successful `task.list` projection, a newly discovered authorized task is durably seeded at revision `0`, read-only and non-sendable; an existing row keeps its current revision and must still match the projected workspace. Upstream status is represented honestly: `notLoaded -> syncing`, `systemError -> failed`, list-only `idle -> unknown`, `active/waitingOnApproval -> waiting-approval`, and other `active` states -> `running`.

`task.read` composes current SessionAuthority, the durable task revision/capabilities, the authorized workspace registry, configured write-bridge model/effort/permission, and the bounded sanitized read projection. A full idle projection may refresh that task to writable/sendable only while the supplied write compatibility is genuine and current for its live supervisor; active/unknown views remain non-sendable, and a missing task is first seeded at revision `0`. For the local MVP, a full `notLoaded` projection with a completed last turn is treated as a sendable completed task under the same genuine runtime gate: the write path still performs the official `thread/resume` immediately before `turn/start`, so stale or conflicting state fails before execution. The refresh preserves the durable revision, so an accepted action advances it once and closes `canSend` until a later full idle/notLoaded completed read. A partial projection is returned as a sanitized authoritative read-only snapshot rather than an encrypted `internal` failure; compatibility markers are visible and all mutation capabilities remain false. Local task `sequence` equals the same durable task revision and its cursor is derived from that revision; E2EE seq/ack is never reused as task event authority. Read `idle` or `notLoaded` becomes `completed` only when the last projected turn is explicitly completed, becomes `failed` for failed/interrupted, and otherwise stays `unknown`/`syncing`. Official items have no item timestamp, so `createdAt` remains `null`; known content and tool/status items are mapped from bounded allowlisted fields, while unknown compatibility items expose only id/type and close write capability. Stream/subscription, interrupt, approval/question, attachment, Relay/public-network, and frontend work remain outside this slice.

### 11.1 Single-open Host dispatcher

The minimum composition layer owns one Host `EstablishedSessionChannel` and calls `openEstablishedApplication` exactly once for each inbound encrypted frame. Operation routing happens only inside that call's private authenticated commit callback, because the operation is ciphertext before open: `workspace.list`, `task.list`, and `task.read` commit through the read-only transaction, while an exact single-text/settings-matched `turn.send` commits through the durable reservation transaction. No caller may pre-route by decrypting twice or by trying the read and write bridges in sequence.

After the one open and durable commit complete, the dispatcher invokes the existing sanitized read projection or durable text controller and seals one encrypted response using the same channel and persisted outbound sequence. Any other request, body/envelope mismatch, multipart input, or settings mismatch closes the current channel without dispatching app-server work. The acceptance test sends `workspace.list -> task.list -> task.read -> turn.send` on one genuine channel, checks contiguous inbound/outbound sequence, one response per request and one turn dispatch, then proves an unsupported request closes the channel. This slice remains package-private and does not add Relay/public transport, frontend changes, stream, interrupt, approval, question, or attachment support.

### 11.2 Ready-session Relay composition

The first public Host composition surface is the high-level `createWindowsCompanionReadySessionHandler`. It accepts one already-ready genuine Host channel plus the existing durable store, sanitized projection, fixed supervisor/runtime binding, authorization assertion, request fingerprint function and a single injected Relay `sendEnvelope` function. The returned handler is the only callback intended for `R3LoopbackRelayHostClient.onEnvelope`: every raw inbound frame goes directly through the single-open dispatcher, and only its encrypted response may be sent back. It exposes no generic app-server or protocol RPC surface.

The handler re-decodes the sealed response only to bind the transport receipt to the exact `connectionGeneration + requestId + seq`. A missing, rejected, unavailable or mismatched receipt, a dispatcher `session-closed` result, concurrent invocation, or any dispatch/send failure invalidates the ready channel and makes the handler permanently fail closed. Relay `relayed` remains transport evidence only; the application result was already determined and durably sealed before that receipt exists. This composition still assumes pairing/session establishment and platform persistence have already succeeded, and it does not add reconnect, public Relay, UI wiring, stream, interrupt, approval, question or attachment support.

### 11.3 Ephemeral local runner

`src/local-runner.ts` is the first runnable composition entry, not a deployment service. It accepts only explicit `--codex-executable` and `--workspace` arguments, creates project data under workspace `.tmp`, binds the R3 Relay to `127.0.0.1:41744`, and uses formal Web origin `http://127.0.0.1:5173`. It creates ephemeral Host identity keys, requires the exact local terminal word `APPROVE`, then installs the ready-session handler. The explicitly named `--test-auto-approve` flag exists only for an already-authorized loopback smoke test. The runner installs a no-op app-server notification subscriber so normal model/turn notifications are drained within the supervisor's bounded delivery path; it does not log or interpret their payloads yet. It never enumerates the environment, reads Codex credentials, writes the pairing fragment to disk, or kills an unowned process. Restart always requires a new pair.

For the local product demo only, `--local-demo-login` additionally binds `127.0.0.1:41745`. A same-origin Vite proxy may POST the fixed test credentials `admin` / `123456`; a successful request creates and returns a fresh in-memory invitation, then the unchanged pairing/session flow runs with local auto-approval. The endpoint rejects non-loopback Origin, other methods, malformed bodies and wrong credentials; it never logs the password or exposes Codex/OpenAI credentials. This flag and proxy are development conveniences and are not a production authentication design.

The text-action bridge now consumes the authenticated request settings instead of requiring one hard-coded UI value. Model display names are mapped through a fixed local allowlist to official app-server model ids and effort is passed unchanged. `permission: read-only` is enforced by `approvalPolicy: "never"` plus `sandboxPolicy: { type: "readOnly", networkAccess: false }`; it is never silently executed with broader thread permissions. `permission: ask` retains the resumed thread's current approval/sandbox policy.

Repeated text turns avoid redundant resume cost without trusting a timer or local guess: the bound runtime first requests official `thread/loaded/list({ limit: 256 })`. An exact target id in the validated page permits direct `turn/start`; absent, malformed or incomplete evidence falls back to the existing exact `thread/resume` validation. Request timeout, child failure or an ambiguous write result is never retried.

The attachment slice keeps transport and execution authority separate. Authenticated turn input may carry bounded inline attachment bytes, but only the Windows action path may decode them. It validates exact metadata and content, writes create-new files only below the current runner's workspace-local `.tmp` runtime directory, maps verified images to official `localImage`, and represents ordinary files through an explicit visible path input that Codex can read with its normal tools. Browser filenames never become paths, unknown media never executes, and no upload may escape the active action/session lifetime.

`--local-demo-full-access` is a loopback-only composition flag. It removes the cwd filter only for sanitized thread list/read, maps every valid local cwd to one virtual workspace without returning the path, and paginates active then archived records. Completed imported tasks may be continued, but the runner keeps an ephemeral set of tasks created by this Demo so external active turns cannot be steered. A signed grant containing `full-access` plus the Host flag is required before mapping existing turns to `never + dangerFullAccess`; switching back to ask explicitly restores `on-request + workspaceWrite` rather than inheriting elevation. Demo new-task requests are E2EE-authenticated and create a fresh fixed-cwd thread before its first turn, so no existing task id is dispatched.
