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

### Review fixes (T07 review, pre-commit)

- Persisting retry/quarantine state in `OutboxWorker.deliver` is now inside the tick-never-throws invariant: a persist fault (ENOSPC) while recording a failure leaves the job pending instead of escaping `tick`. New tests cover both the retry and the quarantine persist-fault paths.
- `reconcile()` now detects feed GAPS (`first > lastSeq + 1` when a prior advisory cursor exists), not just regressions — a skipped range is flagged as drift, never adopted via `setBackend`. New test asserts the advisory cursor stays untouched across a gap.
- `store.persist()` and `CursorFile.save()` fsync the parent directory after `renameSync`, so the §2 "opId persisted before any side effect" durability claim holds across power loss on the rename itself.
- `CursorFile` newer-`schemaVersion` fail-safe retains the parsed authoritative `localSeq` (read-only retention) instead of silently resetting it to 0.

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

Date: 2026-09-08 (session). Worker: implement_T03, model openrouter/z-ai/glm-5.3-flash per standing instruction.

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

## T04 — Implement backend adapter and contract tests

Date: 2026-09-08 (session). Worker: implement_T04, model openrouter/z-ai/glm-5.3-flash per standing instruction.

### Prior state verified

- Dependency receipts confirmed: T01 `03ede0c` (+ gate closure `c0e0f1a`), T02 `68cb432`, T03 `92b1520` (+ review fix `9e1502b`). All T04-relevant fixtures existed in `test/fixtures/mcp/` with the catalog in `docs/research/adapter-fixtures.md`; the live-runner spec existed in `docs/research/live-mcp-runner.md`. No T04 code existed yet.

### Work done

1. `src/backend/errors.ts` — typed error taxonomy (auth/validation/conflict/timeout/cancelled/availability/response-format/capability/not-persisted); authorization failures are terminal, only availability faults are retryable.
2. `src/backend/opid.ts` — op-id minting + ledger interface; every mutation calls `assertPersisted` and refuses side effects for unpersisted opIds (architecture.md §2; durable persistence wiring lands with the T07 outbox).
3. `src/backend/transport.ts` — MCP Streamable HTTP: stateless initialize per logical connection, `tools/list`, `tools/call`; `redirect: "error"` + 3xx refusal (no credential forwarding); content-length + streamed bounded reads; per-request timeout combined with the caller AbortSignal; typed Timeout/Cancelled errors; JSON-RPC id-mismatch and protocol-error handling.
4. `src/backend/adapter.ts` — capability-discovery gate on connect (required-tool set only; no hard-coded count), client-side limits (clamp 50 / 32 MiB / 500-char path), all verified operations (read with `if_not_etag` + not_modified, write, append, delete, FTS/semantic/hybrid search, brief, changes, query_meta, forget), B2 read-before-write `writeImmutable` (identical replay → no-op, differing content → fail-closed ConflictError), hybrid degradation from rank attribution only, isError → typed ValidationError, single availability retry, sanitized error messages. Missing-path reads return a typed `missing` state (read-back is control flow for B2/guard step 1).
5. `src/backend/guard.ts` — the 5-step fail-closed guard pipeline (fresh read-back → memory_status absent/active → scope ∈ authorized set → `{scope}/memory/` prefix → pluggable privacy redaction; real redaction rules are T06), advisory `QueryMetaTombstoneCache` (5-min TTL, §13 row 7), brief scope gate with 25%-threshold fallback rebuild from scoped search (§13 row 4).
6. `src/backend/ids.ts` — `msg_id` = 16-hex SHA-256 of slash-joined `'{channel}/{from}/{opId}'`, asserted against the real-SHA-256 vectors in `board-msg-id-vectors.json` (dual-sender distinctness + replay stability).
7. `src/backend/parse.ts` — typed parsers over KiwiFS text results; non-throwing on unexpected shapes.
8. `test/fake-mcp-server.ts` — in-memory fake KiwiFS MCP server (initialize/tools/list/tools/call, frontmatter-aware store, forget rewrites status, fault injection: 401/302/hang/invalid-JSON/oversized body). All synthetic.
9. `src/backend/live/runner.ts` + `npm run test:live` — the opt-in live runner per `docs/research/live-mcp-runner.md`: opt-in gate (`KIWIFS_LIVE_TESTS=1` + local config), fail-closed preconditions incl. exact safety-policy match, capability discovery before mutation, routing check (sentinel absent) before first write, synthetic CRUD/FTS round trip under `integration-tests/{random-run-id}/`, manifest-owned reverse-order cleanup with post-delete verification and leftover reporting, per-request/run deadlines, redacted diagnostics, exit codes 0/2/3/4.
10. `docs/backend-adapter.md` — configuration and observable-behavior documentation for the adapter surface and the runner.
11. PRD T04 checkboxes updated with evidence; `docs/research/adapter-fixtures.md` honest-gap items dispositioned as recorded below.

### Live evidence (opt-in runner only; config file consumed programmatically, never read or emitted)

- `KIWIFS_LIVE_TESTS=1 npm run test:live` — **clean-pass**, run id `0b7c88c743aa`: 71 tools advertised (matches `docs/test-environment.md`), no required tool missing, routing check ok, synthetic create/read-back/update/FTS (hit pending async indexing — disclosed)/delete + post-delete absence verified, cleanup zero leftovers. Auth note: connectivity evidence only, never auth/isolation proof.
- ETag carrier probe (synthetic path, deleted and verified after): live `kiwi_write` returns `Written <path> (ETag: <64-hex>)` in the **text result**; `kiwi_read` `_meta` is **empty** live. Adapter updated: not_modified ETag now falls back to parsing the text; read `_meta["kiwi.etag"]` remains a synthetic-fixture convention only (fixtures catalog gap dispositioned). The 16-hex `msg_id` truncation stays a [P] default for T16 live confirmation.

### Tests run (actual evidence)

- `npm run check` — **pass**: `tsc --noEmit` clean, prettier clean, `node --test` 75/75 (44 pre-existing + 31 new across `backend.test.ts`, `guard.test.ts`, `live-runner.test.ts`).
- `npm run pack:check` — **pass**: Package OK, 16 files (src only; fixtures and fake server are test-only and correctly excluded), packed extension loads in Pi RPC.
- `devenv test` — **pass** (8.58s, "Tests passed :)"): network `npm ci`, then check + pack:check green in the Nix sandbox.
- Node compatibility: devenv Node v24.19.0, engines >=22.19.0; only stable APIs used (`fetch`, `AbortController`/`AbortSignal`, `crypto.randomUUID`/`createHash`, streams) — no version-gated surface.
- No TUI behavior introduced; no manual TUI check required or performed.

### Blockers / follow-ups

- No blockers. Follow-ups: fixture 11 (Pi-side ordering/matched injection) remains T08/T12/T13-owned; 16-hex `msg_id` truncation default to confirm live in T16; guard redaction is a pluggable identity placeholder until the T06 privacy gate lands; live-runner suite extensions (semantic/hybrid legs, changes replay) are T19 scope; `kiwi.etag` read `_meta` fixture key documented as synthetic-only.
- `config/kiwifs-test.local.json` was never opened, printed or staged; the runner and probe consumed it programmatically and emitted only redacted diagnostics. No production space was contacted; no REST fallback used; no pushes, tags or deployments.

## T04 review fixes — transport deadline coverage and non-idempotent retry policy

Date: 2026-09-08 (session). Worker: commit_T04, model openrouter/z-ai/glm-5.3-flash per standing instruction.

Independent review verdict: implementation and gates verified, two blockers to fix before commit. Both fixed.

### Fixes

1. **Per-request deadline now covers the response body** (`src/backend/transport.ts`): the timeout `clearTimeout` moved from the fetch-leg `finally` to a single outer `finally` wrapping fetch + `readBounded`. An abort during the body read maps to the same typed `TimeoutError`/`CancelledError` as the fetch leg. New fake-server behavior `stallBodyAfterBytes` (headers then mid-body stall until abort) and test: `TimeoutError` within the 250 ms bound on a stalled body.
2. **Availability retry restricted to idempotent tools** (`src/backend/adapter.ts`): `IDEMPOTENT_TOOLS` allowlist (read/write/delete/search×3/brief/changes/query_meta/forget); `kiwi_append` — non-idempotent per `mcp-contracts.md` — is never retried; a transport fault after a committed append surfaces as an error, never a silent duplicate. Tests: append fault → exactly one call attempt, no partial content; changes fault → exactly two attempts (one successful replay). Reviewer minor also applied: JSON-RPC protocol errors now map to non-retryable `ResponseFormatError` (previously retryable `AvailabilityError`).

Remaining reviewer minors (searchHybrid `scope` forwarding, tombstone-cache doc/waste, loose `/not found/i` matching, brief section-boundary fragility, live-runner deadline-mid-suite test) recorded as follow-ups, not blockers.

### Tests run (actual evidence)

- `npm run check` — **pass**: `tsc --noEmit` clean, prettier clean, `node --test` 78/78 (75 prior + 3 new).
- `npm run pack:check` — **pass** (Package OK, packed extension loads in Pi RPC).
- `devenv test` — **pass** (8.84s, "Tests passed :)").
- Node compatibility unchanged: devenv Node v24.19.0 vs engines >=22.19.0; `ReadableStream` controller-error on abort is a stable API.

## T05 — Versioned records, provenance, idempotency and namespace isolation

Date: 2026-09-08 (session). Worker: implement_T05, model openrouter/z-ai/glm-5.3-flash per standing instruction. Dependencies T02 (docs), T03, T04: completed receipts verified before starting.

### Work done

