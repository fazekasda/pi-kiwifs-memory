# KiwiFS memory extension — proposed architecture

Status: proposed architecture implementing `docs/decisions.md` (authoritative confirmed choices) on the contracts verified in `docs/research/mcp-contracts.md` (KiwiFS v0.19.62 @ `3961d5e70a9e0ef457e58e29c40c52c870d57e73`; Pi 0.85.0 local install) and revised against the adversarial review in `docs/architecture-review.md` (all findings F1–F10, R1–R5 resolved there). **Nothing in this document is user-approved beyond decisions.md**; every engineering choice not recorded there is labeled **[P]** (proposal) and is open to revision. The decision/default table in §13 classifies every open item as confirmed, [P] default, or genuinely unresolved.

Capability counts: the source audit enumerated 61 tool names at the pinned revision, but live capability discovery against the provisioned test environment (`docs/test-environment.md`, MCP port 8182) advertised **71 tools**. Live `tools/list` is authoritative; the adapter must discover capabilities at connect time and never hard-code a tool count or assume the source-enumerated list is complete. Test-environment provisioning (separate process/root/index/table, synthetic CRUD/FTS/cleanup over MCP 8182) is complete; the reusable opt-in live test runner is not built yet and remains a backlog deliverable (T04/T19).

Blockers carried from contract verification, referenced as B1–B6:

