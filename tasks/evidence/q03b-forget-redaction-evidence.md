# Q03b — Forget reason redaction + namespace path safety (evidence)

Scope honored: forget reason redaction before backend/local persistent
metadata, and hardened namespace containment for the guard path-prefix step.
No new remote GC / personal-scope changes. No commit (final commit worker
owns commits). Synthetic loopback tests only; no real model calls, no real
secrets (canaries are fixture patterns), no network egress.

## Forget-reason entry-point trace

`/kiwifs-forget <path> [reason…]` (src/index.ts) → `forgetMemoryPath`
(src/commands/manual-ops.ts) — the ONLY production entry point carrying a
user-supplied reason. The reason persists in exactly two durable places:

1. Local: `ManualOpLog.record` → `manual-oplog.jsonl` (fsync, durable).
2. Backend: `store.forget({ reason, opId })` → `KiwiFSAdapter.forget`
   (src/backend/adapter.ts:391) → `kiwi_forget` arg `superseded_reason`
   (frontmatter on the record; body preserved, B6).

`unforgetMemoryPath` takes no reason (fixed provenance line); erasure report
discloses locations only. So redacting inside `forgetMemoryPath` covers both
sinks with a single choke point.

## Changes

- `src/commands/manual-ops.ts` — `sanitizeForgetReason()` wraps the existing
  T06 `redactText` (src/privacy/redaction.ts). The reason is redacted ONCE
  before BOTH sinks (op log + backend). Fail closed on the reason only: if
  redaction cannot classify (control chars / internal fault), the reason is
  HELD (omitted from both sinks); the forget itself proceeds (reason is
  optional metadata; unclassified content is never persisted) and the result
  detail discloses the hold without disclosing the reason text.
- `src/backend/guard.ts` — guard step 4 (path-prefix) replaced the raw
  `path.startsWith(`${scope}/memory/`)` with the hardened
  `pathWithinMemoryNamespace(path, scope)` helper from src/domain/paths.ts
  (rejects `..` segments, prefix-boundary abuse like `memory-evil/`, and
  validates the owner-scope form). Step 3 (authorized scopes) is untouched —
  the gate is strengthened, never weakened.

## Regression tests — test/q03b-forget-redaction.test.ts (5/5 pass)

Through production composition (`forgetMemoryPath` with the real
`ManualOpLog` on a temp dir + fake store mirroring the exact adapter wire
args; `guardCandidate` with the real `KiwiFSAdapter` over the synthetic
fake-mcp-server loopback):

1. Secret canaries (synthetic `sk-…` API key + `ghp_…` token) in the reason
   are redacted in BOTH durable sinks: wire args carry
   `[REDACTED:api-key:N]` / `[REDACTED:github-token:N]`, disk JSONL carries
   the placeholders, raw canaries appear nowhere; result detail is clean.
2. Hostile reason (control chars) → reason HELD: no `superseded_reason` on
   the wire, no `reason` key in the op log, forget still succeeds, detail
   discloses `reason held (could not be classified safely)`.
3. Ordinary clean reason flows through unchanged (no over-scrubbing).
4. Guard step 4 traversal/boundary variants rejected
   (`memory/../memory-evil/`, `observations/../secret.md`, `memory-evil/`,
   `memoryx/`), valid namespace paths still pass end-to-end; `..%2F` literal
   (a filename, not traversal) passes; real `../../` traversal rejected by
   the helper directly.
5. Scope gate NOT weakened: unauthorized `cross/other` scope still rejected
   at step 3 with an in-namespace path.

## Checks (actual, this working tree)

- `node --test test/q03b-forget-redaction.test.ts` — 5/5 pass.
- Full `npm test` — **509/509 pass** (500 pre-Q03b + 5 new + Q03a's 3 + 1;
  up from af996c4's 500), 0 fail, 0 skipped.
- `npm run check` — exit 0 (format, lint, 509 tests).
- `npm run pack:check` — packed extension loads in isolated Pi RPC.
- `devenv test` — exit 0, "Tests passed :)".
- Secret scan (explicit stage of ONLY the three touched files, then unstaged
  — no commit): no credential-pattern matches beyond the synthetic canary
  fixtures themselves. `tasks/evidence/t19-budget-report.json` and all other
  workers' uncommitted changes untouched.
