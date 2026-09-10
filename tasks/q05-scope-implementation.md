# Q05 — personal-write / remote-GC scope reconciliation (plan only, no implementation)

Status: PLANNING REVISED IN Q05P1 (see §2a). This file records the verified
contracts, the very small executable subtask breakdown, exact acceptance,
dependencies and approval gates for Q05. It does not change product docs
beyond the recorded decisions and does not implement command surfaces.
Commit discipline per coordinator: reviewed commits, none in this
scope-contract workflow task itself.

## 2a. Q05P1 revision — G1/G2 ANSWERED (user approval, supersedes the

"needs decision" state recorded below)

The user explicitly approved Q05 personal-global writes with the policy
recommended under G1(b): explicit user action ONLY, never automatic, never
derived from or promoted out of project-scoped observations. The user also
accepted the G2 recommendation: manual board cleanup by the user for now;
remote GC is a separate, later workflow and is NOT implemented here.
Consequences, actually implemented in Q05P1 (personal-write domain/sender
support only, NO command wiring, NO commit in this workflow):

- S1 is no longer doc-only deferral: `docs/decisions.md` #13 records the
  approval verbatim-in-substance.
- `src/commands/personal-note.ts` — `buildExplicitPersonalEnqueue` (smallest
  explicit-command API for the next worker): validates one user-supplied
  statement + provenance (session/branch/entry ids), builds an outbox
  `EnqueueInput` with kind `observation`, scope `personal`, trigger
  `manual`, a deterministic idempotency key (scope is part of the key, so a
  personal record never collides with a project record) and the opId the
  outbox persists BEFORE any side effect. No I/O, no model calls.
- `src/observation/sender.ts` — jobs whose OWN durable scope is `personal`
  are dispatched before the unresolved-project-scope hold (an explicit user
  action does not depend on project identity); personal routing is valid
  for observation records ONLY and is a permanent validation failure
  (quarantine) for reflection/proposal/backup-chunk — project-only features
  are never rerouted to `personal`.
- `test/q05p1-personal-domain.test.ts` — synthetic local tests: builder
  validation and determinism, durable enqueue + reload, delivery with
  project scope UNRESOLVED, durable retry + replay no-op at the same
  deterministic path, personal-routing rejection for project-only kinds,
  and unchanged project-scope routing.
- Planned command wiring (NEXT task, not this one): one explicit command
  (TUI: preview + confirm; headless: requires `--yes`), calling ONLY
  `buildExplicitPersonalEnqueue` + `outbox.enqueue`. No automatic caller is
  permitted anywhere in capture/reflection/backup/board paths; candidate
  read guards and project-only backup/board surfaces stay untouched.
- Remote GC: out of scope here, handled by the NEXT workflow; user does
  manual board cleanup in the meantime.

## 2b. Q05P2 — command wiring implemented (explicit user personal save)

Implemented on top of §2a, same no-commit discipline:

- `src/commands/personal-note.ts` — builder relaxed in one reviewed way:
  `entryIds` is now optional/possibly empty. A personal note is the user's
  own words, so session-only provenance (SourceRef sessionId, no entries)
  is valid; the command layer never invents entry ids. Non-array or
  malformed ids are still rejected before any durable write.
- `src/index.ts` — new command `kiwifs-personal-note` (NOT a tool: the
  model has no path to it, and no capture/reflection/backup/board code
  calls it). Exact syntax:
  `/kiwifs-personal-note <statement…> [--entry id1,id2] [--yes]`.
  Flow: configGate (refuses disabled/private mode) → `scopes.allowPersonalGlobal`
  gate → parse `--entry` ids → redact (`redactText`, fail closed) BEFORE
  the confirmation preview → TUI `ui.confirm` preview of the REDACTED
  statement, or headless requires the literal `--yes` token →
  `buildExplicitPersonalEnqueue` (provenance sessionId from the session
  manager, "pending" fallback) → enqueue via the live runtime's outbox
  store, or (runtime not yet active) a durable open-enqueue-close at the
  same state path; opId persisted before any side effect either way. No
  model call, no network attempt on the command path; sanitized
  metadata-only audit event (opId only, never the statement) when the
  production audit sink exists.
