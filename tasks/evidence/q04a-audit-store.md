# Q04a evidence — AuditSink storage/schema/retention hardening

Scope: `src/privacy/audit.ts` (extracted `buildAuditLine` + `AUDIT_LIMITS`),
new `src/privacy/audit-store.ts` (`FileAuditStore`), tests
`test/q04a-audit-store.test.ts`, one updated privacy test (unsafe-identifier
behavior, intent preserved). No runtime wiring (Q04 production wiring stays
with Q06). No commit made by this task.

## Inspection result (HEAD ea24277)

- `AuditSink` was memory-only: no persistence, no size cap, no rotation, no
  file permissions, no single-owner enforcement, no corruption handling.
- Schema allowlist existed (keys stripped) but identifier/decision values
  were unbounded strings; an attacker-shaped `targetId` could only be
  handled by whole-line suppression.

## Implemented (all content-free, local-only)

- `buildAuditLine`: pure sanitizer — allowlisted keys only, safe-charset
  identifiers (`[A-Za-z0-9._/:@ -]`), decision charset including
  fingerprints (`Error:ECONNREFUSED`), hard caps: kind 64, feature/scope
  128, targetId 256, decision 256, snippet 256 (pre-redaction), line ≤ 2048
  bytes. Unsafe identifier → replaced with fixed marker `(redacted-unsafe)`
  plus content-free reason `unsafe:<key>`; raw value never persisted.
  Oversized-but-clean identifier → truncated to cap.
- `FileAuditStore`: JSONL append to `audit.log`; rotation at
  `maxRotateBytes` (default 256 KiB) keeping `maxRotatedFiles` (default 2)
  rotated segments; stale `*.tmp` cleaned at init; repairs write through
  `.<pid>.tmp` + rename. Total on-disk budget:
  `FileAuditStore.diskBudgetBytes()` = 3 × 256 KiB (768 KiB).
- Permissions: dir 0700, log/lock/temp 0600; existing loosened file mode
  tightened at init (POSIX).
- Single owner: `O_EXCL` lock file with `{pid}`; dead-pid or age-older-than
  `staleLockMs` (default 30 s) takeover; live foreign lock never stolen —
  second writer degrades to a bounded 64-line in-memory buffer, surfaced as
  `status().lock: "unavailable"`; records flagged `degraded: true` (never a
  false success).
- Corruption: trailing partial line truncated to last complete newline via
  tmp+rename; skipped byte count in `status().corruptSkippedBytes`.
- Disk-full / fs faults: `record()` never throws; event goes to bounded
  fallback buffer; `status()` reports sanitized errno class only
  (`ENOSPC`/`EACCES`/`ENOENT`/`EIO`/`io-error`/`lock-unavailable`) — never
  messages, paths, or identifiers. `status()` JSON verified content-free.
- No network I/O anywhere in the path; safe during private mode.

## NEW operational proposal (needs user approval — not fabricated as approved)

`privacy.audit.file` config surface with explicit defaults:
`maxRotateBytes = 262144`, `maxRotatedFiles = 2`, `staleLockMs = 30000`,
log path under the extension state dir, permissions 0600/0700. Q04 status
surface would expose the content-free `FileAuditStoreStatus`.

## Checks

- `node --test test/q04a-audit-store.test.ts`: 17/17 pass
  (allowlist bounds, oversized id, injection, rotation/disk budget, temp
  cleanup, permissions, concurrent-writer degradation, dead/stale/live lock,
  trailing corruption repair, whole-file reset, ENOSPC, arbitrary fs faults,
  content-free status, post-close).
- `node --test test/privacy.test.ts`: 23/23 (one test updated:
  attacker-crafted `targetId` now fails closed per field instead of whole
  line; raw value still never persisted and line still secret-free-checked).
- `npm run typecheck` clean; prettier clean; full `npm test`: 527/527 pass
  (509 prior + 18 new/updated).

## Blockers

None. Real ENOSPC is exercised via synthetic fs injection (real disk-full
injection is not reliably reproducible in CI); real concurrency is enforced
by exclusion (single owner) rather than shared-writer support, per task
instructions.

## Q04 review fixes (final worker round, uncommitted)

Independent review found two Q04-scoped gaps; both fixed with regression
tests:

1. Lock takeover precedence: previously lock AGE took precedence over pid
   liveness, so a live session running longer than `staleLockMs` could have
   its lock stolen by a concurrently started session over the same state
   dir (two writers; rotation could clobber). Fixed in `acquireLock`: pid
   liveness is checked FIRST — a live owner is never stolen regardless of
   age; only a dead owner's lock, or an unreadable/malformed lock older
   than `staleLockMs`, is taken over once. Test: "a LIVE owner's lock is
   never stolen even when older than staleLockMs" (backdated live lock →
   intruder degrades, owner stays owned). Docs updated (audit-store header,
   docs/privacy.md) so the guarantee wording matches the actual semantics.
2. Legacy rotated segments: rotated files numbered beyond
   `maxRotatedFiles` from a prior larger configuration were never cleaned
   at init, so the on-disk budget could exceed the documented 3 × 256 KiB
   after a reconfiguration downward. Fixed: `removeLegacyRotatedSegments()`
   removes `audit.log.N` with N > maxRotatedFiles at init (owner only).
   Test: "legacy rotated segments beyond maxRotatedFiles are removed at
   init".

Also resolved the review's finding 4 by reverting the regenerated
`tasks/evidence/t19-budget-report.json` (test-run timing artifact; not part
of Q04).
