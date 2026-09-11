# Beta release plan

Status: approved decisions recorded; execution has not started.

Target: GitHub-only `v0.1.0-beta.0`. npm publication is excluded from this plan. Creating or publishing the GitHub prerelease still requires explicit user approval after all gates pass.

## Decisions

- Distribute the first beta as a GitHub prerelease. Consider npm after beta feedback.
- Run the existing opt-in KiwiFS live suite manually against the dedicated test deployment at the exact release commit. Archive a sanitized report.
- Build a repeatable default-model evaluation harness and test 10 to 20 annotated synthetic sessions.
- Test the older community GLM-5 tokenizer against provider-reported token counts. Offer it only if compatibility is demonstrated.
- Protect `v*`, protect `main` with required CI, and require environment approval for publishing.
- Disclose the `kiwi_changes` HTTP 500 and bounded `kiwi_query_meta` fallback in the README, release notes, operations documentation, and runtime status.
- Ship a fresh-install checklist, rollback and downgrade runbook, human TUI acceptance record, tester privacy notice, and issue templates.
- Use GitHub Issues and Discussions for beta feedback.
- Replace the incomplete worker-generated research files with one corrected, source-checked report.

## Constraints

- Do not publish to npm.
- Do not create or publish a GitHub release without explicit user approval at B10.
- Do not contact production KiwiFS or read production records.
- Live backend writes are restricted to manifest-owned records in the approved dedicated test space.
- Paid OpenRouter calls require explicit approval immediately before B04 or B05 runs.
- Never place credentials, raw sessions, stored memories, or private configuration in commits, reports, logs, fixtures, or workflow prompts.
- Preserve pending outbox and local state during install, upgrade, downgrade, and rollback tests.
- Run applicable tests after each task. Before a task is accepted, run `npm run check`, `npm run pack:check`, and `devenv test` unless the task changes only repository settings.

## B01: Reconcile research and working tree

**Depends on:** none

Replace `docs/research/beta-prerelease-research.md` and `docs/research/beta-synthesis-decision-brief.md` with one corrected report. The report must distinguish verified fact, recommendation, user decision, and unknown. It must correct these rejected claims:

- the live runner is missing;
- remote CI tested current HEAD;
- tag protection is universally required;
- staged npm publishing is available for a package's first publication.

Inspect `tasks/evidence/t19-budget-report.json`. Revert it if the only difference is generated timing jitter; otherwise document and review the change. Update stale references to 675 tests and pre-final Q10 state.

**Acceptance criteria**

- One source-checked beta research report remains.
- Every public claim has an authoritative URL and access date; repository claims name a path and symbol or line range.
- `git diff --check` and formatting pass.
- The working tree contains only intentional B01 changes.
- No private or generated timing data is represented as release evidence.

## B02: Establish protected release flow

**Depends on:** B01

Push the implementation through a review branch or pull request rather than tagging the 44 local commits directly. Add GitHub rulesets for `main` and `v*`. Require current CI on `main`; prevent tag deletion and unauthorized tag updates. Configure a GitHub `release` environment with a required reviewer. Keep the existing npm environment and npm workflow inactive for prereleases.

Document who can bypass each rule. Test rules with a disposable non-release tag pattern if GitHub cannot evaluate the ruleset without a push.

**Acceptance criteria**

- GitHub CI passes against the exact candidate SHA on Node 22.19.0, Node 24, and the devenv job.
- `main` cannot merge without required checks under the selected ruleset.
- `v*` tags cannot be deleted or updated by an unapproved actor.
- A prerelease does not enter the npm publish job.
- The protected environment records an approval requirement.

## B03: Expose the changes-feed degradation

**Depends on:** B01

Confirm the runtime already marks bounded `kiwi_query_meta` discovery as degraded. Add missing user-facing text without claiming that every KiwiFS deployment is affected. State that the observed HTTP 500 belongs to the reference test deployment and backend version. Explain cursor behavior, bounded listing, deduplication, truncation, and recovery when `kiwi_changes` resumes.

**Acceptance criteria**

- README, operations documentation, release-note draft, and runtime status cover the fallback.
- A regression test proves status changes when fallback activates and clears after a healthy changes cycle.
- Wording distinguishes an observed deployment defect from an MCP protocol guarantee.
- No endpoint, header, token, record path, or message body appears in diagnostics.