- `test/q05p2-personal-command.test.ts` — 9 synthetic local tests through
  the ACTUAL registered command: headless refusal without `--yes`, durable
  enqueue with `--yes` (scope/kind/trigger/session-only provenance), TUI
  confirm gating (decline/accept), redaction before durable bytes,
  `--entry` provenance, private-mode refusal, allowPersonalGlobal refusal,
  fence-marker refusal, and no tool surface for the personal write.
- Docs: `docs/operations.md` command entry, `docs/memory-lifecycle.md`
  "Explicit personal memory" section, README command list.
- `test/extension.test.ts` — registration list updated.
- Remote GC remains the NEXT workflow; nothing on this path deletes or
  rewrites remote board history.

## 0. Verified facts (evidence, not policy)

Each fact below was checked against the tree at 0b5e5db (suite 542/542).

1. **Retrieval scopes include `personal`.** `src/index.ts:642–649`: the
   authorized retrieval scope set = resolved project scope +
   `personal` (only when `config.scopes.allowPersonalGlobal`,
   `src/config/schema.ts:50–51,117`) + opted-in `cross/*` (invalid opt-in
   entries authorize nothing). Matches decisions.md #12/#5.
2. **No code path writes any record under `personal`.**
   `resolveRecordScope` (`src/index.ts:309–341`) resolves exactly one owner
   scope: `project/{id}` from override or git remote, fail-closed otherwise.
   `src/observation/sender.ts:271–277` holds ALL record delivery when the
   scope is unresolved; `sender.ts:294` additionally holds backup delivery
   unless scope starts with `project/`. Observations, reflections, proposals
   and backups are project-scope only. Recall tools are read-only
   (`src/inject/tools.ts:13`).
   - Consequence A: the _write_ half of decisions.md #12 "personal-global
     memory" is unimplemented. This is an implementation gap, not a doc
     mismatch.
   - Consequence B: today nothing can automatically promote project-scoped
     content to `personal` (there is no personal write path at all). The
     coordinator constraint "personal write policy must avoid automatically
     promoting project-specific content globally" is currently satisfied
     vacuously — and must stay satisfied if any personal write surface is
     ever added.
3. **Manual board GC is local-only in code.** `/kiwifs-board-gc`
   (`src/index.ts:1788–1834`) prunes acked/skipped entries >14 d from the
   durable delivery state file only; "no backend call exists on this path"
   (`src/board/delivery.ts:202`). `kiwi_delete` exists in the adapter
   (`src/backend/adapter.ts:283`) but has NO production feature caller
   (live-runner cleanup only). Preview + explicit confirmation already gate
   the local prune.
   - Discrepancy: `docs/architecture.md` §8 (F8) and §13 row 13 **[P]**
     define a manual _remote_ GC (`kiwi_delete` of own + expired + locally
     acked + >30 d messages, explicit confirmation); PRD T17 AC pins "no
     automatic remote deletion exists (manual GC command only)" and T16/T18
     assign the GC command; `docs/operations.md` and
     `docs/memory-lifecycle.md` present the local-only prune as the GC and
     even say server-side expiry is outside this extension. The narrower
     shipped behavior is the safer direction but was never recorded as a
     decision — the docs disagree silently.
   - `docs/memory-lifecycle.md` also states "No remote-delete capability
     exists anywhere in the codebase" — factually inaccurate (the adapter
     method exists; no feature path uses it). Wording fix only.
   - Coordinator addition for any future remote GC: **visible partial
     failures** are NOT stated in §8 and must be added to the §8 contract
     text when (and only when) remote GC is implemented.
4. **Q04 audit identifier follow-up — verified NOT a real defect.**
   Proposal change events use `auditTargetForProposalPath`
   (`src/observation/proposals.ts:57–66`): basename only, `.`/`..`/empty →
   `"proposal"`, wired at `proposals.ts:295`, pinned by
   `test/q04c-domain-audit.test.ts:501–507`. No directory/home/username
   components persist. All other `targetId` emitters are content-free
   (`deriveRecordId` scheduler.ts:704; 16-char set-hash prefixes
   reflection.ts:1092,1240; opIds manual-ops.ts:265–411); outbox/board/
   retrieval events carry no targetId. Charset sanitize
   (`src/privacy/audit.ts:78–87`) and secret post-check apply. **No raw-path
   or privacy leakage found.**
   - One doc defect found (only): `docs/privacy.md` line ~94 still says a
     proposal change carries "the proposal **path** as target id",
     contradicting the basename reduction documented ~30 lines earlier in
     the same file. Fix in Q10's doc pass (or here, see S4).
