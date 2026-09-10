# Q02 chunk 2 evidence — production gate wiring into extraction/reflection factories + scheduler boundaries (HEAD 4e4b06e + uncommitted Q01/Q02a–c fixes)

Commands:

- `node --test test/q02d-scheduler-gate.test.ts` — **5/5 pass** (~2.7s, native node --test TS)
- `node --test test/q02d-scheduler-gate.test.ts test/q01-private-mode-gaps.test.ts test/q02a-outbox-gate.test.ts test/q02b-model-gate.test.ts test/q02c-gate-transition.test.ts` — **23/23 pass**
- `npm test` (full suite) — **495/495 pass** (~41s)
- `npm run typecheck` — clean; Prettier — clean on changed files

## Q01 Gap 2: RESOLVED

`node --test test/q01-private-mode-gaps.test.ts` — **2/2 pass** through the
SHIPPED `buildSessionRuntime` composition (no injected gates): private mode ON
via `setPrivateModeInFile`, `rt.observer.extractNow()` → **zero** model calls.
The repro's witness test is now a passing acceptance regression.

## Production wiring (minimal, no refactor)

- `src/index.ts` `buildSessionRuntime`:
  - `createModelExtractor({ ..., gate: outboxGate })` — the shared
    `LiveConfigPrivateModeGate` now guards EVERY extraction model attempt
    (pull re-read before every transport call + transition-time
    `onCancel` for in-flight work, Q02b semantics).
  - `createModelReflector({ ..., gate: outboxGate })` — same for reflection.
  - `new ObserverScheduler({ ..., isPrivate: () => outboxGate.isPrivate })` —
    live private-mode read at every scheduler boundary.

- `src/observation/scheduler.ts` (boundary gate, durable-first):
  - New optional `isPrivate?: () => boolean` option (absent ⇒ old behavior —
    all 495 existing tests pass unchanged).
  - `onAgentSettled` while private: refuse NEW batch creation, return
    `skippedReason: "private-mode"`; unprocessed entries present at the
    boundary are CLASSIFIED private-session — `markConsumed` WITHOUT
    extraction, so private-period content can never be replayed on resume.
  - `onBeforeCompact` while private: no model call; same classification
    (compaction may remove entries — consuming here is the only way they
    cannot be replayed later); returns `flushed: false, reason:
"private-mode"` (new `FlushResult` reason); `pendingEntries` still
    reports preexisting durably pending batch entries.
  - `extractNow` while private: refused with `"private-mode"`, no
    classification (user command; pre-private entries remain extractable
    post-resume, entries are classified at the next settled/compact
    boundary).
  - Idle-timer fire during private: classifies accrued entries, never batches.
  - Preexisting pending batches are NEVER touched by the private path: same
    opIds, no drops, no duplicates; resume retries them under the original
    opId (cooldown respects the T10 retry budget).
  - `pendingStatus()` discloses the coverage gap: `observer: N entries
captured during private mode classified private-session — never
extracted (visible coverage gap)`.

## Tests (test/q02d-scheduler-gate.test.ts — production runtime, fetch intercepted to a recorder, no real model calls, no network beyond the synthetic interception)

1. `extractNow` during private: `skippedReason "private-mode"`, zero model
   calls, no batch created; refusal does not classify (entries remain for
   later boundaries).
2. Settled boundary during private: zero model calls; entries captured
   DURING private are consumed WITHOUT extraction; status line visible;
   after resume a NEW post-resume entry is extracted exactly once while the
   private-period entry is NEVER selected or replayed.
3. Precompact during private: `flushed:false / "private-mode"`, zero NEW
   model calls, private-period entry classified, PRE-EXISTING pending batch
   retained under its original opId with correct `pendingEntries`.
4. Pre-private pending batch survives the private period (untouched, same
   opId) and is retried on the resume boundary under its ORIGINAL opId — no
   duplicate, no drop.
5. In-flight extraction cancelled on transition: model attempt hangs in a
   signal-honoring fake transport; transition (persist + shared gate push
   `notifyTransition()`) aborts it best-effort; batch stays durably pending;
   `lastError` = sanitized `ExtractionModelError` ("private-mode" reason —
   name only, safe for durable fingerprints).

## Privacy invariants held

- Zero NEW outbound model/backend attempts after transition (pull at every
  boundary AND at every transport attempt; push cancel for in-flight).
- Already-sent bytes unaffected (cannot be recalled) — no recall attempted.
- Pending durable work retained without duplicates or silent drops; resume
  replays only PRE-PRIVATE work under original opIds.
- Private-period content never replayed (classified consumed, gap visible).
- Gate absent ⇒ scheduler behaves exactly as before in unit contexts, but the
  PRODUCTION runtime always passes the real gate — no silent bypass.

## Not done here (per scope)

- No audit-sink expansion (Q04), no composition refactor beyond this wiring
  (Q06 may generalize), no config-lifecycle changes (Q07), no commit.
- All prior uncommitted Q01/Q02a/Q02b/Q02c edits preserved intact.
