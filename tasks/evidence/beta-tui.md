# Beta TUI/PTY acceptance evidence — G05 (B07 Part 4, automated)

**Automated evidence — this is NOT human manual signoff.** Per the beta
release plan, a human TUI review in an actual terminal is still required;
human signoff remains **pending** (see `docs/beta-acceptance.md` Part 4 and
the sign-off block below).

- **Date:** 2026-09-11 (run during G05 attempt 1)
- **Runner:** orchestrating agent inside herdr; pi v0.85.0 TUI in a real
  PTY sidecar pane; drives interaction via pane send-keys/read only
- **Candidate SHA:** 2aecef4e127cc38fa0fcfb5fec1b86d8785a5bb3 (HEAD)
- **Candidate tree hash (HEAD + working tree, temp index `git write-tree`):**
  `1377dd87b124b7f4b01dcb18346a599791211c89`
- **Packed candidate tarball sha256:**
  `e7b3a34e4a62b66ebd78b9712275fe7fed2d18f8fa13da068f261c4c64f67312`
  (0.1.0 tarball from `npm pack --ignore-scripts`; the PTY run loaded the
  extension from this extracted tarball, not from the working tree)
- **Model calls:** zero. No model configured in the isolated env ("No models
  available" shown at startup; no prompt ever submitted). Model route in the
  synthetic config is the exact release route `openrouter/z-ai/glm-5.3-flash`
  with no credentials — extraction fails closed.
- **Isolation:** temporary HOME, `PI_CODING_AGENT_DIR`, `KIWIFS_MEMORY_CONFIG`
  and `KIWIFS_MEMORY_STATE_DIR` under `/tmp`; synthetic config with
  `projectIdentity: g05-tui-gate.synthetic/local`, endpoint
  `http://127.0.0.1:9/mcp` (unreachable loopback port 9), auth via env
  reference to a dummy value. No real service reachable. Temp dir deleted
  after capture.

## Harness run 1 — fresh-install (`npm run test:fresh-install`)

```
fresh-install OK: @fazekasda/pi-kiwifs-memory@0.1.0 — start, restart,
rollback, re-adopt all preserved durable state (1 durable files, 4 total)
with no network access.
```

Exit 0. Covers: first start from clean HOME (offline defaults), restart with
populated state, rollback (install removed, durable state byte-compared),
re-adopt of the same packed candidate. Part 3 state-preservation checks 3.1/
3.3/3.6 are exercised in their offline form; live-backend variants remain in
B06/manual scope.

## Harness run 2 — PTY/TUI checklist (real terminal, driven keys)

Checks map to `docs/beta-acceptance.md` Part 4. Results recorded as command
names and outcomes only; no terminal content that could contain secrets was
copied verbatim beyond sanitized dialog/error text already published in
prior evidence.

| Check                                   | Command                                                      | Result                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 status legibility                   | `/kiwifs-status`                                             | PASS — state line (`healthy` after scope override resolved), per-component notes, credential refs by reference only                                                                                                                                        |
| 4.2 confirmation dialog                 | `/kiwifs-forget integration-tests/g05-tui-gate/synthetic.md` | PASS — dialog rendered on the exact affected record with Yes/No navigation                                                                                                                                                                                 |
| 4.3 cancel = no side effect             | down + enter on dialog                                       | PASS — "forget cancelled"; no backend call on the cancel path                                                                                                                                                                                              |
| 4.2b confirm path fails safe            | re-run + enter on Yes                                        | PASS — `AvailabilityError:availability (no content disclosed)`; no URL/credential/record body in the error                                                                                                                                                 |
| 4.4 private-mode transition             | `/kiwifs-private-mode on` → `/kiwifs-status` → `off`         | PASS — `privateMode: true`, `state: private`, board `state=private`; off releases to `healthy`                                                                                                                                                             |
| 4.5 queue sanitization                  | `/kiwifs-queue`                                              | PASS — aggregate stats only (`pending=0 quarantined=0 acked=0 bytes=0`); no payloads, no credentials                                                                                                                                                       |
| 4.6 board cleanup preview/token binding | `/kiwifs-board-cleanup` / with synthetic sender              | PARTIAL — usage line documents ownership + `--confirm bc-<token>` binding; full preview could not render against the unreachable synthetic backend (fails safe with sanitized `AvailabilityError`). Full preview check needs the live backend (B06 scope). |
| 4.7 no secret values in output          | all of the above                                             | PASS — credentials shown as `env:G05_SYNTHETIC_APIKEY (by reference; value never shown)` throughout                                                                                                                                                        |

Note: an initial run without `projectIdentity` correctly degraded with
`records: DISABLED — record scope not resolved: git remote -v failed`
(fail-closed, sanitized) — recorded as intended behavior, not a defect.

## Defects / failures

None blocking found in the automated PTY pass. 4.6 full-preview rendering
remains unverified offline (needs backend), and items 1.x–3.x with live
backend behavior are outside this task's scope.

## Human signoff

**PENDING.** Automated PTY interaction does not equal the human TUI review
required by B07. A human tester must still perform `docs/beta-acceptance.md`
Part 4 in their own terminal and sign the record there.