5. **No fabricated approval found in Q04 defaults.** The
   `privacy.audit.file` config surface is explicitly labeled a documented,
   UNAPPROVED proposal, not wired (docs/privacy.md Q04a section; commit
   0b5e5db message; no `src/config/schema.ts` entry). Defaults live in code
   (`src/privacy/audit-store.ts:75`), not presented as approved.
   - Minor wording issues only: `docs/operations.md` states 14 d retention /
     60 s polling / 500 backlog / local-only GC as flat facts, dropping the
     §13 "user may override [P]" qualification. Wording fix only.
6. **Q04→Q06 dependency ordering (code-quality-plan).** The plan says Q04
   "Depends on Q06" (audit sink injected uniformly). In reality Q04 landed
   a working `FileAuditSink` seam through the existing typed `AuditSinkLike`
   wiring in `buildSessionRuntime`; Q06's uniform-injection refactor remains
   unchecked and still depends on Q01 (tests) + Q04 (audit sink). Q05 must
   NOT mark Q06 done and must not reorder Q06's acceptance away. Q05 has no
   code dependency on Q06 (policy/doc reconciliation only) and must not
   pre-empt Q06's refactor.

## 1. Decisions requiring the user (approval gates — nothing below G1/G2

proceeds without an answer; S1–S4 are approval-independent)

- **G1 — personal-scope writes in v1. ANSWERED (Q05P1): option (b) —
  explicit user action only. Recorded as decisions.md #13; S1 revised to
  IMPLEMENT (see §2a), not defer. Original question: do `personal`-scope
  writes exist in
  v1 at all, and if so what is the write-eligibility policy? Options:
  (a) v1 keeps `personal` read-only (reads already include it); the write
  half of decisions.md #12 is recorded as deferred — requires recording a
  scope reduction of the confirmed requirement, i.e. explicit user approval.
  (b) personal writes exist via an explicit user-initiated surface only,
  with a hard rule that nothing writes `personal` automatically and that
  project-scoped observations are never auto-promoted globally. (c) richer
  policy (out of Q05's narrow scope).
  _Worker recommendation:_ (b) — satisfies decisions.md #12 fully, keeps the
  no-auto-promotion constraint structural, minimal new surface. But this is
  product policy; not the worker's to choose.
- **G2 — board GC end state. ANSWERED (Q05P1): local-only GC stays; the
  user performs manual board cleanup; remote GC is deferred to a separate
  later task and requires its own explicit approval (with §8 amended to
  state visible partial failures at that time). Original question: implement architecture §8's manual remote GC
  (own-sender + client-TTL-expired + locally-acked + >30 d, preview list,
  explicit confirmation, visible partial failures, no assumption that other
  consumers acked), or record local-only GC as the final state for v1?
  _Worker recommendation:_ record local-only as the v1 decision (least
  privilege, consistent with "no automatic GC / history rewrite"); keep §8
  remote GC as a future explicit-approval feature. Requires user approval
  either way because it reconciles an approved [P] contract with shipped
  behavior.

## 2. Subtask breakdown (very small; each independently executable and

reviewable; no subdelegation)

### S1 — Record the personal-scope write decision (G1 ANSWERED — REVISED TO

IMPLEMENT in Q05P1, see §2a)
Owner: doc pass (Q05) after user answers G1.

- If (a): add one paragraph to `docs/decisions.md` recording "personal
  writes deferred in v1; reads only" as an explicit user-approved scope
  reduction, and a one-line note in `docs/architecture.md` §2. Do not touch
  code.
- If (b): write the policy text only (personal writes via explicit
  user-initiated surface; never automatic; never derived from project-scope
  observations; never promoted from project content) into
  `docs/decisions.md` as a new numbered decision + §13 row; implementation
  of the surface is a separate later task, NOT Q05.
- Acceptance: exactly the chosen policy documented; no other doc behavior
  changes; grep proves no doc claims a personal write path exists before
  implementation; suite untouched (docs-only diff).
