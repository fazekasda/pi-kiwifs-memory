# Release notes — v0.1.0-beta.0 (DRAFT)

**Status: draft.** This is the release-note draft for the beta plan
(task B08/B09 material). It is not a published release, no tag exists as
of this writing, and publication requires explicit user approval at plan
task B10. Claims below are limited to current code behavior and recorded
evidence; tokenizer compatibility and default-model quality results are
deliberately **not** claimed here.

## What this is

First beta of the KiwiFS memory extension for Pi: capture, redaction,
scoped retrieval, background injection, redacted backups, and a board —
backed by a KiwiFS backend over MCP. Distributed as a GitHub prerelease
only; npm publication is out of scope for this release and will be a
separate decision after beta feedback.

## Install (pinned to the tag)

```
pi install github:fazekasda/pi-kiwifs-memory@v0.1.0-beta.0
```

(The tag, not a branch, is the install reference. The tag will be created
at B10 only after explicit user approval and must resolve to the reviewed
candidate SHA.)

## Highlights

- Redact-before-every-outbound-edge privacy gate: pattern + entropy
  scanning, fail-closed holds, structural `[REDACTED:*]` replacement.
- Private mode: zero network requests in any feature domain; pending
  outbox jobs are held, never dropped; resume is explicit and recorded.
- Durable outbox with retry/backoff, quarantine, and private-mode holds;
  acked jobs pruned after 14 days.
- Scoped retrieval with a 3,000-token injection cap enforced only by a
  user-supplied validated tokenizer — no tokenizer, no injection
  (fail-closed; tools keep working).
- Metadata-only audit log with bounded rotation and private permissions.
- Redacted backups with omission manifests (not byte-identical).
- Board delivery with client recipient policy, private-mode gate, and
  bounded polling.

## Known limitations

See `docs/beta-privacy.md` for the full tester privacy notice and
limitation details. Short form:

- Redaction is best-effort; unrecognized secret formats can pass through.
- Forgetting is reversible bookkeeping; Git history, indexes, and backups
  are not purged.
- No byte-identical restore; no automatic restore into Pi.
- Routing labels and scope checks are client-enforced, not backend
  authorization.
- Coexistence with other memory extensions is untested.
- **Changes-feed fallback:** on the reference test deployment,
  `kiwi_changes` currently returns HTTP 500 (a defect of that deployment
  and backend version, not of MCP or all deployments). When the feed fails
  with a non-retryable rejection, board discovery uses a bounded
  `kiwi_query_meta` listing fallback; the cursor is preserved, dedupe
  absorbs overlap when the feed recovers, and truncated listings surface
  as degraded status rather than being hidden.
- **Tokenizer:** no bundled tokenizer; the community GLM-5 candidate
  (`@cyberlangke/tokkit-glm`) was evaluated offline and is **not enabled for
  automatic injection** — its framing offsets were not stable and the
  provider comparison was not performed. Injection stays fail-closed; tools
  keep working without a tokenizer.
- **Model quality:** the default-model evaluation uses synthetic sessions
  only; results are not production-user evidence. No quality claim is made
  in this beta.

## Evidence summary

Recorded evidence for this candidate (source files under `tasks/evidence/`):

- **Live KiwiFS suite (dedicated test space)** — `tasks/evidence/g04-live-runner-report.json`:
  run at candidate SHA `2aecef4e127cc38fa0fcfb5fec1b86d8785a5bb3`, exit 5
  = clean pass with one enumerated degradation (the `kiwi_changes` HTTP 500
  on the reference test deployment only). Run-owned records fully cleaned
  (0 leftovers, verified by independent read-back); a non-owned sentinel
  was untouched; no production requests.
- **Tokenizer (B04)** — `tasks/evidence/tokenizer-eval.json`: offline
  deterministic evaluation only; the candidate (`@cyberlangke/tokkit-glm`
  1.11.0, `glm-5`) produced deterministic counts, but framing offsets were
  **not stable** and the provider comparison was **not performed** (paid
  OpenRouter calls not approved). The candidate is therefore **rejected for
  automatic injection**; the beta keeps the current fail-closed behavior —
  automatic injection requires a separately validated user tokenizer.
- **Default-model evaluation (B05)** — synthetic-corpus harness built and
  thresholds frozen (`b05-thresholds-v1`); dry-run results exist only with a
  fake transport (`tasks/evidence/model-eval/*-dryrun`). The **real paid
  model run has not been performed**; no model-quality claim is made in this
  beta, and dry-run numbers are not user evidence.
- **Install / upgrade / rollback / TUI (B07)** — automated fresh-install and
  PTY interaction passes recorded in `tasks/evidence/beta-tui.md` and
  `docs/beta-acceptance.md`; the required **human TUI review is still
  pending** human sign-off.
- **Local gates** — `npm run check` (715 tests), `npm run pack:check`, and
  `devenv test` all passed on the pre-bump working tree
  (`tasks/evidence/beta-local-gates.md`); exact-Node 22.19.0/24 re-checks at
  the final candidate are part of B09 closure.

## Feedback

- Bugs, privacy/security reports, possible data loss, and backend
  compatibility: GitHub Issues (issue forms; sanitized diagnostics only —
  never credentials, raw transcripts, config files, backend URLs with
  credentials, or memory bodies).
- Scope questions and coordination: GitHub Discussions.
- Sensitive reports: GitHub private vulnerability reporting if enabled,
  otherwise the private contact named on the repository front page.

## Supported versions

Node ≥ 22.19.0 (exact-version gates are run on Node 22.19.0 and Node 24;
see CI at the release SHA).
