# KiwiFS memory implementation plan

Status: draft backlog based on the requirements interview and completed targeted research. Architecture approval and the remaining decisions below still block dependent implementation. Revised against the adversarial review in `docs/architecture-review.md` (F1–F10, R1–R5 resolved; decision/default table in `docs/architecture.md` §13).

Environment status (from `docs/test-environment.md`): the dedicated test space is **already provisioned and verified** — separate KiwiFS process, storage root, Git repository, SQLite index and pgvector table; Streamable HTTP MCP on port 8182; capability discovery succeeded (71 tools advertised); synthetic create, update, read, FTS search, delete and cleanup passed with routing isolation confirmed. **Not yet built:** the reusable opt-in live test runner (manifest-bound cleanup, routing checks), the adapter, and all feature code. Do not re-provision; do not write to deployment config; never claim VPN-only enforcement of auth or tenant isolation (ports are open on all interfaces; Unix user/DB role/key are shared — routing and data separation are not hard security boundaries).

## Research constraints added after targeted investigation

Research run: `kiwifs-observation-design-research-mtsr63ba-snksmt`. Reported backend source: KiwiFS v0.19.62, revision `3961d5e70a9e0ef457e58e29c40c52c870d57e73`. These are source/deployment-definition findings, not a live service health check. T01 must retain exact evidence and verify implementation-critical contracts.

- Deployment definitions indicate REST and MCP, API-key authentication, FTS plus pgvector, OpenRouter embeddings, and periodic Git remote pushes. Never copy deployment secrets into this public repository. Note: the source audit enumerated 61 tool names at the pinned revision, but live capability discovery on the test endpoint advertised 71; live `tools/list` is authoritative and no count is hard-coded.
- Semantic scope filtering reportedly occurs after candidate selection. Increasing top-k does not guarantee recall or authorization. T12 must test scoped under-recall and use a verified bounded fallback; distinguish client-side filtering from backend access control.
- Hybrid search can reportedly return HTTP 200 while using only FTS. T04/T12 must inspect reported engines rather than claiming semantic search from status code alone.
- Vector indexing is asynchronous and may drop jobs when full. T12/T18 must disclose available diagnostics and avoid promising immediate semantic visibility. Index administration remains outside extension scope.
- The reported single-key deployment lacks per-path authorization. Board recipients and project namespaces are organizational boundaries, not confidential channels against other holders of that key.
- No history-purge API was found. Deleting a page cannot erase Git remotes, backups or every index; T18 must not imply otherwise.
- `agent_settled` is a candidate observer trigger. Exact user-input event wiring and retrieval completion before context injection still require integration tests; do not implement an assumed generic `message` hook.
- Keep durable local outbox/cursor recovery compatible with offline startup. A server-only cursor is not sufficient while writes are queued. T07–T09 must reconcile acknowledged backend coverage with locally accepted jobs.
- Pre-compaction work must remain bounded. Do not adopt the research suggestion to always cancel compaction after extraction failure without an explicit policy decision.
- Remote transcript backup fidelity remains unresolved. Redaction is selected; byte-identical remote backup is not. Research labeling redacted backup as fully selected does not settle attachment or recovery policy.