## B04: Determine GLM-5.3-Flash tokenizer compatibility

**Depends on:** B01

Build a local tokenizer comparison harness. Test `@cyberlangke/tokkit` GLM-5 support only as a candidate; do not call it compatible in documentation before validation. Use multilingual prose, source code, JSON, Unicode, long evidence frames, and the exact injection framing generated by `src/inject/packer.ts`.

With separate approval for paid calls, compare local counts with OpenRouter usage counts. Account for provider chat framing by deriving and validating a stable framing offset instead of comparing unrelated raw-text and request totals. Record model slug, provider route, package versions, corpus hash, request settings, and sanitized aggregate results.

**Acceptance criteria**

- Offline corpus and harness contain no private text or secrets.
- The candidate produces deterministic counts on Node 22.19.0 and 24.
- Provider comparison either demonstrates a documented stable mapping across the full corpus or rejects the candidate.
- Any unexplained undercount rejects the candidate for automatic injection.
- If rejected, beta keeps current fail-closed behavior and documentation says automatic injection requires a separately validated user tokenizer.
- No approximation is silently enabled.

## B05: Evaluate default-model memory quality

**Depends on:** B01; B04 only if automatic-injection token budgets are part of the evaluation

Create a versioned evaluation harness and 10 to 20 annotated synthetic sessions covering preferences, project decisions, corrections, failed approaches, task handoffs, irrelevant chatter, duplicates, conflicting facts, prompt injection, secret canaries, project scope, and personal scope. Freeze the rubric and thresholds before running the model.

Measure extraction precision and recall, duplicate rate, conflict classification, forbidden-scope leakage, secret-canary transmission, malformed-output recovery, calls per session, token use, latency, and estimated cost. Keep extraction quality separate from KiwiFS retrieval ranking. Do not describe synthetic results as production-user evidence.

**Acceptance criteria**

- Secret-canary transmission and cross-scope leakage are both zero.
- Every model output is traceable to a corpus case and sanitized result record.
- Thresholds and failure policy are committed before the paid run; failed thresholds block B09 or require a recorded user decision to narrow beta scope.
- The report includes model/provider identifiers, dates, sample count, confidence limits where meaningful, cost, and known blind spots.
- Re-running the harness does not mutate production or the dedicated KiwiFS deployment.

## B06: Revalidate the live KiwiFS path

**Depends on:** B03; candidate SHA from B02

Run `npm run test:live` manually against the approved dedicated space at the exact candidate SHA. Use the ignored local configuration programmatically. Do not print it. Verify startup preconditions before writes and retain the runner's manifest-owned cleanup rules.

The matrix must cover MCP initialization and required tools, create/read/update/delete, FTS, hybrid attribution, ETag carrier, scope isolation, redirects, `kiwi_changes`, bounded fallback, truncation behavior, board delivery, private-mode zero requests, and cleanup after both success and injected failure.

**Acceptance criteria**

- Exit 0 is a clean pass; exit 5 is accepted only for enumerated, reviewed degradations.
- The sanitized report records timestamp, candidate SHA, runner version, backend capability fingerprint, and cleanup result.
- All run-owned records are absent after cleanup.
- No production request occurs.
- A non-owned sentinel remains unchanged.
- Any unknown cleanup outcome blocks B09.

## B07: Test installation, upgrade, rollback, and TUI

**Depends on:** B02, B04, B06

Install the packed candidate in a clean temporary HOME using only documented instructions and synthetic credential references. Test first start, configured start, restart with pending jobs, upgrade from the initial scaffold where practical, downgrade behavior, private-mode transition, backup verification, personal note, proposal confirmation, forget/undo, and board cleanup preview.

Write a rollback runbook that begins by entering private mode, preserving state, and stopping delivery. Do not tell users to delete an outbox to recover. Document compatible state versions and what to do when downgrade parsing is refused.

Perform a human TUI review in an actual terminal. Record tester, date, candidate SHA, commands checked, and failures without terminal content that could contain secrets.

**Acceptance criteria**

- A clean tester can configure and operate the extension from README instructions alone.
- Upgrade and restart preserve pending jobs without duplicate confirmed delivery.
- Rollback preserves state and explains how to return to the candidate safely.
- Destructive TUI actions require clear confirmation; headless variants require explicit confirmation tokens or `--yes` as designed.
- Human TUI result is signed off or remaining defects block B09.

