# Q04c — domain audit event coverage (observation / reflection / backup / retrieval / board / change / commands)

Status: COMPLETE (uncommitted; final commit is the commit worker's job).

## Scope delivered

The promised capture / retrieval / change audit events are now emitted from
every domain through the EXISTING typed sink (`AuditSinkLike` → the
production `FileAuditStore` from Q04a/Q04b). No duplicate audit
implementations; every domain takes an optional `audit?: AuditSinkLike`
(undefined = fully disabled: no events, no files, no errors).

Event kinds recorded (all metadata-only; allowlisted schema, secret-free
post-check, 2048-byte line bound):

| Domain (source)                                        | Kind          | Decisions                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/observation/scheduler.ts`                         | `observation` | `captured` (16-hex record id + entry count), `held (private mode)` (private-session classification; manual hold), `failed (<error name>)` (extraction / acceptance)                                                         |
| `src/observation/reflection.ts`                        | `reflection`  | `ran` (16-char set-hash prefix), `skipped (<reason>)`, `held (redaction)`, `failed (<name>)`                                                                                                                                |
| `src/backup/capture.ts`                                | `backup`      | `captured` / `captured (with held entries)` (chunks/held/omissions), `held (private mode)`, `held (invalid exclusions)`, `skipped (no candidates)`                                                                          |
| `src/retrieval/coordinator.ts`                         | `retrieval`   | `completed` / `completed (degraded)` (items/tokens), `held (private mode)`, `held (no authorized scopes)`, `skipped (ineligible: …)`, `skipped (privacy classification)`, `degraded (deadline exceeded)`, `failed (<name>)` |
| `src/board/delivery.ts` (+`runtime.ts`)                | `board`       | per-cycle `completed` (delivered/skipped/changes/pages) / `held (private                                                                                                                                                    | backlog | unavailable | stopped | consumer lock)`/`completed (listing fallback | truncated)` |
| `src/observation/proposals.ts`                         | `change`      | `approved` / `rejected` / `undone` / `failed (<name>)` (proposal path as target id)                                                                                                                                         |
| `src/commands/manual-ops.ts` (wired in `src/index.ts`) | `command`     | forget / forget-undo `ok (…)` / `failed (…)` — op id only, never the record path or forget reason                                                                                                                           |

Production composition (`buildSessionRuntime`) passes the same
`FileAuditStore` instance to observer, reflection, proposal lifecycle,
retrieval, backup capture and board delivery; the `/kiwifs-forget(-undo)`
command handlers pass `rt.audit`.

## Design notes

- **Sink fail-closed interaction:** a full 64-hex set hash or a full record
  PATH trips the sink's opaque-run entropy post-check and would be downgraded
  to `audit-suppressed`. Domains therefore emit short, content-free ids
  (16-hex record id / set-hash prefix / op id). The full paths remain
  derivable from durable state; the audit log stays strictly content-free.
- **manual-ops hardening:** a throwing `openStore` in
  `forgetMemoryPath` / `unforgetMemoryPath` previously propagated
  uncaught; it now returns the same sanitized retryable failure shape and
  records a `failed (…)` audit event (openStore faults are audited, never
  silent).
- **Ordering guarantee:** observation `captured` is recorded only AFTER
  durable outbox acceptance, so a `captured` line is never a false
  acknowledgement. Audit failure never authorizes, drops, or acknowledges
  work (proven by the injected-ENOSPC test: capture proceeds, event
  buffered, `status().lastError === "ENOSPC"`, `persisted: 0`).

## Tests

`test/q04c-domain-audit.test.ts` — 11/11 through the REAL `FileAuditStore`
(temp state dir, real JSONL on disk), synthetic fixtures only:

1. Observation: `captured` + private-mode `held (private mode): entries
classified private-session`; canary-bearing entry/statement text never
   reaches any line.
2. Observation: extraction failure records `failed (<name>)`.
3. Reflection: `ran` (content-free set-hash prefix) + `skipped
(below-threshold)`.
4. Backup: `captured` + `held (private mode)`.
5. Retrieval: `held (private mode)` + `completed`; sink absent → no events.
6. Change: proposal stale refusal audited (`failed (…)`), visible
   `StaleProposalError` unchanged.
7. Commands: forget ok/failed with op-id-only target ids.
8. Board: `completed` (delivered counter) + `held (private)`.
9. Disabled sink: no audit file created, capture unaffected.
10. Degraded sink (injected ENOSPC): domains proceed, events buffered
    (`buffered > 0`, `persisted = 0`, `lastError: "ENOSPC"`, `degraded`).
11. Disk bound: every emitted line ≤ 2048 bytes; healthy status
    (`degraded: false`, `buffered: 0`).

Shared assertion over EVERY emitted JSONL line: parses as one JSON object,
keys ⊆ schema allowlist, no embedded newline, and none of four synthetic
canaries (API-key, GitHub-token, query-text, board-body shapes) appears in
raw form. Rotation/locking/permission bounds are unchanged from Q04a and
covered there over the same store.

## Checks

- `npx tsc --noEmit` clean; `prettier --check src test docs` clean.
- Full suite: **540/540** (529 prior + 11 new Q04c).
- No network beyond localhost synthetic fixtures; no real model calls; no
  private config reads; no secrets.

## Docs

`docs/privacy.md` Q04 section: exact log location (`<stateDir>/audit.log`),
schema allowlist, per-kind decision codes, retention (256 KiB × 3 files,
0600/0700), and explicit "no visibility claims" framing. The
`privacy.audit.file` config surface remains an unapproved proposal — no new
config surface was fabricated and none was wired.

## Boundaries respected

- No commit made. Working tree contains Q04a + Q04b + Q04c changes only.
- No requirement changes; Q04 plan item ("cap, FIFO eviction, no user
  content, inspectable via status") fully demonstrated across domains.

## Q04 review fixes (final worker round, uncommitted)

Review finding: `ProposalLifecycle.auditChange` passed the user-typed
`proposalPath` into `targetId`; the sanitizer's charset allows `/` and `.`,
so an absolute path (potentially containing a home directory / username)
was persisted verbatim. Fixed (`src/observation/proposals.ts`): change
events now persist only the proposal FILENAME (basename) via
`auditTargetForProposalPath` — no directory components; empty /
traversal-only basenames fall back to the fixed content-free marker
`proposal`. Regression assertion added to the stale-refusal change test:
every `change` event `targetId` contains no `/` or `\`.
