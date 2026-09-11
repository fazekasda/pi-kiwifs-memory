# Q01 reproduction evidence — HEAD 4e4b06e

Command: `npx tsx --test test/q01-private-mode-gaps.test.ts`
Fixture: synthetic 127.0.0.1 listener (records requests, 404), temp config
file + state dir via `KIWIFS_MEMORY_CONFIG`/`KIWIFS_MEMORY_STATE_DIR`,
`projectIdentity: "example.local/synthetic"`, model route
`openrouter/z-ai/glm-5.3-flash` (fetch intercepted — no real model call).
Production composition: `src/index.ts buildSessionRuntime()`.

## Gap 1 — outbox delivery not held in private mode (worker lacks gate/audit)

- Production construction (src/index.ts ~line 418): `new OutboxWorker({store,
send: createObservationSender(...), maxAttempts: MAX_SAFE_INTEGER})` — no
  `gate`, no `audit`.
- Repro: pending observation job enqueued in the runtime's own durable
  outbox; session started through the shipped `coordinator.onSessionStart`
  (arms the 30s tick timer); private mode ON via shipped
  `setPrivateModeInFile`. One coordinator tick later:
- Result (expected-failing assertion):
  `PRIVACY GAP: outbox worker delivered 1 request(s) while private mode was
ON (production worker has no gate): [{"url":"/mcp","method":"POST"}]`
  — a `POST /mcp` backend write was attempted ~30s into private mode.
- Desired behavior: zero requests; job held (durable, replayed on resume).
- Minimal interfaces for the fix: `OutboxWorkerOptions.gate` (a production
  `PrivateModeGate` adapter over the fail-closed live config gate, same
  semantics as board delivery's `repoGate`) and `OutboxWorkerOptions.audit`
  (bounded metadata-only AuditSink, Q04), passed from `buildSessionRuntime`.
  Release listener registration at construction must keep the existing
  hard requirement (registered before the gate can be enabled).

## Gap 2 — scheduler/model extraction unguarded in private mode

- `src/observation/scheduler.ts` (`extractNow`, `onAgentSettled`,
  `onBeforeCompact`) and `src/observation/model.ts` contain no private-mode
  check; nothing cancels in-flight extraction on transition (the T18
  `cancelPendingRetrieval` path covers retrieval only).
- Repro: private mode ON via shipped control surface;
  `observer.extractNow()` on the runtime's shipped scheduler instance with a
  synthetic single-entry provider.
- Result (expected-failing assertion):
  `PRIVACY GAP: scheduler attempted 1 model call(s) while private mode was ON:
["POST https://openrouter.ai/api/v1/chat/completions"]`
- Desired behavior: refuse NEW extraction/model requests after transition
  (fail closed, visible skip reason), best-effort cancel in-flight
  extraction, preexisting pending batches retained without duplicates or
  drops; capture performed DURING private mode classified separately from
  preexisting pending work and never replayed on resume.
- Minimal interfaces for the fix: live private-mode check at batch creation
  and at the model-call boundary (or a cancel hook wired to the
  private-mode transition) — left to Q06/Q07 composition/config-lifecycle
  design.

## Files

- `tasks/code-quality-plan.md` (new, uncommitted)
- `test/q01-private-mode-gaps.test.ts` (new, uncommitted, expected failing)
- No production code changed. No commit made (per Q01 instructions).

Note for Q06: the outbox-gap test currently waits on the real coordinator
timer (30s default; bounded 40s cap) because `buildSessionRuntime` exposes
no manual tick hook and no `tickIntervalMs` option — Q06 may add a
test-visible seam to make this fast without weakening the shipped
construction guarantee.
