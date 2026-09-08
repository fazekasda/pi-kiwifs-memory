# Backend adapter (T04) — configuration and observable behavior

Status: implemented in `src/backend/`. MCP-only (decisions.md #1) — there is no
REST fallback and none is silently substituted for a missing capability. All
contracts trace to `docs/research/mcp-contracts.md` (KiwiFS v0.19.62 @
`3961d5e70a9e0ef457e58e29c40c52c870d57e73`) and `docs/architecture.md` §4.

## Components

| File                         | Responsibility                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/backend/transport.ts`   | Streamable HTTP JSON-RPC: stateless initialize per logical connection, `tools/list`, `tools/call`; redirect rejection; bounded responses; timeouts/cancellation |
| `src/backend/adapter.ts`     | Typed operations, capability discovery gate, client-side limits, B2 deterministic-path writes, retry policy                                                     |
| `src/backend/guard.ts`       | 5-step fail-closed guard pipeline (B3), advisory tombstone cache, brief scope gate + fallback rebuild (§13 row 4)                                               |
| `src/backend/opid.ts`        | Op-id minting + ledger; mutations refuse to run before the opId is recorded as durably persisted                                                                |
| `src/backend/ids.ts`         | `msg_id` = 16-hex SHA-256 of `'{channel}/{from}/{opId}'` (slash-joined framing per `docs/research/adapter-fixtures.md`)                                         |
| `src/backend/parse.ts`       | Typed parsers over KiwiFS text results (scored hits, hybrid attribution, ETags, changes feed, frontmatter, brief sections)                                      |
| `src/backend/errors.ts`      | Typed error taxonomy (`auth/validation/conflict/timeout/cancelled/availability/response-format/capability/not-persisted`)                                       |
| `src/backend/live/runner.ts` | Opt-in live runner (see below)                                                                                                                                  |

## Observable behavior

- **No constructor network I/O.** `KiwiFSAdapter` and `McpHttpTransport`
  perform nothing until `connect()`, which initializes and gates on the
  required tools from `tools/list` (capability-driven; no tool count is
  hard-coded — the live endpoint advertises 71 tools, the fixture is a subset).
  A missing required tool aborts before any mutation.
- **Errors.** Domain failures (`isError: true` JSON-RPC successes) become
  `ValidationError` — never retried. HTTP 401/403 becomes `AuthError`, a hard
  setup error, retried never. Only `AvailabilityError` (transport faults) is
  retried, at most once. A read of a missing path returns `{state: "missing"}`
  because read-back is control flow (B2 idempotency, guard step 1); other
  domain errors throw.
- **Limits (client-enforced):** search `limit` clamped to 50, content capped
  at 32 MiB, paths capped at 500 chars. Responses larger than the transport
  bound (default 48 MiB, header- and stream-enforced) produce
  `ResponseFormatError` without buffering beyond the bound.
- **Idempotency (B2).** `writeImmutable` implements read-before-write on the
  deterministic path: absent → write; identical content → no-op replay;
  differing content → `ConflictError` (fail closed, never overwrite). No CAS,
  no ETag-match, no exactly-once anywhere.
- **Redirects are refused** (`redirect: "error"` plus a 3xx check) —
  credentials never reach a redirected origin.
- **Timeouts/cancellation.** Per-request timeout plus the caller's
  `AbortSignal` combine into one signal; expiry yields `TimeoutError`, caller
  abort yields `CancelledError`. Cancellation propagates into the backend
  request (mcp-go per-request context, `mcp-contracts.md` §2).
- **Hybrid degradation** is detected only from per-result rank attribution
  (`keyword only` / `semantic only`) and surfaced as `degraded: true` — never
  inferred from status codes; keyword-only hits are degraded evidence, never
  semantic proof.
- **Guard pipeline (B3, fail closed at every step):** fresh `kiwi_read` →
  `memory_status` absent/active only → `$.scope` ∈ authorized scope set (the
  only gate on hybrid/brief legs) → path within `{scope}/memory/` → privacy
  redaction (pluggable `Redactor`; the real rules land in T06). The tombstone
  cache (`QueryMetaTombstoneCache`, §13 row 7 defaults: refresh on
  forget/reconnect/5-min TTL) is advisory pre-filtering only — a cache miss or
  a wrong advisory hit can never overrule the read-back.
- **Brief scope gate (§9 fixture 5a):** `kiwi_brief` has no scope parameter,
  so every returned page is guarded; if the kept pack falls below 25% of the
  cap, the pack is rebuilt from scoped search results (all guarded). No brief
  content passes unverified.
- **Secret hygiene.** Error messages are sanitized (bearer tokens and long
  token-like strings redacted); headers are never logged; `msg_id` truncation
  (16 hex) and the `_meta["kiwi.etag"]` carrier are fixture conventions
  pending live confirmation (see below).

## Opt-in live runner

`npm run test:live` runs `src/backend/live/runner.ts`. It is the only
sanctioned path to the dedicated test space (MCP 8182) per
`docs/research/live-mcp-runner.md` and `docs/test-environment.md`:

- Requires `KIWIFS_LIVE_TESTS=1` **and** the git-ignored local config
  (`config/kiwifs-test.local.json`, overridable via `KIWIFS_TEST_CONFIG`) with
  `enabled: true`, `space.provisioned/isolationVerified: true`, and the exact
  safety policy (`integration-tests/` prefix, no outside writes, no server
  administration). Every precondition failure aborts before any network
  traffic (exit code 3; suite failure after cleanup exits 4).
- Capability discovery runs first and aborts before mutation on a gap.
- Routing is verified before the first write (sentinel must be absent).
- The suite performs one synthetic CRUD/FTS round trip under
  `integration-tests/{random-run-id}/`, then manifest-owned cleanup in reverse
  order with post-delete verification; leftovers are reported, never ignored.
- Bounded duration (per-request 10 s, run 60 s defaults), at most one retry on
  transport faults, redacted diagnostics. Observed auth behavior is recorded
  as connectivity evidence — never as proof of authentication, VPN-only
  access or tenant isolation. Deletion is MCP-level only (B6: no
  history/index/backup purge is claimed).

Exit codes: 0 clean pass · 2 opt-in gate/config unreadable · 3 setup-blocked ·
4 suite-failed-after-cleanup.
