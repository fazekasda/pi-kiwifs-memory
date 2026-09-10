# Q07B1 — live-config owner (`readConfigLive`) evidence

Task label: Q07B_config_owner. HEAD before work: f0cea46. Included in the final Q07 commit.
(per instruction; staging deferred to the final Q07 gate).

## What was implemented (Q07B1 only — single-predicate collapse)

- **Owner:** `src/privacy/live-gate.ts` now exports `ConfigLiveView` and
  `readConfigLive()` — the ONE fail-closed LIVE-config read. One `loadConfig`
  call is classified into `ok / privateMode / enabled / invalidReason` (+
  `config`/`file` when ok so callers needing more than the safety fields do
  not re-read). Any read/parse/validation failure ⇒ `ok:false, privateMode:
true, enabled:false` (fail closed) with a sanitized `invalidReason` (same
  message class `resolveStatusText` already surfaces; no secret material).
  A thrown regression in the loader still fails closed (catch → private).
- **Predicate collapse (zero behavior change to outcomes):**
  - `liveConfigPrivateMode()` → `readConfigLive().privateMode` (outbox worker
    tick/pre-send, model gate per attempt, scheduler boundaries, cancel push
    all unchanged — same read, now via the owner).
  - `src/runtime/session.ts` retrieval (per-cycle), backup (per-capture) and
    board `liveGate`/`repoGate` closures → `() => readConfigLive().
privateMode`. The duplicated `!r.ok || r.config.privateMode` bodies are
    gone; per-attempt gates, per-boundary cancellation semantics and
    scheduler `isPrivate` are untouched (Q02c/d invariants preserved).
  - `src/index.ts`: `recallDeps`/`boardDeps`/`configGate`/`controlSurface`
    now read through the owner. Improvement (within contract): the recall/
    board tools' `privateMode` check is now a live per-check read instead of
    a permit captured at call entry — a config that turns invalid/unreadable
    mid-call fails closed instead of using the stale permit. `configGate`
    notices are byte-identical ("config: INVALID", "extension disabled",
    private-mode notice).
- **NOT changed (out of Q07B1 scope):** DISPLAY/gate sites in
  `src/runtime/status.ts`, `src/commands/*` (they read per command
  invocation — per-boundary, no caching); no watcher, no retry loop, no
  cached permit, no live reconfiguration, no snapshot invalidation signal;
  session-boundary rebuild stays the structural reload path. Job-target
  fingerprint (Q07B2) NOT implemented — coordinator answers to the three
  pinned open questions are still required (hold-on-mismatch approval,
  legacy fingerprint-less jobs, `enabled:false` mid-session semantics).

## One-way dependency preserved

- `privacy/live-gate.ts` → `config/loader.ts`/`schema.ts` (pre-existing
  direction). `src/index.ts`/`src/runtime/*` never import index from
  commands/runtime; commands/runtime still never import index.

## Tests

- New: `test/q07b1-live-view.test.ts` (11 tests, all synthetic: temp 0600
  config files, throwaway env, no network, no real model calls):
  1. valid config → truthful ok/enabled/privateMode + config/file present.
  2. persisted private mode → privateMode true, ok stays true.
  3. unparseable JSON → fail closed + sanitized reason.
  4. non-object JSON → fail closed.
  5. validation issues → fail closed + issue summary.
  6. unreadable file (chmod 000) → fail closed + "unreadable" reason.
  7. no config file → defaults (enabled:false), pinned explicitly as NOT
     private (existing loader contract; no invented reinterpretation).
  8. transient invalid window: invalid read N fails closed; valid read N+1
     proceeds — no cached permit, no crash.
  9. predicate equivalence vs independently computed `!ok || privateMode`
     across six config states.
  10. shipped gate: invalid file observes private; normal→private transition
      fires cancel subscribers exactly once; repeated/invalid reads do not
      re-fire; resume clears held refs.
  11. shipped runtime (`buildSessionRuntime`): private flip and invalid
      window observed live via the shared gate; restore resumes; snapshot
      objects untouched.

## Commands and results

```
npx tsc --noEmit                                → clean
npm run check (typecheck + format + tests)      → 645/645 pass, 0 fail
npm run pack:check                              → packed extension loads, safe offline startup
devenv test                                     → "Tests passed :)" (56.1s)
node --test test/q07b1-live-view.test.ts        → 11/11 pass (bounded, ~0.2s)
```

## Stage scan / working tree

- Modified (Q07B1): `src/privacy/live-gate.ts`, `src/runtime/session.ts`,
  `src/index.ts`; new `test/q07b1-live-view.test.ts`.
- Untracked (Q07A artifact): `tasks/plans/Q07A-lifecycle-contract-draft.md`
  (formatted with prettier so `format:check` passes; content unchanged).
- Unrelated, LEFT UNSTAGED per instruction: `tasks/evidence/
t19-budget-report.json` (4-line benchmark jitter) left unstaged. The final Q07 commit follows the gates below.
- Secret scan of the changed set: no tokens, no credentials, no SSH, no
  endpoint other than the synthetic `127.0.0.1:1` fixture URL; token env
  vars restore-protected in tests.

## Q07B2/Q07B3 status

Not started — blocked on the coordinator's answers to the three unresolved
safety questions in `tasks/plans/Q07A-lifecycle-contract-draft.md` §7
(hold-on-mismatch policy, legacy fingerprint-less jobs, mid-session
`enabled:false`, status-diff granularity). Per the task boundary, no queue
fingerprint, no docs/status work, and no commit in this task.
