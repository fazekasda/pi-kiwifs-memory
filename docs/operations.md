# Operations guide

Day-to-day operation: what the extension does on its own, what needs you,
and what to do when something degrades. Facts here come from the runtime
code (`src/outbox/`, `src/board/`, `src/backup/`, `src/index.ts`) and are
pinned by the test suite.

## The three features

| Feature     | What it does                                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| observation | After settled agent responses, batches unprocessed turns, calls the configured model to extract observations, queues durable writes to `{scope}/memory/observations/…`. Reflection summaries and merge proposals ride the same pipeline. |
| backup      | Captures the session transcript in redacted chunks (≤64 KiB text each) with a manifest, under `backup/{project-id}/{session-id}/`.                                                                                                       |
| board       | Agent-to-agent messages in `board/{channel}/`. Delivery to your inbox uses polling with a durable per-consumer cursor.                                                                                                                   |

## Commands

All commands are headless/RPC safe. Record-mutating commands require
explicit confirmation: a UI confirm dialog interactively, or the literal
`--yes` argument in headless/RPC mode.

- `/kiwifs-status` — resolved non-secret settings plus an overall state
  line: `healthy`, `degraded`, `private` or `disabled`, with the reasons.
- `/kiwifs-private-mode on|off|status` — private mode holds ALL reads and
  writes in all three domains. Enabling persists to the config file first,
  then cancels pending retrieval so no stale evidence pack survives.
- `/kiwifs-extract-now` — trigger one bounded extraction cycle now.
- `/kiwifs-reflect-now` — trigger a reflection run (proposals stay
  approval-gated).
- `/kiwifs-proposal approve|reject|undo <proposal-path> [reason]` — merge
  proposal lifecycle. Approve supersedes the target observations; reject
  leaves them untouched; undo restores targets superseded by that proposal.
- `/kiwifs-forget <path> [reason]` — REVERSIBLE: marks the record
  superseded, body preserved. Requires confirmation (`--yes` headless).
