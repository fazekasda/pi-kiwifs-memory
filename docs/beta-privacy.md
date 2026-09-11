# Beta privacy notice and known limitations

Status: beta support document for `v0.1.0-beta.0` (draft; see "Release
status" below). Sources: `docs/privacy.md`, `docs/operations.md`,
`docs/test-environment.md`, `docs/configuration.md`,
`src/board/delivery.ts`, `tasks/evidence/t19-live-report.json`. Every
limitation below is anchored to current code or recorded evidence; nothing
here is a release claim, and no model-quality or tokenizer-compatibility
result is asserted.

## What this beta stores and where

- Session content is captured, redacted, and written as memory records to
  the KiwiFS backend you configure (`docs/privacy.md`, outbound-edge list:
  model requests, backend writes, query transmission, durable queue
  storage, audit log — all consume redacted content).
- The outbox (`<stateDir>/`) queues undelivered writes durably; acked jobs
  are pruned after 14 days (`docs/operations.md`, "Local retention").
- A metadata-only audit log (`<stateDir>/audit.log`, JSONL, 0600/0700
  permissions) records counters and reason codes, never content
  (`docs/privacy.md`, Q04a/Q04b).
- Backups are redacted transcript chunks with an explicit omission
  manifest (see "No byte-identical restore" below).

## Tester consent

By installing and running this beta you consent to the following:

- Your configured KiwiFS backend will receive redacted memory records
  derived from your Pi sessions. The backend operator can read them.
- Pending, undelivered records persist locally in the outbox until
  delivered; entering private mode holds them, it does not delete them.
- If you connect the extension to a backend that is not yours or not
  restricted, other people who can reach that backend may read your
  records (see "Routing labels are not authorization" and "Standalone MCP
  exposure" below).
- Testing artifacts (issue reports, sanitized diagnostics) must never
  include credentials, raw transcripts, config files, backend URLs with
  embedded credentials, or stored memory bodies.

If you do not accept these terms, do not install the beta. To stop all
network activity from an installed instance, enable private mode
(`docs/operations.md`) and stop Pi.

## Current privacy and security limits

These are current behaviors, not promises to fix later:

- **Redaction is best-effort.** Pattern/entropy scanning misses secrets in
  unrecognized formats, below thresholds, or split across boundaries, and
  false-positive redaction of random-looking identifiers also happens.
  Novel secret formats are missed until a pattern exists
  (`docs/privacy.md`, "Scanner limitations").
- **Forgetting is reversible bookkeeping, not secure erasure.**
  `/kiwifs-forget` redacts and marks superseded; it does not purge the
  backend storage, Git history, indexes, or backups
  (`docs/operations.md`, "Retention and forgetting").
- **Git history is retained.** KiwiFS is backed by Git; deletion is
  MCP-level only. Nothing the extension does removes content from history
  (`docs/test-environment.md`, T19 facts).
- **Unauthenticated standalone MCP risk.** The KiwiFS MCP deployment is a
  separate service; reachability with an auth header proves reachability,
  not enforcement. A publicly exposed endpoint must be treated as
  readable by anyone who can reach it (`docs/operations.md`, live-suite
  facts).
- **Routing labels are not authorization.** Board recipient filtering and
  scope checks are client-enforced policy, not a backend security
  boundary. A client that ignores them, or a direct backend client, is
  not constrained by them (`src/board/delivery.ts`, recipient policy
  comment).
- **Scope checks are client-enforced.** Scope isolation is applied by the
  extension before queries and writes; the backend does not enforce your
  configured scopes (`docs/architecture.md`, guard steps).
- **No byte-identical restore.** Backups are redacted before being
  written; restoring yields "complete with recorded redactions/omissions",
  never the original bytes (`docs/privacy.md`, "Backup fidelity").
- **No automatic restore into Pi.** Restoring a backup writes records to
  the backend; the extension does not silently re-inject a restored
  backup into your sessions as if nothing happened.
- **Coexistence with other memory extensions is untested** and expected to
  duplicate injected context (`docs/operations.md`, "Coexistence").

## Changes-feed fallback (`kiwi_changes` HTTP 500)

The reference test deployment (MCP 8182, see `docs/test-environment.md`)
has a **deployment defect**: `kiwi_changes` returns a persistent server
side `internal server error (HTTP 500)` whenever the feed has entries,
while read-back proves records exist. This is an observed defect of that
backend version, **not** an MCP protocol property and **not** a claim that
every KiwiFS deployment is affected.

Current behavior when the feed fails with a non-retryable domain
rejection (`src/board/delivery.ts`):

- Inbound board discovery switches to a bounded `kiwi_query_meta` listing
  pass (≤20 pages of ≤200 raw rows, ≤1,000 kept board paths per
  reconciliation; bounded per-cycle
  listing bounds apply).
- The stored cursor is untouched in fallback mode; when `kiwi_changes`
  resumes, dedupe absorbs the overlap, so messages are not re-delivered.
- A fallback listing that hits its per-cycle bound is marked truncated;
  more board paths may exist until a later cycle covers them.
- The fallback is a disclosed degradation, never counted as a healthy
  feed; `/kiwifs-status` reports degraded state rather than hiding it.

## Tokenizer status

- The extension ships **no bundled tokenizer** for the default model
  route. Automatic injection enforces the 3,000-token cap only with a
  user-supplied, separately validated tokenizer module; without one, or on
  any unreliable count, injection is **skipped fail-closed** with a
  visible status note. Tools keep working
  (`docs/configuration.md`, "Tokenizer requirement").
- The community GLM-5 tokenizer package (`@cyberlangke/tokkit`) is a
  **candidate under validation** (beta plan task B04). Until a documented,
  stable mapping across the full corpus is demonstrated, it is not
  compatible and is not enabled for automatic injection. No approximation
  is silently enabled.

## Model-evaluation limits

- The default-model quality evaluation (beta plan task B05) uses 10–20
  **annotated synthetic sessions**. Synthetic results measure the harness
  configuration, not production-user experience; they are not production
  evidence and must not be quoted as such.
- As of this draft, that evaluation has not been run; **no model-quality,
  extraction-precision, or cost claim is made** for the beta.
- KiwiFS retrieval ranking (backend-side) is a separate quality dimension
  from the extension's extraction; backend semantic recall is known to
  under-recall, and keyword-only hits are never presented as semantic
  (`docs/operations.md`, troubleshooting notes).

## Reporting privacy or security issues

- Use the GitHub issue form for privacy/security reports; it asks for
  versions and sanitized diagnostics and explicitly prohibits secrets,
  raw transcripts, config files, backend URLs with credentials, and
  stored memory bodies.
- If GitHub private vulnerability reporting is enabled for the repository,
  use it for anything sensitive; otherwise contact the maintainer through
  a private channel named on the repository front page before opening any
  public issue.
- General beta feedback (usage, quality, compatibility) goes to GitHub
  Issues; discussion of beta scope and coordination goes to GitHub
  Discussions. Issues carry defects and reports; Discussions carry
  questions and proposals.

## Release status

This document tracks the pending `v0.1.0-beta.0` prerelease. It contains
no release announcement and no claim of publication. Current validation
state (records in `tasks/evidence/`): live revalidation B06 passed with the
enumerated `kiwi_changes` HTTP 500 degradation on the reference test
deployment; tokenizer B04 rejected the candidate for automatic injection
(fail-closed behavior kept); model evaluation B05 has only dry-run results
with a fake transport — the real paid run was not performed; install/TUI
B07 automated passes are recorded but human TUI sign-off is pending.
Package version is now `0.1.0-beta.0` in `package.json`, the lockfile, and
`DEFAULT_RUNNER_VERSION`; no tag exists yet and publication requires
explicit user approval at B10.
