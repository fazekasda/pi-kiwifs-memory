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