- `/kiwifs-forget-undo <path>` — read-back-verified restore to active.
- `/kiwifs-personal-note <statement…> [--entry id1,id2] [--yes]` — save ONE
  user-authored note to personal-global memory (`scope: personal`). The
  ONLY sanctioned personal-scope write (decisions.md #13): never automatic,
  never derived from project content, and not exposed as an agent tool.
  The statement is redacted BEFORE the confirmation preview and before the
  durable enqueue; delivery rides the durable outbox idempotently and does
  not depend on project identity. Requires confirmation (UI confirm, or
  `--yes` headless). `--entry` attaches explicit provenance ids; without it
  the session reference is the provenance. Refuses in private mode and when
  `scopes.allowPersonalGlobal` is false.
- `/kiwifs-backup-verify <session-id> [export-dir]` — verify a backup
  (checksums, completeness, branch links); optionally export to a NEW
  directory (refuses to overwrite).
- `/kiwifs-board-gc` — prune acked/skipped entries older than 14 days from
  LOCAL delivery state. Local-only, no backend calls, undelivered entries
  untouched. Requires confirmation (`--yes` headless).
- `/kiwifs-board-cleanup <from> [--confirm bc-<token>]` — manual REMOTE
  board cleanup of YOUR OWN messages (sender `from` is required and never
  guessed): previews messages you sent that are client-TTL-expired or
  locally acked AND past the 30-day grace, then — only after explicit
  confirmation — deletes exactly those from the remote board. Distinct from
  `/kiwifs-board-gc` (which stays local-only): `--yes` is refused here so
  the local-prune flag can never trigger a remote delete. Headless is a
  two-step flow: a plain run prints a PREVIEW and a confirmation token
  binding the exact candidate set (nothing deleted); `--confirm <token>`
  re-plans and deletes only if the token still binds. TUI mode confirms via
  a dialog on the exact preview. Per-delete fresh rechecks; changed or
  now-ineligible messages are skipped visibly, never force-deleted; delete
  opIds are durably persisted before each side effect; local ack state is
  never modified. Disclosed limits: MCP has no compare-and-swap (an
  unavoidable read-delete race; no atomicity claim), deletion is MCP-level
  only (no history/index/backup purge), no secure-erasure and no
  all-consumer-ack claim is possible, and deletion is reversible only to
  the extent the backend supports. Refuses in private mode, with the board
  feature disabled, on an unresolvable credential, on a bad sender id, and
  on any token/candidate mismatch — always with zero deletes.
- `/kiwifs-queue` — sanitized outbox stats and quarantined-job fingerprints
  (seq, kind, attempts, error name; never payloads).
- `/kiwifs-erasure-report` — disclosure of where record content is
  retained. Deletes nothing.

## Agent-facing tools

Registered with the agent: `kiwifs_memory_search`, `kiwifs_memory_read`,
`kiwifs_board_send`, `kiwifs_board_list`, `kiwifs_board_read`,
`kiwifs_board_inbox`, `kiwifs_board_ack`. Retrieved evidence injected into
context is framed as untrusted data with source IDs; records cannot register
tools or commands.

## Outage behavior and offline queue recovery

Every backend write goes through a durable local outbox (JSONL with a lock
file, in the state directory). Jobs are persisted with a durable `opId`
before any side effect, so a crash cannot mint a second identity for already
written work.

- Backend unreachable or credential unresolved: jobs stay pending with
  capped exponential backoff and jitter. Observation availability failures
  retry without an attempt cap; permanent failures (validation, conflict,
  path collision) quarantine the job with a visible count in
  `/kiwifs-queue` and `/kiwifs-status`.
- Pi keeps working during outages. Retrieval degrades visibly (nothing
  injected); capture continues into the queue.
- Restart: the queue reloads and continues. Nothing pending is dropped, in
  any mode, ever.
- High-water limits: 5,000 jobs or 50 MiB. At the limit, NEW capture pauses
  with a visible `capture paused (coverage gap)` note; pending jobs are
  never dropped. Age-based retention (14 days) prunes only acknowledged
  jobs. If capture pauses, deliver the backlog (restore the backend) and
  the pause lifts; the coverage gap is disclosed, not hidden.
- Duplicate delivery: a replayed job hits the same deterministic path with
  the same content and is a no-op success (read-before-write idempotency).
  A path existing with DIFFERENT content fails closed and quarantines the
  job; nothing is ever overwritten.

## Private mode

`/kiwifs-private-mode on` holds everything: no backend reads, no writes, no
new captures, in all three domains. Pending outbox jobs are held, never
deleted. `/kiwifs-private-mode off` releases held jobs through registered
listeners (observation, backup, board) and the transition is logged. Live
gates re-read config per boundary; no restart needed.

## Backups

Backups are REDACTED. Redaction is irreversible: redacted chunks cannot be
restored to original bytes. A manifest records chunk checksums, the covered
session range and explicit omissions (binaries are omitted and listed).
There is no byte-identical recovery claim, by design (decisions.md #2).

Verify and export with `/kiwifs-backup-verify <session-id> [export-dir]`.
Verification is read-only against the backend and holds during private
mode. Export writes only to a destination directory that does not already
exist and never overwrites.

Restoring a backup back into Pi sessions is DEFERRED (architecture.md §13
row 20): export is the recovery path for now; restore-into-Pi needs format
verification and has not been approved or built.

## Board operations

- Delivery requires `board.consumerId`. Without it, delivery is HELD
  visibly and no backend polling happens.
- Polling: active poll every 60 s by default, backoff after empty polls,
  visible pause at 500 unread by default (nothing dropped).
- Exactly-once delivery is per consumer state file; the outbox itself is
  outbound-only and never discovers inbound messages.
- There is no AUTOMATIC remote deletion of board messages (B5: the backend
  has no TTL primitive). `/kiwifs-board-gc` prunes only LOCAL acked/skipped
  state older than 14 days and requires confirmation. MANUAL remote
  deletion of your own board messages exists ONLY via the explicit,
  user-confirmed `/kiwifs-board-cleanup` command above — never automatic,
  never scheduled, and bounded per run. If you want server-side expiry,
  that is an operator decision outside this extension.
- Board send is subject to private mode and the same fail-closed path
  rules as every other write.

## Forgetting, retention, purge (erasure limits)

- Forgetting is REVERSIBLE by design: `/kiwifs-forget` marks the record
  superseded and preserves the body; `/kiwifs-forget-undo` restores it.
  Read-back guards keep forgotten records out of retrieval even if the
  search index still surfaces them.
- There is NO permanent erasure. `/kiwifs-erasure-report` lists where
  record content is retained: backend record bodies (active and superseded),
  transcript backups, proposal records, the backend's vector/search index,
  git history if the backend is git-backed, and local durable state. The
  ONE remote-delete surface is the user-confirmed board cleanup command
  above, which deletes only your own board messages and purges nothing
  else (no index, history or backup cleanup) — no secure-erasure guarantee
  is claimed (B6). Forgetting does not remove content from git history,
  indexes or remote backups.
- A true purge is an OPERATOR procedure directly against backend storage,
  with verification against every copy listed above. No secure-erasure
  guarantee is claimed (B6). Forgetting does not remove content from git
  history, indexes or remote backups.
- Local retention: outbox acked jobs 14 days; board acked/skipped state
  pruned by the manual GC command; no automatic board GC and no automatic
  erasure anywhere.

## Backend upgrades

The adapter discovers capabilities at connect time and never assumes a tool
count. Additive tool/version changes are tolerated. Removal of a required
tool fails closed BEFORE any mutation, with a visible error. The live suite
(T19) exercised an evolved output shape end to end; additive shape changes
parse unchanged.

## Coexistence with other extensions

Observation capture excludes Pi's own extension-generated entries,
including everything under the extension's `kiwifs.`-prefixed tool and
command surface, so the extension never recursively records its own
activity. Running alongside OTHER memory extensions is untested. If you
use another memory extension, expect duplicated injected context and
nondeterministic interaction; there is no coordination protocol between
extensions. Disable one of the two via its own config.

## Troubleshooting

Start with `/kiwifs-status`. The overall state line and the per-component
notes name the failing piece. Common notes and their meaning:

- `config: INVALID — extension disabled` — validation failed; the listed
  path/message names the offending key. Fix the config; nothing runs
  partially.
- `session coordinator: DISABLED` or `records: DISABLED` — lifecycle state
  or project scope could not resolve (no git remote and no
  `projectIdentity`). Set `projectIdentity` or fix the remote.
- `retrieval: degraded — …` — a retrieval cycle degraded (deadline, out-of
  -scope or superseded candidates rejected, keyword-only hybrid fallback).
  Keyword-only results are never presented as semantic.
- `tokenizer: automatic injection stays skipped — …` — see the tokenizer
  requirement in `docs/configuration.md`. Tools still work.
- `outbox: … capture=PAUSED (coverage gap)` — high-water limit reached;
  see "Outage behavior" above.
- `board delivery: HELD — …` — consumerId unset, private mode, or another
  consumer holds the lock for your consumerId.
- `backend not configured or credential unresolved` — `mcp.url` or the
  referenced credential is missing. Availability errors are retryable; the
  queue holds work until it resolves.

## Live test suite (opt-in, operators)

`KIWIFS_LIVE_TESTS=1 npm run test:live` runs the live integration suite
against a DEDICATED test space only, with random run IDs and
manifest-owned cleanup. It is opt-in and never runs in ordinary tests or
CI. Facts to keep straight:

- Exit code 5 means "clean pass with disclosed degradations" on the
  reference deployment, not a failure-free run.
- The dedicated test space is NOT a secure tenant boundary. It is isolated
  by separate process/storage/index, and connectivity with an auth header
  proves reachability, not enforcement. Its port must never be exposed
  publicly; treat network restriction (VPN/ACL) as the actual boundary.
- Cleanup deletes only manifest-owned test records and never claims to
  purge git history, indexes or backups.

See `docs/test-environment.md` for the reference deployment details.
