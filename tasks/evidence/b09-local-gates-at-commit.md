# B09 local gates at the beta-prep commit (attempt 1/3 — B09b)

Date: 2026-02-27 (session local). Tree: beta-prep working tree at parent
`2aecef4` (44 commits ahead of `origin/main`), staged as one reviewed
commit immediately after these runs.

## Results

| Gate       | Command              | Result                                                                                                          |
| ---------- | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| Check      | `npm run check`      | PASS — typecheck + `prettier --check` + tests: **715 pass, 0 fail, 0 skipped** (63347 ms)                        |
| Pack check | `npm run pack:check` | PASS (exit 0) — allowlist check + isolated Pi RPC smoke; loads offline, safe disabled startup, no backend       |
| Devenv     | `devenv test`        | PASS — "Running tests in 78.3s / Tests passed :)", exit 0                                                       |

## Notes

- The budget test rewrites `tasks/evidence/t19-budget-report.json` with
  as-measured latency on every test run; the jitter-only diff was reverted
  before the commit (B01 rule). Post-commit regeneration by any future
  `npm test` run is expected and never staged.
- `git diff --check` clean at commit time. No benchmark or timing evidence
  altered; no ignored local config read; no live run in this task.
- Exact-Node 22.19.0/24 re-checks at the final candidate and remote CI are
  pending (B02/B09 push — see `tasks/evidence/b09-blocker-bundle.md`).
