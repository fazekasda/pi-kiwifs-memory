# Beta Readiness Report

**Date:** 2026-09-12
**Scope:** Corrected, source-checked readiness assessment for the first beta of
`@fazekasda/pi-kiwifs-memory`. Supersedes the rejected worker-generated
`beta-prerelease-research.md` and `beta-synthesis-decision-brief.md` (both
removed; corrections listed in §2).
**Method:** Local repository inspection and one local test run. No production
KiwiFS contact, no npm/GitHub remote mutation, no credentials read.

**Classification legend:**

- **Verified fact** — checked in this repo (path + symbol/line given) or
  against an authoritative public URL with access date.
- **Recommendation** — judgment by this report; a user decision can override.
- **User decision** — reserved for the owner; this report does not decide it.
- **Unknown** — not resolvable from current evidence; resolution path named.

---

## 1. Verified current state

| Item                  | Status                                                                                                                                                           | Evidence                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Package identity      | `@fazekasda/pi-kiwifs-memory` at `0.1.0`, never published to npm                                                                                                 | `package.json` (`name`, `version`); npm publication excluded by plan (`tasks/beta-release-plan.md`)                                       |
| npm workflow          | Triggers on `release: published`, **skips prereleases** via `if: ${{ !github.event.release.prerelease }}`                                                        | `.github/workflows/publish.yml:13` (job `if`)                                                                                             |
| Publish guard         | Asserts tag equals `v${pkg.version}` and `npm >=11.5.1`; uses OIDC trusted publishing (`id-token: write`), environment `npm`, `--provenance`                     | `.github/workflows/publish.yml:28-46`                                                                                                     |
| CI                    | Node `22.19.0` and `24` matrix, plus `devenv test` job; runs on `push` to `main` and `pull_request`                                                              | `.github/workflows/ci.yml:5-8,14,28-40`                                                                                                   |
| Offline test suite    | **715 tests pass, 0 fail** at local HEAD                                                                                                                         | `npm test` re-run after B03–B06 additions (exit 0); count will be pinned to the candidate SHA at B09                                      |
| Live runner           | **Implemented** — `src/backend/live/runner.ts`, exposed as `npm run test:live`; offline coverage in `test/live-runner.test.ts`                                   | `package.json:42`; `src/backend/live/`; `test/live-runner.test.ts`                                                                        |
| Remote CI coverage    | **Last remote CI run tested `origin/main` at `45a11cc` (2026-09-08)**, not current HEAD                                                                          | `git log origin/main -1` → `45a11cc 2026-09-08`; local HEAD `2aecef4` is 44 commits ahead (`git rev-list --count origin/main..HEAD` = 44) |
| Branch/tag protection | No rulesets configured locally; none can be verified without GitHub API access. Protection of `v*` and `main` is a planned B02 task, not an existing state       | No `.github/rulesets` or branch-protection files in repo (protection lives server-side; actual GitHub state **Unknown** locally)          |
| Default model         | `openrouter/z-ai/glm-5.3-flash`                                                                                                                                  | `tasks/beta-release-plan.md` environment note; `docs/decisions.md`                                                                        |
| Tokenizer             | No bundled production tokenizer; automatic injection requires a user-supplied model-compatible module (`budgets.tokenizer.module`), fail-closed without one      | `README.md:96,214-216`; `docs/configuration.md`                                                                                           |
| Test deployment       | Dedicated KiwiFS test space; observed `kiwi_changes` HTTP 500 on the reference test deployment with a bounded `kiwi_query_meta` fallback (disclosed degradation) | `docs/test-environment.md`; `docs/architecture.md` §8                                                                                     |
| Version gates         | `npm run check` (typecheck + prettier + tests) and `npm run pack:check` exist and are required gates                                                             | `package.json:46-48`                                                                                                                      |

### Stale references found (not edited under B01a ownership)

Corrected in this tree (no follow-up outstanding):

- `README.md` (Known limitations area) said "675 tests"; updated to the
  re-measured count (**715**, includes B03–B06 additions; see test-count note
  in §1).
- `docs/quality-review.md` header recorded pre-final Q10 state at `82eb7fc`;
  consolidated with the Q10 fix (`e9217b8`) and Q03 closure (`2aecef4`), and
  its test count updated to match the re-measured suite.

---

## 2. Corrections to the rejected claims

The superseded research files contained four rejected claims. Corrections:

1. **Rejected claim: "the live runner is missing."**
   **Corrected:** the opt-in live runner exists (`src/backend/live/runner.ts`,
   `npm run test:live`, offline tests in `test/live-runner.test.ts`). What
   remains unproven is a _clean live run at the exact release candidate SHA_
   against the approved dedicated test space (plan task B06). The claim should
   have distinguished "not yet run at a pinned candidate SHA" from "not built."

2. **Rejected claim: "remote CI tested current HEAD."**
   **Corrected:** `origin/main` last advanced to `45a11cc` (2026-09-08); local
   HEAD `2aecef4` is 44 commits ahead. No remote CI evidence covers current
   HEAD. Remote CI on the candidate SHA is exactly what plan task B02 must
   establish before any tag.

