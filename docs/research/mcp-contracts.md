# KiwiFS MCP contracts — verified

Status: verified contract record for the backend the extension targets. Derived from public source `github.com/kiwifs/kiwifs` at revision `3961d5e70a9e0ef457e58e29c40c52c870d57e73` (HEAD = "chore(main): release 0.19.62 (#509)", v0.19.62). Deployment definition inspected at `/home/fazekasda/projects/SelfHosted/KiwiFS/nixos/kiwifs.nix` (structure only; no secrets, no live probes). All line references are to the pinned revision.

Scope: research only. Nothing was written, mutated, probed live, or published. Pi-side claims in this document were additionally checked against the locally installed Pi 0.85.0 (`node_modules/@earendil-works/pi-coding-agent@0.85.0`); those citations are marked [Pi].

Companion documents: `docs/decisions.md` (confirmed user choices — authoritative), `docs/architecture.md` (proposed architecture using these contracts).

## 1. Deployment wiring (verified, secret-free)

- Main service: `kiwifs serve --root … --search sqlite --versioning git --s3 --webdav` on `:3333`; `auth.type = "apikey"`; vector embedder `openai` provider via OpenRouter base URL, pgvector store, chunk 400/50; `space.name = "notes"` (`nixos/kiwifs.nix:100–132`; ExecStart at `nixos/kiwifs.nix:193`).
- Dedicated MCP service: `kiwifs mcp --remote http://127.0.0.1:3333 --api-key "$KIWI_API_KEY" --http --port 8181` (`nixos/kiwifs.nix:304–317`). The deployed MCP is therefore **proxy mode**: MCP server → REST backend (`internal/mcpserver/client.go:22–43`).

## 2. Transport, auth, sessions, cancellation

- Transports: stdio (default) or Streamable HTTP mounted at `/mcp` (`cmd/mcp.go:35–43`; `internal/mcpserver/mcpserver.go:3079–3086` — `server.NewStreamableHTTPServer(s, WithEndpointPath("/mcp"), WithStateLess(true))`). The main server also mounts MCP at `/mcp` with apikey bearer auth (`internal/api/server.go:299,711–712`; `cmd/serve.go:291–299,441–449`).
- **Auth gap (blocker B1):** in standalone `kiwifs mcp --remote --http` mode, `httpAuthToken` returns `""` when `Root == ""` (`mcpserver.go:3048–3054`), and `bearerAuth("")` is a passthrough (`mcpserver.go:3172–3185`). **The deployed port-8181 MCP endpoint has no MCP-layer authentication.** Only the main server's `/mcp` (port 3333) enforces `Authorization: Bearer <api key>` with constant-time compare (`mcpserver.go:3068–3076, 3172–3185`). Deployment mitigation is network-level only (NetBird/LAN). The adapter must target the authenticated 3333 `/mcp` or a network ACL for 8181 must be mandated — this is documented, not assumed.
- Stateless sessions: `WithStateLess(true)` → `StatelessSessionIdManager` ignores session IDs; no session tracking (`mcp-go v0.49.0`, `server/streamable_http.go:40–55, 1465–1483`). No resumability / `Last-Event-ID` replay; no server session state; no server-initiated notifications can be relied on. Every logical connection re-initializes.
- Version negotiation is handled by mcp-go v0.49.0 initialize (server identifies as `kiwifs` / `1.0.0`, `mcpserver.go:96–101`).
- Cancellation: tool handlers run on the HTTP request context; client disconnect/context cancel propagates into `RemoteBackend` calls (`client.go:39–41` uses `NewRequestWithContext`); in-flight results are keyed per-request (`streamable_http.go:1310+`). Cancellation of a request aborts backend REST calls — the mechanism the 2 s RAG deadline relies on.

## 3. Tool registration — exact names and key schemas

Registered in `registerTools` (`mcpserver.go:104–928`) and `registerMemoryTools` (`memory_tools.go:23–40`), plus resource `kiwi://schema` (`mcpserver.go:930–960`). The source audit enumerated 61 tool **name patterns** at this revision (the list contains wildcards such as `kiwi_draft_*`, `kiwi_canvas_*`, `kiwi_workflow_*`, `kiwi_views_*`, so 61 is a count of enumerated patterns, not of concrete tools); however, **live capability discovery against the provisioned test endpoint (`docs/test-environment.md`, MCP port 8182) advertised 71 tools**.

