# Q06 evidence — composition refactor (closed whole-task)

## Scope and result

Q06 (composition refactor: uniform injection of live gates and audit into
worker/observer/reflection/delivery; Q01 failing tests become acceptance
regressions) is COMPLETE, composed of three behavior-preserving extraction
subtasks. No command names, confirmation semantics, privacy holds, scope
rules, cleanup/persistence semantics, or on-disk formats changed anywhere
in the round. No live services, model calls, push, or publication.

## Q06A — backend factory extraction (commit 62fb957)

- `src/backend/factory.ts`: `openBearerAdapter` (fail-closed credential
  resolution, `undefined` → retryable hold, `cached` unset), `buildBearerAdapter`
  (pre-proved-credential sites, `?? ""` header fallback preserved verbatim),
  `resolveBearerSecret` (pure re-export of `resolveAuthSecret`). OpId ledger is
  a REQUIRED typed parameter — no optional ledger; mutations still refuse
  without a durably persisted opId.
- Call sites migrated: src/index.ts ×4 (observation sender, proposal
  lifecycle, retrieval, board delivery), src/commands/manual-ops.ts ×1.
  `src/backend/live/runner.ts` intentionally untouched (probe-harness shape).
- Regression: `test/backend-factory.test.ts` (9 synthetic tests; in-process
  fetch swap, throwaway env, mode-0600 temp files; no sockets/credentials).

## Q06B — session runtime extraction (commit ba6975b)

- `src/runtime/session.ts`: `buildSessionRuntime`, `resolveStateDir`,
  `openConfiguredBackend`, `crossOptInToScopes` extracted from index.ts;
  live gates (private-mode `PrivateModeGate` via config live-gate adapter,
  config-validity gate) and the Q04 `FileAuditStore` audit sink injected
  uniformly into worker/observer/reflection/delivery — closing the Q01
  structural gaps; `SessionRuntime` returned as the single typed handle.
- index.ts became composition/lifecycle only. Q01 acceptance regressions
  (private-mode extraction refusal + live gate at batch creation and
  model-call boundary, audit injected uniformly) run green in the shared
  suite. No test-only factories: production composition path only.

## Q06C — commands/status/controls extraction (this round, staged)

- `src/commands/{registration,board-commands,backup-commands,control-commands}.ts`:
  all 13 commands extracted; `src/index.ts` now 528 lines with **0**
  `registerCommand` calls — lifecycle/composition only. Command modules
  import `session.ts`, never `index.ts` (no cycles).
- `src/runtime/status.ts`: status surfaces (message, probe registry,
  `statusIsSecretFree` redaction guard preserved) moved out of index;
  imports only config/* + observation/model. index → status one-way via
  `wireRuntimeStatusProbes` inside `registerSessionHandlers`.
- `src/runtime/controls.ts`: control surface deps via explicit params only
  (node, retrieval-type, config) — no hidden globals.
- Shared instances (`runtimeBox`, `configGate`) created in index and
  threaded explicitly; no module-level singletons duplicated in moved
  modules.
- Orphan seam removed: `setTokenizerNoteSink` + `runtimeEpoch` gate had
  zero remaining callers after B; deleted. Stale-session note leakage is
  structurally prevented by note ownership via `rt.tokenizerNote` on the
  current-runtime probe (pinned by test 5 of q06c1).
- Exported test seams deliberately preserved via index re-exports:
  `STATUS_MESSAGE`, `computeOverallState`, `resolveStatusText`, all ten
  `set*Probe` seams, `buildSessionRuntime`/`resolveStateDir`/
  `openConfiguredBackend`/`crossOptInToScopes`/`SessionRuntime`,
  `buildRuntimeControlSurface` — t18/extension/q02c/q06b2 suites pass
  unchanged through index.
- Command semantics byte-identical (confirmation tokens, `--yes` refusals,
  privacy holds, cleanup/gc scopes); only fail-closed dep assertions added.
- New tests drive the shipped production factories: `test/q06c1-status.test.ts`
  (7 — real `registerSessionHandlers`), `test/q06c2-commands.test.ts`
  (3 — shipped `kiwifsMemory`), `test/q06c3-composition.test.ts`
  (4 — shipped `kiwifsMemory`).
- Residual unused type-only imports in index.ts noted as non-blocking;
  untouched (tsc-clean).

## Acceptance review

Independent read-only acceptance review of the staged 11-file tree: PASS
(boundaries, dependency directions, behavior diff, safety, secret scan all
verified; blockers none).

## Gates after final edits (re-run at final commit time)

- `npx tsc --noEmit` — clean.
- `npm run check` (typecheck + format:check + test) — 634 pass / 0 fail.
- `npm run pack:check` — OK; packed extension loads in isolated Pi RPC
  (commands registered, safe offline startup, no backend).
- `devenv test` — EXIT=0 (55.3s).
- Secret scan of staged files (explicit list): clean — env-var names and
  synthetic values only; no credentials, no private config.
- Unrelated benchmark jitter (`tasks/evidence/t19-budget-report.json`
  unstaged regeneration) left out of the commit per task rule.