- Gate: **G1 answered.** Without an answer, S1 does not run and Q05 ships
  only S3–S5 + the G1 question.

### S2 — Record the board-GC end-state decision (G2 ANSWERED — local-only

final state; remote GC deferred to the NEXT workflow per §2a)
Owner: doc pass (Q05) after user answers G2.

- If local-only final (recommended): add to `docs/decisions.md` a decision
  recording local-only `/kiwifs-board-gc` as the v1 end state with §8's
  remote-GC paragraph marked "not implemented, deferred — future feature
  requires explicit approval". Align `docs/operations.md`
  ("Board operations", "Forgetting, retention, purge") and
  `docs/memory-lifecycle.md` to cite the decision instead of silently
  contradicting §8; also correct the "No remote-delete capability exists
  anywhere in the codebase" sentence to "no feature path invokes
  `kiwi_delete` (adapter method exists for live-runner cleanup only)".
  Also drop the unapproved "confirmed" word from the `/kiwifs-board-gc`
  command description string (`src/index.ts:1795–1798`) — description-only
  string change, no behavior change, one test-name/text update if any
  asserts the string.
- If remote GC approved: do NOT implement in Q05. Write the §8 amendment
  adding "visible partial failures; deletion never assumes other consumers
  acked" to the contract, record the approval in `docs/decisions.md`, and
  hand the implementation to a new planned task (owner listed in
  code-quality-plan as a Q05 follow-up, sequencing decided by main).
- Acceptance: docs no longer contradict §8; every GC claim traces to
  either the recorded decision or the deferred note; `npm run check` green.
- Gate: **G2 answered.**

### S3 — Fix `docs/operations.md` [P]-marker omissions (approval-free)

- Add the "Default [P], user may override" qualification back to the
  14-day acked-retention, 60 s polling, 500-backlog and local-GC statements,
  citing architecture §13 rows 8, 12, 13. No behavior claims added or
  removed.
- Acceptance: every operational default in operations.md either cites its
  §13 row or is labeled implemented-confirmed; diff touches operations.md
  (+ memory-lifecycle.md wording only where it repeats the same facts);
  suite green.

### S4 — Fix `docs/privacy.md` targetId contradiction (approval-free; may

run in Q05 or be handed to Q10)

- Resolve the internal contradiction at line ~94: state that proposal
  change `targetId` is the **basename** (with `.`/`..`/empty →
  `"proposal"`), per `src/observation/proposals.ts:57–66` and
  `test/q04c-domain-audit.test.ts:501–507`. No new audit claims; do not
  mark the unapproved `privacy.audit.file` proposal as approved anywhere.
- Acceptance: privacy.md contains no "path as target id" claim for proposal
  change events; the Q04a "UNAPPROVED proposal" labeling preserved verbatim;
  docs-only diff.
- Decision point for coordinator: run in Q05 (small, same doc family as S3)
  or defer wholesale to Q10. Default: run in Q05.

### S5 — Q04 audit identifier follow-up closure (evidence-only)

- The coordinator's requested follow-up is CLOSED as verified-clean (see
  §0 fact 4): record in `tasks/evidence/` a short q05 note citing
  `auditTargetForProposalPath`, the pinned test, and the content-free
  targetId inventory. No code change. This satisfies "include Q04 audit
  identifier follow-up only if evidence confirms real issue" — evidence
  confirms the issue was already fixed in Q04's review round; nothing new
  to fix.

### Explicitly out of Q05 scope

- Implementing personal-write surfaces or remote GC (pending G1/G2; new
  tasks after decisions).
- Q06 composition refactor (still open, still depends on Q01+Q04; not
  marked done by Q05 in any doc).
- Any product-doc scope reduction beyond the two recorded decisions above.
- Any change to the `privacy.audit.file` proposal status.

## 3. Dependency / ordering summary

- S3, S4, S5: no gates; can run immediately, in any order, docs/evidence
  only. Recommended order S5 → S3 → S4 (evidence first).
- S1 gated on G1; S2 gated on G2. Both are user product-policy decisions;
  Q05 must return `needs_decision` if unanswered rather than inventing
  approval.
