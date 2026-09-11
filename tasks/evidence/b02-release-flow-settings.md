# B02: protected release flow — applied settings and evidence

Date: 2026-08 (session B02, attempt 1)
Candidate SHA: `9c1404837dd8b803987acd8eaeb35d26d7b34427` (final clean commit)
PR: https://github.com/fazekasda/pi-kiwifs-memory/pull/4 (`beta/0.1.0-beta.0` → `main`)

## Applied via API and verified by read-back

### Ruleset `main-required-ci` (id 22926188, target `branch`, enforcement `active`)

- Applies to `~DEFAULT_BRANCH` (`main`).
- Rules:
  - `deletion` — `main` cannot be deleted.
  - `non_fast_forward` — force pushes to `main` blocked.
  - `pull_request` — merges require a pull request (0 required approving reviews;
    all merge methods allowed). This forces candidate CI to run against the exact
    PR head SHA before merge.
  - `required_status_checks` — required check names, strict policy:
    `Node 22.19.0`, `Node 24`, `Nix development environment` (these match the
    `ci.yml` job display names exactly).
- Bypass actors: none. Nobody (including the repo admin) can push directly to
  `main` or skip required checks. Repository admins can always edit ruleset
  definitions themselves (GitHub platform behavior); that is the only bypass
  surface and it is the same account that created the ruleset.

### Environment `release`

- Required reviewer: `fazekasda` (rule id 65274656, `prevent_self_review: false`).
- Deployment branch policy: protected branches only.
- The GitHub Release publication (B10) must target this environment so the
  recorded approval requirement is enforced.

### Environment `npm`

- Created because `.github/workflows/publish.yml` declares `environment: npm`
  but no such environment existed; without it the first manual trigger would
  have run with no approval gate.
- Required reviewer: `fazekasda`; protected branches only.
- Workflow remains inactive for prereleases via
  `if: ${{ !github.event.release.prerelease }}` (unchanged; verified in the
  candidate tree).

## Manual blocker: `v*` tag ruleset

The REST API rejected every attempt to create a `push`-target ruleset scoped to
`refs/tags/v*` on this repository:

- `POST /repos/fazekasda/pi-kiwifs-memory/rulesets` with
  `conditions.ref_name.include = ["refs/tags/v*"]` (and variants `v*`,
  `refs/tags/*`, `~ALL` + exclude `refs/heads/*`) returns HTTP 422:
  `Target ref_name is not supported for push rulesets`.
- An unscoped `push` ruleset was rejected rather than created: it would also
  block branch deletion/force-pushes repo-wide, which is broader than the plan
  calls for. (Also observed HTTP 500 from the API for `push` rulesets with a
  `ref` conditions key.)

Exact manual step (repo owner, Settings → Rules → Rulesets → New ruleset →
"Push ruleset"):

1. Name: `release-tags-protected`.
2. Enforcement: Active. Bypass list: empty.
3. Target condition: ref name includes `refs/tags/v*`.
4. Rules: `Restrict deletions`, `Restrict updates` (no allowed actors).
5. Save. Read-back: `GET /repos/fazekasda/pi-kiwifs-memory/rulesets` should list
   it with target `push`.

If the web UI also refuses the `refs/tags/v*` condition, fall back to a legacy
tag protection (`refs/tags/v*`) if still offered, and record the outcome here.

## CI status at record time

- PR #4 checks: `Node 22.19.0` and `Node 24` failed at `npm run check`
  (prettier) on `tasks/evidence/b09-local-gates-at-commit.md`;
  `Nix development environment` still pending when checked. Run:
  https://github.com/fazekasda/pi-kiwifs-memory/actions/runs/34609185287
- Fix applied in the working tree but **uncommitted** (committing is not
  assigned to this task): `prettier --write tasks/evidence/b09-local-gates-at-commit.md`
  (5 insertions, 5 deletions). After the fix, local `npm run check` passes:
  715 pass / 0 fail (Node 24.19.0). CI must be re-run once the fix is committed
  to the release branch.

## Follow-ups

1. Commit and push the prettier fix to `beta/0.1.0-beta.0`; confirm all three
   required checks pass against the new head SHA.
2. Create the `release-tags-protected` push ruleset via the web UI (steps above)
   and read it back.
3. Optional hardening: set `prevent_self_review: true` on the `release`
   environment once a second reviewer exists; today the sole reviewer can
   self-approve, which is noted but not weakened.
4. Rules were not exercised with a disposable tag; the `creation` rule is not
   applicable via API (rejected). Deletion/update restriction should be
   smoke-tested with a disposable `vtest-*` tag after the manual ruleset exists.