3. **Rejected claim: "tag protection is universally required."**
   **Corrected:** GitHub rulesets / tag protection are a project-level choice;
   neither GitHub nor npm imposes tag protection on all repositories, and the
   npm publish workflow here is gated by release events, environment `npm`, and
   the prerelease skip, not by tag rules. For _this_ plan, protecting `v*` and
   `main` is an approved decision (`tasks/beta-release-plan.md`, B02), and a
   sound one for a workflow that will later create release tags — but it is a
   deliberate release-flow requirement, not a universal platform mandate.
   - Related public facts (from prior public research, accessed 2026-09-11 via
     r.jina.ai, not re-verified today): GitHub rulesets can protect tag
     patterns such as `v*` against deletion and force-push
     (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets); GitHub environments support required reviewers on public repos
     (https://docs.github.com/en/actions/deployment-targeting-different-environments/using-environments-for-deployment).

4. **Rejected claim: "staged npm publishing is available for a package's first
   publication."**
   **Corrected:** npm staged publishing requires the package to already exist
   on the registry; the first publish of `@fazekasda/pi-kiwifs-memory` cannot
   go through `npm stage publish` and would need a direct `npm publish`
   (interactive auth for first scoped publication, 2FA for later staged
   approvals). Moot for the current plan, which excludes npm publication
   entirely (plan task B11 returns to npm as a separate decision).

---

## 3. Distribution decision (recorded)

**Verified fact:** the plan records an approved user decision — the first beta
is a **GitHub-only prerelease** `v0.1.0-beta.0`, installed via
`pi install git:github.com/fazekasda/pi-kiwifs-memory@v0.1.0-beta.0`; npm is
excluded (`tasks/beta-release-plan.md` Decisions; `docs/publishing.md`).
The publish workflow's prerelease skip (`.github/workflows/publish.yml:13`)
already keeps prereleases out of npm.

**User decisions still outstanding (not made by this report):**

- explicit approval at B10 to create the tag and GitHub prerelease;
- the later npm decision at B11;
- paid OpenRouter approval immediately before B04/B05 runs.

---

## 4. Beta gates and current evidence

| Gate (plan task)                                | Evidence today                                                                                                                | Category                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| B01 research reconciliation                     | This report; t19 evidence diff reverted (timing jitter only, see §5)                                                          | Done for this subtask                       |
| B02 protected flow + remote CI on candidate SHA | No remote CI on current HEAD (44 commits ahead); rulesets unconfigured                                                        | Unknown until B02 runs                      |
| B03 changes-feed disclosure                     | Fallback disclosed in repo docs; wording and regression test to confirm in B03                                                | Recommendation / pending                    |
| B04 tokenizer compatibility                     | No production tokenizer validated; fail-closed is current behavior; `@cyberlangke/tokkit` is only a candidate until validated | Unknown                                     |
| B05 default-model evaluation                    | No controlled evaluation run; harness and 10–20 synthetic sessions planned                                                    | Unknown                                     |
| B06 live revalidation                           | Runner implemented; no recorded clean run at candidate SHA                                                                    | Unknown                                     |
| B07 install/rollback/TUI                        | Rollback runbook and fresh-install checklist not yet written                                                                  | Recommendation: required by plan before B09 |
| B08 support/privacy material                    | Issue templates, Discussions, privacy notice not yet present                                                                  | Pending                                     |
| B09 candidate assembly                          | Version still `0.1.0`; lockfile/tag work pending                                                                              | Pending                                     |

**Accepted beta limitations to disclose** (verified against repo docs):
MCP lacks conditional writes; backend semantic under-recall; stale semantic
candidates guarded by fresh reads; no board push/server TTL; no history purge;
redacted (not byte-identical) backups; routing labels are not authorization;
untested coexistence with other memory extensions; no bundled tokenizer
(`docs/architecture.md` blockers B1–B6; `README.md` Known limitations;
`tasks/beta-release-plan.md` gate summary).

---

## 5. Evidence-file revert

`tasks/evidence/t19-budget-report.json` had uncommitted changes: jittered
latency values in `latency50msPerCall.runs` (first run 964→979, second
959→962, one extra sample 961 inserted) and nothing else. The diff contains no structural, pass/fail, or count changes — generated
timing jitter only. **Action: reverted** via `git checkout --` to keep the
committed evidence stable. No timing data is cited as release evidence in this
report.

---

## 6. Unknowns and resolution paths

| Unknown                                                                 | Resolution                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Actual GitHub-side protection state (rulesets, environments)            | Inspect repo settings during B02; test with a disposable non-release tag if needed |
| Whether `kiwi_changes` HTTP 500 persists at the current backend version | B06 live run records a sanitized capability fingerprint                            |
| GLM-5.3-Flash tokenizer compatibility of `@cyberlangke/tokkit`          | B04 offline corpus first; paid provider comparison only with explicit approval     |
| Default-model extraction quality                                        | B05 harness with thresholds frozen before any paid run                             |
| Pi catalog indexing behavior for any future npm publish                 | Only relevant after a separate B11 decision; not part of this beta                 |
| npm CLI version requirements for a future staged-publish flow           | Deferred with npm to B11; irrelevant while npm is excluded                         |

Public sources above were accessed 2026-09-11 (via r.jina.ai) during the
superseded research and were not re-fetched today; repository claims were all
re-verified locally on 2026-09-12.

---

_End of report. Local verification: `npm test` (715 pass, 0 fail; re-measured
after B03–B06 test additions);
`git diff --check` clean at time of writing. Formatting and `npm run check`
are re-run at B01 acceptance per plan._
