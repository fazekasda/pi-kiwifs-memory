# B09 approval/blocker bundle (attempt 1/3 — B09b)

**Status: B09 NOT complete.** The beta candidate is assembled, all three
local gates pass, and the intentional beta-prep changes are committed as
one reviewed commit. Four evidence items remain pending that this task
cannot produce without user approval or human execution. Per the plan,
B09 stays open and B10 is not requested yet.

## What this attempt fixed (review blocker 4, commit portion)

- Beta-prep working tree committed as one reviewed commit (version bump
  `0.1.0-beta.0` in `package.json` + lockfile and `DEFAULT_RUNNER_VERSION`
  in `src/backend/live/runner.ts` in the same commit, per B09 criteria).
- Regenerated `tasks/evidence/t19-budget-report.json` jitter reverted
  before the commit (B01 jitter-only rule; the budget test rewrites this
  file on every `npm test` run, so post-commit regeneration is expected).
- Local gates re-run on the final tree: `npm run check`,
  `npm run pack:check`, `devenv test` — all PASS (see
  `tasks/evidence/b09-local-gates-at-commit.md`).
- No tag, no GitHub release, no npm action, no push. `npm run check` and
  `git diff --check` clean at commit time.

## Pending item 1 — B05: real paid model evaluation (user approval + key)

Dry-run-only status is recorded honestly in release notes and privacy
docs, but the plan gate itself is unresolved: paid run results, or a
**recorded user decision to narrow beta scope**.

Required before any paid run (per review follow-up): resolve the R01-
deferred matcher-validity/threshold-semantics items — thresholds must be
re-frozen before the run. Also bump `EVAL_CONFIG_VERSION` and re-commit
the frozen corpus first (corpus was edited after the last dry-run without
a version bump — recorded in `tasks/execution-log.md` G03).

Run (once approved, key in `OPENROUTER_API_KEY`, never printed):

```
KIWIFS_EVAL_OPTIN=1 npm run eval:model:real
```

- Model route: `openrouter/z-ai/glm-5.3-flash` (recorded as `MODEL_SLUG`;
  request bodies carry `OPENROUTER_MODEL_ID = "z-ai/glm-5.3-flash"`).
- Gates verified fail-closed: without opt-in the harness exits 2, zero
  network I/O, no report written.

**Alternative the user may choose instead:** record a scope-narrowing
decision ("beta ships without B05 model-quality evidence") — either way,
B05 needs the recorded outcome before B10.

## Pending item 2 — B04b: provider comparison (user approval + key)

Offline evaluation is deterministic; framing offsets are unstable per set
(99/56/37). The formal accept/reject record exists in
`docs/release-notes-0.1.0-beta.0.md` ("rejected for automatic injection",
fail-closed kept) — the safety posture is correct. What remains is the
optional paid provider comparison that could overturn the rejection:

```
KIWIFS_TOKENIZER_PROVIDER_OPTIN=1 node scripts/tokenizer-provider-compare.mjs --run
```

Not run: `OPENROUTER_API_KEY` absent from the environment and paid calls
were not approved. Without it, the reject record stands and no doc claims
compatibility (verified).

## Pending item 3 — B07: human TUI sign-off (human execution)

`tasks/evidence/beta-tui.md` is an automated PTY pass, not the required
human review. `docs/beta-acceptance.md` is a ready checklist with
tester/date/SHA/verdict blank. A human must perform the TUI review in an
actual terminal and sign it; remaining defects then block B09.

## Pending item 4 — B02/B09: push, remote CI, GitHub settings, live re-attribution

- No push and no PR exist (branch is N+44 commits ahead of `origin/main`
  including this commit). B02 requires a review branch/PR rather than a
  direct tag.
- GitHub rulesets (`main` required CI, `v*` tag protection, `release`
  environment with required reviewer, documented bypasses) are not
  configured — GitHub-repo settings outside this task's scope.
- Remote CI must pass on the exact candidate SHA (Node 22.19.0, Node 24,
  devenv job).
- Live evidence `tasks/evidence/g04-live-runner-report.json` names
  `candidateSha: 2aecef4…`, which is now the commit's parent — per B09
  ("live … evidence identify that SHA"), re-run at the final candidate
  SHA (ignored local config consumed programmatically, never printed):

```
KIWIFS_LIVE_TESTS=1 KIWIFS_CANDIDATE_SHA=<final-candidate-sha> npm run test:live
```

## Already verified safe (this session)

- `.github/workflows/publish.yml`: `npm publish` job runs only
  `if: !github.event.release.prerelease` — a prerelease cannot reach npm;
  `environment: npm` sits only on that inactive job.
- Secret scan over diff + untracked beta-prep files: placeholders and
  env-var names only; harnesses read `OPENROUTER_API_KEY` from the
  environment and never print it.
- `npm pack --dry-run`: 68 files, `src/` + README + LICENSE only;
  `tasks/evidence/model-eval/` ignored and invisible to `git status`.
- Fail-closed tokenizer behavior retained; no doc claims compatibility.

## Decision requested from the user

Pick and record one: **(a)** approve + fund the pending B05/B04b runs
(after threshold re-freeze and corpus re-freeze), **(b)** record a beta
scope-narrowing decision for B05 (and optionally B04b), or **(c)** both.
Also: perform/sign the human TUI review (pending 3) and the B02 push +
GitHub settings (pending 4). Once all four items have recorded outcomes,
B09 can close and B10 presentation can proceed.
