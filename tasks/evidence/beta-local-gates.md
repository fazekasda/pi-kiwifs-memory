# G01: local evidence gates (attempt 1)

Date: 2026-02-27 (session local). Branch: `main`, 44 commits ahead of `origin/main`, uncommitted beta-prep working tree present (per plan; no attempt to commit).

## Results

| Gate       | Command              | Result                                                                                                                                                              |
| ---------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check      | `npm run check`      | PASS — typecheck + `prettier --check` + tests: 715 pass, 0 fail, 0 skipped (65922.704738 ms)                                                                        |
| Pack check | `npm run pack:check` | PASS — `check-package.mjs` + `smoke-package.mjs`; packed extension loads in isolated Pi RPC, commands registered, safe offline startup (disabled state, no backend) |
| Devenv     | `devenv test`        | PASS — "Running tests in 86.0s / Tests passed :)", exit 0                                                                                                           |

## Fixes applied by this task

None required. All three gates passed on the existing beta-prep working tree; no test, format, or type errors attributable to the beta-prep diff were found.

## Notes

- Test count is 715 (up from the previously documented 675), reflecting the beta-prep additions (live-runner, status, model-eval, tokenizer-eval, tokenizer-provider-compare, fresh-install tests). Timing values above are as measured; no benchmark or timing evidence was altered.
- No live runner was executed in this task; no ignored local configuration was read or printed.