## B08: Prepare beta support and privacy material

**Depends on:** B03, B05, B07

Add issue forms for privacy/security, possible data loss, backend compatibility, and general bugs. Forms must ask for versions and sanitized diagnostics, never credentials or memory contents. Enable GitHub Discussions and state its purpose.

Write the beta privacy notice and known-limitations section. Include best-effort redaction, reversible forgetting rather than secure erasure, Git history retention, unauthenticated standalone MCP risk, routing labels not being authorization, no byte-identical restore, no automatic restore into Pi, client-enforced scope checks, tokenizer state, model-evaluation limits, coexistence status, and the changes-feed fallback.

**Acceptance criteria**

- Templates explicitly prohibit secrets, raw transcripts, config files, backend URLs with credentials, and stored memory bodies.
- Security reports have a private reporting route if GitHub private vulnerability reporting is enabled; otherwise document the chosen private contact.
- Discussions and Issues have defined roles.
- All limitations match current code and B04 to B07 evidence.

## B09: Assemble and review the beta candidate

**Depends on:** B02 through B08

Set package version to `0.1.0-beta.0`. Prepare release notes, installation command pinned to the tag, upgrade/rollback links, evidence summary, supported versions, and known limitations. Inspect the tarball even though distribution is Git-based, because package allowlisting remains a release gate.

Run an independent code, privacy, packaging, documentation, and evidence review. Re-run exact Node 22.19.0 and 24 checks after the final candidate edit. Push the candidate SHA and wait for remote CI.

**Acceptance criteria**

- `package.json` and lockfile agree on `0.1.0-beta.0`.
- Bump `DEFAULT_RUNNER_VERSION` in `src/backend/live/runner.ts` to
  `0.1.0-beta.0` in the same commit as the version bump, so live-run
  evidence never names a version absent from the tag.
- Re-check the `docs/beta-privacy.md` "Release status" caveat still holds
  (or is updated) once B04–B07 evidence lands.
- `npm pack --dry-run` and `npm run pack:check` expose no credentials, local state, research working files, or test configuration.
- Local exact-version gates and remote CI pass on the same SHA.
- Live, model, tokenizer, fresh-install, and TUI evidence identify that SHA.
- Independent review has no unresolved privacy, data-loss, scope-leakage, release-trigger, or cleanup blocker.
- `git status` is clean.

## B10: Publish the GitHub prerelease

**Depends on:** B09 and explicit user approval

Present the candidate SHA, checks, evidence links, accepted degradations, diff from `origin/main`, and exact release text to the user. Wait for explicit approval. Create signed tag `v0.1.0-beta.0`, then create a GitHub prerelease. Verify that npm was not published and that installation from the immutable tag works in a fresh temporary HOME.

**Acceptance criteria**

- Explicit approval is recorded before tag or release creation.
- Tag resolves to the reviewed candidate SHA and is protected.
- GitHub marks the release as prerelease.
- npm registry has no new package version or dist-tag from this release.
- Post-release install smoke passes from the tag.
- Any failed verification pauses announcements and follows the rollback runbook.

## B11: Decide whether to publish an npm beta

**Depends on:** B10 and a defined beta feedback interval

Summarize defects, privacy reports, setup failures, model-quality feedback, backend compatibility, and install friction. Return to the user for a separate npm decision. If approved later, create a new plan for first direct scoped publication with `--access public --tag beta`, 2FA, trusted-publisher settings, environment approval, provenance, and guards that prevent `latest` publication.

**Acceptance criteria**

- No npm action occurs under this plan.
- The decision uses observed beta feedback rather than a preset date alone.
- Any npm plan includes a dry run, registry ownership verification, explicit final approval, and post-publication dist-tag verification.

## Release gate summary

The beta tag is blocked until B01 through B09 pass. B10 is a manual approval boundary. B11 is post-beta work.

Accepted beta limitations do not waive tests or disclosure. They include MCP's lack of conditional writes, backend semantic under-recall, stale semantic candidates guarded by fresh reads, no board push or server TTL, no history purge, redacted rather than byte-identical backups, routing labels rather than access control, and untested coexistence with other memory extensions unless B07 adds evidence.
