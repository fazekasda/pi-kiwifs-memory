# Reusable opt-in live MCP test runner — specification

Status: specification complete for T01. Implementation is assigned to **T04** (build the runner); suite execution against the dedicated test space is assigned to **T19**. This spec operationalizes the safeguards recorded in `docs/test-environment.md` ("Required runner safeguards") against the verified contracts in `docs/research/mcp-contracts.md`. The runner is the only sanctioned path to the live test service; there is no REST fallback and no other live access.

## Scope and transport

- Target: the dedicated test space's Streamable HTTP MCP endpoint only (`mcp.url` in the git-ignored, secret-bearing `config/kiwifs-test.local.json`; REST port 3336 and MCP port 8182 describe that deployment, but the configured `mcp.url` is authoritative — never assume REST and MCP endpoints are interchangeable).
- Transport: Streamable HTTP MCP only (`mcp-contracts.md` §2). Stateless sessions: re-initialize per logical connection; no SSE/resumability reliance.
- The runner is **opt-in**: never part of `npm test`, `npm run check`, CI defaults, or any automatic path. It runs only on explicit invocation (e.g. `npm run test:live` gate requiring an explicit env flag such as `KIWIFS_LIVE_TESTS=1` **and** the local config file present with `enabled: true`).

## Preconditions checked before any mutation (fail closed)

1. Config present, `enabled: true`, `space.provisioned: true`, `space.isolationVerified: true`; otherwise abort with a setup error — no network traffic.
2. Configuration safety fields (`safety.allowTestSpaceWrites: true`, `allowOutsideTestSpaceWrites: false`, `allowServerAdministration: false`, `requireVerifiedSpaceIsolation: true`, `recordPrefix: "integration-tests/"`, `cleanup: "current-run-only"`) must match the expected policy; the fields express intent, the runner enforces it.
3. **Routing verification before the first write**: read an exact synthetic sentinel path under the run's namespace, assert it is absent; initialize and `tools/list`; optionally read a known test-space marker. A successful header-bearing request proves connectivity only — never auth enforcement (`test-environment.md`); the runner records the observed auth behavior of the endpoint as evidence and makes no VPN-only or tenant-isolation claim.
4. Reject any HTTP redirect before following it; credentials must never reach a redirected origin.

## Run protocol

1. Generate a random run ID; every record is created beneath `integration-tests/{run-id}/`. The path prefix plus isolation-verified space are belt-and-suspenders; isolation is established by the separate server root, not the prefix (`test-environment.md`).
2. Maintain a **manifest** (in-memory and dumped redacted at run end) of every path the run created, in creation order.
3. Capability discovery via `tools/list` first: record the advertised tool names/version as run diagnostics. If any tool required by the suite (§3 table of `mcp-contracts.md`) is absent, abort before mutation with a capability gap report — the adapter is capability-driven and no count is hard-coded.
4. Execute the suite: synthetic CRUD round trip (create → read-back → update → FTS search → delete → post-delete absence), plus the T19 extensions. All payloads synthetic; no model calls; no real conversation data.
5. **Cleanup, manifest-owned**: delete exactly the manifest-owned paths, in reverse creation order, even after a partially failed test; verify absence with a post-delete read of each. Never delete anything not in the run's manifest; never touch production spaces; never attempt Git history or index manipulation. Cleanup is delegated to a `finally`-style pass and itself failure-tolerant (attempt every deletion, report leftovers).
6. **Bounded duration**: per-request timeout from config (`timeouts.requestMs`, default 10 s) and a total run deadline (`timeouts.runMs`, default 60 s) via one `AbortController` per run; on expiry, abort in-flight work, proceed directly to cleanup, report the timeout. No unbounded retries (at most one retry per request on transport-level faults, never on authorization errors).
7. **Redacted diagnostics**: logs and the run report contain tool names, paths, status codes, timings, and capability counts — never header values, URL credentials, response payloads beyond synthetic fixture echoes, or configuration secrets. The config file itself is never logged or echoed; the runner reads it programmatically and outputs no values.

## Reporting

The runner writes a summary: preconditions result, capability list, per-step pass/fail with timings, cleanup verification, and any leftover paths. Auth-observed behavior is labeled "connectivity evidence, not auth proof". Deletion is reported as MCP-level deletion only, never as history/index/backup erasure (B6).

## Failure policy

Any precondition failure, capability gap, routing anomaly, redirect, or deadline expiry aborts mutation and triggers cleanup of whatever was already created. Exit codes distinguish setup-blocked, suite-failed-after-cleanup, and clean-pass outcomes so T19 can gate on them.

## Notes on B1 reconciliation

B1 (unauthenticated standalone MCP on the production deployment's port 8181) governs the **production** endpoint choice. The live runner targets only this network-restricted dedicated test service; 8182's auth behavior is recorded as evidence each run and never assumed — a passing header-bearing run must never be cited as proof of authentication or tenant isolation (`test-environment.md`, `architecture-review.md` S-3).

## T19 execution addendum (implementation deltas)

Two deltas landed in T19 while executing the suite; both are backwards-compatible
with this spec:

- **Degradation disclosure.** A backend-side capability failure that cannot be
  verified live (observed: `kiwi_changes` returning `internal server error (HTTP
500)` IsError whenever the feed has entries, and an empty feed without
  `last_seq` otherwise) is recorded in `disclosedDegradations[]` and the run
  outcome becomes `clean-pass-with-degradations` (exit code **5**) when every
  core contract otherwise passed. Contract violations observable only when the
  feed works (e.g. identical-input replay divergence) remain hard failures.
- **Cleanup signal isolation.** Manifest cleanup uses a fresh abort signal, not
  the run's signal: a run-deadline expiry must never orphan manifest-owned
  records. Cleanup stays bounded via per-request timeouts.
- **Read-only retry.** Read-only suite calls (e.g. `kiwi_changes`) retry once at
  the runner level on any failure, per this spec's one-retry bound; the adapter's
  typed-error policy is unchanged.
