# T19 chunk 1 workplan — close the remaining AC1 fault-matrix gaps

Task label: T19_fault_feed (chunk 1). Prior state: ed193c914ed1 (PARTIAL T19;
AC1/5/6/7 unchecked). This chunk closes the four AC1 gaps named in the PRD
note plus the `kiwi_changes` 500 board-delivery consequence. Synthetic-only:
in-process fake MCP server, zero live service contact, zero model calls, no
commit (final worker commits).

## Scope

1. **Brief-leg cross-scope leakage (dedicated case)** — real integrated
   pipeline (KiwiFSAdapter → fake MCP server → RetrievalCoordinator): brief
   pack containing out-of-scope, superseded, and fabricated-body sections
   (the fake brief ignores `path_prefix`, mirroring the contract: brief has
   no scope param). Assert guard drops (scope/status steps), fabricated brief
   text never reaches the pack (guard re-reads), zero canaries, kept section
   attributed leg `brief`.
2. **Malformed SEARCH output (dedicated case)** — fake-server text override
   returns malformed FTS/semantic/hybrid result text (score-less lines,
   negative scores, unknown hybrid attribution, canary-bearing garbage).
   Assert: parsers fabricate nothing, coordinator completes with visible
   degradation, no crash, canaries never reach the pack.
3. **Dropped vector jobs (dedicated simulation)** — two cases:
   a. dropped INDEX job (`state.semanticDropPaths`): record absent from the
   semantic leg, present via FTS + keyword-only hybrid → recalled via FTS,
   B4 under-recall measured/reported, no semantic claim.
   b. dropped DELETE job (`state.staleSemanticPaths`): deleted record still
   surfaced by semantic/hybrid → guard read-back rejects (missing), zero
   canaries in pack or notes.
4. **Backend upgrade compatibility** — real pipeline fixtures:
   a. additive upgrade (extra tools in `tools/list`, bumped serverInfo
   version) → connect succeeds, capability-driven, delivery + retrieval
   still work;
   b. regressive upgrade (required tool removed) → `connect()` fails closed
   BEFORE any mutation (request log proves no write);
   c. additive response-shape evolution (extra unknown lines in changes/
   search text) → parsers tolerate, delivery + changes parsing unaffected.
5. **`kiwi_changes` 500 → actual board delivery impact, reproduced and
   remediated** — the live deployment fails `kiwi_changes` with a server-side
   IsError HTTP 500 whenever the feed has entries (t19-live-report.json).
   Inbound board discovery is feed-based, so delivery is DEAD on that
   deployment; the outbox is outbound-only and does NOT solve inbound
   discovery (pinned by test: the outbox send path issues no listing call).
   Remediation implemented in this chunk (contract supports full
   requirements — no blocker):
   - `BoardRepository.listAllBoardMessagePaths()`: MCP-only paginated
     discovery via `kiwi_query_meta` filters `{type: "board-message"}`,
     limit/offset paging (BOARD_LIST_MAX page size, bounded pages, strict
     board-path shape post-filter, offset-ignoring-backend guard,
     truncated disclosure, private-mode assert). Every delivery read still
     goes through the existing fresh-read parse/TTL pipeline, so the
     discovery set is exactly the deliverable message set (the read path
     rejects non-`board-message` records as malformed either way).
   - `BoardDelivery.runCycle()`: when the feed fails with a NON-retryable
     domain rejection (the live IsError-500 shape), run ONE bounded listing
     fallback pass per cycle through the SAME read/skip/deliver pipeline
     (dedupe, recipient policy, TTL, created-order, durable markers).
     Availability faults still pause as today. Cursor untouched in fallback
     mode; dedupe absorbs overlap when the feed recovers. Disclosed via
     `CycleResult.discoveryFallback` / `DeliveryStatus.discoveryFallback`
     and the board-inbox polling line. Truncated listings are visible
     (`listingTruncated`), never silent.
   - Tests: reproduction (feed-domain-fault + fallback-unavailable → paused,
     nothing delivered, cursor untouched), fallback delivery + dedupe +
     disclosure, feed-recovery resumption without double delivery, outbox
     outbound unaffected / never claimed as inbound discovery, bounded
     offset-ignoring backend, private mode zero reads in fallback.

## Out of scope (later chunks; honest gaps)

- AC5 measured latency/context/extraction budgets; AC6 documented quality
  expectations; AC7 full long-session handle audit; live suite re-run.
- `docs/decisions.md` untouched (no user-approved change required: the
  fallback is MCP-only, uses a verified primitive already named in
  architecture.md §8 as the board-listing primitive, and weakens no gate —
  the same records the feed would deliver, same client-side policy).

## Files

- `test/fake-mcp-server.ts` — fault-injection additions (text overrides,
  extra/removed tools, serverInfo version, semantic drop/stale sets,
  changes-fault-when-populated).
- `test/t19-fault-matrix.test.ts` — new integrated cases (1–4) + outbox-is-
  not-inbound-discovery assertion.
- `test/board-delivery.test.ts` — changes-500 fallback suite (5).
- `src/board/repository.ts`, `src/board/delivery.ts` — fallback
  implementation (MCP-only, bounded, disclosed).
- `src/board/tools.ts` — disclose fallback state in `kiwifs_board_inbox`.
- `docs/architecture.md` §8/§12 — fallback mode documented as a disclosed
  degradation mode (B5 consequence of the observed deployment defect).
- `tasks/execution-log.md`, `tasks/prd-kiwifs-memory.md` — evidence +
  remaining-gaps record (checkboxes stay unchecked; no commit).

## Gates after final edits

`npm run check` (typecheck + format + full suite), `npm run pack:check`;
Node 22.19.0 exact floor if obtainable (npx pinned version); `devenv test`.
No commit.