**Disposition (T01):** the discrepancy is informational. The adapter is capability-driven: it discovers tools at connect time via `tools/list` (authoritative), hard-codes no count, and gates only on the presence of the ~14 tools in the table below. The source list's wildcards (`kiwi_draft_*`, `kiwi_canvas_*`, …) mean 61 undercounts concrete tools by construction, so 71 live registrations are expected rather than anomalous. The discrepancy would only become actionable if a required table tool turns out to be missing live — the live runner's capability pass (T04, `docs/research/live-mcp-runner.md`) aborts before mutation in that case and reports the gap. The 61 names identified in source: `kiwi_read, kiwi_write, kiwi_search, kiwi_tree, kiwi_query_meta, kiwi_query, kiwi_view_refresh, kiwi_delete, kiwi_rename, kiwi_bulk_write, kiwi_aggregate, kiwi_import, kiwi_ingest, kiwi_export, kiwi_export_document, kiwi_changes, kiwi_append, kiwi_search_semantic, kiwi_search_hybrid, kiwi_brief, kiwi_backlinks, kiwi_analytics, kiwi_memory_report, kiwi_suggestions, kiwi_embeddings, kiwi_graph_analytics, kiwi_graph_centrality, kiwi_graph_communities, kiwi_graph_path, kiwi_peek, kiwi_similar, kiwi_section, kiwi_graph_walk, kiwi_velocity, kiwi_timeline, kiwi_context, kiwi_health_check, kiwi_eval, kiwi_eligible, kiwi_claim, kiwi_task_create, kiwi_task_progress, kiwi_cite, kiwi_release, kiwi_draft_*, kiwi_lint, kiwi_clip, kiwi_canvas_*, kiwi_versions, kiwi_claims_list, kiwi_feed, kiwi_workflow_*, kiwi_views_*, kiwi_remember, kiwi_forget`.

Contracts the extension depends on:

| Operation  | Tool                   | Schema / behavior (cited)                                                                                                                                                                                                                                               |
| ---------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read       | `kiwi_read`            | `path` (required, ≤500 chars), `resolve_links`, `metadata_only`, **`if_not_etag`** → `not_modified` + etag when unchanged (`mcpserver.go:110–123, 1037–1066`)                                                                                                           |
| Write      | `kiwi_write`           | `path`, `content` (required, ≤32 MiB), `actor` (default `mcp-agent`), `provenance` (`type:id`); returns `Written <path> (ETag: <etag>)` (`mcpserver.go:124–135, 1070–1096`). **No If-Match/conditional write on the MCP path**                                          |
| Append     | `kiwi_append`          | atomic append, no read-modify-write race; `path`, `content` required, `separator` (default `\n`), `actor`; returns ETag (`mcpserver.go:334–345, 1713–1734`). `idempotencyHint` false — replays duplicate by design                                                      |
| Delete     | `kiwi_delete`          | git-committed deletion, history preserved (`mcpserver.go:197–205, 1922+`)                                                                                                                                                                                               |
| FTS        | `kiwi_search`          | `query` required; `limit` default 20 **max 50**; `offset` pagination; `path_prefix`; `scope` (exact frontmatter `$.scope` match); `recency_weight`; text result with numbered `path (score)` + snippet + "Use offset=N to see more" (`mcpserver.go:136–149, 1102–1168`) |
| Semantic   | `kiwi_search_semantic` | `query`, `limit` default 5 max 50, `threshold` (client-side post-filter of scores), `scope`; scores to 3 dp (`mcpserver.go:346–357, 1844–1897`)                                                                                                                         |
| Hybrid     | `kiwi_search_hybrid`   | `query`, `limit` default 15 max 50, `path_prefix` only — **no `scope`**; per-result engine attribution `both / keyword only / semantic only` (`mcpserver.go:358–368, 1794–1841`)                                                                                        |
| Brief      | `kiwi_brief`           | `query`, `budget_tokens` (default 4000), `max_pages` (default 20), `path_prefix`; pack + manifest of dropped items with token costs (`mcpserver.go:369–380, 1737–1792`)                                                                                                 |
| Changes    | `kiwi_changes`         | `since` = commit-hash cursor (exclusive), `limit` default 50 max 500; returns paths/actions/actors/timestamps + `last_seq` (`mcpserver.go:324–333, 1682+`)                                                                                                              |
| Remember   | `kiwi_remember`        | writes `episodes/{YYYY-MM-DD}/{episode_id}.md` with `memory_kind: episodic`, `episode_id` (UUID), `created`, `scope`, `tags` (`memory_tools.go:24–40, 41–89, 93–120`)                                                                                                   |
| Forget     | `kiwi_forget`          | sets `memory_status: superseded`, `valid_until`, optional `superseded_reason`; reversible, body preserved (`memory_tools.go:31–40, 108–153`)                                                                                                                            |
| Meta query | `kiwi_query_meta`      | frontmatter filters `$.field=value`, AND/OR groups, sort, `limit`/`offset` (`mcpserver.go:161–175, 1243+`) — the board-listing primitive                                                                                                                                |

