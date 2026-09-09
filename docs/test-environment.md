# Existing KiwiFS test environment

## Status

The dedicated test environment is provisioned and enabled in the local configuration. It uses a separate KiwiFS process, storage root, Git repository, SQLite index and pgvector table from the production `notes` space:

- Space: `pi-kiwifs-memory-test`
- Storage root: `/var/lib/kiwifs/pi-kiwifs-memory-test`
- REST port: `3336`
- Streamable HTTP MCP port: `8182`
- Vector table: `kiwi_vectors_test`
- Backup remote: none

MCP initialization and `tools/list` succeeded over the user's approved VPN transport; the endpoint advertised 71 tools and MCP server version `1.0.0`. Synthetic create, update, read, FTS search and delete checks passed. Cleanup was verified by a failing post-delete read. An exact-path read of the temporary test sentinel through the production MCP endpoint failed while it existed in the test space, confirming separate routing. No production records were listed, searched or modified, and no test records remain from provisioning checks.

Successful requests with an authentication header prove connectivity, not that the standalone proxy-mode MCP endpoint enforces authentication. Source research reports that this mode may rely on network isolation. The test endpoint therefore remains VPN-restricted and must not be exposed publicly. A reusable live test runner is not implemented yet; configuration safety fields describe required runner behavior but do not themselves enforce it.

The user approved a dedicated test space and all actions inside it. That approval does not extend to production spaces, server-wide destructive actions, or Git history rewrites.

## Local configuration

Edit `config/kiwifs-test.local.json`. This file is ignored by Git and formatting tools, with local permissions `0600`. Do not paste credentials into chat, commits, screenshots or logs.

- `mcp.url`: exact MCP Streamable HTTP endpoint for the test space, including its actual path. Do not assume REST and MCP endpoints are interchangeable.
- `mcp.headers`: authentication headers required by your deployment. For example, use an `Authorization` header only if your server expects it; the exact authentication scheme must be verified rather than guessed.
- `space.name`: dedicated space name, `pi-kiwifs-memory-test`.
- `enabled`, `space.provisioned` and `space.isolationVerified` are true in the ignored local file after successful provisioning checks. The tracked example remains disabled.

Prefer a credential restricted by the server to this test space. If the service only supports a shared key, the client must verify the routing mechanism before writes; the key itself does not enforce isolation.

The tracked `config/kiwifs-test.example.json` contains no credentials. To recreate the local file if missing:

```sh
(umask 077; cp config/kiwifs-test.example.json config/kiwifs-test.local.json)
```

Do not run that command over an existing populated configuration.

## Provisioning evidence

KiwiFS v0.19.62 does not expose space administration through its 71 MCP tools. The approved NixOS deployment therefore provisions the test space as separate `kiwifs-memory-test` and `kiwifs-memory-test-mcp` services. Both services were active after deployment. Isolation is established by separate server root and indexes, not by the `integration-tests/` path prefix or a client-provided label.

Provisioning validation used two random run IDs and manifest-owned paths. It covered routing isolation, tree visibility, create, overwrite/update, read-back, asynchronous FTS indexing, delete and post-delete absence. Cleanup succeeded for both runs. The production endpoint received only an exact read for the synthetic test path; no write was attempted there.

## Required runner safeguards

- Live testing is opt-in, never part of ordinary offline tests or public CI by default.
- Check configured space, connection routing and explicit enablement before mutation.
- Use random run IDs beneath `integration-tests/`; keep a manifest of records created by that run.
- Cleanup deletes only manifest-owned records in the dedicated space, even after a partially failed test.
- Reject redirects that could forward credentials to another origin.
- Bound requests and total run duration; avoid unbounded retries.
- Redact headers, URL credentials and sensitive response content from diagnostics.
- Use no model calls or real conversation data for initial backend tests.
- Never claim deletion purges Git history, indexes or remote backups.

## T19 live execution facts (dedicated space, MCP 8182)

Recorded during the T19 authorized live suite runs (synthetic records only,
manifest-owned cleanup, zero leftovers):

- 71 tools advertised; all adapter-required tools present.
- ETag carrier verified live on `kiwi_write` results (both create and update).
- FTS indexing is asynchronous (hit appears after indexing; miss disclosed).
- Hybrid search: synthetic record surfaced with `keyword only` attribution
  (vector index not ready within the run window) — degradation is disclosed,
  never counted as semantic evidence.
- `kiwi_changes` is NON-FUNCTIONAL on this deployment: persistent server-side
  `internal server error (HTTP 500)` IsError whenever the feed has entries (all
  cursor variants, immediate and after 30 s), and an empty feed with no
  `last_seq` when quiet — while read-back proves records exist. Local durable
  state remains authoritative (architecture.md §2); this is a deployment defect
  to report upstream, not a product blocker.
- Post-delete absence verified; deletion is MCP-level only (no Git-history,
  index or backup purge claim).
