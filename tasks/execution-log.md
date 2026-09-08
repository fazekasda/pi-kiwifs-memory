# Task execution log

Append-only record of task work and the tests actually run. Commit receipts are added by the committer after each task commit.

## T01 — Verify deployment and backend contracts

Date: 2026-02-08 (session). Worker: implement_T01, model openrouter/z-ai/glm-5.3-flash per standing instruction.

### Prior state verified

- No prior committed task receipts (`[]`). Baseline commit `45a11cc` (scaffold) exists.
- Pre-existing untracked/modified planning baseline (inventory; belongs to project setup, staged by the committer — never blanket-staged, and `config/kiwifs-test.local.json` is secret-bearing and must never enter Git/logs/model context):
  - `docs/architecture.md`, `docs/architecture-review.md`, `docs/decisions.md`, `docs/test-environment.md`, `docs/research/mcp-contracts.md` — untracked planning baseline from the coordinator-approved research/architecture phase.
  - `tasks/prd-kiwifs-memory.md` — untracked PRD/backlog.
  - `config/kiwifs-test.example.json` — tracked-able, credential-free example (tracked in this T01 commit as planning baseline); `config/kiwifs-test.local.json` — git-ignored, never staged.
  - `.gitignore` / `.prettierignore` — pre-existing modifications adding `config/kiwifs-test.local.json` to both ignores.

### Work done

1. Read the PRD (T01 + dependencies), `docs/decisions.md`, `docs/architecture.md` §1–3, `docs/architecture-review.md`, `docs/test-environment.md`, `docs/research/mcp-contracts.md` in full.
2. **Contract fixtures for T04** (T01 acceptance item 5): created synthetic data fixtures in `test/fixtures/mcp/` (19 files) covering initialize/stateless handshake, capability-discovery shape, CRUD/append/delete results with ETags, `if_not_etag`, FTS/semantic/hybrid result shapes with engine attribution and pagination hint, brief pack with embedded out-of-scope page, `kiwi_changes` cursor, board `kiwi_query_meta` rows, the 5-step fail-closed guard pipeline cases (including empty/stale tombstone cache), real-SHA-256 `msg_id` derivation vectors (dual-sender distinctness + replay stability), limit clamp/oversize/path-length cases, and error-normalization cases (domain isError, 401 hard setup, oversized response, redirect credential rejection, timeout/cancel). Catalog with per-fixture citation traces: `docs/research/adapter-fixtures.md` (including honest gaps: synthetic tools-list subset; `_meta` ETag carrier to confirm live in T04; [P] 16-hex msg_id truncation default).
3. **Live MCP runner spec** (T01 acceptance item 6): `docs/research/live-mcp-runner.md` — opt-in fail-closed runner targeting only the dedicated test space MCP endpoint; preconditions (config flags, safety fields), routing verification before first mutation, `tools/list` capability gate with abort-before-mutation on missing required tools, random run IDs beneath `integration-tests/`, manifest-owned cleanup verified post-delete, per-request + total-run deadlines, redacted diagnostics (no header/credential/config values in output), B1 reconciliation per architecture-review S-3. Assigned T04 (implementation) / T19 (execution).
4. **61 vs 71 tool discrepancy disposition** (T01 acceptance item 7): recorded in `docs/research/mcp-contracts.md` §3 — informational; source list contains wildcards so 61 undercounts concrete tools by construction; adapter is capability-driven with no hard-coded count; live runner aborts before mutation if a required tool is missing.
5. Updated PRD T01 checkboxes to reflect the three completed items; fixtures catalog cross-referenced from `mcp-contracts.md` §9.
6. No live service contact, no mutation, no production access, no credentials read or printed.

### Tests run (actual evidence)

- `npm run check` — typecheck (`tsc --noEmit`), `prettier --check .`, `node --test test/*.test.ts`: **pass** (scaffold tests unchanged; fixtures are JSON/MD data, not compiled or executed).
- `npm run pack:check` (`scripts/check-package.mjs` + `scripts/smoke-package.mjs`): **pass**; packaging allowlist unchanged this task (`files: src/` only — fixtures are dev artifacts, correctly excluded).
- `devenv test` — **not run**: requires `npm ci` over the network and full Nix sandbox evaluation; report limitation, not a silent skip. `npm run check` and `npm run pack:check` (the repo-check constituents) were run directly and passed. Node 24 (devenv default) and Node 22.19.0: fixture files are data, no runtime compatibility surface introduced.
- No TUI behavior introduced; no manual TUI check required or performed.

### Limitations / handoff

