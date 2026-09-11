# Q02a evidence — production outbox private gating (HEAD 4e4b06e + uncommitted fix)

Command: `npx tsx --test test/q02a-outbox-gate.test.ts` (4/4 pass, ~1.1s total)
Regression: `npx tsx --test test/q01-private-mode-gaps.test.ts` — Gap 1 (outbox)
now PASSES through the shipped 30s coordinator-timer path (zero requests during
the bounded 40s window); Gap 2 (scheduler/model) still fails — owned by Q06.

## Fix (shared production dependency, not test-only assembly)

- `src/privacy/live-gate.ts` (new): `LiveConfigPrivateModeGate` — fail-closed
  live-config gate adapter. Every check re-reads the persisted config
  (`loadConfig`); invalid config = private. Same semantics as the
  retrieval/backup/board live gates already in `src/index.ts`. Resume is
  detected lazily on the next gate read (the worker's own tick);
  `onRelease` is registration-only to avoid re-entrant double delivery.
- `src/privacy/private-mode.ts`: exported structural seam
  `PrivateModeGateAdapter` (the stateful `PrivateModeGate` satisfies it).
- `src/outbox/worker.ts`: option type widened to the seam — logic unchanged.
- `src/index.ts` `buildSessionRuntime`: passes `gate: new
LiveConfigPrivateModeGate()` and `audit: new AuditSink()` (metadata-only)
  into the production `OutboxWorker`; `SessionRuntime` now exposes `worker`
  (tests drive the shipped `worker.tick()` — the same callback the coordinator
  timer invokes — no injected gates, no 30s waits).

## Acceptance (all through production construction)

1. Private startup: zero outbound requests; job held, durable, not quarantined.
2. normal→private: attempt while normal (404 → availability retry), then a
   DUE retry tick held — no request during private, job retained.
3. private→normal: preexisting pending work resumes exactly once
   (no duplicate send, no drop — pending+quarantined accounting = 1).
4. Restart under private mode: fresh `buildSessionRuntime` over the same
   state dir; pending work survives and remains held, zero requests.

Privacy invariants: no drops, no duplicates, pending work retained; already
sent bytes unaffected (cannot be recalled). Capture-during-private
classification and scheduler/model gating remain Q06/Q07.