Error behavior: all domain failures return `mcp.NewToolResultError(...)` with `err=nil` → `result.IsError = true` inside a JSON-RPC success (`mcpserver.go:1042, 1047, 1081, 1108, 1140`, etc.). Missing content/path → explicit "query is required" / "content is required". Only a handler panic (recovery middleware, `mcpserver.go:98`) yields a transport-level error. ETags are returned on every mutation and surfaced in text results — usable for optimistic read-back compare, but there is **no server-side conditional write over MCP**.

## 4. Search internals

- **FTS scope filtering is SQL-side**: `SearchWithOptions` adds `EXISTS (... json_extract(frontmatter,'$.scope') = ?)` inside the FTS query, plus `pathPrefix LIKE` (`internal/search/sqlite.go:449–516`). Superseded records are excluded by default: `AND COALESCE(LOWER(json_extract(...,'$.memory_status')),'') != 'superseded'` (`sqlite.go:477–479`). Deleted pages leave the FTS index via pipeline delete.
- **Semantic scope filtering is post-candidate**: `LocalBackend.SearchSemanticScoped` fetches `searchLimit = max(limit, 200)` candidates then filters via `FilterByScope` (`mcpserver/local.go:463–509`; `search/sqlite.go:1788–1822`). `SearchFiltered` widens fetch up to `maxFilteredFetch = 4096` then gives up (`vectorstore/service.go:318–327`). Confirms the earlier lead: raising top-k is not an authorization fix; under-recall is real when the top-200 candidates are scope-mismatched.
- **Hybrid silently degrades to FTS-only** when no vector service exists or on vector-side error: lexical results are returned, HTTP/tool result is still success; the per-result rank attribution (`keyword only, #n`) is the observable tell (`internal/hybrid/hybrid.go:63–122, 1794–1841`). Contract tests must assert on `describeHybridRanks` output, not status.
- **Hybrid/semantic do NOT exclude superseded memory.** The lexical side of hybrid calls `SearchWithOptions` with only `ExcludePrefixes` (`hybrid.go:156–160`), so that side is clean; but the semantic side (`Vectors.Search`/`SearchFiltered`, `hybrid.go:205+`) has **no `memory_status` filter**, and `kiwi_forget` only rewrites frontmatter — the page is re-embedded as-is. **Forgotten records can still surface via `kiwi_search_semantic`, `kiwi_search_hybrid`'s semantic side, and `kiwi_brief`'s vector leg.** FTS, `kiwi_search` with `scope`, and raw `kiwi_read` are unaffected. The adapter must compensate (tombstone guard, §8).
- **Vector indexing is asynchronous with silent drops**: `submit()` drops jobs when the queue is full and only logs (`vectorstore/service.go:178–184`); deletes likewise (`EnqueueDelete` → `RemoveByPath` in worker). A deleted page whose delete job was dropped can leave stale vectors — a concrete fixture for "deleted records in recall". Index lag is inherent (no read-your-write guarantee).
- Hybrid `path_prefix` is applied on the lexical side in SQL and by post-filter `keep()` on the semantic side (`hybrid.go:44–46, 205–214`).

## 5. Board primitives

**No dedicated board tools exist in MCP.** `kiwi_workflow_board` is a Kanban view of workflow-state pages, not a message board. Verified primitives that can host a board as an MCP-side convention (these are the only MCP surfaces — nothing is being silently replaced by REST):