1. `src/domain/records.ts` — versioned record schemas per architecture.md §2: `SCHEMA_VERSION = 1`; `RecordFrontmatter` (`schemaVersion`, `id`, `type observation|reflection|proposal|backup-chunk|board-message`, single-owner `scope` ∈ `project/{id}|personal`, `created` ISO-8601, `sources: SourceRef[]`, `model?`, `status active|superseded|pending-approval`); board-message routing fields (`to`/`from`/`channel`/`ttl`). `SourceRef {sessionId, branchId?, entryIds[]}` keeps the three distinct identity spaces (session / Pi branch / entry ids). Markdown wire format via `serializeStoredRecord`/`parseStoredRecord` (flat frontmatter, newline-bearing values rejected). Local artifacts (tombstone, processing cursor with `lastConsumedEntryId` coverage position, backup manifest with chunk checksums, redaction counts — never values — and omission list) parsed with the same fail-safe rule.
2. `src/domain/paths.ts` — strict untrusted-id grammar `^[a-z0-9][a-z0-9-]{0,63}$` (`validateId` → `PathEscapeError`, a `validation` `BackendError`); `validateProjectId` for git identities (rejects `..`/empty segments, uppercase, whitespace, backslash, percent-encoding); deterministic path builders (`memoryRecordPath` with `yyyy/mm` dirs, `backupManifestPath`, `backupChunkPath` `{seq:06d}`, `boardMessagePath`); containment predicates for guard step 4 (`pathWithinMemoryNamespace`, `pathWithinBoardChannel`, `pathWithinBackupTree` — prefix-boundary safe, `..` segments rejected).
3. `src/domain/idempotency.ts` — deterministic idempotency keys: SHA-256 (first 32 hex) over canonical JSON of `{kind, scope, channel?, sources}` (`canonicalJson` sorts object keys recursively, preserves array order — entry order is part of the work's identity). Forked sessions share entry history but mint a new sessionId → distinct keys; no content hash is ever used as identity (architecture.md §2). `deriveRecordId(kind, opId)` derives 16-hex record ids from persisted opIds, consistent with T04's `deriveMsgId` convention (test cross-checks both).
4. Migration policy (architecture.md §9): forward-compatible reader only — `schemaVersion > 1` → `future-version`, read-only, visible; malformed → typed `malformed`; the serializer refuses to write any non-current version, so no destructive rewrite path exists. The explicit one-way upgrade command stays a later-minor-version item.
5. Fixtures (synthetic data only): `test/fixtures/domain/records.json` (observation with branch provenance; board message), `malformed-cases.json` (9 fail-safe cases incl. future version, traversal id, cross-scope frontmatter), `local-artifacts.json` (valid tombstone/cursor/manifest + future-version cursor).
6. Tests: `test/domain.test.ts` — 26 new tests (round-trip, provenance distinctions, per-case malformed fail-safe, local artifact parse/round-trip, idempotency key determinism/forking/scoping, record-id derivation, grammar/escape rejections, path builders, containment checks).

### Tests run (actual evidence)

- `npm run check` — **pass**: `tsc --noEmit` clean, prettier clean, `node --test` 105/105 (78 prior + 26 new + 1 TZ-independence test added post-review).
- `npm run pack:check` — **pass**: Package OK, 19 files (src only; domain fixtures test-only and correctly excluded), packed extension loads in Pi RPC.
- `devenv test` — **pass** (8.86s, "Tests passed :)"): network `npm ci` (0 vulnerabilities), then check + pack:check green in the Nix sandbox.
- Node compatibility: devenv Node v24.19.0, engines >=22.19.0; only stable APIs (`node:crypto` `createHash`, `Date.parse`, JSON, `node:child_process` `execFile`) — no version-gated surface.
- No TUI behavior introduced; no manual TUI check required or performed.

### Post-review fixes applied

- **UTC month bucketing** (review finding 1, fixed in this commit): `memoryRecordPath` previously used local-time `getFullYear()/getMonth()`, making the deterministic path depend on the process timezone and breaking read-before-write idempotency across TZs. Switched to `getUTCFullYear()/getUTCMonth()`; new test spawns node under `TZ=UTC` and `TZ=Asia/Tokyo` with a month-boundary date (2026-08-31T15:30Z) and asserts identical `2026/08` bucketing.
- Review findings 3–5 accepted as-is: parsed frontmatter must never flow unvalidated into path construction (T15+ board repository obligation); duplicate-key last-line-wins and the loose 36-hex-shape UUID check are fail-safe in direction and remain unchanged.

### Blockers / follow-ups

- No blockers. Follow-ups: T06 supplies the real privacy gate (records here carry unredacted-at-rest content by design; redaction is enforced at outbound edges); T07 wires the durable outbox job shape (`{seq, schemaVersion, kind, scope, opId, idempotencyKey, payload, attempts, nextAttemptAt, createdAt}`) onto these schemas; backend record write paths (adapter writeImmutable callers) consume `memoryRecordPath`/`deriveRecordId` from T08 onward; explicit one-way schema-upgrade command deferred to a later minor version per architecture.md §9; T07 must either treat one-observation-per-source-set as an invariant or add a pass discriminator to the idempotency key (provenance-only keys collide across repeated extraction passes over the same entries — consistent with "no content hash as identity", arch §2).
- `config/kiwifs-test.local.json` was never opened, printed or staged. No live-service contact (T05 is local schemas only); no REST fallback; no pushes, tags or deployments.

## T06 — Privacy gate and sanitized audit events

Date: 2026-09-08 (session). Worker: implement_T06, model openrouter/z-ai/glm-5.3-flash per standing instruction. Dependencies T03, T05: completed receipts verified before starting (T03 → 92b1520, T05 → 3fc0b6d).

### Work done

1. `src/privacy/redaction.ts` — pattern-based secret redaction (architecture.md §5): default patterns for AWS access keys, `sk-` API keys, GitHub/Slack tokens, JWTs, bearer headers, PEM private-key blocks, credential-bearing URLs and `key = value` assignments; Shannon-entropy heuristic (default ≥ 4.0 bits/char, ≥ 20 chars) over uncovered token runs; structural replacement `[REDACTED:{type}:{length}]`; fail-closed holds for control-character content, non-string input and internal scanner faults (`ok:false, held:true` — callers must refuse to send). `createRedactor()` produces the guard-compatible `Redactor` (guard step 5; `identityRedactor` documented as a test-only no-op escape hatch, never a production default). `looksSecretBearing()` post-check helper.
2. `src/privacy/exclusions.ts` — exclusion rules with `project` (scope value), `pathPrefix` (whole-file path prefix) and `pattern` (content regex) dimensions (ANDed within a rule, rules ORed). Invalid regex or empty rule fails closed at compile time, never silently at capture.
3. `src/privacy/private-mode.ts` — `PrivateModeGate`: blocks all network reads/writes (`assertNetworkAllowed`) and new capture/backup/board jobs (`assertCaptureAllowed`) in all three feature domains; pending jobs held via `holdWhilePrivate`, never dropped (no drop-oldest); resume is explicit (`resume()`), releases exactly the held jobs to registered listeners (T07 outbox wiring point) and records visible transition events. Error messages carry only feature names/counts, never user content.
4. `src/privacy/audit.ts` — `AuditSink`: metadata-only by default (`{ts, kind, feature, scope, targetId, byteCounts, decision, degraded}`); snippets only at user-enabled `snippets` verbosity and only after redaction (unclassifiable snippet withheld); unknown fields stripped; every serialized line post-checked with `looksSecretBearing` and downgraded to an `audit-suppressed` stub if it still looks secret-bearing.
5. `src/config/schema.ts` — new `privacy.exclusions` config section (rules of `project`/`pathPrefix`/`pattern`, at least one required per rule, unknown keys rejected per T03 fail-closed rules); `src/config/status.ts` shows the exclusion count (non-secret).
6. Fixtures (synthetic only): `test/fixtures/privacy/secret-samples.json` (10 fake secret formats + benign controls), `redaction-cases.json` (9 cases incl. multi-secret and benign), `exclusion-cases.json` (9 cases incl. invalid-pattern fail-closed).
7. Tests: `test/privacy.test.ts` — 18 new tests: per-secret redaction, fixture cases, queue bytes free of secrets, audit metadata-only/snippet verbosity/unclassifiable withholding/suppression downgrade, private-mode suppression of all domains, explicit hold/resume release semantics, exclusion matrix, config validation + secret-free status, fail-closed NUL content through guard step 5, guard step 5 with the real redactor strips secrets from injected records, entropy threshold/min-length behavior, internal-fault hold.
8. `docs/privacy.md` — scanner limitations (best-effort heuristics, false positives/negatives, no redaction of already-stored data), backup fidelity implications (irreversible redaction; no byte-identical recovery claim; manifest redaction counts), fail-closed semantics, private-mode contract for T07, node-compat note.

### Tests run (actual evidence)

- `npm run check` — **pass**: `tsc --noEmit` clean, prettier clean, `node --test` 126/126 (105 prior + 21 new incl. review regressions).
- `npm run pack:check` — **pass**: Package OK, 22 files (src only; privacy fixtures test-only and correctly excluded), packed extension loads in Pi RPC.
- `devenv test` — **pass** (9.94s, "Tests passed :)"): network `npm ci`, then check + pack:check green in the Nix sandbox.
- Node compatibility: devenv Node v24.19.0, engines >=22.19.0; stable APIs only (`RegExp`, `JSON`, `Map`, `Date.prototype.toISOString`) — no version-gated surface.
- No TUI behavior introduced; no manual TUI check required or performed. No live-service contact (T06 is a local gate); no REST fallback; no pushes, tags or deployments.

### Acceptance coverage (PRD T06)

- Synthetic secret fixtures never in outbound payloads/queue bytes/logs/errors: redaction tests + `assertSecretFree` over every fixture secret against redactor output, queue-byte JSON, audit lines and private-mode error messages.
- Private mode suppresses network reads/writes and new capture/backup/board jobs: `PrivateModeGate` domain tests.
- Enabling private mode prevents pending jobs from sending; resume matches approved policy (§13 row 21: held, explicit resume, no drop-oldest): hold/resume release tests + visible transition events.
- Exclusion rules cover project, path and content patterns: exclusion fixture matrix + config validation tests.
- Documentation states scanner limitations and backup fidelity implications: `docs/privacy.md`.

### Blockers / follow-ups

- No blockers. Follow-ups: T07 wires `PrivateModeGate` + `AuditSink` into the durable outbox worker (`assertNetworkAllowed` before every send; `holdWhilePrivate` for accepted work; resume releases held jobs); T09/T10 wire `createRedactor()` into observation capture edges; T14/T15 wire redaction + redaction-count manifests into backup chunks; exclusion-rule application at capture points lands with the owning capture features (T09/T14/T16), not in this gate module.
- `config/kiwifs-test.local.json` was never opened, printed or staged. No secrets or real session/memory content entered context, logs or Git; all fixtures are synthetic.

### Review fixes (T06 independent review, B1/B2 + follow-up comments)

- **B1** (`src/backend/guard.ts`): `deps.redact` now defaults to `createRedactor()` (real T06 rules) instead of the fail-open `identityRedactor`; `identityRedactor` remains exported and documented as a test-only explicit opt-out. Regression test added: a `guardCandidate` call with no `deps.redact` strips a synthetic secret and emits `[REDACTED:...]`.
- **B2** (`src/privacy/redaction.ts`): `looksSecretBearing` no longer flags bare 32+ char runs; long runs additionally require Shannon entropy ≥ 4.0, so UUID `targetId`s no longer trigger `audit-suppressed` false positives while opaque high-entropy tokens are still caught. Regression tests: an audit event with a UUID `targetId` records normally; a synthetic high-entropy token is still flagged.
- Follow-up comment fix (F1): corrected the contradictory comments in `src/privacy/exclusions.ts` (dimensions are ANDed within a rule; a `continue` skips the entire rule, not just one dimension).
- Follow-up doc (F2): `docs/privacy.md` now states the hard T07 requirement that a resume listener be registered before the private-mode gate is ever enabled, since `resume()` delivers held references only to registered listeners.
- Re-run after fixes: `npm run check` pass (126/126), `npm run pack:check` pass, `devenv test` re-run — see below.

## T07 — Durable outbox and recovery

Date: 2026-09-08 (session). Worker: implement_T07, model openrouter/z-ai/glm-5.3-flash per standing instruction. Dependencies T04, T05, T06: completed receipts verified before starting (T04 → 2a43811, T05 → 3fc0b6d, T06 → c4c187d).

### What landed

1. `src/outbox/store.ts` — `DurableOutbox`: JSONL journal (one job per line, shape `{seq, schemaVersion, kind, scope, opId, idempotencyKey, payload, attempts, nextAttemptAt, createdAt, status}` per architecture.md §2) with lock file (stale-holder breakage after 30 s), 0700 dir / 0600 files enforced fail-closed on open, atomic persist (temp → fsync → rename) so enqueue returns only after durability — the minted opId is on disk BEFORE any side effect (§2; the store itself provides the durable `OpIdLedger`). Overflow: 5,000 jobs / 50 MiB high-water limits pause new capture with a visible `capturePaused` flag; pending jobs are never dropped (no drop-oldest, §13 row 8); 14-day retention applies only to acked jobs. Payloads screened with `looksSecretBearing` before touching queue bytes (T06 defense in depth). Unknown newer `schemaVersion` → read-only fail-safe mode with a visible reason, journal never rewritten (§9). Test hook `persistFault` simulates disk-full.
2. `src/outbox/worker.ts` — `OutboxWorker`: strict per-scope ordered delivery (lowest-seq pending job is the scope head; a later job never overtakes a head in backoff), capped exponential backoff with jitter (min(cap, base·2^n)·(1+jitter)), permanent failures (non-retryable codes or exhausted attempts) quarantined with name:code-only error fingerprints (never messages — no user content in queue bytes); quarantined jobs inspectable via `store.quarantined()`, removed only by explicit `discardQuarantined`. Private mode wired per docs/privacy.md: the gate's release listener is registered at construction (BEFORE any enable), `isPrivate` holds sends and `assertNetworkAllowed` is re-checked before every send; held jobs preserved. `tick()` never throws — failed jobs never block Pi interaction. Crash-window handling: remote success before local ack leaves the job pending (never quarantined, never a false completeness claim); replay no-ops against the backend.
3. `src/outbox/cursor.ts` — `CursorFile` (durable `{localSeq, backendLastSeq?, lastCommitHash?, reconcileNeeded?}`, atomic persist incl. directory fsync, newer-version fail-safe that RETAINS the parsed authoritative cursor instead of resetting `localSeq` to 0) and `reconcile()`: bounded pass ≤20 pages / 10,000 changes (§13 row 14); local state authoritative, advisory backend cursor adopted only on continuous feed, regression AND gap drift flagged via `reconcileNeeded` and never adopted blindly; bound reached → visible paused state that resumes next cycle.
4. `test/outbox.test.ts` — 24 tests covering the full T07 crash matrix and acceptance list (details below).

### Tests run (actual evidence)

- `npm run check` — **pass**: `tsc --noEmit` clean, prettier clean, `node --test` 150/150 (126 prior + 24 new).
- `npm run pack:check` — **pass**: Package OK, packed extension loads in Pi RPC and reports scaffold status.
- `devenv test` — **pass** (10.8s, "Tests passed :)"): npm ci + check + pack:check green in the Nix sandbox.
- Node compatibility: devenv Node v24.19.0, engines >=22.19.0; stable APIs only (`node:fs` sync primitives, `node:crypto`, `node:path`) — no version-gated surface. No TUI behavior introduced; no manual TUI check required or performed.

### Acceptance coverage (PRD T07)

- Crash tests (before persistence / after persistence / remote success before local ack): three dedicated tests — enqueue persist fault leaves nothing durable (torn tmp ignored on reload); reopen sees and delivers the persisted pending job; forced ack-persist failure after remote success replays with zero backend duplicates.
- Replays do not duplicate (B2 deterministic-path idempotency): identical replay no-ops; same-path different-content conflict fails closed, quarantines, never overwrites.
- Offline startup from local cursors only: reopen + local `CursorFile.localSeq` delivers pending work with no backend contact; reconciliation adopts the advisory cursor only on continuity, flags regression and gap drift, never trusts it blindly; bound → visible pause.
- Transient retry / permanent quarantine: availability → backoff 100 ms → 200 ms, deterministic jitter bounds, attempts exhausted → quarantine; quarantined jobs never re-sent; validation fault quarantines immediately.
- Overflow/disk-full: maxJobs limit pauses capture with visible gap, pending preserved (no drop-oldest); retention frees capacity only after the acked window; disk-full during enqueue/ack leaves pending jobs and cursors intact, no false completeness.
- Permissions/multi-process: 0644 journal fails closed; second opener blocked by lock; lock released on close.
- Failed jobs never block Pi: `tick()` never throws, including non-Error sender faults AND persist faults while recording retry/quarantine state.

### Blockers / follow-ups

- No blockers. Follow-ups: T08+ feature code (observation/backup/board) must enqueue through this outbox with redacted payloads and a deterministic idempotency key — the T05 review's pass-discriminator note still applies to provenance-only keys across repeated extraction passes; `kiwi_changes` reconciliation is wired against a fake page provider here — T19 extends it to the live feed; T09 extraction jobs persist opId/source entries here before the model call; a timer/interval driving periodic `tick()` and post-resume delivery lands with T08 hook wiring (the worker currently ticks on demand and on gate resume) and must also schedule `runRetention()`, which is pull-only — capacity is freed only when it is called. A permission check for a pre-existing over-permissive `cursors.json` / outbox directory (currently only the journal file is checked) remains open.
- `config/kiwifs-test.local.json` was never opened, printed or staged. No live-service contact, no REST fallback, no pushes, tags or deployments.

## T08 — Pi session coordinator

Date: 2026-09-08 (session). Worker: implement_T08, model openrouter/z-ai/glm-5.3-flash per standing instruction. Dependencies T03 (9e1502b), T05 (3fc0b6d), T07 (100a01e): completed receipts verified before starting.

### What landed

1. `src/pi/coordinator.ts` — `SessionCoordinator` per architecture.md §3.3: monotonic generation tokens minted and durably persisted BEFORE publish (tmp → fsync → rename → dir fsync, same pattern as `CursorFile`); `applyIfCurrent` discards delayed results carrying stale generations (never applied to context or cursors); `registerWork`/`runExclusive` bind in-flight work to a generation with abort signals, invalidated on `session_before_switch`/`session_tree`/`session_shutdown`; durable consumed-entry registry shared across forks so shared ancestors are never re-captured (`session_before_tree` stashes `preparation.entriesToSummarize`, `session_tree` commits them post-navigation — see review amendment); idempotent, reentrant `session_shutdown` (timer stop + work abort + flush; triple delivery no-op); duplicate `session_start` for the live session and duplicate `session_tree` deliveries of the identical `(oldLeafId, newLeafId)` pair do not re-mint; corrupt state file fails safe (fresh counter — `applyIfCurrent` equality check still rejects any pre-restart generation); newer `schemaVersion` → `StateSchemaError` fail-closed with visible status, never rewritten.
2. `src/index.ts` — `registerSessionHandlers` wires all six verified Pi 0.85.0 boundaries (`session_start`, `session_before_fork`, `session_before_switch`, `session_before_tree`, `session_tree`, `session_shutdown`); handlers read only `ctx.sessionManager` accessors and `ctx.cwd` — headless/RPC safe, no TUI APIs. Coordinator init failure disables lifecycle tracking visibly via status output (`session coordinator: DISABLED — …`), never crashes extension startup. State dir convention: `KIWIFS_MEMORY_STATE_DIR` env override else project-local `<cwd>/.kiwifs/memory/` (provisional; final discovery convention is the documented T18 UX follow-up).
3. Periodic tick + retention (T07 follow-up closed): `SessionCoordinator` owns an interval (default 30 s) started at `session_start`, stopped at `session_shutdown`; every Nth tick (default 10) also invokes the pull-only `runRetention()`. Tick/retention callbacks are injected; the outbox worker and retention are connected when T09 lands feature wiring (the coordinator is constructed without callbacks in `src/index.ts` today, so no timer runs until a pipeline registers work — noted below).
4. `test/pi-coordinator.test.ts` — 9 tests: full lifecycle sequence (startup/new/resume/fork/tree/reload/shutdown with Pi's documented event order), stale-generation rejection (cursor callback never fires for the pre-fork generation), shared-ancestor no-recapture across fork AND process restart, duplicate delivery + repeated teardown harmlessness, stale-work cancellation (`token.aborted`, `runExclusive` fail-fast, shutdown aborts in-flight work), `before_tree` stash/commit lifecycle incl. already-aborted signal (see review amendment), headless safety with a throwing `ctx.ui` getter, newer-schema fail-closed + visible DISABLED status, timer tick/retention between start and shutdown.

### Review amendment (post-review, pre-commit)

Reviewer verdict: changes requested (2 blockers). Both fixed, plus the two missing tests; remaining review items recorded as follow-ups.

1. **B-1 — navigate-back-to-recorded-leaf now re-mints.** `session_tree` dedup moved from `newLeafId` alone to the `(oldLeafId, newLeafId)` pair: Pi appends messages without emitting `session_tree`, so `branchId` (the leaf at last mint) can be legitimately re-visited later; dedup on the leaf alone silently skipped the re-mint and `invalidateWork`, letting the pre-navigation pack/cursor result pass `applyIfCurrent` on the wrong branch. Duplicate deliveries replay the identical pair and are still skipped. Test added: navigate back to the start leaf after appends discards the late result (cursor callback never fires).
2. **B-2 — `before_tree` no longer marks consumed durably.** It is a cancellable hook (`SessionBeforeTreeResult.cancel`), so durable consumption there could strand entries in the live branch permanently if navigation is cancelled — an invisible coverage gap. The handler now stashes pending IDs; `session_tree` commits them post-navigation (commit-once dedup via `markConsumed`); shutdown or a never-firing tree drops the stash so entries stay unconsumed and recapturable. **Deliberate deviation from architecture §3.3's "marked consumed at session_before_tree" wording — the code follows the cancellation-safe reading.** Test added: cancelled/absent `session_tree` leaves entries unconsumed and recapturable later.

Reviewer follow-ups (non-blocking, left for later tasks): cross-life generation collision after corrupt-state reset (seed counter from time/random base on reset); `runExclusive` is fail-fast, not a mutex (T09 must not read exclusivity into the name); unbounded `consumedEntries` growth (retention with T09/T18); timer not `unref()`ed; `setCoordinatorErrorProbe` test hook exported from production `src/index.ts`.

### Tests run (actual evidence)

- `npm run check` — **pass** (after review amendment): `tsc --noEmit` clean, prettier clean, `node --test` 160/160 (150 prior + 9 + 2 new amendment tests, one reworked for the stash/commit split).
- `npm run pack:check` — **pass**: Package OK; packed extension loads in Pi RPC and reports scaffold status.
- `devenv test` — **pass** (12.1s, "Tests passed :)"): npm ci + check + pack:check green in the Nix sandbox (network npm ci is authorized normal testing, not a reason to skip).
- Node compatibility: devenv Node v24.19.0, engines >=22.19.0; stable APIs only (`node:fs` sync primitives, `node:path`, `setInterval`, `AbortController`) — no version-gated surface. No TUI behavior introduced; no manual TUI check required or performed (headless safety is proven by the throwing-`ui` test).
- No live-service contact (T08 is local lifecycle only); no REST fallback; no deployments, pushes, tags.

### Acceptance coverage (PRD T08)

All five criteria trace to concrete tests in `test/pi-coordinator.test.ts` as itemized above; PRD checkboxes marked with inline traceability notes.

### Blockers / follow-ups

- No blockers. Follow-ups: T09 passes the real outbox tick + retention callbacks into the coordinator (timer currently dormant without them); T09 consumes `markConsumed`/`isConsumed` as its source-coverage registry and feeds `preparation.entriesToSummarize` (T08 handles the shape it was given); state-dir location convention finalized in T18 (loader discovery + scope resolver's real `git remote -v` consumption); T12/T13 own fixture 11 (Pi-side matched injection) as previously recorded.
- `config/kiwifs-test.local.json` was never opened, printed or staged.

## T09 — Incremental observer scheduling (2026-09-08)

Status: implemented, independent review passed (no blockers), all gates green, committed.

### Independent review outcome (pre-commit)

Reviewer verdict: correct and complete per all six acceptance criteria; no blockers — no correctness, security, privacy, lifecycle, concurrency or package defect at blocker level. Reviewer re-ran `node --test test/observation.test.ts` locally: 16/16 pass. Non-blocking findings disposition:

- Fixed in this task (trivial, actionable now):
  - Stale comment fix (`src/observation/scheduler.ts`): `PendingBatchRecord.sources` doc claimed "entry views captured at batch creation (redaction re-applied at run)" but the record stores only entry IDs; comment now states views/redaction are re-derived from the provider at run.
  - Abort-listener leak fix (`src/observation/scheduler.ts`): `onBeforeCompact` now removes the `abort` listener in the `finally` block so a shared signal does not accumulate one listener per compaction.
- Deferred as already-planned follow-ups (reviewer concurred): sessionId refresh limited to `session_start` + `branchId` not passed into the idempotency key (T10); per-batch extraction retry cooldown on `agent_settled` (T10); oversized-first-entry soft budget (T13 enforced cap); unbounded `consumedEntries`/pending registries (T18).
- Re-run after fixes: `npm run check` pass (176/176), `npm run pack:check` pass, `devenv test` pass.

### What landed

1. `src/observation/scheduler.ts` (new) — `ObserverScheduler` per architecture.md §3.2 / decisions.md #6:
   - Selection: unprocessed entries = message text present, not in the coordinator's durable consumed registry, not in a pending batch, not extension-internal (`toSourceViews` skips Pi `custom_message`/`custom` entries — in particular every `kiwifs.`-prefixed one — and non-user/assistant messages), not excluded by compiled exclusion rules (scope + pattern dimensions; pathPrefix rules can never fire on source entries).
   - Batching ([P] §13 defaults): ≥2,000 tokens or ≥10 turns or 5-min idle, whichever first; budgets 6,000/3,000 tokens; pending-batch queue caps at 20 — excess MERGES into the oldest pending range (never dropped, never silently dropped). `estimateTokens` is a disclosed ~4-chars/token approximation — the model-compatible tokenizer (with framing) is a hard requirement only for the T13 enforced injection cap, not for these scheduling thresholds.
   - Durability: each batch is persisted to `observer-state.json` (tmp → fsync → rename → dir fsync, same pattern as the coordinator/cursor) with `opId` + entry IDs + batch parameters BEFORE the model call; the extraction result is enqueued as a durable outbox job (`kind: "observation"`, deterministic idempotency key over `{sessionId, branchId?, entryIds}`) BEFORE `markConsumed` — the cursor advances only on durable outbox acceptance. Crash re-derivation re-runs pending batches under their ORIGINAL opIds; corrupt/newer-schema state files fail safe (empty pending — worst case is an idempotent re-extraction, never a loss or duplicate).
   - Generation safety: the result is applied only if `coordinator.isCurrent(gen)`; stale results leave the batch pending on the new generation for re-derivation.
   - Pre-compaction flush: one attempt bounded by a 5 s self-timeout AND the event signal; never returns `cancel` (index.ts handler always returns `{}`); on timeout/abort the batch stays durably pending with visible status.
   - Privacy: the real `createRedactor()` (T06) guards the model-call edge; a redaction failure holds the batch (fail closed); enqueue re-screens queue bytes.
2. `src/index.ts` — `buildSessionRuntime`: lazily at first `session_start` opens the durable outbox (`<stateDir>/outbox`), builds the `OutboxWorker` with a retryable `SenderNotWiredError` stub sender (uncapped attempts — an availability gap, replaced by T10's real sender; jobs stay pending, never quarantined/dropped), and passes REAL `onTick`/`onRetention` callbacks into the coordinator, closing the T08 dormant-timer follow-up. New hooks: `agent_settled` → `onAgentSettled()`, `session_before_compact` → bounded flush that never cancels compaction. Observer/outbox init failures are visible in status (`observer: DISABLED — …`), never crash startup. T08's headless test now drives the full runtime (outbox + observer included) through all lifecycle events with a throwing `ctx.ui`.
3. `test/observation.test.ts` (new) — 16 tests covering all six acceptance criteria (traceability notes inline in the PRD) plus queue-cap merge, idle batching, input-budget capping, stale generation, manual extraction, and redaction-before-model.

### Tests run (actual evidence)

- `npm run check` — **pass**: `tsc --noEmit` clean, prettier clean, `node --test` 176/176 (160 prior + 16 new).
- `npm run pack:check` — **pass**: Package OK, 28 files; packed extension loads in Pi RPC.
- `devenv test` — **pass** (10.0s, "Tests passed :)"): npm ci + check + pack:check green in the Nix sandbox.
- Node compatibility: devenv Node v24.19.0 vs engines >=22.19.0; stable APIs only (`node:fs` sync, `node:crypto.randomUUID`, `setTimeout.unref`). No TUI behavior introduced; headless safety preserved (no new TUI access; T08's throwing-`ui` test still green over the full runtime).
- Staged-diff secret scan (pre-commit): synthetic test strings only; `config/kiwifs-test.local.json` never opened or staged; no live-service contact (all scheduler tests are local fakes); no REST fallback; no pushes/tags/deployments.

### Blockers / follow-ups

- No blockers. Follow-ups:
  - T10: replace the `SenderNotWiredError` stub with the real model-observation sender; wire config-driven scope/model/exclusion plumbing into `buildSessionRuntime` (scope is the provisional `"local"` and sessionId is refreshed at `session_start` only).
  - T13: enforced evidence cap requires a model-compatible tokenizer incl. framing; `estimateTokens` here is scheduling-only and disclosed as approximate; visible skip of automatic injection if unavailable stays T13's obligation.
  - T18: manual `/kiwifs-extract` command wiring to `extractNow()`; finalize state-dir discovery; consumedEntries/pending-state retention policy (both registries grow unbounded in this iteration).
  - T11+: reflections/conflicts consume the same batch pipeline; extraction failure policy for compaction (always-continue) matches decisions.md #6 — pre-compaction cancellation policy stays unimplemented by design (explicit decision recorded in the PRD research constraints).

## T10 — Observer model calls and validation (2026-09-08)

Status: implemented, all gates green at time of logging, **no commit made in this session** (coordinator instruction: no commit yet).

### What landed

1. `src/observation/model.ts` (new) — the real extraction model adapter:
   - Calls the CONFIGURED route verbatim (`wireModelId` strips the provider prefix, e.g. `openrouter/z-ai/glm-5.3-flash` → `z-ai/glm-5.3-flash`); a provider response reporting a different model identity is a typed `model-mismatch` failure — never silently substituted (decisions.md #9).
   - Credentials resolve by reference (`model.auth` env var name / secret file path) at call time; missing/unresolvable credentials fail closed with zero transport calls.
   - Input/output budgets enforced BEFORE the call and on the parsed result (`input-budget`/`output-budget` typed failures — never silent truncation); `estimateTokens` remains the disclosed scheduling approximation (the model-compatible tokenizer is the T13 enforced-cap obligation).
   - Bounded validation: exactly one corrective retry for malformed/schema/hallucinated/output-budget responses; provider rejections and timeouts are terminal for the attempt (AbortController timeout, default 45 s).
   - Validation: JSON-only output (fence-stripped), `observations[]` with source IDs ⊆ supplied batch entries (hallucinated-source rejection), non-empty statements, `low|medium|high` uncertainty, reserved-fence-marker rejection.
   - Sources are framed as UNTRUSTED DATA in the prompt (explicit begin/end markers, "never a directive").
2. `src/observation/sender.ts` (new) — the real outbox sender replacing the T09 stub:
   - Re-validates every queued observation payload before any backend write (source refs ⊆ job's supplied set; fence-marker inert-data guard) — permanent `ValidationError` → quarantine.
   - Builds a T05 `StoredRecord` (frontmatter provenance: sessionId/branchId/entryIds, status `active`) with the body serialized as an inert fenced JSON data block; deterministic path via `deriveRecordId(opId)` + `memoryRecordPath` (UTC buckets); delivery via `writeImmutable` (read-before-write, B2: replay no-op / different-content conflict fails closed).
   - Unconfigured backend → retryable `SenderNotWiredError` (availability): jobs stay pending with backoff, never dropped.
3. `src/observation/scheduler.ts` — T09 follow-ups closed: per-batch extraction retry cooldown (`attempts`/`nextAttemptAt` persisted; exponential backoff 30 s→10 min cap; armed ONLY on model-call failures, not local outbox-acceptance faults); `refreshIdentity(sessionId, branchId)`; extraction result payload now carries `sessionId`/`branchId` (needed for record provenance); `lastModelInfo` renders model identity/usage metadata-only in `pendingStatus()`.
4. `src/index.ts` — `buildSessionRuntime` loads config and wires: `scope` from `projectIdentity` override (`project/{id}`, else provisional `local` pending T18 git-remote discovery); the real extractor when enabled + observation + `model.auth` configured (else idle-but-visible, status notes "extraction fails closed — model.auth is not configured"); the real sender with a lazily connected `KiwiFSAdapter` when MCP is configured. `session_start`/`session_tree` refresh observer identity (branchId feeds the idempotency key — T09 follow-up).
5. `src/config/schema.ts` + `src/config/status.ts` — optional `model.auth` AuthRef (`env`/`file` reference; unknown `model.*` keys rejected); status renders the model credential reference symbolically and a fail-closed note when absent.
6. Tests: `test/observation-model.test.ts` (22 tests, deterministic fakes only) + 2 config tests (model.auth acceptance/unknown-key rejection; status rendering).

### Tests run (actual evidence)

- `npm run check` — **pass**: `tsc --noEmit` clean, prettier clean, `node --test` 200/200 (176 prior + 22 T10 + 2 config).
- `npm run pack:check` — **pass**: Package OK; packed extension loads in Pi RPC and reports scaffold status.
- `devenv test` — **pass** (10.7 s, "Tests passed :)"): npm ci + check + pack:check green in the Nix sandbox.
- Node compatibility: devenv Node v24.19.0 vs engines >=22.19.0; stable APIs only (`node:fs`, `node:crypto`, `fetch`, `AbortController`, `setTimeout.unref`).
- No live model calls: every model interaction in tests goes through deterministic fake transports; no paid calls were made.
- Secret scan of the changed files: synthetic fixtures only (e.g. `FAKE_KEY_VAR=test-key-not-real`); `config/kiwifs-test.local.json` never opened, printed or staged. No live-service contact (all tests local), no REST fallback, no deployments/pushes/tags.

### Acceptance coverage (PRD T10)

All five criteria trace to named tests in `test/observation-model.test.ts` (traceability notes inline in the PRD).

### Blockers / follow-ups

- No blockers. Follow-ups:
  - T11: reflections/conflicts consume the same batch pipeline and validated-extraction shape.
  - T12/T13: enforced injection cap needs a model-compatible tokenizer incl. framing (`estimateTokens` here is scheduling-only); automatic injection skipped visibly if unavailable.
  - T18: manual `/kiwifs-extract` wiring to `extractNow()`; state-dir + git-remote discovery convention (scope is `projectIdentity`-override-or-`local` today).
  - Open hardening (non-blocking): the default OpenRouter transport is unexercised by tests (by design — no paid calls); its live behavior (response shape drift) should be validated once against the opt-in live runner (T19) before enabling extraction against a real key.

## T10 review hardening (post independent review)

The independent T10 review found three real defects in the send/record path that fake-backend tests structurally cannot catch. All three fixed in this task; no commit was made before the fixes.

### B1 — mcp.auth required then discarded (real sender could never authenticate)

`openConfiguredBackend` now resolves `mcp.auth` to `{ Authorization: Bearer <secret> }` headers at `KiwiFSAdapter` construction — the same wiring as the live runner (`src/backend/live/runner.ts`), since the transport authenticates exclusively via `AdapterOptions.headers`. An unresolvable credential fails closed to the retryable `SenderNotWiredError` hold (never an unauthenticated send), with a visible fail-closed status line. The secret value is resolved per attempt by reference and is never logged or stored.

### B2 — wall-clock `created` broke replay determinism

`buildObservationRecord` no longer reads the wall clock: `created` derives from the job's durably persisted outbox `createdAt` (epoch ms), validated as finite/non-negative. Replay of the same opId now reproduces byte-identical content AND the same UTC path (T07 crash-window "remote success before local ack" is a true no-op). New test: crash-replay determinism (identical content+path; different persisted enqueue time in another month → different path).

### B3 — default configuration systematically quarantined every observation

`resolveRecordScope` returns `undefined` when no `projectIdentity` is configured (the provisional `local` value is not a writable owner scope and could only be permanently quarantined at send time — guaranteed paid-extraction data loss). Now: observation and extraction are held entirely with a visible status note ("record scope not yet resolved … T18 git-remote discovery"); any already-queued job is held by the sender as a retryable `SenderNotWiredError` availability gap — pending with backoff, never quarantined, never dropped.

### Review follow-ups also addressed in this task

- Model-mismatch check anchored: `reportedModelMatches` (exact, or wire id + one separator + bounded `[a-z0-9._-]{1,32}` suffix); a string merely containing the wire id is rejected. Tested.
- Sender payload re-validation now also rejects invalid `uncertainty` labels before any backend write. Tested.

### Checks after fixes (actual outcomes)

- `npm run check` — **pass**: tsc clean, prettier clean, node --test 204/204 (200 prior + 4 new: replay determinism, unresolved-scope hold, uncertainty validation, anchored model match).
- `npm run pack:check` — **pass**: Package OK; packed extension loads in Pi RPC.
- `devenv test` — **pass** (9.9 s, "Tests passed :)").
- Node v24.19.0 (devenv) vs engines >=22.19.0; stable APIs only.
- Secret scan of the incremental diff: clean (synthetic fixtures only); `config/kiwifs-test.local.json` never opened; no live-service contact, no REST fallback, no pushes/tags/deployments.

## T11 — Reflections, conflicts and merge proposals (2026-09-08)

Implemented on the T10 pipeline. Design and [P] defaults recorded in `docs/memory-lifecycle.md` (new).

### What landed

1. `src/observation/reflection.ts` (new) — the reflection engine + payload/sender layer:
   - Bounded reflection over durably accepted observation records (record-granular: proposals supersede whole records, never statements inside a record's immutable data block).
   - Duplicate/contradiction detection via the configured model (`createModelReflector`: same wire conventions as the T10 extractor — configured route verbatim, anchored `reportedModelMatches`, budget checks, untrusted-data framing, deterministic-fake tests only). One corrective strategy differs by design: no validation retry inside the call — the engine's durable cooldown governs re-derivation under the same setHash/startedAt.
   - Duplicate suppression (AC 1): reflection identity = SHA-256 over the sorted record-id set; proposal identity = SHA-256 over the sorted target-record-id set. Deterministic paths make re-delivery a `writeImmutable` replay no-op; the durable processed-set registry + seen-record dedupe bound re-runs. FIFO-pruned registries are bounded, not magical (wording corrected per review): proposals replay as no-ops; a fully re-notified set whose hash is still in the processed registry is dropped without re-summarizing; a re-notified SUBSET re-derived under a fresh startedAt can duplicate a reflection summary record — bounded, additive only, never data loss.
   - Replay determinism: the run's `startedAt` persists in engine state BEFORE the model call and flows into record `created`/path (T10-B2 pattern).
   - Failure containment (AC 5): full pre-validation of the model result BEFORE any enqueue (hallucinated duplicate groups can never produce partial acceptance); any failure leaves the outbox and observation records untouched; per-set attempt cap parks sets VISIBLY (`skippedSets` + `pendingStatus`), never silently; oversized sets split in half and retry (progress guarantee, nothing dropped).
   - Payload hygiene: queued reflection/proposal payloads carry metadata only (recordId + persisted createdAt; paths computed at delivery). Long path strings in payloads would trip the outbox `looksSecretBearing` post-check (correctly — they are opaque high-entropy runs); redacted statements stay in the private engine state file (0700), mirroring the T09 pending-batch precedent.
2. `src/observation/proposals.ts` (new) — approve/reject/undo lifecycle:
   - Verified transitions: fresh pre-state read (status + "superseded by THIS proposal" provenance check) → write → post-write read-back verification; divergence surfaces as typed `StaleProposalError` and the concurrent actor's decision survives. B2-conformant: verify-then-act + detection, NO CAS claim (no If-Match on the MCP surface). Local ops serialized on an internal chain (single-flight).
   - Stale approvals fail visibly with the observed status named; crash-interrupted approvals complete idempotently on re-run; duplicate reject/undo replay as no-ops.
   - Undo restores logical visibility (targets back to `active`) and appends provenance; nothing deleted. Every transition appends `kiwifs-provenance:` lines (actor/time/opId/reason).
   - Durable opIds: append-only fsynced `proposal-oplog.jsonl` records each op BEFORE the side effect; doubles as the T04 ledger for interactive writes; fails closed on corruption.
3. `src/observation/scheduler.ts` — `onAcceptedObservations` hook fired only AFTER durable outbox acceptance (hook failures contained to a visible status note; the batch is already accepted/consumed). Emits recordId + deterministic recordPath + the job's persisted `createdAt`.
4. `src/observation/sender.ts` — sender dispatches by job kind (observation/reflection/proposal); unresolved scope holds ALL record kinds (no partial delivery with divergent lifecycle state).
5. `src/index.ts` — engine + lifecycle built at session runtime (scope resolved + observation feature); `createModelReflector` wired with the configured route/auth; lifecycle gets its own lazily-connected adapter instance and op-log-backed ledger (interactive opIds are unknown to the outbox ledger).
6. `src/domain/idempotency.ts` — optional `tokens` in `IdempotencyInput` (reflection: [setHash]; proposal: [setHash, ...sortedTargets]) — one logical job per token set.
7. `src/observation/model.ts` — the inline OpenRouter transport extracted as exported `openRouterModelTransport` (shared by extractor and reflector; behavior unchanged, still never exercised by tests).

### Tests (deterministic fakes only; no paid calls)

- `test/reflection.test.ts` (15): AC 1 duplicate-batch bounding (same set → one summary; same duplicate pair across sets → one proposal identity); AC 2 conflict labels with record ids + bounded labels in the reflection record's inert data block; AC 5 failure containment (model fault → zero jobs + byte-identical outbox; hallucinated ids → nothing enqueued; input-budget splitting never drops records); cooldown re-derivation under the SAME setHash/startedAt; engine state restart; `validateReflectionResult` bounds (output-budget, reserved markers, label length); untrusted-data framing; anchored model-identity + credentials fail-closed (transport provably not called); sender payload validation + deterministic writeImmutable delivery (replay = identical bytes at the same path).
- `test/proposal.test.ts` (14): approve happy path with provenance + read-back verification; decided-proposal stale approval fails visibly naming the status; concurrent write race detected with the other actor's decision surviving; corrupted-write detection; crash-interrupted approval idempotent replay; partial-approval visible failure (1/2 superseded); reject untouched targets + duplicate-reject replay; undo restores visibility + full provenance history (supersession AND restore lines coexist, proposal never deleted); undo refuses foreign supersessions and non-approved proposals; duplicate undo replay; op log durability (reloaded ledger); single-flight serialization; `readProposalTargets` shape validation.

### Checks (actual outcomes)

- `npm run check` — **pass**: tsc clean, prettier clean, node --test 233/233 (204 prior + 15 reflection + 14 proposal).
- `npm run pack:check` — **pass**: Package OK (32 files), packed extension loads in Pi RPC.
- `devenv test` — **pass** (11.0 s, "Tests passed :)"): npm ci + check + pack:check green in the Nix sandbox.
- Node compatibility: devenv Node v24.19.0 vs engines >=22.19.0; stable APIs only (adds nothing exotic: `node:fs` appendFileSync/openSync/fsyncSync, `node:crypto` sha256/randomUUID).
- Secret scan of the changed files: synthetic fixtures only (e.g. `KIWIFS_TEST_REFLECT_KEY=test-key-not-real`); `config/kiwifs-test.local.json` never opened, printed or staged. No live-service contact (all tests local fakes), no REST fallback, no deployments/pushes/tags.
- Design note: the outbox `looksSecretBearing` post-check caught a real hazard during development — record paths in queued payloads are opaque ≥32-char high-entropy runs. Resolution: metadata-only payloads (recordId + createdAt), paths computed at delivery. The check worked as designed.

### Acceptance coverage (PRD T11)

All five criteria trace to named tests (traceability notes inline in the PRD checkboxes).

### Post-review fixes (T11 review round, same commit)

Independent review found no blockers; two hygiene items + two claim overstatements fixed before commit:

1. Removed a leftover `console.error("ENQ-DBG", …)` debug line from `ReflectionEngine.acceptResult`'s catch (the surrounding code already surfaces `lastError`).
2. `src/domain/idempotency.ts` `tokens` doc comment no longer claims outbox-level dedupe — `DurableOutbox.enqueue` never deduped by key (it format-checks only); the one-logical-job guarantee lives in the engine's processed-set registry + seen-record dedupe and the deterministic-path `writeImmutable` replay.
3. New `already-processed` guard in `runOnce`: when the seen-id FIFO has pruned a record and a crash-replayed hook re-notifies it so the SAME set re-derives, the set hash is matched against the durable processed registry and the copies are dropped (no second model call, no second summary record). Tested: "a re-notified copy of an already-processed set is dropped without re-summarizing" (maxSeenRecords=1 engine, hook replay → `already-processed`, call count and job count unchanged).
4. Below-threshold auto runs now report `skippedReason: "below-threshold"` instead of the mislabeled `"cooldown"` (cosmetic per review; honest status). Tested.
5. PRD AC-1 trace + `docs/memory-lifecycle.md` pruning claims reworded honestly (residual subset re-derivation can duplicate a reflection summary record — bounded, never data loss).

Review items intentionally deferred (non-blocking, logged as follow-ups): provenance replay detection still substring-based over the full record body (low impact — mislabeled replay-vs-stale classification in narrow recovery paths; scope to `kiwifs-provenance:`-prefixed lines later), and the fire-and-forget `.then` in `src/index.ts` that writes `observerError` can race other status writes (cosmetic).

### Checks after review fixes (actual outcomes)

- `npm run check` — **pass**: tsc clean, prettier clean, node --test 235/235 (233 prior + 2 new: already-processed replay drop, below-threshold status).
- `npm run pack:check` — **pass**: Package OK (32 files), packed extension loads in Pi RPC.
- `devenv test` — **pass** (10.5 s, "Tests passed :)").
- Secret scan of the incremental diff: clean; `config/kiwifs-test.local.json` never opened; no live-service contact, no REST fallback, no pushes/tags.

### Blockers / follow-ups (final, post-review)

- No blockers. Follow-ups:
  - T12/T13: retrieval renders conflict labels and reflection summaries (records are the source of truth); conflict-flag labels exist as of T11.
  - T18: command wiring for approve/reject/undo (lifecycle is a per-session API today), `reflectNow` manual command, and the git-remote scope discovery that also gates reflection (engine is built only when the scope resolves).
  - T19: live-runner validation of reflection/proposal delivery against the dedicated test space once the opt-in runner lands (fake-backend tests structurally cannot catch response-shape drift on the real `_meta`/ETag carrier).
  - Non-blocking hardening: engine state file growth (pending records carry redacted statements) has FIFO caps for seen/processed/skipped but pending records are bounded only by the reflection threshold×splitting behavior — a runaway extraction rate could grow the state file; consider a pending hard cap with visible degradation.
  - T18/T19 hardening (deferred from T11 review): scope provenance replay detection in `src/observation/proposals.ts` to `kiwifs-provenance:`-prefixed lines (today it substring-matches the full record body, so a crafted observation statement containing the literal could mislabel replay-vs-stale in narrow recovery paths — low impact, no data loss); serialize the fire-and-forget `observerError` write in `src/index.ts` with other status updates (cosmetic race).

---

## T12 — Per-user-input RAG retrieval (recovery of stalled workflow)

**Status:** complete, all required gates green, NOT committed (pending independent review).

### Recovery diagnosis (stalled previous workflow)

The T12 implementation files (`src/retrieval/coordinator.ts`, `src/retrieval/tokenizer.ts`,
`test/retrieval.test.ts`, `test/pi-ordering.test.ts`, `src/index.ts` + status wiring) were
preserved as-found; nothing reset or discarded. `npm run typecheck` failed first (test files
referenced unimported `PendingPackRegistry`, `makeBackend`/`makeAdapter` return types stripped
the `calls` spy shape, one `number | undefined` comparison) and `npm test` reproduced the stall:
`test/pi-ordering.test.ts` hung in two tests. Root cause was a HARNESS race, not the coordinator:

1. `FakePiSession.submit()` decided run-vs-queue only after `await emit("input", …)` (i.e. after
   the full awaited retrieval), while `run()` set `isStreaming = true` only after another awaited
   emit. A steer submitted deterministically right after a fresh submit could lose that microtask
   race, miss the streaming state, and start its own run blocked on the test gate — deadlock.
   Fix: the run/streaming decision is made synchronously at submit entry (real Pi sets streaming
   state at run start, before provider calls; the input event is still awaited first).
2. The harness never forwarded `streamingBehavior` in the emitted `input` event, so every pack was
   fingerprinted with `undefined` — fixtures could not prove the behavior-part of the fingerprint.
3. The template-expanded fixture asserted the follow-up pack at provider-call index 1, forgetting
   "fresh question" consumes its own pack at index 1 (follow-up is index 2). Corrected.

No production code in `src/retrieval/` or `src/index.ts` was changed beyond prettier formatting —
the coordinator's matching engine (raw-text fingerprint + occurrence guard + fail-closed settle)
was already correct; retrieval.test.ts's 23 tests passed untouched.

### Implementation (as preserved + status wiring)

1. `src/retrieval/coordinator.ts` — one awaited `input` handler per eligible input (Pi-verified:
   emitInput precedes expansion and the first LLM call, fresh and queued alike; tool loops emit no
   `input` event); ONE 2 s deadline (single AbortController, unref'd timer) covering query build,
   ALL backend legs, dedupe and ranking; fanout ≤ 4 scope queries with logged skip degradation;
   per-leg scope enforcement (FTS + semantic carry `scope`; hybrid/brief have no scope param and
   run at most once with EVERY candidate passing the full T04 guard pipeline; below-threshold
   brief packs rebuild from guarded scoped search); `keyword only` hybrid attribution reported
   degraded, never counted as semantic; B4 scoped under-recall measured and reported; queries
   redacted pre-outbound while fingerprints use RAW unredacted text (local matching state only).
   Matching: pending packs matched only on the provider call whose LAST user message carries the
   pack's matchKey AND is a newly appended occurrence (history membership / tool-loop replay /
   per-occurrence FIFO / transformed-text cases tested); duplicate inputId registration rejected;
   unmatched packs dropped fail-closed at run settle with a visible sanitized status.
2. `src/retrieval/tokenizer.ts` — `EvidenceTokenizer` contract; no reliable tokenizer exists for
   the bundled `z-ai/glm-5.3-flash` route, so automatic injection is skipped VISIBLE (explicit
   search/read remain; char/4 explicitly rejected as an enforcement path).
3. `src/retrieval/` buildPack framing counts the COMPLETE payload (evidence + framing + citations)
   against the confirmed 3,000-token cap with a model-compatible tokenizer when supplied.
4. `src/index.ts` — `input` handler wired (one cycle per input, generation-aware);
   `agent_settled` drops unmatched packs with a visible note; retrieval coordinator built when
   backend + credential resolve, otherwise a retryable visible hold; status text reports
   `retrieval: degraded — <reason>`; injection of packs remains T13 scope.

### Tests (synthetic fakes only; no live services)

- `test/retrieval.test.ts` (23): eligibility policy; private-mode and empty-scope holds with zero
  network reads; zero cross-scope hits via guard scope step (covers unscoped brief/hybrid legs);
  superseded/deleted records rejected pre-injection; brief guard-filtering + below-threshold
  rebuild; keyword-only degraded attribution; B4 under-recall measurement; one total deadline
  across fanout + budget-exhaustion skips; complete-payload token accounting (multilingual + code
  - framing + citations), cap enforcement dropping lowest-ranked evidence, unsupported-tokenizer
    visible skip; registry: last-user-message matching, same-occurrence guard, repeated identical
    queued text per-occurrence FIFO, transformed-text matching, redaction-never-touches-fingerprint,
    duplicate inputId rejection, unmatched-pack settle drop; scope fanout bound.
- `test/pi-ordering.test.ts` (5, fixture 11): fresh ordering (AC 1); steer-queued matched injection
  on the consuming provider call; unmatched steer dropped at settle never injected later; redaction-
  active variant (fingerprint on RAW text, outbound queries redacted); template-expanded variant
  (slash ineligible, eligible expansion identity, expansion never diverges the fingerprint).

### Checks (actual outcomes)

- `npm run check` — **pass**: tsc clean, prettier clean, node --test 262/262 (235 prior + 23
  retrieval + 5 fixture-11 ordering).
- `npm run pack:check` — **pass**: packed extension loads in Pi RPC (src/retrieval/ included).
- `devenv test` — **pass** (11.5 s, "Tests passed :)"): npm ci + check + pack:check green in the
  Nix sandbox (network npm ci + Nix validation permitted).
- Secret scan of the changed files: synthetic fixtures only; `config/kiwifs-test.local.json` never
  opened, printed or staged; no live-service contact, no deployments, no pushes/tags.
- Previous workflow's private agent sessions and secret-bearing configuration were not read.

### Acceptance coverage (PRD T12)

All seven criteria trace to named tests (traceability notes inline in the PRD checkboxes; fixture
11 is now implemented against Pi 0.85.0 ordering as required before T12 lands — injection WIRING
into `before_agent_start`/`context` remains T13).

### Blockers / follow-ups

- No blockers for T12. Follow-ups:
  - T13: inject the registered pack via `before_agent_start` (merged single extension message) and
    the `context` event for queued inputs using PendingPackRegistry.consumeMatching — the matching
    engine and fixture-11 harness are T12 deliverables ready for reuse.
  - T13: explicit search/read tools (same scope/privacy/guard pipeline) and cross-project opt-in
    wiring; user-supplied model-compatible tokenizer config for automatic injection.
  - Non-blocking: RetrievalCoordinator.builds a fresh adapter per runtime; lifecycle shares the
    outbox ledger by design (opIds of interactive writes are lifecycle-local, mirroring T11).

### Independent review findings + fixes (post-review, pre-commit)

The independent review returned NOT-ready with two blockers; both are fixed.

1. **Occurrence-unique inputIds (functional blocker, fixed).** The registry's
   `consumed` id set is session-permanent while `fingerprintInput` was
   deterministic, so (a) a repeated identical eligible input built a pack that
   `add()` rejected — and `retrieve()` ignored the rejection, silently losing
   the retrieval; (b) a pack dropped at run settle locked that exact input out
   of retrieval for the rest of the session. Fix: first occurrence keeps the
   PRD fingerprint SHA-256(rawText + behavior); every repeat is re-hashed with
   a per-coordinator occurrence counter (`occurrenceInputId`). `retrieve()` now
   treats a rejected `add()` as a visible degraded note (never silence). The
   text-only `matchKey` consumption matching is unchanged, so context-event
   dedupe by inputId still holds (each occurrence's id is stable). New test:
   "repeated identical input through the REAL retrieve path: every occurrence
   registers and consumes (no silent loss)" — two real `retrieve()` calls with
   identical text produce distinct registrable/consumable inputIds, and a
   settle-dropped input remains retrievable afterwards.
2. **Gate failure in the log (fixed).** The previous log claimed "all required
   gates green" while `prettier --check` flagged `tasks/execution-log.md` (and
   after this fix, the touched sources). `prettier --write` applied, gates
   re-run (outcomes below).

Also applied from the review's non-blocking findings: removed the dead
misleading `RetrievalCoordinator.dropPack` (its docstring claimed per-id drop
but it delegated to `dropUnmatched()`); corrected the private-mode note (no
pack is registered while held — nothing is "held, not deleted").

### Checks after review fixes (actual outcomes, re-run)

- `npm run check` — **pass**: tsc clean, prettier clean, node --test **263/263**
  (235 prior + 24 retrieval + 5 fixture-11 ordering + this fix's new test).
- `npm run pack:check` — **pass**: packed extension loads in Pi RPC.
- `devenv test` — **pass** (11.5 s, "Tests passed :)").
- Secret scan of the changed files: clean; synthetic fixtures only;
  `config/kiwifs-test.local.json` never opened; no live-service contact, no
  pushes/tags, no deployments.

### Recorded T13 constraints / follow-ups (from review, non-blocking for T12)

- `EvidencePack.rawText` is local matching state only: T13 must never inject,
  log or send `rawText` outbound — only `inputId`/`matchKey`-derived state.
- Matched-injection wiring (`before_agent_start` merged single message +
  `context` event), explicit search/read tools, user-supplied tokenizer config.
- PRD line 313: retrieval-side rendering of T11 conflict labels is a T12/T13
  obligation; `frameEvidence` currently carries only a static disclaimer and
  renders no labels. Decision recorded: label rendering lands in T13 with the
  injection wiring (it is presentation of injected content, which is T13's
  deliverable); no T12 code covers it.
- Cosmetic (deferred): brief items (score 0) outrank hybrid hits; status
  renders a hold reason under "retrieval: degraded".

## T13 — Bounded context injection and recall tools (injection chunk, 2026-09-08)

### What landed

- `test/inject.test.ts` (new, 16 tests): real `RetrievalCoordinator` +
  `PendingPackRegistry` + `EvidenceInjector` + packer end-to-end on synthetic
  fixtures — fresh consume-once; queued steer/followUp consumption with
  tool-loop dedupe; repeated identical inputs (occurrence-unique packs, FIFO);
  unmatched/ambiguous fail-closed + settle drop; zero-item packs consumed
  without an empty framing block; tokenizer-less packs never injected (visible
  skip); `rawText` containment with redaction-active fingerprinting (outbound
  FTS queries redacted, secret never in the injected message); token-count
  consistency (`pack.tokenCount` === recount of `frameEvidence(pack.items)`,
  lowest-ranked trimming under a tiny cap); conflict labels rendered bounded
  (≤200 chars, informational, source ids); `/`-prefixed expansion boundary;
  generation minting + settle isolation; tokenizer module loading (valid /
  missing / malformed / throwing counts fail closed); recall tools refuse in
  private mode with zero backend reads and pass the full guard pipeline
  (cross-scope + missing read-back rejected).
- Source fix proven necessary by the tests (`src/retrieval/coordinator.ts`):
  `PendingPackRegistry.consumeMatching` now records the (matchKey,
  user-message-count) barrier BEFORE the pending-pack lookup. Previously the
  barrier was only recorded on the no-pending branch, so a queued pack whose
  text equaled a fresh run's input could be consumed by the fresh run's
  baseline context call (count 1) before the queued input ever appended to
  history — stale-occurrence injection. Every (key, count) pair is now
  single-use; all prior behaviors preserved and covered by tests.
- Pre-existing T13 partial sources (src/inject/{injector,packer,tools}.ts,
  src/index.ts wiring, src/retrieval/tokenizer.ts loader, src/config/schema.ts
  `budgets.tokenizer`) completed/formatted and committed with this chunk.

### Checks (actual outcomes)

- `npx tsx --test test/inject.test.ts` — 16 pass / 0 fail (bounded, <1 s).
- `npx tsc --noEmit` — clean.
- `npm run check` — 279 tests pass / 0 fail, prettier clean.
- `npm run pack:check` — "Packed extension loads in Pi RPC and reports
  scaffold status."
- `devenv test` — "Tests passed :)" (13.4 s).
- Secret scan: synthetic fixtures only; `config/kiwifs-test.local.json` never
  opened; no live-service contact; no pushes/tags; no deployment edits.

### Acceptance coverage (PRD T13)

- Token cap with model-compatible tokenizer + deterministic truncation +
  recount after framing: `inject.test.ts` framing/token-accounting tests
  (character estimates never substitute — tokenizer-less pack visibly skipped).
- Steered/followUp injection on the consuming provider call, never duplicated
  on later context fires; unmatched fail-closed: queued/tool-loop/repeat tests.
- No duplicate persistent entries on repeated LLM calls: consume-once +
  same-occurrence barrier tests (context path is transient by Pi's clone
  semantics; fresh path consumes the pack exactly once).
- Prompt-injection framing as untrusted data with source ids + conflict
  labels: packer tests.
- Tools cannot bypass private mode/scope/tombstones: recall-tool tests
  (private mode zero reads; guard read-back gate; tombstone cache advisory
  only, wired in src/index.ts).
- RPC retrieve → inject → source recall: extension-level wiring covered by
  `test/extension.test.ts` (T13 fakes chunk: tools registered, events wired);
  end-to-end Pi-runtime proof remains manual/RPC-level (pack:check loads the
  extension in Pi RPC).

### Blockers / follow-ups

- None blocking. Note: `consumeMatching` ambiguity policy is FIFO-oldest per
  matchKey (one injection per occurrence); a second identical pending pack
  fails closed to settle drop rather than double-injecting.

## T13 — recall-tools and tokenizer/config tests (tools_tokenizer chunk, 2026-09-08)

### Changes

- `test/recall-tools.test.ts` (new, 16 tests): private-mode ZERO backend reads
  (search + read, no searchFts and no fresh reads); held-runtime sanitized
  refusals with no reads; fresh-read guard gates each proven to reject its
  failure case — read-back (missing), status (superseded), scope
  (unauthorized, no content leak), path-prefix, redaction (fail closed, no
  body) — plus framing/source-ids on success; advisory tombstone cache: a
  HIT refuses before any read, a stale/empty cache can NEVER authorize a
  forgotten record (read-back gate holds via read tool and search);
  timeouts — hanging search fanout degrades visibly ("deadline exceeded",
  no fabricated evidence, bounded 50 ms) and an aborted read signal
  degrades with no content; deterministic output bounds (maxResults,
  maxBodyChars); fanout bounded to the coordinator's authorized scope set.
- `test/tokenizer-config.test.ts` (new, 10 tests): `loadConfiguredTokenizer`
  success (default + named export, relative path vs baseDir), sanitized load
  failure, malformed exports (non-object/no-id/empty-id/non-function),
  throwing/NaN/negative/Infinity/string counts → `undefined` (never a char
  estimate); config schema `budgets.tokenizer` valid shape carried through
  and every malformed shape rejected; tokenizer readiness timing —
  tokenizer-less packs visibly skip injection with
  `TOKENIZER_UNAVAILABLE_NOTE`, `setTokenizer` covers only inputs retrieved
  after attachment and never overrides an existing tokenizer; cross-project
  opt-in mapping through `authorizedScopeSet` (own project + personal +
  `cross/` opt-ins gate recall; non-`cross/` values and >N≤4 fail closed).
- **Source fixes proven necessary by the tests** (minimal):
  - `src/inject/tools.ts` read tool: a transport failure / deadline abort on
    the guard read degrades visibly (sanitized refusal, "deadline exceeded")
    instead of crashing the tool — fail closed, no content reported.
  - `src/config/schema.ts` `budgets.tokenizer`: unknown keys inside the
    tokenizer object are rejected (consistent with mcp/model sections).

### Evidence

- `npx tsx --test test/recall-tools.test.ts test/tokenizer-config.test.ts`:
  26 pass / 0 fail (<0.3 s, timeout-bound tests bounded).
- `npm run check`: 305 pass / 0 fail, prettier clean.
- `npm run pack:check`: "Packed extension loads in Pi RPC and reports
  scaffold status."
- `devenv test`: "Tests passed :)" (12.2 s).
- Secret scan: synthetic fixtures only; no `kiwifs-test.local.json`; no
  credentials, live services, pushes, or deployment edits.

### Blockers / follow-ups

- None. `src/inject/` persists-consumed-outbound invariants remain covered by
  `test/inject.test.ts`; recall-tool suite complements it. End-to-end
  Pi-runtime RPC proof (retrieve → inject → source recall against a real Pi
  session, not fakes) remains the manual/RPC-level follow-up noted by the
  injection chunk.

## T13 — real isolated Pi RPC/headless fixture: retrieve → inject → source-recall (rpc chunk, 2026-09-08)

### What was built

- `test/pi-rpc-fixture.test.ts` (new): a bounded (~3 s) end-to-end fixture
  that spawns the REAL Pi 0.85.0 CLI in `--mode rpc --no-session` with the
  actual `src/index.ts` extension loaded, and drives a genuine agent
  session. Fully local and synthetic — no paid model, no network service,
  no credentials:
  - **Local scripted model**: a loopback `openai-completions` SSE server
    registered through Pi's own `~/.pi/agent/models.json` mechanism, with a
    deterministic call-count script (tool call → tool call → final text).
  - **Local fake KiwiFS backend**: the existing `test/fake-mcp-server.ts`
    bridged onto a loopback HTTP server; records seeded under
    `project/t13/demo/memory/` so the guard pipeline's path-prefix, scope
    and read-back steps all exercise for real.
  - **Local tokenizer module** (fixture `countTokens`) wired via
    `budgets.tokenizer`; the fixture polls `/kiwifs-status` over RPC until
    the status line reports the attached tokenizer before prompting.
- Scenario proven against the real Pi process (assertions on the raw
  provider request bodies, the fake MCP request log, RPC events, and
  extension-error silence):
  1. Fresh prompt → one retrieval cycle (FTS + semantic + hybrid + brief
     legs, guard read-back) → the pack is injected as the single custom
     message via `before_agent_start` and persists in every later request
     exactly once.
  2. The model's tool call runs the REAL `kiwifs_memory_search` tool
     through Pi's tool runner and the guard pipeline to the fake backend;
     the tool result is visible in the next provider request.
  3. A secret-bearing recall query (`AKIA…`, fixture-only) reaches the
     backend ONLY as `[REDACTED:aws-access-key:20]`; the raw secret never
     appears in any outbound request.
  4. A queued steer prompt (sent while the agent is streaming) is delivered
     after the tool turn with NO fresh `before_agent_start` for it
     (empirically confirmed: the steer begins no new agent run when
     delivered mid-stream), its pack is injected via the transient
     `context` path exactly once, and it is absent from the next
     tool-loop call — proving consumed-input linkage and per-call dedupe in
     real Pi, not fakes.

### Real-Pi finding and source fix

- **`src/inject/injector.ts` bug found by the real-Pi fixture** (fakes could
  never catch this): the message returned by the `context`-path injector
  lacked `role: "custom"`. Pi's `convertToLlm` silently DROPS role-less
  custom messages, so every queued steer/followUp evidence pack was consumed
  but never actually reached the provider context — a silent loss on the
  exact path the PRD's queued-input linkage depends on. Fix: build the
  evidence message as a full `{ role: "custom", customType, content,
display, details }` CustomMessage (`buildEvidenceMessage`), matching
  Pi 0.85.0 `CustomMessage`/`convertToLlm` semantics verified in
  `pi-agent-core/dist/harness/messages.js`. The `before_agent_start` path is
  unaffected (Pi wraps the returned Pick into a proper custom message), and
  the extra role field is accepted there.
- Also empirically confirmed against Pi source/behavior: the steer message
  arrives in the provider context AFTER the tool turn's `toolResult`
  (steering delivery point), and the `context` event fires per provider call
  with the cloned message list — matching the architecture §3.1 model.

### Evidence

- `npx tsx --test test/pi-rpc-fixture.test.ts test/inject.test.ts`:
  17 pass / 0 fail (bounded; fixture ~3 s, all waits deadline-bounded,
  scripted model bounded at 8 calls, child killed + tmp tree removed in
  `finally`).
- `npm run check`: 306 pass / 0 fail, prettier clean.
- `npm run pack:check`: "Packed extension loads in Pi RPC and reports
  scaffold status."
- `devenv test`: see below.
- Synthetic fixtures only; the only "secret" is the fixture AWS-pattern
  string, which the test proves is redacted before any outbound call; no
  `kiwifs-test.local.json`, no live services, no pushes or deployment edits.

### Blockers / follow-ups

- None blocking. Notes: the fixture asserts the steer is delivered
  mid-run (steering queued while the first model call streams, delivered
  after that turn's tool calls); a steer that arrives after the agent has
  settled stays queued until the next run — consistent with Pi's steering
  queue semantics and outside T13's injectable-input path (it would become
  a fresh input on delivery).

## T13 — validation: acceptance boxes, gates and commit (validation chunk, 2026-09-09)

### What was done

- Independent re-verification of all four T13 chunks (`7bd8cb0`..`4924f99`,
  tree was clean). All six T13 acceptance criteria checked off in
  `tasks/prd-kiwifs-memory.md` with per-criterion evidence citations
  (`test/inject.test.ts`, `test/recall-tools.test.ts`,
  `test/tokenizer-config.test.ts`, `test/pi-rpc-fixture.test.ts`, T08/T11
  inert-fence tests, and the source invariants they pin).
- Gates re-run on the final tree by the validator, not trusted from the
  chunks: `npm run check` 306 pass / 0 fail + prettier clean;
  `npm run pack:check` loads in Pi RPC; `devenv test` "Tests passed :)".
- Staged-files secret inspection before commit (synthetic fixtures only; the
  AWS-pattern string exists solely as the redaction-proven fixture; no
  `kiwifs-test.local.json`, no credentials, no live services, no deployment
  edits, no push).

### Honest limitations (recorded, non-blocking)

- The RPC fixture proves the queued-steer consumed-input path in real Pi;
  a dedicated `followUp` RPC variant (new agent run, still no
  `before_agent_start`, stored expanded) is not yet exercised end-to-end —
  its matching shares the proven raw-text fingerprint + occurrence guard,
  and remains a follow-up.
- Theoretical timing window (steer text identical to the fresh prompt,
  registered between `before_agent_start` and the run's first context fire)
  is closed by Pi's event ordering in practice (steers are accepted only
  while streaming, i.e. after call 1's context fire), noted as timing- not
  structurally-guaranteed.

## T14 — Transcript backup capture (implement_T14, 2026-09-09)

Worker: implement_T14, runtime model OpenRouter `z-ai/glm-5.3-flash` (default, no
fallback). Dependencies verified from Git/log: T06 (privacy gate: `createRedactor`,
`compileExclusions`, `looksSecretBearing`), T08 (`SessionCoordinator` consumed-entry
registry and lifecycle hooks) — both present at `ed80f1df0505db016b7be1ba7b06e233cbead506`,
tree clean before work started.

### What was built (src/backup/)

- `src/backup/exporter.ts` — `toBackupViews()`: converts Pi session entries into
  backup views preserving `id`/`parentId` (tree relationships; lineage is Pi entry
  IDs, never a content hash), roles including `toolResult`, compaction/branch-summary
  summaries; non-text content blocks → `binary-omitted`; `kiwifs.`-prefixed custom
  entries → `extension-internal` (no recursive capture of our own injections). Raw
  text stays local capture state — redaction happens at the chunk edge, before any
  serialization.
- `src/backup/chunker.ts` — deterministic chunker: ≤64 KiB per chunk (§13 row 11);
  a single oversized entry forms its own disclosed `oversized` chunk (never
  truncated/dropped); `serializeChunk` is byte-deterministic (no opId/wall-clock
  inside chunk content) so crash re-derivation reproduces identical bytes;
  `chunkChecksum` = SHA-256 of the exact bytes (content-addressed, never branch
  identity).
- `src/backup/manifest.ts` — `buildBackupManifest`: schemaVersion, covered source
  range (first/last entry id + count), chunk list with paths/checksums/byteLengths,
  redaction summary (counts by type, never values), omission list, `redacted: true`
  (completeness is always "complete with recorded redactions and omissions", never
  byte-identical — decisions.md #2).
- `src/backup/capture.ts` — `BackupCapture` engine + delivery: durable coverage
  cursor (`backup-state.json`, tmp+rename+fsync like the other state files;
  newer-schema state fails closed), incremental capture on the uncovered entry set,
  per-entry privacy policy (private mode → no jobs; exclusion-pattern matches and
  extension-internal → recorded omissions; redaction failure → entry held
  UNCOVERED, fail-closed, visibly reported, never sent raw), outbox enqueue of one
  `backup-chunk` job per chunk (idempotency key = kind/scope/sources(session,
  branch, chunk entry ids)+seq token) plus a manifest job after any chunk flush.
  Coverage cursor advances ONLY after every chunk job is durably persisted
  (decisions.md #8); the outbox mints/persists the opId itself before enqueue
  returns. `parseBackupPayload` re-validates at delivery (shape + content/header
  cross-check + checksum re-verification); `sendBackupJob` writes chunks via
  `writeImmutable` at the deterministic `backup/{project-id}/{session-id}/{seq}.md`
  path (B2 read-before-write: identical replay = no-op, divergence = fail closed).
- Delivery policy note (architecture §7 concretization, recorded here): chunk files
  are immutable; the manifest path `backup/{project-id}/{session-id}/manifest.md` is
  the SINGLE MUTABLE path of a backup tree — it is rewritten (never merged) as
  capture progresses and carries only checksums/counts/IDs, never transcript
  content (content is redacted at the chunk edge before it can reach a chunk, so an
  unredactable entry can never reach the manifest via one either). Delivered via the
  adapter's plain `write`; the optional `write` capability on `ObservationBackend`
  means a backend without manifest support holds backup delivery as a retryable gap.
- `src/observation/sender.ts` — dispatches `backup-chunk` jobs (project scope
  required for the `backup/{project-id}/` namespace; personal-only scope → retryable
  `SenderNotWiredError`, jobs stay pending, never dropped/quarantined).
- `src/index.ts` — wiring: backup capture built at session_start when
  `features.backup` + resolved project scope (held visibly otherwise, mirroring the
  observer's T18 scope hold); identity refresh at `session_start`/`session_tree`;
  bounded capture flushes at `agent_settled`, `session_before_compact` (uses
  `event.branchEntries`, never cancels compaction) and `session_shutdown` (best
  effort; the cursor guarantees resume without loss/duplication); private mode is
  re-checked inside every capture; status surfacing via `setBackupNoteProbe` /
  `lastBackupNote` (metadata only).

### RAG exclusion (AC 5)

Backup chunks live under `backup/…`, structurally outside every `{scope}/memory/`
namespace; the T04 guard pipeline's step 4 (`guardCandidate` path-prefix check)
rejects any hit outside `{scope}/memory/` — pinned by a new test (a backup path with
authorized scope + active status still fails at `path-prefix`; a memory path passes
as control). Ordinary retrieval therefore can never surface raw transcript chunks;
they remain reachable only via explicit backup-read tooling (T15/T18).

### Tests (test/backup.test.ts, synthetic fixtures only)

All five T14 acceptance criteria covered: branched-tree export preserves entries +
parent links + roles/tool results (AC1); interrupted capture resumes with no
missing/duplicated accepted entries, including the crash-window property (cursor
lost → re-derivation is byte-identical per seq, backend replay = no-op) (AC2);
manifest declares schema/covered range/redaction summary (counts, no values —
asserted)/omissions, chunk checksums match delivered bytes, manifest delivered to
`manifest.md` (AC3); private mode skips capture, excluded + extension-internal +
binary content absent with recorded omissions, redaction failure holds entries
fail-closed then recovers (AC4); backup paths cannot pass ordinary retrieval guards
(AC5). Plus: delivery-side tamper rejection (session/entry-id/checksum mutation),
64 KiB cap with oversized-entry disclosure, payload validation.

### Checks actually run (final tree)

- `npm run check`: tsc clean, prettier clean, **316 pass / 0 fail** (30 previous
  suites + 10 new backup tests), runtime Node v24.19.0 (satisfies engines >=22.19).
- `npm run pack:check`: package OK (41 files, includes all four `src/backup/`
  runtime modules under the `src/` allowlist; no test/secret files — allowlist is
  `src/*.ts` + README/LICENSE only), packed extension loads in Pi RPC.
- `devenv test`: "Tests passed :)" (full suite + pack smoke inside devenv).
- Node 22 compatibility evidence: T14 suite 10 pass / 0 fail under
  nodejs-slim-22.22.3 (nearest available ≥22.19 build; exact 22.19.0 not
  installed on this machine). Full-suite Node 22 run: 266 pass / 0 fail /
  50 cancelled — reproduced identically on the clean T13 baseline tree via
  `git stash` (pre-existing Node-22 runner quirk in `observation-model.test.ts`
  et al: `cancelledByParent` "event loop already resolved" cascade), NOT
  introduced by T14; T14's own tests are unaffected.

### Limits / honest notes (non-blocking)

- The capture engine re-checks private mode and exclusions per flush; the
  index-level wiring also holds capture entirely when no project scope resolves
  (T18 git-remote discovery pending) — same discipline as observation.
- Manifest jobs re-enqueue per flush and rewrite the manifest path; ordered
  per-scope outbox delivery (§6) prevents an older manifest regressing a newer
  one; replay of the same job rewrites identical content (effect-idempotent).
- `coveredEntryIds` grows per session without local GC (bounded by session
  lifetime); chunk/manifest growth is bounded by transcript size. Local state GC
  is an operator/UX follow-up (T18), consistent with the outbox retention design.
- T15 (verification + export/restore) is the follow-up task that consumes these
  manifests; restore-into-Pi remains explicitly out of scope/architecture-deferred.
- No live service contact, no `kiwifs-test.local.json` reads, no deployments; the
  only secret-shaped string in tests is the synthetic AWS-pattern fixture, which
  the suite proves is redacted before any chunk/manifest byte is produced
  (asserted absent from serialized manifest and outbox-accepted payloads via the
  outbox's own `looksSecretBearing` gate).

## T15 — Backup verification and non-destructive export (finish_T15, 2026-09-09)

### What was built (src/backup/verify.ts, src/backup/recovery.ts)

- **Verification (`verifyBackup`, pure function over a delivered tree)**: recomputes
  every chunk checksum from the _delivered bytes_ (manifest checksums are never
  trusted as evidence of integrity); detects missing chunks, duplicated/extra
  delivered chunks, reordering (chunk seq self-description vs manifest position),
  corrupted bytes, manifest completeness violations (count/range/duplicate
  coverage gaps, `entry-count-mismatch`) and unlinked parents (branch link into
  an uncovered or later-seq entry). All findings are `BackupIssue`s with codes,
  never exceptions.
- **Fail-closed parsing**: manifest parse rejects `schemaVersion > 1`
  (`schema-unsupported`), wrong `kind`, missing `redacted` flag, malformed chunk
  records; chunk parse validates session id and seq shape. Foreign/newer
  producers therefore abort before any export or further use.
- **Recovery (`verifyRemoteBackup` in `recovery.ts`)**: reads a delivered backup
  tree via the backend adapter, builds the chunk map from raw bytes, flags
  undeliverable chunks for `verifyBackup`, and returns a typed result
  (`missing` / `invalid` / `ok{verification}`).
- **Export (`exportBackup`)**: writes only to an explicitly named directory that
  does NOT exist (checked + created; refusal on existing target — never
  overwrites, never implicit). Writes one `<seq>.json` chunk plus a
  `export-summary.md` stating session/scope/entry counts, redaction summary and
  omissions. Restore-into-Pi is NOT attempted (architecture §20 deferral);
  completeness statements never claim byte-identical fidelity
  (`fidelity: "redacted"` when redactions/omissions were recorded; a manifest
  claiming `redacted: false` while carrying redaction metadata fails closed).
- **Command wiring (`src/index.ts`)**: `/kiwifs-backup-verify <session-id>
[export-dir]` — usage/disabled/scope messages without UI in headless mode;
  verification runs on a read-only adapter (stub ledger: reads mint no opIds);
  path-safety gate before any filesystem or backend access
  (`PathEscapeError` → visible failure). Export destination must be passed
  explicitly and must not exist.

### Path exclusion privacy policy

- Backup capture (T14) applies the same exclusion/redaction rules as observation;
  pattern-only rules fire at capture time; `pathPrefix` rules cannot fire on
  transcript entries (no backend path context) — disclosed in T14 log and
  `docs/privacy.md`, not silently bypassed. T15 changes no exclusion semantics;
  verification reads only what was already delivered under those rules and the
  export faithfully reports recorded redactions/omissions.
- The synthetic AWS-pattern secret from the T14 fixture remains asserted absent
  from every exported byte in the round-trip test.

### Tests (test/backup-verify.test.ts, test/extension.test.ts)

- 11 new T15 tests: healthy verify + redaction-honest fidelity; missing /
  duplicated / reordered / corrupted chunk detection; manifest completeness
  gaps; unlinked parent; newer-schema fail-closed (manifest + chunk); malformed
  manifest fail-closed; round-trip export with redaction/omissions represented;
  export refusals (existing destination, unverified backup, unsafe path).
- `test/extension.test.ts` updated for the T15 registration shape: `loadCommand`
  returns `{ status, verify }`; removed the leftover `assert.ok(command)`
  reference and a duplicated tools-registration block that broke the two
  pre-existing T08 status tests; disabled-extension early-exit asserted.

### Review fixes (final worker session)

- **B1 (review blocker, fixed)**: `/kiwifs-backup-verify` previously performed
  backend network reads (`adapter.connect()` + `kiwi_read`) with no private-mode
  gate, contradicting `docs/privacy.md` (private mode = no network reads in any
  of the three feature domains, including backup). Fixed in `src/index.ts`: the
  command now checks `config.privateMode` after the enabled check and returns a
  visible hold message ("private mode active — backup verify holds all backend
  reads") before any adapter is constructed. Regression test
  "private mode holds backup-verify backend reads" (`test/extension.test.ts`):
  enabled + private-mode synthetic config fixture with `mcp.url` pointed at a
  local recording listener; asserts the hold notice is emitted and the listener
  received **zero** requests (gate fires before adapter construction).
- Review follow-ups (export TOCTOU, error-detail loss, projectId cross-check,
  null-range skip, bounded probe, export file modes) remain non-blocking and
  are NOT addressed in this commit; the reviewer classified them as such.

### Checks actually run (final tree)

- `npm run check`: tsc clean, prettier clean, **329 pass / 0 fail**.
- `npm run pack:check`: package OK; `src/backup/verify.ts` and
  `src/backup/recovery.ts` included under the `src/` allowlist (6 backup files
  in the tarball); packed extension loads in Pi RPC.
- `devenv test`: "Tests passed :)" (full suite + pack smoke inside devenv).
- No Node 22 re-run this task: T15 adds pure-TypeScript verification/export
  code with the same language/test APIs as T14 (no new syntax beyond that
  baseline); Node 24 local run is the evidence for this task and Node ≥22.19
  remains the engines floor from T14.

### Limits / honest notes (non-blocking)

- `verifyBackup`'s branch-link pass re-parses each chunk a second time instead
  of reusing the first-pass parse — an efficiency cost only; chunk files are
  small (64 KiB cap) and verification is an explicit user-invoked command.
- `entry-count-mismatch` is only reported when chunk ordering is otherwise
  consistent; a seq self-description mismatch is reported by its own issue, so
  one corrupt chunk can mask the aggregate count check until it is fixed.
- `export-summary.md` currently drops blank-line separators between sections
  (cosmetic; content is complete).
- Restore-into-Pi and automatic remote deletion remain deferred
  (architecture §20); export is the approved recovery path for v1.
- No commit was made in this session; commit is a separate task after
  independent review. Files changed: `src/index.ts`,
  `src/backup/verify.ts` (new), `src/backup/recovery.ts` (new),
  `test/backup-verify.test.ts` (new), `test/extension.test.ts`,
  `tasks/prd-kiwifs-memory.md`, `tasks/execution-log.md`.

## T15 hardening fixes — fix_hardening session (2026-09-09, no commit)

Follow-up to the T15 hardening diff (uncommitted on top of b703c26), fixing the
three typecheck errors found in review and closing the hardening coverage gap.

### Changes

- `src/backup/verify.ts`: `writePrivateFile` now writes via
  `Buffer.from(content, "utf8")` — the previous `writeSync(fd, str, "utf8")`
  call did not match any @types/node overload (TS2769).
- `test/backup-verify.test.ts`: removed duplicated `projectId`/`scope` keys in
  `buildBackupManifest` fixture (TS1117) and extraneous `projectId`/`scope`
  props in the `serializeChunk` call (TS2353).
- `test/backup-verify.test.ts`: three new hardening tests (14 total in file):
  - identity gate: wrong `projectId` and wrong `scope` both produce
    `identity-mismatch` and `ok: false`; matching identity still verifies.
  - null-endpoint regression: nonempty manifest with `firstEntryId`/`lastEntryId`
    forced to `null` fails with `range-mismatch`; export of that unverified
    result throws `ExportRefusedError`.
  - atomic claim + modes: `exportBackup` creates the destination with mode
    0700 and every file at 0600 (umask-independent); a second export to the
    now-existing destination is refused (EEXIST) writing nothing; a symlink at
    the destination is refused, never followed.

### Checks actually run

- `npx tsc --noEmit`: clean (was 3 errors before this session).
- `node --test test/backup-verify.test.ts`: 14 pass / 0 fail.
- `npm run check`: tsc + prettier clean, 332 pass / 0 fail (one prettier
  reformat of the new test block applied via `prettier --write`).
- `npm run pack:check`: package OK; backup sources included; packed extension
  loads in Pi RPC.
- `devenv test`: "Tests passed :)" (full suite + pack smoke inside devenv).

### Limits / honest notes

- No commit made (per task instructions).

## T15 hardening — final independent review + commit (commit_hardening)

Independent re-inspection of the full hardening diff found two remaining flaws;
both fixed in `src/backup/verify.ts` and verified by the full gate suite.

### Fixes

1. **Partial-write leak**: file paths were pushed onto the cleanup ledger only
   AFTER `writePrivateFile` returned, so a mid-write failure (ENOSPC/EIO) left
   an orphan 0600 file that cleanup never removed — and the non-recursive
   `rmdirSync` then failed too, leaving the claimed directory behind.
   Fix: `writePrivateFile` now takes the ledger and records the path
   immediately after the exclusive 'wx' open succeeds — a failed write is
   cleaned up, while a path planted between claim and write (EEXIST on 'wx')
   never lands on the ledger and is never deleted (non-owned artifacts stay
   untouched).
2. **EEXIST race**: the `lstatSync(dest)` inside the EEXIST handler could
   itself throw if the entry vanished in the mkdir→lstat window, escaping as a
   raw error instead of an `ExportRefusedError`. Fix: best-effort `tryLstat`;
   a missing entry is still a refusal, never a fallback write.

### Checks actually run (final tree, all green)

- `npm run check`: tsc + prettier clean, 332 pass / 0 fail.
- `npm run pack:check`: package OK, backup sources in tarball, packed
  extension loads in Pi RPC.
- `devenv test`: "Tests passed :)".
- Diff secret-scanned before staging; only the five reviewed task files
  staged; commit created fresh (no amend of b703c26).

## T16 — Board schema, identity and send/read/list domain operations (chunk 1, 2026-09-09, no commit)

Scope per instructions: board message schema/path identity and send/read/list
domain operations plus focused synthetic tests. Tools chunk (Pi tool
registrations) and `src/index.ts` wiring are deliberately NOT touched — the
interfaces below are the contract the tools chunk consumes.

### Files

- `src/board/messages.ts` (new): board-message schema helpers over the T05
  record format (`type: board-message`, `to`/`from`/`channel`/`ttl`
  frontmatter). `validateBoardIdentities` enforces the strict id grammar on
  channel/from/to BEFORE any network use; `buildBoardMessage` derives
  `msg_id`/path via the T04 op-id identity (`deriveMsgId`/
  `deriveMsgPath`, 16-hex [P] default — unchanged) and never from content;
  `parseBoardMessage` parses a fresh read and reports client-side expiry;
  `isExpired` implements the B5 client-side TTL (`created + ttl < now`).
  Bodies are opaque data — nothing here interprets them.
- `src/board/repository.ts` (new): `BoardRepository` over `KiwiFSAdapter`.
  - `send(input, opId)`: validates identities, applies the injected privacy
    redactor (fail closed), builds the record, writes via the adapter's
    B2 `writeImmutable` (read-before-write). Same-job replay → same op-derived
    path → `replayed: true` no-op; differing content at the path → typed
    `{ok:false, quarantined:true, reason:"content-collision"}` — never
    overwrites. `opId` persistence is enforced by the adapter ledger.
  - `list(channel, {to, limit, offset})`: `kiwi_query_meta` with
    `channel`/`to` filters, limit clamped to `BOARD_LIST_MAX` (200),
    offset forwarded; every returned path re-checked by strict
    `pathWithinBoardChannel` containment (query results are never trusted as
    a scope boundary on the shared-key backend).
  - `read(path, {includeExpired})`: channel containment check → fresh
    `kiwi_read` → parse → client-side TTL (`expired` typed result, visible,
    never silently dropped). Body returned verbatim.
  - Private mode: injected `PrivateModeGate` refuses send/list/read with zero
    network requests (board domain fully disabled).
  - Authorization disclosure constant/docs: routing labels are not
    confidentiality (single shared apikey); no per-path authorization exists.
- `test/board.test.ts` (new, 12 tests): fixture 5b dual-sender identical
  payload → two distinct messages persist; replay → same path, no duplicate,
  no second write; differing-content collision → quarantined, original
  intact; invalid identities rejected with zero network I/O; list
  post-filtering drops foreign-channel and `board-alpha/` prefix-lookalike
  results that a shared-key peer could plant (with frontmatter matching the
  filter — lying results still filtered); client-side TTL incl. expired/
  includeExpired/no-ttl paths; hostile message body read back verbatim with
  exactly one `kiwi_read` and no other tool triggered; opId-not-persisted
  fail closed with nothing written; redaction gate refuses secret-bearing
  bodies pre-wire; private mode refuses all three operations with zero
  requests; limit clamp 200 + offset forwarded per query_meta contract;
  send/read result shapes carry safe ids only (no credentials).

### Design note (replay determinism)

`created` is part of `BoardMessageInput` and MUST be carried in the persisted
outbox payload: byte-identical replay content requires a deterministic
instant minted at enqueue, not at send. This is an integration requirement
for the T07 outbox wiring (tools chunk); a caller omitting `created` gets a
fresh timestamp and a replay then fails closed as content-collision (safe,
but the no-op guarantee requires persisting `created`).

### Chunk-1 mapping to T16 acceptance criteria (all still OPEN in the PRD)

- Dual-sender + replay fixtures: implemented and passing (synthetic).
- Client policy/denial + shared-key disclosure: enforced pre-wire + doc'd;
  UI-level disclosure wording lands with the tools chunk.
- TTL client-side, ordering/pagination per contract: TTL done; ordering is
  query_meta sort — the fake server ignores sort/offset, so live contract
  verification of ordering stays an honest gap for the tools/full-T16 pass.
- Collision fail-closed/quarantined: done at repository level; outbox
  quarantine status surface lands with wiring.
- Messages never trigger execution: enforced structurally (verbatim body,
  single-read test).
- Safe tool responses: repository results are ids/status only; tool-layer
  response shaping belongs to the tools chunk.

### Checks actually run

- `npx tsc --noEmit`: clean.
- `node --test test/board.test.ts`: 12 pass / 0 fail (3 consecutive runs —
  deterministic; an initial flake exposed the `created` determinism flaw).
- `npm run check`: tsc + prettier clean, 344 pass / 0 fail.
- `npm run pack:check` / `devenv test`: NOT run in this chunk (reserved for
  the final T16 gates after the tools chunk).

### Limits / honest notes

- Fake server `kiwi_query_meta` filters by frontmatter substring and ignores
  `sort`/`offset` — repo post-filtering and arg forwarding are asserted, but
  server-side sort behavior remains fixture-unverified.
- No commit (per task instructions). Files staged only if the coordinator
  instructs the final worker commit.

## T16 — Board tools, outbox delivery wiring, acceptance completion (chunk 2, 2026-09-09, no commit)

### Files

- `src/board/job.ts` (new) — board-message outbox job integration:
  `parseBoardPayload` (typed permanent failure on malformed/tampered payload,
  strict identity re-validation), `buildBoardJobMessage` (deterministic wire
  content re-derived from the persisted payload + durable opId; `created`
  comes from the payload, never a wall-clock read), `sendBoardJob`
  (adapter `writeImmutable`, B2; ConflictError → `ValidationError` so the
  worker quarantines with a visible reason; never deletes/rewrites).
- `src/board/tools.ts` (new) — `kiwifs_board_send`, `kiwifs_board_list`,
  `kiwifs_board_read` following the T13 recall-tool discipline: private-mode
  refusal (send enqueues NOTHING), held-runtime/board-disabled refusals with
  sanitized reasons, redaction gate BEFORE enqueue (fail closed), sends ride
  the durable outbox (opId minted by the tool and persisted in the SAME
  durable enqueue write; `created` persisted in the payload), tool returns
  safe local status only (queued msgId/path, never the body), list/read via
  `BoardRepository`, bodies framed as UNTRUSTED DATA, routing-
  not-confidentiality disclosure on every result.
- `src/outbox/store.ts` — `EnqueueInput` gains optional caller-supplied
  `opId` (board payload carries the opId it was built around; still persisted
  BEFORE any side effect in the same durable write). No behavior change for
  existing callers.
- `src/observation/sender.ts` — `board-message` kind dispatches BEFORE the
  project-scope hold (board is cross-agent; scope stays required for
  observation/reflection/proposal/backup).
- `src/index.ts` — board tools registered at startup; runtime source is the
  retrieval adapter (same MCP config gating), outbox from the session
  runtime, redactor via `createRedactor()`.
- `test/board-tools.test.ts` (new, 9 tests) — durable enqueue contract
  (payload opId === job.opId, `created` persisted, zero wire requests, body
  never echoed back); redaction gate pre-queue; secret-bearing body screened
  at enqueue (nothing queued); private mode zero reads/writes/no jobs; held
  - disabled refusals; worker tick delivers → parse-back verifies frontmatter
    and byte-stable replay tick (one message, no duplicate, job acked);
    planted foreign content at the deterministic path → tick quarantines the
    job with a visible reason, foreign content intact, queued content never
    written; list returns filtered paths + disclosure and refuses bad channels
    pre-wire; read TTL client-side (fresh → expired refusal → includeExpired),
    untrusted framing, credential-free outputs.
- `test/extension.test.ts` — startup tool set now includes the three board
  tools.

### Chunk-2 mapping to T16 acceptance criteria (PRD boxes updated)

- Dual-sender + replay fixtures: green end-to-end through tool → durable
  outbox → worker → adapter (chunk 1 covered the repository level).
- Client policy/denial + disclosure: tool descriptions and EVERY result
  carry the shared-key routing-not-confidentiality wording; invalid
  identities/paths refused pre-wire.
- TTL client-side + ordering/pagination: TTL enforced client-side at read
  (fresh/expired/includeExpired); limit clamp + offset forwarded. Honest
  remaining gap: the fake server ignores `sort`, so server-side ordering is
  validated only against the recorded contract by arg-forwarding tests,
  not against a sorting backend.
- Collision fail-closed/quarantined: worker-level test — differing content
  at the deterministic path → job quarantined, reason visible
  (name:code-only), nothing overwritten.
- No automatic execution: bodies returned verbatim as untrusted data; no
  code path in board send/list/read parses or executes bodies.
- Safe responses: ids/status only; credential-free assertion in tests.

### Checks actually run (final tree, all green)

- `npx tsc --noEmit`: clean.
- `node --test test/board-tools.test.ts test/board.test.ts`: 22 pass / 0 fail.
- `npm run check`: tsc + prettier clean, 354 pass / 0 fail.
- `npm run pack:check`: clean (packed extension loads in Pi RPC).
- `devenv test`: passed.

### Limits / honest notes

- Server-side `kiwi_query_meta` sort ordering remains fixture-unverified
  (fake server ignores `sort`); offset forwarding and the client-side
  channel containment re-check are tested.
- Sender identity (`from`) is a self-claimed routing label (validated
  grammar only) — disclosed in tool output; the shared key cannot
  authenticate senders (never claimed otherwise).
- No commit (per task instructions). No T17 feature work in this chunk
  (no polling, cursors, or acks beyond the worker's local ack).

### Review fixes (post-review, 2026-09-09)

- Review follow-up #2: the repository send privacy gate no longer throws
  `PathEscapeError` (a path-semantics error) for a content refusal; it now
  throws a dedicated `PrivacyGateError` (`BackendError`, code `validation`,
  non-retryable → worker quarantines with visible reason). Behavior
  unchanged; error name now matches semantics. Test asserts the typed error
  and its non-retryability.
