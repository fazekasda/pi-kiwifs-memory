# Q04b evidence — durable audit sink wired into the shipped runtime

Scope: `src/index.ts` (production composition), `src/outbox/worker.ts`
(transition audit events), `src/privacy/audit.ts` (`AuditSinkLike` seam),
`docs/privacy.md`. Builds directly on the uncommitted Q04a changes; no commit
made by this task. No unrelated feature work.

## Implemented (all local, content-free, no network added)

- **Production instantiation:** `buildSessionRuntime` creates
  `FileAuditStore` at `<stateDir>/audit.log` (Q04a default limits:
  256 KiB × 3 files, staleLockMs 30 s, 0600/0700 permissions) and passes it
  to the shipped `OutboxWorker` as its audit sink. No config surface is
  parsed; the Q04a `privacy.audit.file` proposal remains a proposal.
- **Worker audit coverage** (metadata-only, allowlisted): `sent`,
  `retry <n>/<max> (<fingerprint>)`, `quarantined (<fingerprint>)`, and NEW
  private-transition events — `held (private mode)` on every
  hold (tick head, mid-send transition, PrivateModeActiveError) and
  `released (private mode)` on gate release notification.
- **Sanitized visible audit failure:** a new `lastAuditNote` status probe
  surfaces `audit: DEGRADED — buffered=<n> writeFailures=<n>
lastError=<errno class> [lock=unavailable]
[corruptSkippedBytes=<n>]` in `resolveStatusText` and degrades the overall
  state line. Content-free: counts + errno classes only; healthy sinks are
  silent. Audit logging stays best-effort: a failed record never
  authorizes a request, drops a pending job, or acknowledges delivery.
- **Lifecycle:** `session_shutdown` calls `audit.close()` (idempotent),
  releasing the single-owner lock so a next session's store is never a
  second writer against a stale live lock. No duplicate subscriptions: the
  store holds no gate subscriptions; the worker keeps exactly its
  construction-time gate listeners.
- **Seam:** `AuditSinkLike` (structural `record()` interface) lets the
  worker accept both the in-memory `AuditSink` and the durable
  `FileAuditStore`.

## Acceptance tests (real runtime wiring, not manual sink injection)

`test/q04b-runtime-audit.test.ts` (2/2, bounded local fixtures; synthetic
127.0.0.1 MCP listener with ok / HTTP 404 / JSON-RPC error modes; no real
model calls, no secrets):

1. `buildSessionRuntime` exposes `audit instanceof FileAuditStore`; a real
   delivery through the shipped worker persists a `sent` JSONL line; a
   JSON-RPC protocol error quarantines with a `quarantined (...)` line; an
   HTTP 404 yields a `retry ...` line (`degraded: true`); private mode
   produces a `held (private mode)` line while the job stays pending; after
   resume the scope drains with `sent` lines. Every line passes an
   allowlisted-key check; no URLs/paths in any line.
2. Through `registerSessionHandlers` + shipped session lifecycle: a real
   EACCES fault (read-only state dir) flags `record()` as `degraded`,
   `status().lastError === "EACCES"`; status JSON and visible status text
   contain no paths/payloads; `state: degraded` attributed; double
   `session_shutdown` is idempotent and releases the lock; a fresh runtime
   over the same state dir then owns the lock and records without
   degradation (no stale-lock second-writer).

## Checks

- `npm run typecheck` clean; `npx prettier --check src test` clean.
- Full suite `npm test`: **529/529 pass** (527 prior + 2 new Q04b tests).
- No network egress beyond the local synthetic 127.0.0.1 listener; no
  private config reads, secrets, or real model calls.

## Notes / boundaries

- The `onRelease` release-audit fires only for gates that push transitions;
  the shipped `LiveConfigPrivateModeGate` resolves release lazily via the
  next tick (which records the resulting `sent` events). Behavior preserved.
- `privacy.audit.file` config surface remains an explicit proposal
  (documented in docs/privacy.md), not fabricated as approved.
