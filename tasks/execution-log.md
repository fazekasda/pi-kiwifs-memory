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
