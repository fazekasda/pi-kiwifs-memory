# Q05 evidence — personal writes + manual remote board cleanup

## Personal subtask evidence (Q05P1 + Q05P2, user-approved decisions.md #13)

- Q05P1: `src/commands/personal-note.ts` `buildExplicitPersonalEnqueue`
  (explicit-only builder, deterministic scope-bound idempotency key, opId
  persisted before any side effect, no I/O, no model calls);
  `src/observation/sender.ts` personal routing for observations only,
  quarantine for project-only kinds. Evidence: `test/q05p1-personal-domain.test.ts`
  (builder validation/determinism, durable enqueue+reload, unresolved-scope
  delivery, retry replay no-op, personal-routing rejection, unchanged
  project routing).
- Q05P2: `/kiwifs-personal-note` through the ACTUAL registered command —
  headless `--yes` gating, TUI confirm, redaction BEFORE durable bytes,
  `--entry` provenance, private-mode + allowPersonalGlobal + fence refusals,
  no tool surface, sanitized opId-only audit events (including the durable
  open-enqueue-close fallback, fixed in Q05R3). Evidence:
  `test/q05p2-personal-command.test.ts` (9 tests).
- Nothing automatic anywhere: grep-visible — only the registered command
  calls `buildExplicitPersonalEnqueue`; capture/reflection/backup/board
  paths never reference it.

## Remote board cleanup evidence (Q05R1/R2/R3, user-approved decisions.md #14)

- Eligibility (cleanup-rules.ts) — CONJUNCTIVE per the approved §8 F8 /
  §13 row-13 contract (Q05 closure correction: the earlier "expired OR
  acked" wording in decision #14 was a transcription drift, narrowed, never
  broadened): own-sender AND client-TTL-expired AND locally-acked AND >30 d
  grace from the LATER settled instant; fail-closed `malformed`;
  expired-only and acked-only records HELD (test-pinned); bounded
  listing/read (200/500) with truncation surfaced. Pinned by
  `test/q05r1-cleanup-preview.test.ts`.
- Executor (cleanup-execute.ts): exact-preview binding, fresh per-delete
  recheck (incl. backend-supplied `kiwi.etag` content identity when
  available; no CAS invented when absent), persist-opId-before-del,
  partial-failure classification, UNKNOWN-outcome disclosure for cancelled
  deletes, no-CAS/no-purge/no-secure-erasure/no-all-consumer-ack disclosure
  on every ok:true. Pinned by `test/q05r2-cleanup-execute.test.ts` (22
  tests, incl. `to`-drift proceeds and etag-drift skip).
- Command (index.ts `kiwifs-board-cleanup`): preview → exact-token confirm
  (SHA-256 over sorted msgId|path|created[|etag]; changed set refuses with
  zero deletes); headless preview ALSO persists a content-free durable
  record (`board-cleanup-preview.json`, 0600) so the token is recoverable
  in every output mode (JSON output mode included — notify is verified for
  print/RPC modes only); local ack evidence read fresh from this
  consumer's durable board delivery state file, fail-closed (no/corrupt
  state → nothing eligible, conservative hold disclosed); `--yes` refused;
  `/kiwifs-board-gc` untouched (local-only, zero backend calls,
  test-pinned). Pinned by `test/q05r3-cleanup-command.test.ts` (15 tests).
- No atomicity is claimed anywhere: MCP has no CAS, so a read-delete race is
  unavoidable and DISCLOSED; deletes are reversible only to the extent the
  backend supports; no secure-erasure or all-consumer-ack claim exists
  (grep-checked).

## Follow-ups closed

- Q05 closure review (headless delivery / eligibility / binding): the
  receipt's three claims were verified against actual behavior — (a) OR
  eligibility was real and BROADENED the approved §8 conjunction → narrowed
  (blocker fixed); (b) "token inaccessible when hasUI=false" was FALSE for
  print mode (notify reaches stdout) and is moot for JSON mode via the new
  durable preview record; (c) token binding DOES cover channel drift (path
  in the token); `to`-drift is ignored and verified harmless (routing
  label, not confidentiality; eligibility never reads `to`), pinned by test.

- Q04 audit identifier follow-up: verified clean (basename targetId via
  `auditTargetForProposalPath`, pinned test/q04c-domain-audit.test.ts);
  no new issue.
- Doc contradictions (architecture §8/§13 vs shipped behavior): resolved by
  decision #14 + operations.md/memory-lifecycle.md amendments (R3).