- **B1** — standalone port-8181 MCP is unauthenticated (`mcpserver.go:3048–3054, 3172–3185`); the adapter must target the apikey-authenticated `/mcp` on the main server (3333) or a mandated network ACL.
- **B2** — no conditional (If-Match) writes over MCP; idempotency must come from deterministic paths/content, not optimistic concurrency.
- **B3** — superseded/deleted records can surface via `kiwi_search_semantic`, `kiwi_search_hybrid`'s semantic leg, and `kiwi_brief`'s vector leg (`hybrid.go:205+`; `vectorstore/service.go:178–184`); adapter tombstone guard + read-back verification required.
- **B4** — semantic scope filtering is post-candidate with 200/4096 caps (`mcpserver/local.go:463–509`; `vectorstore/service.go:318–327`); bounded under-recall is permanent and must be disclosed.
- **B5** — no board TTL or push-notification primitives; `kiwi_changes` polling + client-side TTL only.
- **B6** — no history-purge tool; permanent erasure is an operator procedure with no secure-erasure guarantee (consistent with decisions.md #3).

## 1. Components

```text
Pi process (extension)
  input ──────────────► RAG coordinator ──► Privacy gate ──► KiwiFS adapter ──► MCP (3333 /mcp)
                            │                    ▲                                   │
                            ▼                    │                                   ▼
                      Evidence packer      redaction rules                    KiwiFS backend
                            │                                     (FTS / pgvector / git)
  before_agent_start ─► context injector
  agent_settled ──────► Observer ──► privacy gate ──► outbox ──► adapter   (extraction model:
  session_before_compact ► bounded flush ┘                                     OpenRouter z-ai/glm-5.3-flash, configurable (confirmed, decisions.md #9))
  session_before_fork/switch/tree/shutdown ──► Session coordinator (generation tracking)
  commands (/kiwifs-*) ──► User controls ──► sanitized activity log
  Board client ──► adapter (kiwi_write/kiwi_append + kiwi_query_meta + kiwi_changes polling)
  Transcript exporter ──► chunker ──► privacy gate ──► outbox ──► adapter
```

Components and responsibilities:

| Component                          | Responsibility                                                                                                                                      | Verified hooks / primitives used                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Session coordinator                | generation tokens per session/branch, stale-work rejection, lifecycle init/cleanup                                                                  | `session_start`, `session_before_fork/switch/tree`, `session_tree`, `session_shutdown` [Pi: `types.d.ts:850–873, 919–938`]  |
| KiwiFS adapter                     | single typed MCP boundary; capability-discovered tool set (71 advertised live); tombstone guard; read-back verification; op-id ledger; cancellation | MCP Streamable HTTP `/mcp` with bearer apikey (B1); `kiwi_read/write/append/delete/search*/brief/changes/query_meta/forget` |
| Scope resolver                     | project identity, scope strings, cross-project opt-in                                                                                               | git remote normalization + override (decisions.md #5)                                                                       |
| Privacy gate                       | redaction before every outbound call (writes, queries, model calls, outbox, audit)                                                                  | decisions.md #10                                                                                                            |
| Observer                           | incremental extraction from settled responses                                                                                                       | `agent_settled` [Pi: event union, `types.d.ts:813`]; model OpenRouter GLM default, configurable (decisions.md #9)           |
| RAG coordinator                    | one retrieval cycle per eligible user input, one total deadline                                                                                     | `input` awaited before first LLM call [Pi: `agent-session.js:844–854`]                                                      |
| Evidence packer / context injector | ≤3000-token pack injected once per turn                                                                                                             | `before_agent_start` [Pi: `agent-session.js:914–932`]                                                                       |
| Outbox                             | durable local queue, retries, reconciliation                                                                                                        | decisions.md #8; local JSONL **[P]**                                                                                        |
| Transcript exporter                | redacted session-tree chunks + manifest                                                                                                             | decisions.md #2; `kiwi_write`, `kiwi_changes`                                                                               |
| Board client                       | channels, message IDs, polling cursor                                                                                                               | `kiwi_write`/`kiwi_append`, `kiwi_query_meta`, `kiwi_changes` (B5)                                                          |
| User controls                      | `/kiwifs-status`, private mode, forget/undo, proposals                                                                                              | Pi commands + RPC-safe output                                                                                               |
| Activity log                       | sanitized metadata-only audit events                                                                                                                | decisions.md #10                                                                                                            |

**[P]** Source layout mirroring the PRD's suggested areas: `src/config/`, `src/scope/`, `src/backend/` (adapter), `src/privacy/`, `src/outbox/`, `src/pi/` (session coordinator + hooks), `src/observation/`, `src/retrieval/`, `src/inject/`, `src/backup/`, `src/board/`, `src/controls/`. Created as needed during implementation; no empty placeholder directories.

## 2. Schemas and backend path layout

All stored records carry `schemaVersion` (integer, starts at 1), stable IDs, `scope`, timestamps, and lifecycle status, per decisions.md and PRD T05. **[P]** concrete formats:

Backend path layout (namespace isolated by prefix; untrusted IDs rejected by strict charset grammar `^[a-z0-9][a-z0-9-]{0,63}$` so paths cannot escape their namespace):

```text
{scope}/memory/observations/{yyyy}/{mm}/{obs_id}.md        # extracted observations
{scope}/memory/reflections/{yyyy}/{mm}/{refl_id}.md        # bounded reflection summaries
{scope}/memory/merge-proposals/{proposal_id}.md            # proposals, separate from accepted records
backup/{project-id}/{session-id}/manifest.md               # manifest (schema, range, omissions)
backup/{project-id}/{session-id}/{seq:06d}.md              # transcript chunks (redacted)
board/{channel}/{msg_id}.md                                # board messages (one file per message)
```

(There is no backend tombstone path: `kiwi_forget` rewrites frontmatter in place, so tombstones are local cache state only — see §3.1/§9.)

**Operation IDs (all domains).** Every mutating operation is assigned a durable, randomly unique `opId` (UUIDv4) that is persisted in the outbox job **before any side effect** (before the model call for extractions, before any `kiwi_write`/`kiwi_delete`). Replays of the same job reuse the persisted `opId`, so re-derivation after a crash cannot mint a second identity for work that was already written. `obs_id`, `refl_id`, `msg_id` and backup chunk seq are derived from or bound to the persisted `opId`.

**Immutable records, collision fail-closed.** Observation, reflection, backup-chunk and board-message paths are written once and never rewritten. Before the first write to a fresh deterministic path the adapter reads it: identical content → no-op success (replay); path exists with different content → fail closed (job quarantined, visible degraded status, never overwrite); path absent → write. No compare-and-swap, no exactly-once, and no optimistic-concurrency behavior is claimed anywhere (B2); this is read-before-write idempotency only.

- Record `scope` is a **single owner value** ∈ `project/{project-id}` | `personal`. Cross-project access is expressed in the **session's authorized scope set** (`[project/A, personal]` plus `cross/B` after per-session opt-in), never by rewriting record frontmatter. Retrieval issues one query per authorized scope value (see §3.1).
- **[P]** Project identity: normalized git remote (`host/repo` after stripping scheme, port, `.git`, credentials), explicit `projectIdentity` config override for non-Git/ambiguous cases. A content hash of memory text is never used as branch/source identity; session/branch lineage comes from Pi session/entry IDs, and backend revision identity is the git commit hash from `kiwi_changes` cursors — three distinct identity spaces.
- Record frontmatter **[P]**: `schemaVersion`, `id`, `type` (`observation|reflection|proposal|backup-chunk|board-message`), `scope`, `created`, `sources: [{sessionId, branchId?, entryIds[]}]`, `model` (for model-generated records), `status` (`active|superseded|pending-approval`).
- Board message frontmatter (matches `kiwi_remember`-style conventions, `memory_tools.go:24–40`): `msg_id` = hex-truncated SHA-256 of `channel + from + opId` (the `opId` is assigned and persisted at outbox enqueue, so a replayed job reproduces the same `msg_id` while two senders sending identical payloads at the same sequence produce distinct files — no content-derived id), plus `to`, `from`, `channel`, `created`, `ttl`.
- Local outbox record **[P]**: `{seq, schemaVersion, kind, scope, opId, idempotencyKey, payload(redacted), attempts, nextAttemptAt, createdAt}` in JSONL with a lock file; retention default 14 days / 5,000 jobs / 50 MiB high-water limits; on overflow **new capture pauses** with visible coverage gaps and **pending jobs are never dropped** (no drop-oldest — §13 row 8); the 14-day retention applies only to acknowledged jobs. _All values proposals pending T07 testing._

## 3. Pi event sequences

### 3.1 Per-input RAG (one cycle, one total deadline)

Verified ordering [Pi]: `emitInput` is awaited inside prompt submission _before_ skill/template expansion and before agent start, for fresh and queued inputs alike (`agent-session.js:844–854`); `InputEvent.streamingBehavior` distinguishes `steer`/`followUp`/idle (`types.d.ts:657–667`).

```mermaid
sequenceDiagram
  participant U as User input
  participant P as Pi (input handler)
  participant R as RAG coordinator
  participant A as Adapter
  participant K as KiwiFS /mcp
  U->>P: input event (fresh or steer/followUp)
  P->>R: await retrieve(text, streamingBehavior, inputId)
  R->>R: eligibility check (slash command? extension input? private mode? excluded?)
  R->>R: build redacted query (privacy gate)
  R->>A: per authorized scope value: search w/ tombstone guard + read-back, one AbortController
  A->>K: kiwi_search / kiwi_search_semantic (scope-critical); kiwi_brief only with scope post-filter
  Note over A,K: ONE total deadline (confirmed 2 s, decisions.md #7) covers query build,<br/>all N ≤ 4 scope queries, dedupe, ranking — not per attempt
  K-->>A: results (or transport cancel)
  A-->>R: ranked, read-back-verified, redacted evidence
  R-->>P: evidence pack bound to inputId
  alt fresh input
    P->>P: before_agent_start → pack injected as result.message [agent-session.js:914–932]
  else steer / followUp input
    P->>P: context event: pack consumed only if messages contain the matching<br/>user input (inputId fingerprint); else fail closed (dropped, visible status)
  end
```

- **One logical retrieval per eligible user input.** Retrieval runs in the awaited `input` handler at submit time for fresh **and** queued (steer/followUp) inputs alike (verified: `emitInput` awaited, `agent-session.js:844–854`).
- **Injection is per-input and verified against consumed input (F1).** `before_agent_start` fires only when an agent run starts (`agent-session.js:914–933`), so it serves fresh turns. A steered/followUp input has no new `before_agent_start` (verified: `emitBeforeAgentStart` fires only inside `prompt()`, `agent-session.js:915`); a `followUp` may begin a _new_ agent run after the current one settles, which still produces no `before_agent_start` for the queued input — so its pack is delivered through the `context` event, which fires per provider request (`types.d.ts:514–516`). The context handler injects a pending pack **only if** the `context.messages` array contains a user message matching that pack's `inputId` fingerprint (hash of the **raw input-event text**, unredacted — the fingerprint is local matching state and is never sent anywhere, so redaction must not touch it; combined with `streamingBehavior`). The fingerprint uses the raw text as received in the `input` event, _before_ skill/template expansion, because queued steer/followUp messages are stored and replayed by Pi as _expanded_ text (`agent-session.js:853–868`); raw-input text is the only stable value the extension itself observes. Inputs beginning with `/` are ineligible for retrieval (see below), so expansion cannot diverge the fingerprint for eligible inputs. There is no notion of "input event position" in Pi's event model and none is used — i.e. the evidence is matched to the input the agent is actually consuming on this provider call, not merely to "the next context fire" or the submission moment. If the current provider call does not consume the pending input (tool-loop call, wrong turn, ambiguity), the handler fails closed: it injects nothing and retries on the next `context` fire within the same run; if the run settles (`agent_settled`) with the pack still unmatched, the pack is dropped with a visible degraded-status event. A pack is never carried across a turn boundary into a later unrelated turn. The feasibility of matching the pending input inside `context.messages` is verified in T13 fixtures before T12/T13 land; if Pi 0.85.0 cannot support the linkage, steer/followUp retrieval degrades to opt-in (retrieval-only-on-request) and this is surfaced — never silently lost.
- The `context` event is used **only** for steer/followUp delivery and deduped by `inputId`; it is not used for first injection of fresh turns because it fires on every LLM call including tool loops.
- Deadline: a single `AbortController` armed at retrieval start; on expiry the RAG coordinator injects nothing and logs a sanitized degraded-status event. Pi continues; cancellation propagates into backend calls (mcp-go per-request context, `mcp-contracts.md` §2).
- **Fanout is bounded inside the one deadline.** The authorized scope set has at most **N = 4** scope values **[P]**; retrieval issues at most N backend queries (one per scope value) plus at most one optional `kiwi_brief` call, all under the single total deadline (2 s, confirmed configurable — decisions.md #7). Per-query deadline is `total/N`-ish via a shared budget; if the budget is exhausted, remaining scope queries are skipped (degraded, logged) — never a new deadline per attempt.
- **Scope enforcement per leg (F2).** Scope-critical retrieval uses `kiwi_search` (FTS, SQL-side `scope` filter) and `kiwi_search_semantic` (server-side `scope` param, post-candidate — B4 under-recall disclosed). `kiwi_brief` has **no `scope` parameter**; it is used only when its `path_prefix` can be pinned inside the session's own scope prefix, and **every** returned page is additionally post-filtered client-side: read-back must confirm `$.scope` ∈ authorized set. Any brief-pack page failing the check is dropped; if the brief pack then falls below the minimum-evidence threshold **[P]**, the packer rebuilds from `kiwi_search`/`kiwi_search_semantic` results instead. No brief-pack content passes through unverified.
- **Token accounting (local contract).** `kiwi_brief`'s `budget_tokens` is a server-side heuristic estimate, not a model-native tokenizer count; it is treated as advisory. The evidence packer must use a tokenizer compatible with the active model and count the complete injected evidence, including framing and citations, against the confirmed 3,000-token cap. It drops lowest-ranked evidence first and recounts the final payload. Character estimates are diagnostic only, not enforcement. If no reliable tokenizer is available, automatic injection is skipped with visible degraded status; tools remain available. T13 must test multilingual text, code and framing overhead.
- Eligibility policy **[P]**: fresh interactive/RPC text inputs are eligible; `streamingBehavior` queued inputs each get their own cycle (verified they arrive as separate `input` events); **all `/`-prefixed inputs** (slash commands, skills, prompt templates — any input subject to expansion) and extension-generated inputs are ineligible, so template/skill expansion can never make the queued expanded text diverge from the fingerprinted raw text; tool-loop LLM calls never re-trigger (they emit no `input` event).
- Evidence is framed as untrusted data with source IDs and conflict labels (decisions.md #7/#11); retrieved records can never register tools or commands. Every candidate record passes, in order: read-back (fresh `kiwi_read`), status check (`memory_status` absent or `active`; any other value rejected), scope check (`$.scope` ∈ authorized scope set), path-prefix check (within the scope's `memory/` namespace), and privacy redaction of the content — before any of it can be injected. Cached tombstones are advisory hints only; a cache miss never permits injection (the read-back is the gate). Vector health is never inferred from keyword-only hits: hybrid results attributed `keyword only` are reported as degraded, not as semantic evidence (B3/B4/T12).

### 3.2 Observation cadence and compaction relation

Verified [Pi]: `agent_settled` fires per completed agent run; `session_before_compact` is awaited with no built-in timeout and carries a `signal` plus `cancel`/`compaction` result fields (`agent-session.js:1496–1512`; `types.d.ts:857–860`).

- Trigger: `agent_settled` enqueues the response interval as a source range (decisions.md #6). **[P]** Extraction batches when unprocessed source ≥2,000 tokens or ≥10 turns or 5 min idle, whichever first; batch input/output budgets 6,000/3,000 tokens; queue caps at 20 pending batches, excess merged into oldest-unprocessed ranges (never silently dropped — overflow converts into a visible "pending work" status).
- Extraction jobs persist their `opId`, source entry list and batch parameters to the outbox **before** the model call; the extraction result is persisted (as a durable outbox job) before any `kiwi_write` of the observation. A crash before the model call re-derives work from source under the same `opId`; a crash after the write replays idempotently (read-before-write, §2 collision rules).
- Reflection: bounded summaries may run automatically per decisions.md #11; merge proposals and conflict flags are always proposals requiring approval, never auto-applied.
- **Pre-compaction flush (bounded, never indefinite):** on `session_before_compact`, the observer runs a bounded flush — one extraction attempt with a **[P]** 5 s self-timeout, honoring the event's `signal`. The handler **never returns `cancel`**; on timeout or failure it returns normally, compaction proceeds, and unprocessed ranges remain durable in the outbox/source-coverage state with visible pending status (decisions.md #6: continue compaction after failure, show pending work). Source coverage advances only after durably accepted output (T09).

### 3.3 Lifecycle (fork/switch/reload/shutdown)

- Session coordinator mints a monotonically increasing **generation token** per (session, active branch). All async results (retrieval packs, extractions, board deliveries) carry the generation they were created for; stale results are discarded, never injected (T08).
- `session_before_fork`/`session_before_tree`: coordinator snapshots cursors, re-mints generation for the new branch. Shared-ancestor source entries are marked consumed per entry ID, so a fork does not re-capture shared history (T08).
- `session_before_switch`: stop in-flight board polling and RAG work for the old generation (best-effort; stale results additionally filtered by generation check).
- `session_shutdown`: idempotent teardown — flush outbox state file, stop timers, release locks. Repeat delivery is harmless (handlers are reentrant).
- Reload/new session: components re-init from durable state files; cursors live locally, never only in memory.

**Never rely solely on a remote cursor while offline:** the authoritative processing cursor for every pipeline (observer coverage, backup coverage, board delivery) is the local durable cursor; `kiwi_changes`' `since`/`last_seq` is a reconciliation _aid_, checked against local coverage at startup. A branch/source identity is also never inferred from a content-only hash — lineage is Pi entry IDs; the git commit hash from `kiwi_changes` identifies backend feed position only.

## 4. MCP wire boundary

- Transport: Streamable HTTP, endpoint `/mcp` on the main server (3333) with `Authorization: Bearer <api-key-ref>` — **B1 requires this** or a documented network ACL for 8181. Auth is stored as a reference (env var / secret file path), never in config files or logs (T03).
- Stateless sessions (`WithStateLess(true)`, `mcp-contracts.md` §2): the adapter initializes per logical connection, does not depend on session IDs, and treats absence of server-initiated notifications as a design constraint (no SSE reliance).
- The extension uses **only MCP tools** in v1 (decisions.md #1). REST is not implemented and not silently substituted for missing MCP capability; any gap is surfaced as a blocker/limitation.
- Errors: domain errors arrive as `IsError=true` JSON-RPC successes (`mcpserver.go:1042+`); the adapter maps these to typed results. Transport errors, panics, timeouts map to typed failures. Authorization failures are terminal, never retried as transient (T04).
- No conditional writes over MCP (**B2**): mutations use durable operation IDs (§2) + deterministic paths; replay safety comes from read-before-write on deterministic message/chunk paths, with collisions on differing content failing closed (§2) (`kiwi_append` is atomic per call but replays duplicate, `mcpserver.go:1713–1734`; it is not used for immutable records). The lost-update window for concurrent `kiwi_write` to the same path is documented as a known limitation; no CAS, ETag-match or exactly-once behavior is implemented or claimed.
- Every search-mode result carries its engine attribution; the adapter asserts hybrid degradation from rank attribution (`keyword only`), not status (T04/T12).

## 5. Privacy and query redaction

Per decisions.md #10, the privacy gate sits on **every** outbound edge: memory writes, transcript chunks, board messages, RAG queries (search text can leak secrets into backend logs), model calls, outbox bytes, and audit log. **[P]** mechanics:

- Pattern-based redaction (regex + entropy heuristics) with user-configurable exclusions by path prefix, content pattern, and whole-file; replacement is structural (`[REDACTED:type:n]`) preserving length class where useful for token budgeting.
- Fail-closed: content that cannot be classified is treated as sensitive (held for manual run, not silently sent).
- Private mode: no network reads or writes in any of the three domains, no new capture/backup/board jobs, pending outbox jobs held (not deleted); transition on and off is explicit and visible (T06/T19).
- RAG queries are built from redacted user text only; evidence returned from the backend is untrusted data (never executed, never used to change tool behavior).
- Audit log records metadata (event kind, scope, byte counts, decision) with payload snippets only after redaction; default is metadata-only.

## 6. Durable source chunks, outbox and reconciled cursors

- Every accepted unit of work (observation batch, transcript chunk, board message) is persisted to the local outbox **before** being acknowledged as durable (decisions.md #8), with a durable randomly unique `opId` (§2) and an idempotency key = deterministic path + content hash _of the payload_ (a payload fingerprint, explicitly not an identity for lineage).
- Outbox worker: per-scope ordered delivery, capped exponential backoff with jitter, permanent-failure quarantine (inspectable, bounded), retention/overflow per §2 defaults. Failed jobs never block Pi interaction (T07).
- Cursors: each pipeline keeps `{localSeq, backendLastSeq?, lastCommitHash?}`. Local state is authoritative; on reconnect, `kiwi_changes(since=lastCommitHash)` is used to reconcile — detect drift (e.g., another writer advanced the feed) and re-scan coverage by listing (`kiwi_query_meta`) rather than trusting either cursor blindly. Catch-up after a long outage is a **bounded loop**: successive `kiwi_changes` pages (`limit` ≤ 500, commit-hash cursor) with a **[P]** maximum of 20 pages or 10,000 changes per reconciliation pass; if the feed is not caught up within that bound, reconciliation pauses with visible pending status and resumes on the next cycle — it never runs unbounded. Offline startup works entirely from local state (T07/T08).
- Crash windows tested: crash before outbox persist (work re-derived from source), after persist before send (replay, idempotent), remote success before local ack (replay must not duplicate — deterministic paths make it so, **B2**).

## 7. Redacted transcript backup — completeness and export

Per decisions.md #2: redacted complete session tree and tool outputs; binaries omitted and recorded in the manifest; **no byte-identical recovery claim**.

- Capture: incremental on `agent_end`/`agent_settled` **[P]**, chunked (≤64 KiB text per chunk **[P]**), preserving entry IDs, parent links, roles, tool results, timestamps; images/binaries recorded as omission entries `{entryId, reason: "binary-omitted"}`. Chunk boundaries are decided by the **coverage cursor** (durable consumed-entry position), not by which lifecycle event fired the capture: whether the trigger was `agent_end` or `agent_settled` (R1), the next chunk covers exactly the entries the cursor says are unconsumed, so entries in flight during steered turns are never skipped or double-captured.
- Manifest per session: `schemaVersion`, covered entry range, chunk list with checksums, redaction summary (counts by type, never secret values), omission list. Content-addressed checksums verify chunk integrity but are never treated as branch identity (§3.3 rule).
- Raw transcript chunks are stored under `backup/…` with a scope flag that **excludes them from ordinary RAG retrieval** (retrieval queries filter to `memory/` paths via `path_prefix`); they remain searchable only via explicit backup-read tooling.
- Verification/export (T15): verify checksums + manifest completeness + tree links; export to an explicit new destination only; restore into Pi sessions is **not promised** unless format contracts are verified and approved later; completeness statements always say "complete with recorded redactions/omissions".

## 8. Board concurrency and delivery

- Message files use `msg_id = SHA-256(channel + from + opId)` paths under `board/{channel}/` (§2) — concurrent senders sending **identical payloads** at the same sequence still produce distinct messages (the `opId`, not content, disambiguates); replayed sends of the same job reproduce the same `msg_id` and read-before-write no-ops (**B2** compensation, no CAS). Delivery acknowledgment is local state; nothing remote is mutated by acknowledging.
- Listing via `kiwi_query_meta` (`$.to`/`$.channel` filters, sort by `created`, limit/offset); delivery cursoring via `kiwi_changes` polling **[P]** every 60 s during active sessions with capped backoff when idle (B5: no push notifications exist). Polling is bounded: maximum **[P]** 3 consecutive empty polls per cycle then backoff; maximum unread backlog surfaced in status at **[P]** 500 messages, beyond which delivery pauses with a visible "backlog overflow" state rather than processing unboundedly. No exactly-once delivery is claimed; at-least-once with client-side dedupe by `msg_id` is the guarantee.
- TTL: client-side filter at read time (`created + ttl < now` → skip); the backend never expires files (B5).
- **Growth and GC (F8):** the backend never deletes board files, so unbounded growth of `board/{channel}/` is a documented property. Default policy: **no automatic remote deletion.** A manual, user-initiated `/kiwifs-board-gc` command **[P]** may delete (`kiwi_delete`) only messages **sent by this agent's identity**, expired by TTL, acknowledged **locally by this agent** (acknowledgments are per-agent local state; there is no shared delivery record over MCP, so "acked by all consumers" is unverifiable), and older than a **[P]** 30-day grace window. Accepted limitation: another agent that has been offline longer than the grace window may lose a message this agent deletes; the grace period and the manual confirmation step are the compensating controls — with an explicit confirmation listing what will be deleted. It never touches other senders' messages and never claims Git-history or index purging (B6). Local dedupe-set retention is **[P]** 90 days. Automatic GC remains off unless a future user decision approves it.
- Two consumers maintain independent cursors locally; acknowledgments are local state, distinct from delivery. Unread backlog is bounded and visible in status.
- Board messages are untrusted data: never executed, never parsed as commands (decisions.md #4). Recipient labels are organizational routing only — not confidentiality against other holders of the shared apikey (verified single-key backend).

## 9. Authorization limitations (must-document)

- Single shared apikey; **no per-path authorization exists on the backend**. Scope (`$.scope` frontmatter, single owner value) is an organizational convention enforced by the extension's own queries (one per authorized scope value, §3.1) and the FTS SQL filter; semantic search filters post-candidate (**B4** — under-recall possible, leakage impossible from the filter itself, but the boundary is client-enforced policy, not access control).
- **Network exposure is not tenant security (test-environment verified).** In the current deployment, service ports are opened on all interfaces and the Unix user, database role and API key are shared; VPN routing separates _traffic_, and the dedicated test space separates _data_ (separate process/root/index/table), but neither is a hard authorization boundary. Nothing in this architecture may claim VPN-only firewall/auth enforcement, per-tenant isolation, or that the shared key cannot read other spaces' records. Endpoint auth (B1) is a prerequisite for enabling the extension, not evidence of tenant separation.
- Cross-project recall requires explicit per-session opt-in; default scope resolution denies cross-project reads (T03).
- Endpoint auth: B1 (3333 bearer or ACL for 8181). MCP-layer auth on the chosen endpoint is a hard prerequisite for enabling the extension. **Reconciliation with the test environment (T04/T19):** the opt-in live runner targets only the network-restricted dedicated test service (MCP 8182, `docs/test-environment.md`); B1 governs the production endpoint the extension is enabled against. Auth behavior observed on 8182 is recorded as evidence only — it is never assumed to prove enforcement, and a successful authenticated request is not evidence that the endpoint rejects unauthenticated ones.

## 10. Secret-free audit

- Audit events: `{ts, kind, feature, scope, targetId?, byteCounts, decision, degraded?}` — no payloads, no secrets, no full queries by default; redacted snippets only at user-enabled verbosity (decisions.md #10). Logs, thrown errors, status output, and package artifacts are covered by T06/T19 checks; config status shows resolved non-secret settings only.

## 11. Migrations

- All local state (outbox, cursors, tombstone cache, config) carries `schemaVersion`; unknown newer versions fail safely read-only with a visible message, never destructively rewritten (T05). **[P]** Backend records also embed `schemaVersion` in frontmatter; migration = forward-compatible readers + explicit one-way upgrade command in a later minor version. No server-side schema migration exists (KiwiFS owns its own storage); extension scope is client-side only.

## 12. Fault tests and phased milestones

Fault matrix (synthetic fixtures; maps to PRD T07/T08/T19 and `mcp-contracts.md` §9):

| Fault                                                        | Expected behavior                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Backend outage mid-write                                     | outbox holds job; Pi unaffected; retry with backoff                                          |
| Crash before/after outbox persist; remote-success-before-ack | no logical duplicates (deterministic paths); no lost accepted work                           |
| Duplicate delivery / replayed `input`                        | idempotent by generation + idempotency keys                                                  |
| Retrieval deadline exceeded                                  | no injection, degraded status, Pi continues                                                  |
| Vector index unavailable / dropped vector job                | hybrid rank attribution shows `keyword only`; tombstone guard + read-back still applied (B3) |
| Superseded record appears in semantic results                | filtered before injection (B3 fixture)                                                       |
| Scope under-recall                                           | zero cross-scope hits; shortfall measured and reported (B4)                                  |
| Malformed model output / provider rejection                  | safe visible failure; original observations intact (T10/T11)                                 |
| Compaction concurrent with flush                             | flush bounded by signal + self-timeout; compaction never cancelled by default (§3.2)         |
| Fork/switch during in-flight work                            | stale generation results discarded                                                           |
| Private mode transition                                      | pending sends held; no new network jobs; resume explicit                                     |
| Backend upgrade (version bump)                               | contract fixtures re-run; unknown tool/schema → degraded-but-safe                            |

### Module map and task dependencies

| Module (source area)           | Implements                                                                                     | PRD task | Depends on                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | -------- | -------------------------------------- |
| `src/config/`                  | config loader, schema validation, secrets-by-reference                                         | T03      | —                                      |
| `src/scope/`                   | project identity, scope grammar, authorized scope set                                          | T03      | T03 config                             |
| `src/backend/`                 | MCP adapter, capability discovery, op-id ledger, read-back/collision rules, tombstone advisory | T04      | T03                                    |
| `src/backend/fixtures/`        | fake MCP server fixtures + opt-in live runner                                                  | T04, T19 | T04                                    |
| `src/domain/` (in T05 schemas) | record schemas, idempotency keys, migration policy                                             | T05      | T02                                    |
| `src/privacy/`                 | redaction, exclusions, private mode, sanitized audit                                           | T06      | T03, T05                               |
| `src/outbox/`                  | durable queue, worker, bounded reconciliation                                                  | T07      | T04, T05, T06                          |
| `src/pi/`                      | session coordinator, hook wiring, generation tokens                                            | T08      | T03, T05, T07                          |
| `src/observation/`             | incremental scheduling, bounded flush, model extraction, validation                            | T09, T10 | T08 (T10 also T06)                     |
| `src/observation/reflection`   | reflections, conflict flags, merge proposals                                                   | T11      | T10                                    |
| `src/retrieval/`               | RAG coordinator, per-scope fanout, deadline, token accounting                                  | T12      | T04, T06, T08                          |
| `src/inject/`                  | evidence packer, `before_agent_start` + `context` matched injection, recall tools              | T13      | T11, T12                               |
| `src/backup/`                  | transcript chunker, manifest, verification, export                                             | T14, T15 | T06, T08 (T15: T14)                    |
| `src/board/`                   | board repository, send/list/read, delivery, ack, GC command                                    | T16, T17 | T04, T05, T06, T07 (T17 also T08, T16) |
| `src/controls/`                | `/kiwifs-*` commands, status, forget/undo                                                      | T18      | T13, T15, T17                          |
| evaluation harness             | integrated fault/privacy suite                                                                 | T19      | T18                                    |
| docs                           | README, ops/security guide                                                                     | T20      | T19                                    |

### Milestone gates

Milestones (phases mirror PRD delivery sequence; a gate passes only when every listed criterion is evidenced, and release of each phase additionally requires user approval):

1. **Contracts & decisions** (T01–T02): this document set + PRD alignment; architecture + default table (§13) reviewed; approval gate. Gate: architecture approval. Rows #18–#20 do not block v1: automatic deletion and restore-into-Pi are deferred; unredacted archival is excluded by confirmed privacy policy.
2. **Safe foundation** (T03–T07): config/identity, MCP adapter + fixtures (incl. opt-in live runner skeleton), records, privacy gate, outbox. Gate: zero cross-scope hits in fixtures; crash matrix (§12 table) green; private mode suppresses all outbound edges.
3. **Observational memory + RAG** (T08–T13): session coordinator, observer, reflections, retrieval, injection. Gate: steer/followUp matched-injection fixture passes or retrieval degrades to opt-in with visible status (§3.1); B3/B4 fixtures green; budget metrics meet §13 rows 1–5.
4. **Transcript backup** (T14–T15). Gate: manifest completeness verified; export non-destructive; no byte-identical claims.
5. **Board** (T16–T17). Gate: identical-payload dual-sender fixture green; at-least-once + dedupe demonstrated; GC manual-only enforced in code review.
6. **Controls, fault evaluation, release candidate** (T18–T20). Gate: full fault matrix + opt-in live runner suite green; secret-free audit verified; release approval recorded.

## 13. Decision and default table

Every previously open item is classified: **Confirmed** (user-approved in decisions.md — not re-litigatable), **Default [P]** (engineering design choice proposed here, safe default, user may override during review of the owning task), or **Unresolved** (genuinely needs a user decision before the owning task starts). This table eliminates vague TODOs.

| #   | Item                                          | Status      | Value / resolution                                                                                                                                                                                              | Owning task                             |
| --- | --------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | RAG deadline                                  | Confirmed   | 2 s total, configurable (decisions.md #7)                                                                                                                                                                       | T12                                     |
| 2   | Evidence cap                                  | Confirmed   | 3,000 tokens, configurable (decisions.md #7)                                                                                                                                                                    | T12/T13                                 |
| 3   | Scope fanout bound                            | Default [P] | N ≤ 4 authorized scope values per retrieval, shared deadline                                                                                                                                                    | T12                                     |
| 4   | Minimum-evidence threshold (brief fallback)   | Default [P] | Rebuild from search results when a filtered brief pack drops below 25% of cap                                                                                                                                   | T12                                     |
| 5   | Local token estimator                         | Default [P] | Model-compatible tokenizer including evidence framing; no automatic injection when a reliable tokenizer is unavailable                                                                                          | T13                                     |
| 6   | Steer/followUp injection                      | Default [P] | `context`-event delivery matched to consumed input by `inputId` fingerprint (raw unredacted input-event text + streamingBehavior; `/`-prefixed inputs ineligible); fail closed on ambiguity; drop at run settle | T13 (feasibility fixture gates T12/T13) |
| 7   | Tombstone cache refresh                       | Default [P] | On local forget, on reconnect, and TTL 5 min; scoped to the session's authorized scope set; advisory only                                                                                                       | T04/T18                                 |
| 8   | Outbox retention/overflow                     | Default [P] | 5,000 jobs / 50 MiB high-water limits; pause new capture with visible coverage gaps, preserve pending jobs; 14-day retention applies only to acknowledged jobs                                                  | T07                                     |
| 9   | Extraction thresholds/budgets                 | Default [P] | ≥2,000 tok or ≥10 turns or 5 min idle; 6,000/3,000 tok batch; 20-batch queue                                                                                                                                    | T09/T10                                 |
| 10  | Pre-compaction flush timeout                  | Default [P] | 5 s self-timeout, never `cancel`                                                                                                                                                                                | T09                                     |
| 11  | Backup chunk size                             | Default [P] | ≤64 KiB text per chunk                                                                                                                                                                                          | T14                                     |
| 12  | Board polling                                 | Default [P] | 60 s active, capped backoff idle; 3 empty polls → backoff; backlog pause at 500                                                                                                                                 | T17                                     |
| 13  | Board GC                                      | Default [P] | Manual `/kiwifs-board-gc` only (own messages, expired, acked, >30 d); automatic GC off; dedupe-set retention 90 d                                                                                               | T16/T17/T18                             |
| 14  | Reconciliation bound                          | Default [P] | ≤20 pages / 10,000 changes per pass, then visible pause                                                                                                                                                         | T07                                     |
| 15  | Eligibility policy details                    | Default [P] | Per §3.1 (fresh + queued eligible; slash/extension-generated ineligible)                                                                                                                                        | T12                                     |
| 16  | Source directory layout                       | Default [P] | Per §2 path grammar                                                                                                                                                                                             | T05                                     |
| 17  | Board channel naming                          | Default [P] | `board/{channel}` with the §2 charset grammar; channels created implicitly on first write                                                                                                                       | T16                                     |
| 18  | Automatic board message deletion by any party | Deferred    | Default is no automatic remote deletion; if the user ever wants aggressive server-side board expiry, that is a new decision (touches B5/B6 policy)                                                              | —                                       |
| 19  | Unredacted archival                           | Excluded    | decisions.md #2/#10 fix redaction; unredacted archival is excluded from v1, not an unresolved approval requirement                                                                                              | No v1 gate                              |
| 20  | Restore-into-Pi                               | Deferred    | Export verified in T15; restoring into Pi sessions needs format-contract verification and explicit user approval                                                                                                | Deferred beyond v1                      |

Any change touching confirmed decisions.md scope or privacy policy requires explicit user approval. **[P]** defaults may be changed by the user at any time before their owning task's milestone gate without re-opening the architecture.
