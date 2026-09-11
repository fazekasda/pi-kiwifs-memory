# Beta acceptance record — install, upgrade, rollback, and human TUI review

Template and result record for B07 of the beta release plan. Fill in the
result columns during actual runs; an empty record means the check has
not been performed. Record only commands checked, observed outcomes, and
failures — never terminal content that could contain credentials, raw
transcripts, or memory bodies.

- **Tester:** _fill in_
- **Date:** _fill in_
- **Candidate SHA:** _fill in_
- **Pi version:** 0.85.0 · **Node:** 22.19.0 / 24.19.0
- **Verdict:** ☐ signed off ☐ defects open (block B09)

## Part 1 — Clean install (documented instructions only)

Environment: a clean temporary HOME, a synthetic credential setup (dummy
env-var names; no real secrets), only the README instructions. A clean
tester must be able to configure and operate the extension from the
README and `docs/configuration.md` alone.

| #   | Check                                                                                                  | Result | Notes |
| --- | ------------------------------------------------------------------------------------------------------ | ------ | ----- |
| 1.1 | Install from the documented command works (`pi install` of the release ref)                            | ☐      |       |
| 1.2 | `KIWIFS_MEMORY_CONFIG` unset → extension loads disabled, Pi unaffected                                 | ☐      |       |
| 1.3 | Config written from README example; inline secret is rejected by schema validation                     | ☐      |       |
| 1.4 | First start: `/kiwifs-status` renders `healthy`/`degraded`/`disabled` with reasons, not buried in logs | ☐      |       |
| 1.5 | Missing/unresolved credential → fail-closed with visible note, config still valid for status           | ☐      |       |
| 1.6 | No tokenizer configured → automatic injection skipped with visible note; search/read tools still work  | ☐      |       |
| 1.7 | `.kiwifs/` created at 0700; nothing written outside documented paths                                   | ☐      |       |

## Part 2 — Configured start and feature checks

| #   | Check                                                                                                                  | Result | Notes |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------ | ----- |
| 2.1 | Configured start against a test endpoint: status healthy; retrieval injects nothing without backend records (no error) | ☐      |       |
| 2.2 | `/kiwifs-personal-note` — confirmation preview shows REDACTED statement; headless without `--yes` refuses visibly      | ☐      |       |
| 2.3 | `/kiwifs-proposal` approve/reject/undo — reject leaves targets untouched; undo restores superseded records             | ☐      |       |
| 2.4 | `/kiwifs-forget` requires confirmation; `--yes` headless works; `/kiwifs-forget-undo` restores read-back-verified      | ☐      |       |
| 2.5 | `/kiwifs-backup-verify` — read-only; export refuses to overwrite an existing directory                                 | ☐      |       |
| 2.6 | `/kiwifs-board-cleanup` preview — no deletes on preview; token binds exact candidate set; `--yes` refused              | ☐      |       |
| 2.7 | Private-mode transition: `on` holds everything (status shows `private`); `off` releases held work, transition visible  | ☐      |       |

## Part 3 — Restart, upgrade, downgrade, rollback (state preservation)

Run against the same project directory so `.kiwifs/memory/` persists.
Generate pending jobs (e.g. by stopping the backend or revoking the
credential) before each restart so the outbox is non-empty. Never delete
pending outbox state at any step — see `docs/rollback.md`.

| #    | Check                                                                                                                                                          | Result | Notes |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----- |
| 3.1  | Restart with pending jobs: queue reloads, same pending counts, no dropped or duplicated jobs                                                                   | ☐      |       |
| 3.2  | After backend recovery: backlog delivers; replayed jobs are no-op successes (no duplicate confirmed delivery)                                                  | ☐      |       |
| 3.3  | Upgrade to the candidate over the prior version: local state untouched; queue counts preserved                                                                 | ☐      |       |
| 3.3b | Upgrade from the initial scaffold (unconfigured pre-config install), where practical: `.kiwifs/` state created by the scaffold loads as-is under the candidate | ☐      |       |
| 3.4  | Config endpoint/credential-reference change across a session rebuild: retained jobs HELD visibly (target pin), never delivered to the new target               | ☐      |       |
| 3.5  | Downgrade: state written by the newer version either parses or fails safe with a typed, visible error; nothing auto-truncated or reset                         | ☐      |       |
| 3.6  | Rollback per `docs/rollback.md`: private mode first, state preserved, delivery stopped, return to candidate preserves state and re-delivers idempotently       | ☐      |       |
| 3.7  | At no step was any pending outbox job deleted to recover                                                                                                       | ☐      |       |

## Part 4 — Human TUI review (actual terminal)

Performed interactively in a real terminal, not via RPC/print mode.
Record failures with command names only.

| #   | TUI item                                                                                                                                                | Result | Notes |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----- |
| 4.1 | `/kiwifs-status` renders the state line and per-component notes legibly                                                                                 | ☐      |       |
| 4.2 | Destructive TUI actions (proposal approve, forget, board cleanup, board-gc, personal-note) each show a confirmation dialog on the exact affected record | ☐      |       |
| 4.3 | Cancelling a confirmation dialog performs no side effect                                                                                                | ☐      |       |
| 4.4 | `/kiwifs-private-mode` toggles visibly; held-work release is observable in status                                                                       | ☐      |       |
| 4.5 | `/kiwifs-queue` shows sanitized stats and quarantine fingerprints only (no payloads, no credentials)                                                    | ☐      |       |
| 4.6 | Board cleanup preview in TUI mode shows the exact preview and token binding                                                                             | ☐      |       |
| 4.7 | No secret values appear in any command output (credential references only)                                                                              | ☐      |       |

## Defects found

| Defect              | Severity | Blocks B09? | Reference |
| ------------------- | -------- | ----------- | --------- |
| _none recorded yet_ |          |             |           |

## Sign-off

Tester name and date:

```
_awaiting B07 execution_
```

Any open defect in the table above blocks B09 until resolved or a
recorded user decision narrows beta scope.
