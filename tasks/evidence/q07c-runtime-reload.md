# Q07C evidence — production runtime reload wiring + delivery-target pin

Task: Q07C_runtime_reload. Base: f0cea46 (Q06, committed) + this Q07 commit.
No standalone commit — included in the final Q07 commit. No live service, no real model calls, no secrets, no SSH,
no deploy/push. All tests synthetic: credential-isolated 127.0.0.1 loopback
fronting the audited in-process fake provider (`test/fake-mcp-server.ts`),
temp config files (mode 0600), throwaway env vars.

## What was implemented

1. **Single owner into the remaining production surfaces.** Q07B1 collapsed
   the runtime gates (outbox/model/scheduler/retrieval/backup/board).
   Q07C routes the DISPLAY/gate surfaces through the same owner
   (`readConfigLive()`): `src/runtime/status.ts` (`resolveStatusText`,
   fail-closed invalid branch now uses the sanitized `invalidReason`),
   `src/commands/control-commands.ts` (private-mode status view),
   `src/commands/backup-commands.ts` (verify gate),
   `src/commands/board-commands.ts` (cleanup repo gate). No remaining
   `loadConfig` call sites outside the owner and the snapshot owner
   (`buildSessionRuntime` head — the documented SNAPSHOT read).
   Duplicated synchronous reloads: the per-check closures
   (`privateMode: () => readConfigLive().privateMode`) are deliberately
   separate reads — that IS the live safety semantics (no permit caching);
   no other site reads the file more than once per check.

2. **Delivery-target pin (Q07A §3 queue-hazard contract — the one new
   persisted-shape element):**
   - `src/outbox/target.ts`: `targetFingerprint(url, authRef, scope)` =
     sha-256 of endpoint URL + credential-REFERENCE identity (kind+ref,
     never the resolved secret) + record scope.
   - `src/outbox/store.ts`: additive optional `target` on `OutboxJob` /
     `EnqueueInput`; store option `targetFor(scope)` attaches the
     enqueue-time pin. No migration; legacy jobs load unchanged.
   - `src/outbox/worker.ts`: option `expectedTarget(job)`; BEFORE the send
     (AFTER the private-mode gate — privacy keeps precedence), a pending job
     whose pin differs from the current session snapshot's target is HELD:
     no network attempt, no attempt consumed, no backoff, no quarantine,
     never dropped; sanitized audit record `held (delivery target changed)`;
     stays pending under the original opId so restoring the original config
     releases delivery exactly once.
   - `src/runtime/session.ts`: `DurableOutbox.open(..., { targetFor })` pins
     from the session SNAPSHOT; the worker's `expectedTarget` re-derives the
     expected fingerprint from the same snapshot (personal jobs always
     expect their own `personal` scope, mirroring the sender's routing).

3. **Status truthfulness.** `resolveStatusText` now carries one explicit
   lifecycle line: private mode and enabled are live; endpoint/credential
   refs/scopes/budgets/features are the session snapshot and apply at the
   next session. Status never claims all settings are live.

4. **Docs.** `docs/configuration.md` new section "Which settings are live
   and which apply at the next session" (exact boundaries, fail-closed
   semantics, target-pin behavior, legacy caveat + open question);
   `docs/architecture.md` §6 target-pin bullet. Re-export compatibility
   unchanged (index re-exports untouched); one-way dependency preserved
   (commands/runtime never import index; outbox/target imports config
   schema types only).

## Not done (out of Q07C scope, per contract)

- No live reconfiguration of adapters/scopes/features/budgets; no config
  watcher; no caching layer; no snapshot invalidation signal; no widening
  of `onRelease` auto-fire; no change to private-period classification.
- Q07A §7 open questions remain coordinator decisions (legacy
  fingerprint-less pending jobs deliver as today — documented additive
  default; a visible warning for them is NOT implemented).

## Gates

- `npm run check`: **typecheck + format:check + 653/653 tests pass**
  (645 pre-existing incl. all q02*/q06*/q07b1 suites unchanged + 8 new
  `test/q07c-runtime-reload.test.ts` tests).
- `npm run pack:check`: pass (below).
- `devenv test`: pass (below).
- `test/q07c-runtime-reload.test.ts` demonstrations (all through the SHIPPED
  `buildSessionRuntime` + shipped worker tick):
  a. Production reload sequence: INVALID config ⇒ held, zero requests →
  valid+private ⇒ held, zero requests → public ⇒ sent exactly once,
  original opId, job acked, nothing quarantined.
  b. Mid-session snapshot change (endpoint + budgets edited in the file) ⇒
  delivery flows to the ORIGINAL loopback target; the edited target
  receives zero bytes (no invented live reconfiguration).
  c. Session rebuild with CHANGED endpoint ⇒ retained pinned job HELD,
  zero requests to the new target, never dropped/quarantined; rebuild
  with RESTORED config ⇒ delivered exactly once to the original target.
  d. Record-scope change across rebuild ⇒ held (no silent scope
  reinterpretation), zero requests.
  e. Credential VALUE rotation (same env-ref identity) ⇒ delivers.
  f. Legacy fingerprint-less journal entry ⇒ delivers as today (pinned
  additive default).
  g. Status text states the live/snapshot split and renders INVALID config
  fail-closed through the owner.

## Stage scan (explicit list staged at gate time)

- src/outbox/target.ts (new), src/outbox/store.ts, src/outbox/worker.ts,
  src/runtime/session.ts, src/runtime/status.ts, src/commands/control-commands.ts,
  src/commands/backup-commands.ts, src/commands/board-commands.ts,
  docs/configuration.md, docs/architecture.md,
  test/q07c-runtime-reload.test.ts (new),
  tasks/evidence/q07c-runtime-reload.md (this file).
- Left UNSTAGED: `tasks/evidence/t19-budget-report.json` (unrelated
  long-session benchmark jitter — preserved, not committed).
- Secret scan of the staged list: no credential values, no tokens, no
  private paths; the fingerprint is sha-256 over non-secret identity only.