- Q06 remains unchecked after Q05 regardless of S1–S5; only its dependency
  text (Q04 audit sink now exists) may be factually updated by the commit
  worker, never its status.

## 2c. Q05R3 — explicit remote cleanup command implemented

Same no-commit discipline. On top of Q05R1 (preview planner), Q05R2 (guarded
executor) and the user-approved manual-cleanup decision (#14):

- `src/commands/board-cleanup.ts` — pure helpers + `BoardCleanupOpLog`
  (durable opId ledger: append + fsync + 0o600 at
  `<state>/board-cleanup-oplog.jsonl`, corrupt-log fails closed). The delete
  opIds are INTERACTIVE (not outbox job ids), so the outbox ledger cannot
  hold them; the dedicated log mirrors ManualOpLog/ProposalOpLog and
  persists BEFORE each side effect.
- `src/index.ts` — `kiwifs-board-cleanup <from> [--confirm bc-<token>]`.
  DISTINCT from `/kiwifs-board-gc` (local prune untouched, its `--yes` kept);
  `--yes` here is REFUSED so an old local flag never deletes remotely.
  Sender identity required (validateId grammar; ownership never guessed).
  TUI: preview + ui.confirm on the exact preview object. Headless: two-step
  — preview-only run prints a deterministic candidate-set token (SHA-256
  over sorted `msgId|path|created`); `--confirm <token>` re-plans and
  executes only if the token still binds (changed board → refuse, zero
  deletes). Gates: configGate, features.board, private mode (upfront AND
  live per-delete via executor), credential resolution, ack evidence only
  from this consumer's durable delivery state (inactive → TTL basis only,
  conservative). Every result carries the fixed no-CAS/no-purge/no-secure-
  erasure/no-all-consumer-ack disclosure. Metadata-only audit events.
- `src/commands/manual-ops.ts` — erasure-report wording corrected: memory
  records have no remote-delete path; the only remote delete is the
  user-confirmed board cleanup command (MCP-level, no purge claims). Docs
  (`operations.md`, `memory-lifecycle.md`) amended to state the actual
  capability and its limits; the previously inaccurate "no remote-delete
  capability exists anywhere" wording is fixed.
- Q04 follow-up (S4-adjacent, small + promised coverage): the
  `/kiwifs-personal-note` durable open-enqueue-close fallback previously
  DROPPED its sanitized audit event (rt?.audit undefined outside the
  runtime). It now records through the same durable sink path (bounded
  in-memory degradation when the lock is held; never throws).
- `test/q05r3-cleanup-command.test.ts` — 12 synthetic tests through the
  ACTUAL registered command (fake MCP server behind a stubbed global fetch;
  no live service, no real model): preview-only headless run (zero writes +
  token), exact-token confirm deleting exactly the own candidate while the
  other consumer's message stays, wrong-token refusal, changed-set refusal,
  `--yes` refusal, TUI accept/decline with disclosure assertions, private
  mode (zero backend calls), grammar refusal, credential fail-closed,
  disabled extension/board gates, and `/kiwifs-board-gc` unchanged
  (local-only, never calls the backend).
- Gates: full suite 598/598; `npm run pack:check` + `devenv test` re-run by
  the final worker; nothing committed.

## 2d. Q05R1 — preview planner + eligibility rules (on top of §2c refs)

