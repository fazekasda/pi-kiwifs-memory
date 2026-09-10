# Code Quality Plan Q01–Q10

Source: user-approved quality plan (Q01–Q10), implemented via small workers on
`openrouter/z-ai/glm-5.3-flash`. Main thread coordinates; workers do not
sub-delegate. Statuses are unchecked until the owning task's acceptance is
demonstrated by evidence. Audit findings are hypotheses to reproduce, not
proof — each defect claim is reproduced locally against production
composition before any fix lands.

Ground rules (all tasks):

- Never weaken the privacy promise, skip tests, or mark partial acceptance
  complete.
- Private mode prevents NEW domain/backend/model requests after transition and
  best-effort cancels in-flight requests; already-sent bytes cannot be
  recalled. Pending durable work is retained without duplicates or silent
  drops. Capture during private mode is classified separately from
  preexisting pending work; private-session content is never replayed on
  resume.
- No backend deployment changes; MCP-only requirement unchanged.
- Tests exercise the actual shipped extension runtime construction
  (`buildSessionRuntime`), not tests injecting safer gates.
- Synthetic local fixtures only; no real model calls, no private sessions, no
  secrets, no local config reads. Long commands run in background; race tests
  bounded.
- Before any final task commit: `npm run check`, `npm run pack:check`,
  `devenv test`. Explicit staging; secret diff inspected; separate task
  commits by the designated commit worker only.
- Reducing existing requirements needs explicit user approval. No automatic
  GC / history rewrite.

## Q01 — Reproduce audit defects with bounded local reproduction ✅

Status: COMPLETE. Both repro tests failed on HEAD 4e4b06e for the documented
reasons (evidence below); the gaps were then resolved through production
composition by Q02 chunks a–d (same green commit per coordinator approval).
Final state: `test/q01-private-mode-gaps.test.ts` — **2/2 pass** through the
shipped `buildSessionRuntime` (Gap 1: zero outbox requests during the
coordinator tick; Gap 2: zero model calls on `extractNow`).

- Verify current HEAD (4e4b06e) against the prior audit report (also at
  4e4b06e): OutboxWorker missing production PrivateModeGate/AuditSink;
  scheduler/model lacking private-mode gates.
- Reproduce through production composition (`buildSessionRuntime`), add
  failing regression tests, record exact failure evidence and the minimal
  interfaces needed. Do NOT fix production in Q01; failing repro tests stay
  uncommitted until fixed. No test skips, no inverted claims.

Findings (verified against HEAD 4e4b06e):

1. `src/index.ts` `buildSessionRuntime` constructs the observation outbox
   worker WITHOUT `gate` and WITHOUT `audit` (both optional in
   `OutboxWorkerOptions`). Consequence: the worker's private-mode hold
   (`tick` → `gate.isPrivate` → hold) never engages in production, and no
   outbox audit records are produced. The 30s coordinator tick therefore
   delivers pending jobs over the network while private mode is ON.
2. The observation scheduler/extractor path has no private-mode gate:
   `src/observation/scheduler.ts` (`extractNow`, `onAgentSettled`,
   `onBeforeCompact`) and `src/observation/model.ts` never re-read config or
   consult a gate, and nothing cancels in-flight extraction on transition.
   Retrieval (T18) and backup-verify hold correctly; observation extraction
   and outbox delivery do not.

Reproduction tests: `test/q01-private-mode-gaps.test.ts` (UNCOMMITTED,
expected failing):

- `private mode does not hold outbox delivery (worker lacks production gate)`
  — pending observation job in the runtime's own durable outbox; private mode
  ON via the shipped control surface; one coordinator tick (30s interval —
  bounded await, ~35s cap). EXPECTED (desired): zero backend requests, job
  held. ACTUAL: request hits the local synthetic listener → FAILS.
- `extraction runs the model while private mode is ON (scheduler unguarded)`
  — private mode ON, `observer.extractNow()` via the shipped scheduler
  instance; `globalThis.fetch` intercepted to a local recorder (no real model
  call). EXPECTED (desired): zero model calls. ACTUAL: openrouter chat
  completion attempted → FAILS.

Minimal interfaces needed for the later fix (for Q06 composition refactor):

- `buildSessionRuntime` must pass a production `PrivateModeGate` (config
  live-gate adapter, same fail-closed semantics as board delivery's
  `repoGate`) and an `AuditSink` into `OutboxWorker`.
- The observer scheduler/extract path needs a live private-mode check at
  batch creation AND at the model-call boundary (or a cancel hook wired to
  the private-mode transition) so new extraction is refused and in-flight
  extraction is best-effort aborted.

Acceptance: both tests fail on HEAD for the documented reason; evidence
recorded below; no production code changed in this task.

Failure evidence (recorded): see tasks/evidence/q01-repro.md.

## Q02 — Private-mode gate wiring (chunks a–d)

Status: chunks a–e complete (uncommitted; final commit by the designated
commit worker). a: production OutboxWorker gate/audit. b: model request
gate seam (extractor/reflector). c: shared gate transition notification +
command bridge. d: gate wired into production extraction/reflection
factories and scheduler boundaries (settled/idle/manual/precompact);
Q01 Gap 2 resolved through `buildSessionRuntime`. e: transition integration
edges across all domains through the shipped runtime + `changes()`
fails-closed fix; review blockers fixed (helper `exactOptionalPropertyTypes`
types; truthful evidence rewrite) — see
`tasks/evidence/q02{a,b,c,d,e}-evidence.md`.

Acceptance re-run by the commit worker after review fixes: full suite
500/500, typecheck clean, `npm run check` / `npm run pack:check` /
`devenv test` — see the commit receipt in `tasks/execution-log.md`.

## Q03 — Confirmation/reason/path

Private-mode (and other control) transitions must carry an explicit
confirmation, a sanitized reason, and the exact path edited; no silent
success. Blocked on Q01 evidence for the transition-path inventory.

Status: unchecked.

## Q04 — Bounded audit log

Introduce a bounded, metadata-only audit sink wired into production
composition (outbox worker per Q01; other domains as applicable). Cap, FIFO
eviction, no user content, inspectable via status. Depends on Q06.

Status: unchecked.

## Q05 — personal-write / remote-GC scope reconciliation

Reconcile personal-scope writes with remote garbage collection; define which
records are GC-eligible, keep no automatic GC / history rewrite without
explicit approval. Status: unchecked.

## Q06 — Composition refactor

Refactor `buildSessionRuntime` so live gates (private mode, config validity)
and audit are injected uniformly into worker/observer/reflection/delivery —
closing the Q01 gaps structurally instead of per-callsite patches. The Q01
failing tests become the acceptance regressions.

Status: unchecked. Depends on Q01 (tests), Q04 (audit sink).

## Q07 — Config lifecycle

Config re-read/invalidation lifecycle: single owner for live gates, defined
behavior on invalid config (fail closed), documented reload boundaries.
Status: unchecked.

## Q08 — Deterministic concurrency

Make cross-domain concurrency deterministic (tick/reflection/delivery
interleavings, lock semantics); bounded race tests only. Status: unchecked.

## Q09 — Evidence

Consolidated evidence per task: exact commands, failures, passes, budgets.
Status: unchecked. Depends on Q01–Q08.

## Q10 — Docs/review

Update docs/privacy.md, docs/architecture.md, docs/decisions.md to match the
implemented gates/audit; final review pass. No requirement reductions without
explicit approval. Status: unchecked. Depends on all.