- Send: `kiwi_append` to an immutable per-channel log path, or `kiwi_write` of one file per message (`board/{channel}/{msg_id}.md`) with frontmatter (`to`, `from`, `msg_id`, `created`, `ttl`) — replay idempotency via deterministic `msg_id` path + read-before-write.
- List/read: `kiwi_query_meta` with `$.to=...` filters, sort, limit/offset.
- Delivery cursor: `kiwi_changes` with `since` commit-hash cursor + `last_seq` — durable and reconnect-safe. No TTL enforcement, no push notifications (stateless SSE only): polling via `kiwi_changes` is the only verified delivery mechanism; TTL is enforced client-side at read time.
- Confidentiality limits confirmed: single apikey backend; scope/recipient labels are organizational conventions only (`bearerAuth` single token, `nixos/kiwifs.nix:123–125`). Board messages are untrusted data — nothing in MCP executes them.

## 6. Pi 0.85.0 event surface [Pi]

Verified against the locally installed `node_modules/@earendil-works/pi-coding-agent` 0.85.0.

- Full event list: `dist/core/extensions/types.d.ts:813` (union `ExtensionEvent`), re-exported via `dist/index.d.ts`. Relevant: `input`, `before_agent_start`, `agent_start`/`agent_settled`/`agent_end`, `context`, `before_provider_request`, `session_before_compact`, `session_before_fork`/`session_before_switch`/`session_before_tree`, `session_shutdown`.
- **Retrieval before the first LLM call is possible and ordered**: `input` handlers are awaited synchronously inside prompt submission _before_ skill/template expansion and agent start, including queued inputs (`dist/core/agent-session.js:844–854`: `emitInput` is awaited; `streamingBehavior: "steer" | "followUp"` passed through, `undefined` when idle). A ≤2 s retrieval awaited in the `input` handler completes before the provider call. Fresh vs queued is distinguishable via `InputEvent.streamingBehavior` (`types.d.ts:657–667`). There is **no native generic `message` hook** — the earlier PRD lead is confirmed correct.
- Injection point: `before_agent_start` fires once per agent-run start and its handler result carries **one** custom extension message (`result.message`, singular — `types.d.ts:845–849`); the plural `messages` array exists only inside Pi's internal runner (`runner.js:888–926`, `agent-session.js:919`). An extension providing both an evidence pack and any other custom message must merge them into a single message per handler invocation. The handler can also override the system prompt, before the provider call (`agent-session.js:914–932`). The `context` event fires per provider request with replaceable `messages` (`types.d.ts:514–516, 814–816`) — the only viable delivery point for evidence matched to a steered/followUp input (no new `before_agent_start` fires for queued inputs), but it fires on every LLM call including tool loops, so evidence must be matched to the consumed input and deduped; `before_agent_start` remains the single-shot injection for fresh turns.
  Queued inputs and expansion divergence: `emitInput` receives the raw text **before** skill/template expansion (`agent-session.js:841–853`), but queued steer/followUp messages are stored and replayed by Pi as **expanded** text (`agent-session.js:853–868`), and a `followUp` may begin a _new_ agent run after the current one settles — still with no `before_agent_start` (that emission exists only inside `prompt()`, `agent-session.js:915`). Any input-matching scheme (e.g. matching retrieval packs against `context.messages`) must therefore fingerprint the raw input-event text and treat all `/`-prefixed inputs as ineligible, since only those are never expanded.
- **Pre-compaction flush**: `session_before_compact` is awaited with no built-in timeout; the event carries `preparation`, `branchEntries`, `reason`, `willRetry`, and a `signal` (compaction abort); the handler result may set `cancel` or supply `compaction` (`agent-session.js:1496–1512`; `types.d.ts:857–860`). Boundedness is the extension's responsibility: honor `signal`, self-timeout, never `cancel` by default (matches `docs/decisions.md` #6).
- Session lifecycle hooks with cancellation results exist for fork/switch/tree/shutdown (`types.d.ts:850–873, 919–938`) — sufficient for generation tracking (PRD T08).

## 7. Capability matrix (MCP-only)