- `src/board/cleanup-rules.ts` — pure eligibility: own-sender AND
  (client-TTL-expired OR locally-acked) AND strict `>` 30 d grace
  (GC_GRACE_MS per approved decision #14); fail-closed `malformed` on
  unparseable `created`/bad `ttl`; ack and TTL grace both evaluated, later
  settled instant governs. Recipients are routing labels, not
  confidentiality.
- `src/board/cleanup.ts` — bounded planner: maxCandidates=200 /
  maxReads=500; `listingTruncated`/`readTruncated` surfaced; skip reasons
  visible. Preview items carry channel/from/created/ack basis only — no
  bodies, no raw paths itemized beyond what the confirm token needs.
- `test/q05r1-cleanup-preview.test.ts` — 10 synthetic tests (grace edges,
  ack vs TTL basis, malformed fail-closed, bounds/truncation).

## 2e. Q05R2 — guarded delete executor

- `src/board/cleanup-execute.ts` — per-delete fresh recheck (fresh read
  with includeExpired, byte-exact msgId+created+from binding against the
  preview, fresh ack, current now, path-stem integrity), persist opId
  BEFORE adapter.del, classified skips (`changed`, `delete-failed`,
  `missing`, `bound-exceeded`), maxDeletes default 100, AbortSignal per
  candidate, private-mode transition → refusal with partial deletes
  disclosed, local ack state never mutated, NO_CAS_DISCLOSURE on every
  ok:true result.
- Cancellation AFTER ledger persist (CancelledError from adapter.del) is
  disclosed as UNKNOWN outcome: the opId appears in
  `unknownDeleteOpIds` (opIds only, never paths/bodies); re-plan replay
  re-checks idempotently. Final-worker addition, test-pinned.
- `test/q05r2-cleanup-execute.test.ts` — 18 synthetic tests.

## 2g. Q05 closure — conjunctive eligibility, headless token durability,

content-identity recheck (fixes from the Q05 closure review)

No-commit discipline kept. Three verified gaps fixed, nothing else widened:

1. **Eligibility narrowed to the approved §8 conjunction.** The "expired OR
   locally-acked" OR basis in §2d/decision #14 was a transcription drift
   from the approved §8 F8 / §13 row-13 contract (both conjunctive) — no
   user approval of the OR basis exists on record, so per the no-widening
   rule `evaluateCleanupCandidate` now REQUIRES BOTH client-TTL-expiry and
   a local ack; expired-only/acked-only records are held (tests pin both
   holds). Grace counts from the LATER of expiry and ack (unchanged
   semantics, now only reachable with both bases). Docs amended to match.
2. **Headless delivery/eligibility closure.** The preview + token are
   additionally persisted durably at `<state>/board-cleanup-preview.json`
   (0600, content-free) on every headless preview run, and the notice names
   the file — so the two-step flow works in JSON output mode too (where
   `ui.notify` delivery is not guaranteed; notify is verified/documented
   for print and RPC modes). The receipt's claim that the token is
   "inaccessible when hasUI=false" was verified FALSE for print mode and
   is now moot for JSON mode as well. Local ack evidence is read FRESH from
   this consumer's durable board delivery state file
   (`<state>/board/delivery-<consumerId>.json`), read-only and fail-closed
   (absent/corrupt → no ack evidence → nothing eligible, disclosed).
3. **Fresh content identity where backend metadata allows.** When the
   backend supplies `kiwi.etag` on reads, the preview records it (bound
   into the confirmation token too) and the executor re-verifies it on the
   fresh recheck read; a drifted etag under a stable id/created/from is a
   visible `changed` skip. No CAS is invented when the backend supplies no
   etag (binding stays on the exact tuple).

Also test-pinned: the executor proceeds when ONLY the recipient label
(`to`) changed — routing labels are not confidentiality (decisions.md #4),
eligibility never reads `to`, and the residual read-delete race is already
disclosed by NO_CAS_DISCLOSURE. Channel drift remains bound via the path
encoded in the token.

- Tests: `test/q05r1-cleanup-preview.test.ts` (11),
  `test/q05r2-cleanup-execute.test.ts` (22),
  `test/q05r3-cleanup-command.test.ts` (15) — incl. the durable preview
  record (notify token === record token, exact candidate set, no body
  content), confirmation bounded to the persisted eligible set, and the
  conservative-hold disclosures.

## 2f. Q05RF — final worker (acceptance, traceability closure)

- Fixed review findings: UNKNOWN-outcome disclosure (above), portable
  fsync fd (`r+`), erasure-report typo `purge;)` → `purge)`.
- Traceability: this file records R1/R2/RF; `tasks/evidence/q05-evidence.md`
  aggregates personal (Q05P1/P2) and remote-cleanup (R1–R3) subtask
  evidence; docs contradictions resolved in R3 (operations.md /
  memory-lifecycle.md now state the actual MCP-level capability and its
  limits; "no remote-delete capability anywhere" wording corrected).
- Gates re-run after last edits: `npm run check` (599/599 expected),
  `npm run pack:check`, `devenv test`; explicit stage + secret scan;
  commit only if acceptance complete. `t19-budget-report.json` jitter
  stays uncommitted.