- Fixture 11 (Pi ordering, matched injection, redaction-active/template-expanded variants) is spec-level; T08/T12/T13 must implement it against Pi 0.85.0 source before T12/T13 land.
- `_meta["kiwi.etag"]` key names in read fixtures are fixture conventions pending live confirmation in the T04 runner capability pass.
- `config/kiwifs-test.local.json` was never opened, printed, or staged; only its existence and ignore status were verified.

## T01 follow-up — devenv test validation gap closed

Date: 2026-02-08 (session). Worker: close_T01_gate, model openrouter/z-ai/glm-5.3-flash per standing instruction.

Prior worker had skipped `devenv test` citing network npm ci/Nix eval; this run confirms it as authorized normal testing and executes it.

### Tests run (actual evidence)

- `devenv test` — **pass** (7.69s): `npm ci` over the network, then `npm run check` (typecheck + prettier + node --test, 3/3 pass) and `npm run pack:check` (Package OK, 4 files; packed extension loads in Pi RPC and reports scaffold status). Full log: "Tests passed :)".
- `npm run check` — re-run directly: **pass** (3/3 tests, formatting clean).
- `npm run pack:check` — re-run directly: **pass**.
- T01 defect inspection: all 20 `test/fixtures/mcp/*.json` files parse as valid JSON; commit `03ede0c` diff reviewed for secrets — none; `config/kiwifs-test.local.json` still ignored and untouched.

### Result

- No T01 defects found; no code changes. Required gate `devenv test` now recorded as completed for T01, not skipped.
- T01 acceptance criteria remain satisfied; follow-ups unchanged (T04 cursor replay/ETag integration, T16 msg_id framing live confirmation).

## T02 — Resolve decisions and approve architecture

Date: 2026-09-08 (session). Worker: implement_T02, model openrouter/z-ai/glm-5.3-flash per standing instruction.

### Prior state verified