| Requirement (decisions.md)                    | MCP-capable                 | Notes                                                                                                                             |
| --------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Observational memory writes (auto extraction) | ✅                          | `kiwi_write`/`kiwi_remember` + `kiwi_bulk_write`; actor/provenance recorded                                                       |
| Reversible forget                             | ⚠️                          | `kiwi_forget` works; **semantic/hybrid recall can leak superseded pages** (§4)                                                    |
| Duplicate/merge/conflict detection            | ✅                          | client-side over `kiwi_query_meta`, `kiwi_search_semantic` near-dup checks                                                        |
| Per-input RAG ≤3000 tok, ≤2 s                 | ✅                          | `kiwi_brief` (`budget_tokens`) or `kiwi_search`; deadline enforced client-side; cancellation propagates                           |
| Scope filtering without cross-scope leakage   | ✅ FTS / ⚠️ semantic        | semantic post-candidate filter → bounded under-recall, never leakage; disclose and measure                                        |
| Deleted/forgotten exclusion                   | ✅ FTS / ⚠️ semantic+hybrid | stale vectors possible on dropped delete jobs                                                                                     |
| Session transcript backup                     | ✅                          | `kiwi_write` chunks + manifest file; `kiwi_changes` for coverage reconciliation; binaries omitted by client policy                |
| Message board                                 | ✅ (convention)             | files + `kiwi_query_meta` + `kiwi_changes`; no TTL/notification primitives                                                        |
| Cross-project opt-in                          | ⚠️                          | one `scope` string convention per backend key; no per-path authorization; client must enforce opt-in                              |
| Conditional writes / optimistic concurrency   | ❌ over MCP                 | ETags returned but no If-Match tool argument; If-Match appears REST-only (`handlers_file.go` CORS headers). Surface as limitation |
| MCP in v1                                     | ✅                          | full tool surface, stdio + Streamable HTTP, apikey auth on 3333 `/mcp`                                                            |

**MCP-only is viable** for all three feature domains. The gaps are quality/consistency gaps, not missing operations.

## 8. Minimum adapter interface

```
init(endpoint, authRef, space) -> capabilities(backend mode, vectorEnabled?)
read(path, {if_not_etag?}) -> {content|not_modified, etag}
write(path, content, {actor, provenance, msgIdForIdempotency}) -> {etag}
append(path, content, {separator, actor}) -> {etag}
del(path, actor) -> void
search({query, scope, pathPrefix, limit, offset, mode: fts|semantic|hybrid, threshold?}) -> results[]
brief({query, budgetTokens, maxPages, pathPrefix}) -> pack
changes(since, limit) -> {changes, lastSeq}
forget(path, reason) -> {etag}          // paired with adapter-side recall guard
listMeta(filters, {sort, limit, offset}) -> rows
```

Adapter-level guard required, applied per candidate before injection (each step fail-closed): (1) fresh `kiwi_read` of the hit (404/missing → reject); (2) status check — reject unless `memory_status` is absent or `active` (`kiwi_forget` sets `superseded` while the body remains readable, `memory_tools.go:108–153`, so content-exists is **not** a pass); (3) scope check — `$.scope` must be in the session's authorized scope set (a record's `scope` is a single owner value; hybrid/brief carry no `scope` parameter, so this client-side check is the only scope gate on those legs); (4) path-prefix check within the scope's `memory/` namespace; (5) privacy redaction of content. A locally cached tombstone list (superseded paths from `kiwi_query_meta` on `$.memory_status=superseded`, scoped to the authorized scope set, refreshed on forget/reconnect/bounded TTL) is advisory pre-filtering only — a cache miss never permits injection. Vector health is never inferred from keyword-only hybrid hits; rank attribution (`keyword only`) means degraded, not semantic.

## 9. Contract-test fixtures (synthetic, no live service)

Implemented as data fixtures in `test/fixtures/mcp/` with a citation-tracing catalog in `docs/research/adapter-fixtures.md` (T01). Fixture 11 (Pi-side ordering/matched injection) remains a spec-level requirement owned by T08/T12/T13.

