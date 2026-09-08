# Memory lifecycle: reflections, conflict flags, merge proposals (T11)

Status: implements PRD T11 on the architecture (§2/§3.3) and decisions.md #11
("automatic observation writes with inspection/undo. Detect duplicates, propose
merges and flag conflicts rather than silently replacing disputed source
facts"). Engineering choices below are proposals ([P]) consistent with the
architecture's decision/default table; user-visible confirmation surfaces
(`/kiwifs-*` commands) are the T18 obligation.

## Components

- `src/observation/reflection.ts` — the reflection engine: bounded summaries
  over durably accepted observation records, duplicate and contradiction
  detection via the configured model, merge-proposal and reflection record
  generation, plus the payload validation and deterministic senders.
- `src/observation/proposals.ts` — the proposal lifecycle (approve / reject /
  undo) with verified transitions and the durable local op log.
- `src/observation/scheduler.ts` — notifies the engine after a batch's
  observation job is DURABLY accepted into the outbox (never before).
- `src/observation/sender.ts` — dispatches outbox jobs by kind (observation /
  reflection / proposal) under the same scope/backend discipline.

## Record kinds and namespaces (architecture §2)

| Kind       | Namespace                                | Status at creation | Applied automatically?                            |
| ---------- | ---------------------------------------- | ------------------ | ------------------------------------------------- |
| reflection | `memory/reflections/{yyyy}/{mm}/{id}.md` | `active`           | Summary only — never modifies observations        |
| proposal   | `memory/merge-proposals/{id}.md`         | `pending-approval` | NO — approval is an explicit lifecycle transition |

Conflict flags are not records of their own: they live in the reflection
record's inert data block as `{recordIds, label}` pairs, always referencing
exactly the records supplied in that reflection run. Merge proposals carry
their target record ids + target paths in the inert data block.

## Duplicate suppression (PRD AC 1)

- Reflection identity: SHA-256 over the sorted record-id set (`setHash`). One
  logical summary per `(scope, setHash)` — deterministic record id and path.
- Proposal identity: SHA-256 over the sorted target-record-id set. The same
  duplicate pair detected in different reflection batches maps to the SAME
  `merge-proposals/` path; a re-delivery is a `writeImmutable` replay no-op.
- Engine registries (pending records, seen ids, processed set hashes) are
  durably persisted with FIFO caps. Bounded pruning behavior: proposals always
  replay as no-ops at the deterministic target-set path, and a fully
  re-notified set whose hash is still in the processed registry is dropped
  without re-summarizing; the narrow residual (a re-notified subset re-derived
  under a fresh startedAt) can duplicate a reflection summary record —
  bounded and additive only, never data loss.
- Replay determinism (T07/T10 pattern): the run's `startedAt` is persisted in
  the engine state BEFORE the model call and flows into the record
  `created`/path, so crash re-derivation reproduces byte-identical content.

## Proposal lifecycle (PRD AC 3/4)

- `approve`: proposal `pending-approval → active`, then each target
  observation `active → superseded` with provenance naming the proposal.
- `reject`: proposal `pending-approval → superseded` with a reason; targets
  are NOT touched (disputed facts stay visible).
- `undo` (of an approval): targets superseded by THIS proposal return to
  `active` (logical visibility restored); the proposal becomes `superseded`
  with an approval-undone provenance line. Nothing is ever deleted.
- Every transition appends a `kiwifs-provenance:` line (actor / UTC time /
  opId / reason) to the record body — history is never silently rewritten.
- Verified concurrency protection: every transition reads the proposal and
  each target FRESH, verifies the expected pre-state (status, and for targets
  that a prior supersession was made by THIS proposal), writes, then verifies
  the write by read-back. Divergence is surfaced as `StaleProposalError` —
  the concurrent actor's decision survives. **B2 conformance: this is
  verify-then-act with post-write detection. NO compare-and-swap or
  optimistic-concurrency behavior is claimed** (the MCP surface has no
  If-Match writes); local lifecycle operations are additionally serialized
  on an internal chain.
- Replay safety: a crash-interrupted approval re-run completes idempotently
  (targets already superseded by the same proposal are verified, not
  rewritten); duplicate reject/undo replays as a no-op.
- Durable opIds: the lifecycle records each op in an append-only, fsynced
  local log (`proposal-oplog.jsonl`) BEFORE any backend side effect; the log
  doubles as the T04 opId ledger for interactive writes and fails closed on
  corruption.

## Failure containment (PRD AC 5)

A reflection failure (model fault, invalid result, redaction hold, local
outbox fault) enqueues nothing and never touches the original observation
records. The set stays durably pending with backoff; per-set attempts are
capped, after which the set is parked VISIBLY (reason in `pendingStatus()`) —
never silently dropped. Oversized sets split in half and retry immediately
(progress guarantee; nothing dropped).

## [P] Defaults

- Reflection threshold: 12 durably accepted records pending summarization
  (manual `reflectNow` bypasses the threshold; T18 wires the command).
- Budgets: 6,000 input / 2,000 output tokens (char-based estimate for
  scheduling — the model-compatible tokenizer remains the T13 obligation).
- Backoff: 30 s base, 10 min cap, 8 attempts per set before visible parking.
- Automatic reflection rides the `features.observation` gate (decisions.md
  #11 allows automatic summaries); proposals/conflict flags are always
  approval-gated regardless of feature flags.

## Wiring

The engine is built at session runtime when the record scope is resolved and
observation is enabled. Accepted observation records flow in via the
scheduler's `onAcceptedObservations` hook (after durable outbox acceptance
only). The proposal lifecycle is available per-session with its own backend
instance and op log; command wiring (approve/reject/undo surfaces) lands in
T18.