Research options such as REST primary, JSONL outbox storage, and changes-feed delivery remain proposals, not approved decisions. (The 3,000-token evidence budget is **confirmed**, decisions.md #7 — not a proposal.)

## Verification update (post-interview)

The follow-up interview is complete (`docs/decisions.md`) and backend/Pi contracts have been verified against primary sources: `docs/research/mcp-contracts.md` (KiwiFS v0.19.62 @ `3961d5e70a9e0ef457e58e29c40c52c870d57e73`) and `docs/architecture.md` (Pi 0.85.0, local `node_modules/@earendil-works/pi-coding-agent`). MCP is required in v1 and no REST fallback is approved. Verified blockers that tasks below must honor:

- B1: standalone port-8181 MCP is unauthenticated; the adapter targets the apikey-authenticated `/mcp` on the main server (3333) or a mandated network ACL.
- B2: no conditional (If-Match) writes over MCP; replay idempotency uses deterministic paths/content, never optimistic concurrency.
- B3: superseded/deleted records can surface via semantic and hybrid (vector-leg) search; adapter tombstone guard plus read-back verification is mandatory before injection.
- B4: semantic scope filtering is post-candidate (200/4096 candidate caps); bounded under-recall is permanent and must be disclosed, never promised away.
- B5: no board TTL or push-notification primitives; `kiwi_changes` polling plus client-side TTL only; at-least-once with client dedupe, no exactly-once claims.
- B6: no history-purge tool; permanent erasure is a documented operator procedure with no secure-erasure guarantee.

Verified Pi hooks to build against: `input` is awaited before the first LLM call (including queued steer/followUp inputs, distinguishable via `InputEvent.streamingBehavior`); `before_agent_start` is the single-shot injection point; `agent_settled` triggers observation; `session_before_compact` is awaited with a `signal` and `cancel`/`compaction` results; fork/switch/tree/shutdown hooks support generation tracking. There is no generic `message` hook.

## Product

Build a Pi-side extension connecting to an existing KiwiFS instance. Primary function: observational memory. Secondary functions: session transcript backup and an agent-to-agent message board.

Confirmed requirements:

- Automatically extract observations, with inspection and undo.
- Run retrieval-augmented generation (RAG) search after each user input; inject bounded relevant evidence and expose explicit search/read tools.
- Support project and personal-global memory. Cross-project recall requires opt-in.
- Default extraction/consolidation model: OpenRouter `z-ai/glm-5.3-flash`, configurable by the user.
- Detect duplicates, propose merges, and flag conflicting claims.
- Preserve transcript/tool-output backups and support agent messaging.
- Redact secrets before external storage or model requests; support exclusions, private mode, and an activity log.
- Continue Pi operation during backend outages using a durable local retry queue.
- Support reversible forgetting and a separate permanent-erasure procedure.

All delegated development/research agents must use `openrouter/z-ai/glm-5.3-flash` unless the user changes this instruction. This routing constraint is separate from the extension's configurable runtime model.

## Boundaries

Do not install, start, configure, or administer KiwiFS. Do not copy unlicensed extension code. Do not publish npm releases without approval. Do not read existing stored memories or credentials during deployment research. Do not claim secure erasure while Git history, backups, indexes, or local queues retain copies.

No autonomous execution of board messages. No mandatory cloud embeddings provider. No second transport implementation until justified by verified deployment requirements. Existing scaffold and CI are completed work, not implementation tasks to repeat.

## Proposed architecture, pending verification

> **Superseded (post-decision):** this section predates the follow-up interview. The transport choice is now confirmed: MCP-only in v1 (decisions.md #1); REST is not approved and is not a fallback. The component sketch below is retained for history only — `docs/architecture.md` is authoritative.

```text
Pi events / commands / tools
          |
          v
Session coordinator ---- Scope resolver ---- Privacy gate
          |                       |
          +--> Observer ----------+--> Memory repository
          +--> Transcript exporter+--> Durable outbox --> KiwiFS adapter
          +--> Board client ------+                         |
          |                                                 v
User input --> RAG coordinator --> scoped backend search --> evidence pack
                                   |
                                   v
                      bounded ephemeral Pi context
```

Keep transport, storage schema, policy, and Pi lifecycle separate. ~~Prefer a single backend adapter chosen from verified REST/MCP capabilities. Native `fetch` is sufficient if REST requirements permit; do not add an HTTP dependency by default.~~ Superseded: MCP-only is confirmed (decisions.md #1); REST-dependent wording no longer applies.

All asynchronous results carry session/branch generation and scope. Stale work must not inject into a replacement session. Persist processing cursors only after durable acceptance of corresponding work. A durable local queue is another sensitive data store and needs explicit retention and protection.

Suggested source areas: `src/config/`, `src/domain/`, `src/backend/`, `src/privacy/`, `src/outbox/`, `src/pi/`, `src/observation/`, `src/retrieval/`, `src/backup/`, `src/board/`. Create areas as needed, not empty directories in advance.

## Decisions blocking implementation

The follow-up interview is complete: see `docs/decisions.md`. **MCP is required in v1**; REST-only implementation is unacceptable. Confirmed choices resolve backup fidelity, board visibility, identity, observer failure policy, and initial RAG budgets. The items below now require contract verification and architecture documentation rather than repeating those interview questions.

D1. Verify installed KiwiFS version and exact supported REST/MCP operations from `/home/fazekasda/projects/SelfHosted/KiwiFS`, without exposing secrets or contacting the live service.

D2. Choose transport, authentication configuration, stable project/user/agent identity and authorization boundaries. Metadata scope alone is not an authorization boundary.

D3. Implement confirmed redacted session-tree backups with binary omission manifests. Unredacted archival is excluded from v1. Verify export completeness; restore into Pi is deferred. Specify retention without deleting pending work.

D4. Define board visibility and delivery: project channels/direct recipients, notification timing, acknowledgments, TTL and whether polling is sufficient. Do not promise exactly-once delivery.

D5. Define observer cadence: completed-response trigger with batching thresholds, pre-compaction bounded flush, and manual run. Select initial token, latency, queue-size and retention budgets.

D6. Define reflection behavior: bounded summaries may be automatic, but disputed source claims and proposed merges require the agreed approval policy. Confirm interaction with Pi's native compaction and other memory extensions.

Record answers and evidence in `docs/architecture.md` and `docs/decisions.md`. Proposed defaults are not user-approved decisions.

## Delivery sequence

1. Evidence and decisions: T01–T02.
2. Safe foundation: T03–T07.
3. Observational memory and per-input RAG: T08–T13.
4. Transcript backup: T14–T15.
5. Agent board: T16–T17.
6. User controls, fault tests and release readiness: T18–T20.

Dependencies below are authoritative. Independent tasks can run in parallel after dependencies pass. Each task should produce a reviewable change; split oversized tasks into child tasks without weakening acceptance criteria.

## Shared definition of done

Every implementation task must:

- Add automated tests for its acceptance criteria, including relevant failure paths.
- Pass `npm run check`, `npm run pack:check`, and `devenv test` before merge.
- Keep Node 22.19.0 and Node 24 CI passing, or explicitly propose a compatibility change first.
- Use synthetic fixtures, never real credentials, transcripts, or user memories.
- Keep credentials and sensitive content out of logs, snapshots, thrown error messages and package artifacts.
- Document configuration and observable behavior introduced by the task.
- Record tests actually run and remaining limitations. No task closes with failing or skipped required acceptance checks.

For Pi UI changes, verify TUI behavior manually and automate RPC/headless checks; browser testing is not relevant to this terminal extension.

## Task backlog

### T01 — Verify deployment and backend contracts

**User story:** As an implementer, I need proven backend contracts so the extension does not depend on imagined APIs.

**Depends on:** none. **Output:** `docs/research/mcp-contracts.md`.

**Instructions:** Largely complete: `docs/research/mcp-contracts.md` records verified MCP contracts for KiwiFS v0.19.62 @ `3961d5e70a9e0ef457e58e29c40c52c870d57e73` (transport/auth, the 61 source-enumerated tool names with the live 71-tool count recorded, key schemas, search internals, board primitives, Pi 0.85.0 event surface, blockers B1–B6, synthetic fixtures). Remaining work: fold these contracts into implementable adapter test fixtures; specify the reusable opt-in live MCP runner (its safeguards are already recorded in `docs/test-environment.md`) as a T04/T19 deliverable; re-verify if the deployment's KiwiFS version changes; keep the record secret-free.

**Acceptance criteria:**

- [x] Every required operation has a source citation and version, or is marked unsupported with a documented alternative/blocker.
- [x] Search evidence covers FTS/vector/hybrid support, scope filtering (FTS SQL-side; semantic post-candidate with 200/4096 caps), superseded-record leak in semantic/hybrid, async vector indexing with dropped jobs, and result shapes including hybrid engine attribution.
- [x] Append/update/create conflict behavior (no If-Match over MCP; atomic append; ETag read-back), actor/provenance semantics and `kiwi_changes` cursor delivery are verified; conditional writes and history purge are recorded as blockers.
- [x] Deployment report contains no credentials, private service data or stored memories.
- [x] No live service mutation or probe occurs without separate authorization.
- [x] Contract fixtures for the adapter (T04) exist and trace to citations in `docs/research/mcp-contracts.md`. Done in T01: synthetic fixtures in `test/fixtures/mcp/` with catalog `docs/research/adapter-fixtures.md` (guard pipeline, limits, error normalization, board msg-id vectors, search/CRUD/changes/brief shapes). Fixture 11 (Pi-side ordering) remains spec-level, owned by T08/T12/T13.
- [x] The reusable opt-in live MCP runner is specified (capability discovery via `tools/list`, random run IDs beneath `integration-tests/`, manifest-owned cleanup, routing check before mutation, bounded duration, redacted diagnostics) and assigned to T04 (implementation) and T19 (suite execution) per `docs/test-environment.md` safeguards. Done in T01: `docs/research/live-mcp-runner.md`.
- [x] The 61-source-names vs 71-live-tools discrepancy is dispositioned (adapter is capability-driven, so it is informational unless a required tool turns out to be missing live). Done in T01: disposition recorded in `docs/research/mcp-contracts.md` §3.

### T02 — Resolve decisions and approve architecture

**User story:** As the owner, I want explicit decisions before implementation fixes policy in code.

**Depends on:** T01. **Output:** `docs/architecture.md`, `docs/decisions.md` and updated backlog.

**Instructions:** D2–D6 are resolved in `docs/decisions.md`; `docs/architecture.md` now proposes components, schemas/path layout, Pi event sequences, the MCP wire boundary, observer/compaction interaction, per-input RAG with one total deadline, privacy/query redaction, durable chunks plus outbox/reconciled cursors, crash/switch/fork/reload behavior, backup completeness, board concurrency/delivery, authorization limitations, secret-free audit, migrations, fault tests, milestone gates, and the decision/default table (§13) that classifies every open item as confirmed, [P] default, or genuinely unresolved. Unselected engineering details are labeled **[P]** proposals. Remaining work: user review/approval of the architecture, the §13 default table, and the review resolutions in `docs/architecture-review.md`; record requested revisions before dependent implementation. Do not modify `docs/decisions.md` without user approval.

**Acceptance criteria:**

- [x] Transport (MCP-only, decisions.md #1), backup fidelity (redacted, no byte-identical claim), board semantics (routing labels, no confidentiality), scoping, cadence and resource budgets have recorded decisions.
- [x] Every component maps to verified Pi hooks and MCP primitives with citations.
- [x] Session switch/fork/reload, compaction (bounded flush, never indefinite cancel), crash recovery and private mode have explicit sequences.
- [x] Remaining unknowns are labeled proposals/blocked tasks (B1–B6), not silent defaults.
- [x] Every previously vague open item is dispositioned in the §13 decision/default table (confirmed / [P] default / unresolved); only genuinely user-level choices (#18–#20) remain unresolved.
- [x] User approves architecture, the §13 default table, and the review resolutions in `docs/architecture-review.md`, or requested revisions are recorded before dependent implementation. _Recorded T02: the user approved the architecture set by instructing execution of the approved task plan (architecture approval = the execute-plan instruction). Coordinator corrections applied at the same time: pending outbox jobs never drop-oldest — capture backpressure with visible coverage gaps (architecture.md §2 aligned with §13 row 8); model-compatible tokenizer including framing required for the 3,000-token cap, else visible skip of automatic injection (§13 row 5, already reflected); queued-input matching must distinguish newly consumed occurrences, repeated identical text, transformations and followUp lifecycle — history membership alone insufficient (§3.1/T13 fixture, remaining gate). Rows #18–#20: #19 excluded by confirmed privacy policy; #18/#20 deferred, not blocking v1. No revisions to decisions.md._

### T03 — Implement validated configuration and scope identity

**User story:** As a user, I can configure my existing service without leaking credentials or mixing projects.

**Depends on:** T02. **Output:** config loader, schema and scope resolver.

**Instructions:** Implement documented precedence and validation for endpoint, credential references, model route, scopes, budgets and feature flags. Derive stable project identity using the approved rules; provide explicit overrides for non-Git projects and ambiguous remotes.

**Acceptance criteria:**

- [x] Tests cover invalid URLs, missing credentials, conflicting config and explicit overrides.
- [x] Worktrees/branches/non-Git directories follow the recorded identity policy.
- [x] Cross-project reads are denied by default.
- [x] Status output exposes resolved nonsecret settings only.
- [x] Private mode disables all three feature domains, not only observation extraction.

### T04 — Implement backend adapter and contract tests

**User story:** As a feature developer, I use one typed backend boundary with predictable errors.

**Depends on:** T03. **Output:** adapter interface, MCP transport and fake server fixtures.

**Instructions:** MCP-only (decisions.md #1); no REST fallback. Target the apikey-authenticated `/mcp` on the main server (B1). Discover capabilities at connect time (`tools/list` is authoritative — live endpoint advertises 71 tools vs 61 enumerated in source; never hard-code counts). Implement exactly the verified operations in `docs/research/mcp-contracts.md` §8. Handle stateless sessions (re-initialize per logical connection, no SSE reliance), `IsError=true` JSON-RPC successes as typed errors, hybrid degradation detection via rank attribution (never status), and the guard pipeline per candidate (B3, fail-closed at every step): fresh `kiwi_read` → status check (`memory_status` absent/active only) → scope check (`$.scope` in the session's authorized scope set — the only scope gate on hybrid/brief legs) → path-prefix check → privacy redaction; the cached tombstone list is advisory pre-filtering only. Enforce durable randomly unique `opId`s persisted before any side effect; read-before-write with differing-content collisions failing closed; no CAS/ETag-match/exactly-once behavior (B2). Replay idempotency via op-id-derived deterministic paths, never optimistic concurrency. Normalize authorization, validation, conflict, timeout and availability errors. Propagate cancellation; bound responses and retries. Reject unintended credential forwarding to redirected hosts. Implement the opt-in live MCP runner specified in T01 against the already-provisioned test space (MCP 8182) per `docs/test-environment.md` safeguards. Note: B1 (endpoint auth as a hard prerequisite) governs the **production** endpoint; the live runner targets only the network-restricted dedicated test service, and 8182's auth behavior is recorded as evidence, never assumed.

**Acceptance criteria:**

- [x] Contract fixtures cover CRUD, search (FTS/semantic/hybrid incl. `keyword only` degradation), pagination, limits (limit clamp 50, 32 MiB content, 500-char path), `if_not_etag` reads, `kiwi_changes` cursor replay, the full B3 guard pipeline (read-back, status, scope, path, redaction — each step proven to reject its failure case, incl. stale/empty tombstone cache), op-id replay/collision fail-closed behavior, and the brief scope-gate fixture (`mcp-contracts.md` §9, 5a–5c). _T04: wired into the fake MCP server (`test/fake-mcp-server.ts`) and asserted in `test/backend.test.ts`, `test/guard.test.ts`, `test/live-runner.test.ts` (75 tests); msg_id vectors asserted against real SHA-256; fixture 11 (Pi-side ordering) remains T08/T12/T13-owned._
- [x] Timeouts and cancellation terminate pending requests within configured bounds (request-context cancellation propagates into backend calls). _T04: combined per-request timeout + caller `AbortSignal`; TimeoutError/CancelledError tests with a hanging fake server; cancellation propagates into the backend request. Review fix: the per-request deadline now arms the entire lifecycle including the streamed body read — a mid-body stall test (`stallBodyAfterBytes`) proves `TimeoutError` fires within the bound._
- [x] Authorization errors are not retried as transient failures; auth failures on the chosen endpoint are a hard setup error. _T04: HTTP 401/403 → `AuthError` (hard setup), zero retries asserted; only `AvailabilityError` on IDEMPOTENT tools retries once. Review fix: `kiwi_append` is excluded from availability retry (non-idempotent per `mcp-contracts.md` — replays duplicate by design); test asserts exactly one call attempt and no partial content; JSON-RPC protocol errors map to non-retryable `ResponseFormatError`._
- [x] Invalid/oversized backend responses produce typed safe failures. _T04: `ResponseFormatError` for non-JSON, id mismatch and bounded-read overflow (header + stream-enforced bound); nothing buffered beyond the bound._
- [x] No constructor/factory performs network I/O. _T04: request-count test proves zero traffic until `connect()`._
- [x] The opt-in live runner executes capability discovery, a synthetic CRUD/FTS round trip and manifest-owned cleanup against the dedicated test space (MCP 8182), never touching production spaces and never claiming VPN-only enforcement. _T04: implemented per `docs/research/live-mcp-runner.md` (`npm run test:live`, opt-in gate `KIWIFS_LIVE_TESTS=1` + local config). Executed once: clean-pass, run `0b7c88c743aa`, 71 tools advertised (no required tool missing), routing check before first write, synthetic create/read-back/update/FTS/delete verified, manifest cleanup with zero leftovers; auth note recorded as connectivity evidence only. Live probe also confirmed the ETag carrier: write/append carry `ETag:` in the text result and read `_meta` is empty — adapter parses text as fallback; the `_meta["kiwi.etag"]` read fixture remains a synthetic convention (fixtures doc honest gap now dispositioned). Probe path deleted and absence verified; 16-hex `msg_id` truncation stays [P] default for T16._

### T05 — Define versioned records and provenance

**User story:** As a user, I can trace each observation or message to its source and safely evolve stored data.

**Depends on:** T02. **Output:** validated domain schemas and serialization fixtures.

**Instructions:** Define observations, reflections, source references, tombstones, backup manifests/chunks, board messages and processing cursors. Include schema version, stable IDs, scope, timestamps and lifecycle status. Specify deterministic idempotency keys and migration policy.

**Acceptance criteria:**

- [x] Round-trip tests preserve supported metadata and content. _T05: `test/domain.test.ts` round-trips every record in `test/fixtures/domain/records.json` (markdown → parse → serialize → parse; frontmatter and body deep-equal); board-message routing fields (`to`/`from`/`channel`/`ttl`) preserved; serialization refuses non-current schemaVersions._
- [x] Malformed and unknown future versions fail safely without destructive rewrites. _T05: 9 malformed fixtures (`malformed-cases.json`) each fail with typed reason and `readOnly: true`; future `schemaVersion: 2` backend records and local artifacts fail as `future-version` read-only; nothing is ever rewritten (writer refuses schemaVersion ≠ 1)._
- [x] Source references distinguish session, branch and entry IDs. _T05: `SourceRef {sessionId, branchId?, entryIds[]}` round-trips all three id spaces distinctly; a source without branchId gains no phantom value; fork with shared entries but new sessionId has a distinct idempotency key._
- [x] Idempotency key tests cover repeated events and forked/shared history. _T05: same event → same key (key-order independent via canonical JSON); forked session/other branch/reordered entries/different scope → distinct keys; record ids derive from persisted opIds (`deriveRecordId`, 16-hex) and stay consistent with T04's `deriveMsgId` convention._
- [x] Untrusted paths/IDs cannot escape their intended namespace. _T05: strict grammar `^[a-z0-9][a-z0-9-]{0,63}$` (`validateId`) rejects traversal/encoding/length/charset attacks; `validateProjectId` rejects `..` segments and separator abuse while accepting T03 git identities; path builders (`memoryRecordPath`, `backupManifestPath`, `backupChunkPath`, `boardMessagePath`) and containment checks (`pathWithinMemoryNamespace`, `pathWithinBoardChannel`, `pathWithinBackupTree`) tested against `../`, `%2e%2e`, prefix-boundary (`memory-evil/`) and cross-scope escapes. Post-review: `memoryRecordPath` month buckets switched to UTC (`getUTCFullYear`/`getUTCMonth`) so the deterministic path is timezone-independent; verified by a TZ=UTC vs TZ=Asia/Tokyo month-boundary test._

### T06 — Implement privacy gate and sanitized audit events

**User story:** As a user, I control what leaves my machine and what gets retained locally.

**Depends on:** T03, T05. **Output:** shared privacy pipeline and tests.

**Instructions:** Apply exclusions and approved redaction before model requests, backend writes, query transmission, durable queue storage and audit logging. Define behavior when content cannot be classified safely. Audit metadata, not full payloads, by default.

**Acceptance criteria:**

- [x] Synthetic secret fixtures never appear in outbound payloads, queue bytes, logs or error messages.
- [x] Private mode suppresses network reads/writes and new capture/backup/board jobs.
- [x] Enabling private mode prevents pending jobs from sending; resume behavior matches approved policy.
- [x] Exclusion rules cover project, path and content patterns.
- [x] Documentation states scanner limitations and backup fidelity implications.

### T07 — Implement durable outbox and recovery

**User story:** As a user, backend outages do not lose accepted work or stop Pi.

**Depends on:** T04, T05, T06. **Output:** bounded outbox, worker and crash tests.

**Instructions:** Persist sanitized jobs atomically before acknowledging durable acceptance. Because MCP offers no conditional writes (B2), idempotent operations mean deterministic backend paths + content derived from the idempotency key, with read-before-write where the tool requires it; never rely on optimistic concurrency. Local durable state is the authoritative cursor for every pipeline; `kiwi_changes` `since`/`last_seq` is a reconciliation aid only — offline startup must work entirely from local state. Capped exponential backoff with jitter, per-scope ordering where required, permanent-failure quarantine. Define multi-process locking, retention and overflow behavior (proposed defaults in `docs/architecture.md` §2).

**Acceptance criteria:**

- [ ] Crash tests cover before persistence, after persistence, and remote success before local acknowledgment.
- [ ] Replayed jobs do not duplicate logical observations, archive chunks or board messages (deterministic-path idempotency, B2).
- [ ] Offline startup processes pending jobs and advances pipelines using only local cursors; backend cursor drift is detected at reconnect and reconciled, never trusted blindly.
- [ ] Transient failures retry; permanent failures become inspectable without an infinite loop.
- [ ] Queue high-water limits pause new capture with visible coverage gaps and preserve pending jobs. Age-based cleanup applies only to acknowledged work. Disk-full/crash fixtures prove pending jobs and cursors survive without false backup-completeness claims.
- [ ] Queue permissions and multi-process tests prevent accidental exposure/corruption.
- [ ] Failed jobs never block ordinary Pi model interaction.

### T08 — Implement Pi session coordinator

**User story:** As a user, memory follows the correct session and branch across lifecycle changes.

**Depends on:** T03, T05, T07. **Output:** hook wiring and lifecycle harness.

**Instructions:** Pi 0.85.0 hooks are already verified (`docs/research/mcp-contracts.md` §6): `session_start`, `session_before_fork/switch/tree`, `session_tree`, `session_shutdown`. Track session generations, active branch and durable cursors. Cancel stale work, initialize resources at supported lifecycle boundaries, and make cleanup idempotent.

**Acceptance criteria:**

- [ ] Tests exercise startup, new session, resume, fork, branch navigation, reload and shutdown.
- [ ] Delayed results from a previous generation cannot alter current context or cursors.
- [ ] Shared ancestor entries are not captured repeatedly merely because a fork occurs.
- [ ] Duplicate event delivery and repeated teardown are harmless.
- [ ] Headless/RPC paths never require TUI-only APIs.

### T09 — Implement incremental observer scheduling

**User story:** As a user, important conversation changes become observations automatically without repeated full-session processing.

**Depends on:** T08. **Output:** incremental input selection and scheduler.

**Instructions:** Select unprocessed source entries and schedule bounded extraction using the agreed completed-response/batching policy (decisions.md #6; proposed thresholds in `docs/architecture.md` §3.2). Support manual extraction and a bounded pre-compaction flush: on `session_before_compact`, run one extraction attempt with a self-timeout honoring the event's `signal`; the handler never returns `cancel` by default — on timeout/failure it returns normally so compaction proceeds, and unprocessed ranges stay durably covered with visible pending status. Exclude the extension's own injected evidence and internal work from recursive capture.

**Acceptance criteria:**

- [ ] A source interval is processed once logically despite repeated triggers.
- [ ] New content arriving during an extraction schedules a later non-overlapping batch.
- [ ] Empty/irrelevant batches do not invoke the model unnecessarily.
- [ ] Pre-compaction flush is bounded by its self-timeout and the compaction `signal`; it never blocks compaction indefinitely and never returns `cancel` by default (decisions.md #6).
- [ ] Durable cursor advances only when related work is durably accepted (outbox acceptance); unprocessed ranges survive compaction, crash and restart.
- [ ] Extraction jobs persist `opId`, source entries and batch parameters before the model call, and extraction results are persisted as durable outbox jobs before any backend write; a crash at any point re-derives or replays under the same `opId` without duplicating observations (deterministic-path + read-before-write with fail-closed collisions, `docs/architecture.md` §2).

### T10 — Implement observer model calls and validation

**User story:** As a user, extracted observations are sourced, bounded and reviewable.

**Depends on:** T06, T09. **Output:** model adapter, prompts and validated extraction.

**Instructions:** Use the configured model, defaulting to OpenRouter GLM as selected. Produce structured observations with source entry references and uncertainty. Enforce input/output budgets and bounded validation retries. Never silently substitute another model.

**Acceptance criteria:**

- [ ] Tests use deterministic fake model responses, not paid live calls.
- [ ] Malformed output, hallucinated source IDs, timeout and provider rejection produce safe visible failures.
- [ ] Stored observations refer only to supplied source entries.
- [ ] Model identity and usage/cost data, when available, are visible without payload logging.
- [ ] Observation content cannot be interpreted as instructions to execute tools.

### T11 — Implement reflections, conflicts and merge proposals

**User story:** As a user, memory remains compact without silently overwriting disputed facts.

**Depends on:** T10. **Output:** reflection generation and proposal lifecycle.

**Instructions:** Build bounded reflection summaries according to approved policy, retaining source links. Detect duplicates and contradictory claims. Keep proposals separate from accepted records; support approve, reject and undo.

**Acceptance criteria:**

- [ ] Duplicate batches do not produce unbounded duplicate summaries/proposals.
- [ ] Conflicting facts remain distinguishable and are labeled during retrieval.
- [ ] Approval uses verified concurrency protection; stale approvals fail visibly.
- [ ] Undo restores logical visibility and records provenance rather than erasing history silently.
- [ ] Reflection failure leaves original observations intact.

### T12 — Implement per-user-input RAG retrieval

**User story:** As a user, each new request benefits from relevant prior evidence without manual recall.

**Depends on:** T04, T06, T08. **Output:** query coordinator and retrieval tests.

**Instructions:** Use verified Pi input semantics (`docs/research/mcp-contracts.md` §6): `input` is awaited before the first LLM call; `InputEvent.streamingBehavior` distinguishes fresh vs steer/followUp; slash commands and extension-generated inputs are ineligible; tool loops emit no `input` event. Arm ONE total deadline (2 s, user-confirmed configurable — decisions.md #7; the value is not a proposal) covering query build, all backend calls, dedupe and ranking — a single `AbortController`, not per-attempt budgets. Bound the fanout: at most N = 4 **[P]** queries (one per authorized scope value — record `scope` is a single owner value; the session holds an authorized scope set), all inside the shared deadline; skipping a scope query on budget exhaustion is a logged degradation. Generate a bounded redacted query per scope value. Scope enforcement per leg: `kiwi_search` (FTS, SQL-side `scope`) and `kiwi_search_semantic` (server-side `scope` param, B4 under-recall disclosed) are the scope-critical legs; `kiwi_brief` has no `scope` parameter and is used only with a pinned `path_prefix` plus the adapter's client-side scope/read-back post-filter on every returned page — no brief content passes through unverified (fallback rebuild from scoped search results when the filtered pack falls below the minimum-evidence threshold, `docs/architecture.md` §13 row 4). Apply the full B3 guard pipeline, deduplicate and rank. Token accounting uses a tokenizer compatible with the active model and includes framing and citations. Server `budget_tokens` and character estimates are advisory only. Without a reliable tokenizer, skip automatic injection and report degradation. Vector health is never inferred from keyword-only hits — attribution `keyword only` is reported as degraded, never as semantic evidence.

**Acceptance criteria:**

- [ ] Each eligible user input triggers one logical retrieval cycle; tool-loop LLM calls do not repeat it (proven against Pi 0.85.0 ordering: evidence precedes the first `before_provider_request`).
- [ ] Queued/steering inputs and commands follow the documented eligibility policy; a steer-queued input gets its own retrieval cycle, and its evidence pack is injected only on the provider call that consumes that input (matched-injection fixture, `mcp-contracts.md` §9 fixture 11); unmatched packs fail closed and are dropped with visible degraded status, never carried into a later unrelated turn.
- [ ] Tests prove scope restrictions are applied with zero cross-scope hits — including on `kiwi_brief` and hybrid legs via the client-side post-filter — and semantic under-recall (B4) is measured and reported, never hidden.
- [ ] The single total deadline is respected across the entire scope fanout (≤ N queries) and permits Pi continuation; expiry injects nothing and records a degraded status.
- [ ] Missing vector index/provider follows the documented fallback with observable engine attribution, never fabricated semantic results and never inferred vector health from keyword-only hits.
- [ ] Forgotten, excluded and unauthorized records cannot appear in returned evidence (full B3 guard pipeline; FTS `memory_status` exclusion verified).
- [ ] The compatible tokenizer verifies the complete evidence payload is within the cap, including multilingual text, code, framing and citations. Unsupported tokenizers skip automatic injection visibly.

### T13 — Implement bounded context injection and recall tools

**User story:** As an agent user, I receive useful evidence without session bloat and can inspect original sources.

**Depends on:** T11, T12. **Output:** evidence packer, context hook and search/read tools.

**Instructions:** Fresh turns inject via `before_agent_start`, whose handler result carries **one** custom extension message (`result.message`, singular — `types.d.ts:845–849`; an evidence pack plus any other extension message must be merged into that single message). Steered/followUp inputs have no new `before_agent_start`; their packs are delivered via the `context` event and injected only when `context.messages` contains the user message matching the pending pack's `inputId` fingerprint — a hash of the **raw input-event text (unredacted; it is local matching state, never outbound) plus `streamingBehavior`**. Raw text must be used because queued steer/followUp messages are stored by Pi as _expanded_ text (`agent-session.js:853–868`) while `emitInput` observes pre-expansion text (`agent-session.js:841–853`); all `/`-prefixed inputs are ineligible for retrieval, so expansion can never affect an eligible pack. A `followUp` may begin a new agent run, still without `before_agent_start`. Evidence must be matched to the consumed input, not merely to the next `context` fire; on ambiguity or an unmatched run settle, the pack fails closed (dropped, visible degraded status). Any `context`-event use is deduped by `inputId` because the event fires on every LLM call including tool loops. Feasibility of the consumed-input linkage must be proven by a Pi 0.85.0 fixture before T12/T13 land; if unsupported, steer/followUp retrieval degrades to opt-in and is surfaced. Keep the latest eligible evidence pack isolated by session/input. T13 fixtures must include a case with privacy redaction active (fingerprinting still matches the raw unredacted input text) and a template-expanded queued case (expansion must not diverge the fingerprint; `/`-prefixed inputs ineligible). Frame memories as untrusted data with source IDs and conflict markers. Expose explicit search/read with the same scope/privacy/guard pipeline. Verify persistence behavior against Pi source rather than assumptions.

**Acceptance criteria:**

- [ ] Evidence stays within the configured token cap using model-compatible tokenization and deterministic truncation, with a recount after framing. Character estimates never substitute for enforcement.
- [ ] A steered/followUp input's evidence is injected on the provider call consuming that input and never duplicated on later `context` fires (per-input dedupe); unmatched packs are dropped fail-closed.
- [ ] Repeated LLM calls do not append duplicate persistent memory entries.
- [ ] Prompt-injection fixtures remain data; no instructions from retrieved records gain authority.
- [ ] Explicit tools cannot bypass private mode, scope checks or tombstones.
- [ ] RPC integration proves retrieve → inject → source recall using synthetic fixtures.

### T14 — Implement transcript backup capture

**User story:** As a user, I retain session history independently of local Pi session files.

**Depends on:** T06, T08. **Output:** session-tree exporter and backup manifests.

**Instructions:** Back up completed session entries incrementally, preserving IDs, parent links, roles, tool results and supported metadata. Apply the approved redaction/attachment policy. Separate archival storage/search visibility from semantic memory so raw logs do not overwhelm RAG.

**Acceptance criteria:**

- [ ] Synthetic branched session export preserves all included entries and tree relationships.
- [ ] Interrupted capture resumes without missing or duplicating accepted entries.
- [ ] Manifest declares schema, covered source range, redaction and omitted content.
- [ ] Private/excluded content is absent according to policy.
- [ ] Raw transcript records are not automatically eligible for ordinary memory retrieval.

### T15 — Implement backup verification and export/restore path

**User story:** As a user, I can prove my backup is complete and recover supported content safely.

**Depends on:** T14. **Output:** verification command and approved recovery path.

**Instructions:** Verify chunk checksums, manifest completeness and branch links. Implement non-destructive export; native Pi session restoration only if approved in T02 and supported by verified format contracts. Never overwrite existing sessions implicitly.

**Acceptance criteria:**

- [ ] Missing, duplicated, reordered and corrupted chunks are detected.
- [ ] Round-trip fixture recovers all promised fields, with redaction/omissions explicitly represented.
- [ ] Recovery writes only to an explicit new destination after validation.
- [ ] Foreign/newer schema versions cannot silently corrupt a local session.
- [ ] Backup completeness does not claim byte-for-byte fidelity when redaction occurred.

### T16 — Implement message board storage and tools

**User story:** As an agent user, I can send and inspect scoped messages for other agents.

**Depends on:** T04, T05, T06, T07. **Output:** board repository and send/list/read tools.

**Instructions:** Implement the approved channel/recipient model over verified MCP primitives only (`docs/research/mcp-contracts.md` §5): send via `kiwi_write` of one immutable file per message at `board/{channel}/{msg_id}.md`. `msg_id` = hex-truncated SHA-256 of `channel + from + opId` (opId assigned and persisted at outbox enqueue) — never a content hash, so two senders sending identical payloads at the same sequence produce distinct messages; replays of the same job reproduce the same `msg_id` and read-before-write no-ops (differing-content collisions fail closed, B2 — no CAS). List/read via `kiwi_query_meta`. Validate sizes and identities. There are no server-side TTL or notification primitives (B5). Keep board storage separate from observation memory and backup indexes. No automatic remote deletion; GC is the manual `/kiwifs-board-gc` policy in `docs/architecture.md` §8/§13 (own messages, expired, acked, >30 d grace, explicit confirmation).

**Acceptance criteria:**

- [ ] Concurrent senders and retries preserve distinct messages without logical duplicates: the dual-sender fixture (two senders, identical payload, same sender sequence → both messages persist, `mcp-contracts.md` §9 fixture 5b) and the replay fixture (same job replays to the same path, no duplicate) both pass.
- [ ] Unauthorized channel/recipient operations are denied by the enforceable client policy; the single-key backend's lack of per-path authorization is disclosed, and routing/data separation is never claimed as hard tenant security (shared Unix user/DB role/key; ports open on all interfaces).
- [ ] TTL is enforced client-side at read time (backend has no TTL primitive, B5); ordering and pagination via `kiwi_query_meta` match the recorded contract.
- [ ] A replayed or colliding write to an existing message path with different content fails closed (quarantined, visible status), never overwrites.
- [ ] Messages cannot trigger shell commands, model runs or tool execution automatically.
- [ ] Tool responses contain safe IDs/status and do not disclose credentials.

### T17 — Implement board delivery and acknowledgment

**User story:** As an agent user, I notice new messages without repeated notifications or runaway polling.

**Depends on:** T08, T16. **Output:** bounded poll/event consumer and cursors.

**Instructions:** Use bounded `kiwi_changes` polling (verified commit-hash cursor + `last_seq`); no push notifications exist (B5). Polling is bounded per `docs/architecture.md` §13 row 12 (60 s active, capped backoff, empty-poll cap, backlog pause at 500 with visible status). Persist per-consumer cursors/acknowledgments locally — acknowledgments are local state only and mutate nothing remote; local state is authoritative, the remote cursor is a reconciliation aid; distinguish delivery from user/agent acknowledgment. Apply approved context/notification policy without interrupting active work unexpectedly.

**Acceptance criteria:**

- [ ] Reconnect/restart replays do not cause repeated logical notifications beyond the documented at-least-once + client-dedupe guarantee.
- [ ] Two consumers maintain independent local cursors; offline startup works without the remote cursor.
- [ ] Expired (client-side TTL) or unauthorized messages are not delivered.
- [ ] Private mode and session teardown stop delivery and background resources.
- [ ] Polling frequency/backoff and maximum unread work remain bounded and visible in status (backlog pause threshold enforced).
- [ ] Acknowledgment and delivery are demonstrably local-state only: no remote mutation occurs on ack, and no automatic remote deletion exists (manual GC command only).

### T18 — Implement user controls, forgetting and status

**User story:** As a user, I can inspect, pause, undo and diagnose memory behavior.

**Depends on:** T13, T15, T17. **Output:** Pi commands, status view and sanitized activity log.

**Instructions:** Extend `/kiwifs-status`; expose approved controls for private mode, observations/reflections, conflict proposals, manual capture, queue failures, archive verification and board activity. Implement soft forget (`kiwi_forget`) with retrieval/cache invalidation: the B3 tombstone guard must apply to subsequent retrieval and cached evidence. Document permanent erasure as a separate capability-checked operator procedure requiring explicit confirmation (B6).

**Acceptance criteria:**

- [ ] Status distinguishes healthy, degraded, disabled and private states plus queue/model/search capability state (including hybrid degradation attribution and vector-index availability; keyword-only hits are never reported as healthy semantic retrieval).
- [ ] Forget immediately removes eligible records from subsequent retrieval (FTS exclusion + B3 guard pipeline) and cached evidence; the tombstone cache refresh (on forget, reconnect, bounded TTL) and its advisory-only role match `docs/architecture.md` §13 row 7.
- [ ] Undo follows recorded tombstone/history policy (`kiwi_forget` is reversible; body preserved per `memory_tools.go:108–153`).
- [ ] Permanent-erasure UX discloses all known retained copies and never claims unsupported purge guarantees (B6).
- [ ] TUI checks pass; RPC/headless commands do not crash or emit terminal-only UI.

### T19 — Run integrated fault, privacy and quality evaluation

**User story:** As a user, I can rely on memory across crashes without cross-project leaks or runaway costs.

**Depends on:** T18. **Output:** reproducible fixtures, evaluation commands and report.

**Instructions:** Exercise all three features together using fake backend/model services, plus the synthetic contract fixtures from `docs/research/mcp-contracts.md` §9. Run the opt-in live integration suite (built in T04) against the already-provisioned dedicated test space (MCP 8182) with manifest-bound cleanup; never target the existing user's data by default; never claim VPN-only enforcement (ports open on all interfaces, shared Unix user/DB role/key). Measure retrieval usefulness, observation coverage, budgets and queue growth against approved baselines.

**Acceptance criteria:**

- [ ] Tests cover outage, restart, duplicate delivery, conflicting writes, malformed search/model output, superseded-recall leak (B3 incl. the read-back predicate with stale/empty tombstone cache), scope under-recall (B4) and brief-leg scope leakage, dropped vector jobs, and backend upgrades.
- [ ] The opt-in live suite runs against the dedicated test space (MCP 8182) with random run IDs, manifest-owned cleanup verified even after partial failure, and bounded duration.
- [ ] Scope/privacy adversarial suite reports zero unauthorized content disclosures in fixtures.
- [ ] Private-mode transition cancels/prevents pending sends according to policy across all features.
- [ ] Measured retrieval latency/context usage and extraction call volume meet T02 budgets.
- [ ] Retrieval fixture expectations and observation coverage criteria are documented and met; no invented quality percentages.
- [ ] Long-session test demonstrates bounded local state and no active handles after shutdown.

### T20 — Document installation and prepare release candidate

**User story:** As a new user, I can connect my own KiwiFS service and understand the extension's guarantees.

**Depends on:** T19. **Output:** README/config guide, security/operations guide and reviewed package.

**Instructions:** Replace scaffold-only README with accurate feature/setup instructions. Document minimum tested backend/Pi versions, auth references, model configuration, backup limits, messaging semantics, offline queue recovery, erasure limits and coexistence with other memory extensions. Run release checks; request approval before publication.

**Acceptance criteria:**

- [ ] Fresh-environment setup succeeds using documented steps and synthetic service credentials.
- [ ] npm tarball includes required runtime assets and no local data, logs or credentials.
- [ ] Packed-extension RPC smoke covers core registration and safe offline startup.
- [ ] Node matrix, Nix checks and full required tests pass.
- [ ] Known limitations and migration policy are explicit.
- [ ] No npm publication, release tag or live deployment change happens without approval.

## Completion criteria

The project is implementation-complete when T01–T20 acceptance criteria pass and evidence is recorded. Shipping can be phased, but backup and board are required project scope, not silently dropped stretch goals. A milestone may be released only after its safety dependencies and user approval are satisfied.