- T01 receipt present: original commit `03ede0cd…`, completed, follow-up commit `c0e0f1a` closing the devenv test gate. T01 acceptance items 5–7 evidenced in the log. Dependency satisfied.
- `docs/decisions.md` (D2–D6 choices, #1–#12 confirmed), `docs/architecture.md` (§1–§13 incl. decision/default table), `docs/architecture-review.md` (F1–F10, R1–R5, B-1…M-3 all resolved) read in full; `docs/test-environment.md` re-read for live-runner constraints.

### Work done

1. **Architecture approval recorded** (T02 final acceptance item): the user approved the architecture set by instructing execution of the approved task plan; approval is the execute-plan instruction. Recorded in PRD T02 checkbox with the coordinator's applied corrections: pending outbox jobs never drop-oldest (capture backpressure with visible coverage gaps); model-compatible tokenizer including framing required for the enforced 3,000-token cap, with visible skip of automatic injection if unavailable; queued-input matching must distinguish newly consumed occurrences, repeated identical text, transformations and followUp lifecycle (history membership alone insufficient). Rows #18–#20 dispositioned: #19 excluded by confirmed privacy policy; #18/#20 deferred, not blocking v1. **No changes to decisions.md.**
2. **Consistency fix found and applied**: `docs/architecture.md` §2 local-outbox record still said "oldest-jobs-dropped with visible status on overflow", contradicting §13 row 8 and the coordinator correction. Rewritten to state high-water limits, capture pause with visible coverage gaps, pending jobs preserved, 14-day retention applies only to acknowledged jobs. No other doc inconsistencies found: §3.1 token accounting already requires a model-compatible tokenizer (§13 row 5), §3.1 queued-input matching already covers the followUp lifecycle and fail-closed ambiguity handling, and the architecture-review "Remaining gates" list matches the PRD state.
3. No code, test-fixture, or config changes; no live service contact; `config/kiwifs-test.local.json` never read or staged.

### Tests run (actual evidence)

- `npm run check` — **pass**: typecheck clean, prettier clean, node --test 3/3 (scaffold tests unchanged).
- `npm run pack:check` — **pass**: Package OK, 4 files; packed extension loads in Pi RPC.
- `devenv test` — **pass** (7.47s): full suite incl. network `npm ci`; "Tests passed :)".
- Node compatibility: task changes Markdown/docs only, no runtime surface; engines `>=22.19.0`, devenv toolchain Node v24.19.0, all checks green there.

### Blockers / follow-ups

- No blockers. Remaining gates unchanged and carried to owning tasks: T13 feasibility fixture (queued-input matched injection) before T12/T13 land; B1 production-endpoint auth before enabling outside the test space; T04/T19 live runner unbuilt.

## T03 — Implement validated configuration and scope identity

Date: 2026-02-09 (session). Worker: implement_T03, model openrouter/z-ai/glm-5.3-flash per standing instruction.

### Prior state verified

- T01 receipt (commit `03ede0c`, gate-closure `c0e0f1a`) and T02 receipt (`68cb432`) present; T02 dependency satisfied. Relevant docs re-read: `docs/architecture.md` §2/§4/§5/§9/§10/§13, `docs/decisions.md` #5/#9/#10/#12, `docs/test-environment.md` safeguards.

### Work done

1. `src/config/schema.ts` — `MemoryConfig` schema + `validateConfig` (fail-closed): http(s)-only URL (credentials-in-URL rejected; `headers` keys rejected — credentials are by reference only: `auth: {kind: env|file, ref}`), model-route shape check (default `openrouter/z-ai/glm-5.3-flash`, decisions.md #9), scope flags, budgets (defaults 2000 ms / 3000 tokens, decisions.md #7), feature flags, explicit `projectIdentity` override. Unknown keys and unknown/older/newer `schemaVersion` are validation errors (newer refuses to run or rewrite, architecture.md §10). `effectiveFeatures`: private mode disables ALL three domains (decisions.md #10).
2. `src/config/loader.ts` — documented precedence defaults < config file (`options.file` or `KIWIFS_MEMORY_CONFIG`) < explicit runtime overrides, cumulative deep merge; unreadable/invalid-JSON file is a fatal visible error; loader never resolves credential references to secret values.
3. `src/config/status.ts` + `src/index.ts` wiring — `/kiwifs-status` shows resolved nonsecret settings only (endpoint, symbolic credential ref `env:NAME`/`file:/path`, model route, scopes, budgets, effective features, identity override); defensive `statusIsSecretFree` suppresses display if token-like material ever appears; config errors render as visible `config: INVALID — extension disabled`, never a crash.
4. `src/scope/identity.ts` — `normalizeGitRemote` (host + owner/repo; strips scheme, credentials, port, `.git`; scp-like syntax; credentials redacted in errors), `resolveProjectIdentity` (single/equivalent remotes resolve; conflicting remotes and non-Git dirs fail closed demanding the explicit `projectIdentity` override; worktrees/branches are repo-level — identity never from content hashes or branch names, architecture.md §2), `authorizedScopeSet` (own project + optional `personal` + explicit `cross/` opt-in only; N≤4 fanout bound fails closed, §13 row 3), `scopeIsAuthorized` exact-membership gate (cross-project denied by default).

### Tests run (actual evidence)

- `npm run check` — **pass**: typecheck clean, prettier clean, node --test **44/44 pass** (18 config, 21 scope, 5 extension incl. updated status assertions).
- `npm run pack:check` — **pass**: Package OK, 8 files (adds `src/config/*`, `src/scope/identity.ts`); packed extension loads in Pi RPC.
- `devenv test` — **pass** (7.88s): network `npm ci`, full suite, "Tests passed :)".
- Node compatibility: devenv toolchain Node v24.19.0; engines `>=22.19.0`; code uses only stable Node 22+ APIs (`node:fs`, `node:url` parsing via `URL`, no experimental flags). Typecheck and tests green on the devenv Node.
- Secret scan: staged diff contains no secret values (only test fixtures with synthetic references like `KIWIFS_API_KEY`); `config/kiwifs-test.local.json` never read, opened, printed, or staged. No live service contact in this task (T03 is config/identity only).

### Acceptance coverage

- Invalid URLs / missing credentials / conflicting config / explicit overrides: `test/config.test.ts` (URL scheme + credentials-in-URL + headers rejection; enabled-without-auth; unknown keys; schemaVersion guards; override precedence).
- Worktrees/branches/non-Git identity policy: `test/scope.test.ts` (worktree parity, repo-level identity, no-remotes fail-closed, override wins, conflicting-remote fail-closed).
- Cross-project reads denied by default: authorized-scope-set default + exact-membership gate tests (prefix look-alikes rejected).
- Status nonsecret-only: resolved-status assertions + `statusIsSecretFree` unit tests + extension-level status test.
- Private mode disables all three domains: `effectiveFeatures` tests (all false under privateMode regardless of feature flags).

### Blockers / follow-ups

- No blockers. Follow-ups for later tasks: status output later extended per-feature as domains land (T08+); loader file location convention (project-local vs user-global discovery) is a T08/T18 UX decision; scope resolver consumes real `git remote -v` output starting T08 (module accepts remotes as input already).
