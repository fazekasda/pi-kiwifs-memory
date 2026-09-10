# Architecture decisions

Status: product/technical choices confirmed through two user interviews. Final architecture and implementation contracts still require review. These decisions override conflicting research recommendations.

## Confirmed scope

Primary: observational memory. Secondary: redacted full-session backups and agent-to-agent project message board. Extension connects to an existing KiwiFS service; no backend lifecycle management.

## Confirmed technical choices

1. **MCP is required in the first release.** A REST-only release does not satisfy requirements. REST fallback is not approved by this decision; unsupported MCP capabilities must be surfaced, not silently replaced.
2. **Backup:** redacted complete session tree and tool outputs. Omit binaries and record omissions explicitly in a manifest. Do not claim byte-identical recovery.
3. **Forgetting:** reversible logical forgetting, plus a documented operator purge procedure. No automatic Git history rewriting and no unsupported secure-erasure guarantees.
4. **Board:** project channels ship in scope. Recipient labels route messages; they do not provide confidentiality from other holders of the shared backend key. No automatic execution of board content.
5. **Project identity:** normalized Git remote identity with explicit override. Strip credentials; do not expose raw private remotes unnecessarily. Cross-project recall requires per-session opt-in.
6. **Observation cadence:** check each settled response, extract at configurable thresholds, support manual extraction and bounded pre-compaction flush. Continue compaction after failure with visible pending work and durable source coverage.
7. **RAG:** after each eligible user input; 3,000-token evidence cap and two-second total retrieval deadline, both configurable. The deadline covers the whole retrieval operation, not each fallback attempt. Integrate source-labeled evidence as untrusted data.
8. **Outbox:** durable private local storage outside Pi session files. Continue Pi during backend outages. Storage format, exact size/retention defaults, locking and reconciliation must be specified and tested.
9. **Runtime model:** configurable, default OpenRouter `z-ai/glm-5.3-flash`. Do not silently substitute a model.
10. **Privacy:** redact before outbound storage/model/search calls, configurable exclusions, private mode with no feature reads/writes, sanitized activity log.
11. **Memory lifecycle:** automatic observation writes with inspection/undo. Detect duplicates, propose merges and flag conflicts rather than silently replacing disputed source facts.
12. **Scopes:** project and personal-global memory, cross-project opt-in. Backend authorization and client organizational scope must be documented separately.
13. **Personal-scope writes (Q05, user-approved):** personal-global memory writes exist ONLY via an explicit user action (a user-initiated command, confirmed in the TUI or via explicit `--yes` in headless mode). Nothing writes the `personal` scope automatically; project-scoped observations, reflections and proposals are never automatically promoted to `personal`, and no capture/reflection path may call the personal write surface. Personal records reuse the existing record schema, provenance and idempotent outbox delivery (kind `observation`, scope `personal`); personal routing is invalid for project-only features (reflections, merge proposals, backups). Remote board GC is NOT part of this decision: the user handles board cleanup manually for now; any remote GC feature requires its own explicit approval and a separate later task.

## Development constraint

All subagents must use `openrouter/z-ai/glm-5.3-flash` unless the user changes this instruction. No npm publication without approval. Current work is research, planning and architecture, not implementation.

## Still to specify

- Exact MCP tool schemas, auth and pagination/filtering behavior for the verified backend revision.
- Observer input thresholds, reflection budget, queue size/retention/overflow policy and safe private-mode transition behavior.
- Board notification timing, polling limits, cursor and acknowledgment conventions.
- Backup export/recovery format and schema compatibility guarantees.
- Verified Pi hook sequencing for user input, queued/steering messages and bounded context injection.

These are engineering proposals to state explicitly in the architecture. Any required change to confirmed scope or privacy policy requires user approval.