1. Scope under-recall: 250 same-topic pages, 10 scoped; semantic scope query returns ≤200-candidate filter set — assert zero cross-scope hits, accept and record the shortfall.
2. Superseded leak: `kiwi_forget` a page, then semantic/hybrid query — expect it can appear; assert the adapter tombstone filter removes it.
3. Stale vector: delete a page while simulating a dropped vector job (unit-level against `vectorstore.Service.submit` semantics); assert FTS excludes, semantic may include, adapter read-back re-verification catches it.
4. Hybrid fallback: no-vector config → assert results carry `keyword only` rank attribution, HTTP-equivalent success.
5. ETag conditional read: unchanged `if_not_etag` → `not_modified`; changed → content.
   5a. Brief scope gate: a `kiwi_brief` pack containing a page whose read-back `$.scope` is outside the session's authorized scope set → adapter drops that page (fixture asserts the drop and the fallback rebuild from scoped search results).
   5b. Board dual-sender collision: two senders, identical payload, same sender sequence → distinct `msg_id` paths (op-id-derived), both messages persist (guards against content-derived message IDs merging distinct messages).
   5c. Read-back predicate: `kiwi_forget` a page, then verify the adapter rejects it on read-back (status check), including the case where the local tombstone cache is stale or empty (cache is advisory only).
6. Append race: two `kiwi_append` on one path → both persisted (git commits), no lost update.
7. Changes cursor: write A, checkpoint, write B, `kiwi_changes(since)` → only B; replay with same `since` → idempotent.
8. Limits: query limit 60 → clamped 50; 33 MiB content → rejected; 501-char path → rejected.
9. isError: missing-path read → `IsError=true`, `err=nil` JSON-RPC success.
10. Auth: wrong bearer to 3333 `/mcp` → 401 constant-time path; port 8181 with token unset → accepted (documented exposure).
11. Pi ordering [Pi]: headless/RPC — `input` handler awaits a 50 ms retrieval; assert evidence precedes the first `before_provider_request`; a steer-queued input mid-stream gets its own retrieval cycle **and its evidence pack is injected on the provider call that consumes that steered input, verified by matching the pack's input fingerprint against the user message in `context.messages` — not merely on the next `context` fire or at submission; an unmatched pack is dropped fail-closed at run settle**; the fixture must include a variant with privacy redaction active and a variant with a template-expanded queued input — the fingerprint matches raw input-event text, so neither may break the match; a `session_before_compact` handler honoring `signal` never blocks compaction past its bound.

## 10. Hard blockers / must-document limitations

1. **Unauthenticated standalone HTTP MCP (port 8181)** — the extension must target 3333 `/mcp` (apikey bearer) or mandate a network ACL for 8181; cannot be left implicit.
2. **No conditional (If-Match) writes over MCP** — outbox idempotency must use deterministic paths/content, not optimistic concurrency; document the lost-update window for `kiwi_write`.
3. **Superseded/deleted content can surface via semantic and hybrid search** — adapter tombstone guard + read-back verification required (PRD T12/T18).
4. **Semantic scope filtering is post-candidate (200/4096 caps)** — bounded under-recall is a permanent property; document it, never promise top-k parity.
5. **No board TTL/notification primitives** — polling via `kiwi_changes` only; client-side TTL; no exactly-once delivery claims.
6. **No history-purge tool** — consistent with `docs/decisions.md` #3; permanent erasure stays an operator procedure.

## 11. Corrections to earlier research

Earlier research (run `kiwifs-observation-design-research-mtsr63ba-snksmt`, PRD header) reported leads at the same revision. Verified status:

- "Semantic scope filtering occurs after candidate selection" — **confirmed** (`mcpserver/local.go:463–509`; `search/sqlite.go:1788–1822`), with exact caps 200/4096.
- "Hybrid can return HTTP 200 while using only FTS" — **confirmed**, and the observable signal is per-result engine attribution, not status (`hybrid.go:63–122`; `mcpserver.go:1794–1841`).
- "Vector indexing is async and may drop jobs" — **confirmed** (`vectorstore/service.go:178–184`); dropped deletes additionally leave stale vectors, which earlier research did not state.
- "Single-key deployment lacks per-path authorization" — **confirmed**; also newly found: the standalone port-8181 MCP has _no MCP-layer auth at all_ (§2), which earlier research did not report.
- "No history-purge API" — **confirmed**.
- "REST and MCP both deployed" — confirmed, but the deployed MCP at 8181 is proxy-mode and unauthenticated; the authenticated MCP surface is 3333 `/mcp`. The extension design must treat MCP as the sole transport (decisions.md #1).
- Earlier reports did not verify the superseded-recall leak in semantic/hybrid (§4) or the absence of conditional writes over MCP (§3); both are now confirmed gaps and are reflected as blockers B2/B3 in `docs/architecture.md`.
