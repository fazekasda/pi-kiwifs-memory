# Q03a evidence — consistent confirmation on record-mutating commands

Verified against HEAD af996c4 + working tree (Q02 closure changes intact and
preserved). All tests synthetic (tmpdir, unroutable 127.0.0.1:1 backend);
no real model calls, no private sessions, no secrets, no network mutations.

## Gap (reproduced by inspection against the shipped registration)

- `/kiwifs-forget-undo <path>`: executed with no confirmation in UI mode
  (no `ctx.ui.confirm`) and no `--yes` gate in headless/RPC mode.
- `/kiwifs-proposal <approve|reject|undo> <path>`: same — transitions ran
  immediately after the usage/config gates.
- `/kiwifs-forget` and `/kiwifs-board-gc`: already confirmed (UI confirm /
  headless `--yes`) — the approved pattern, kept as the reference.
- Read-only commands (`kiwifs-status`, `kiwifs-queue`,
  `kiwifs-erasure-report`, `kiwifs-backup-verify`): confirmation-free by
  design; untouched (read-only listing unaffected, per approved policy).

## Fix (src/index.ts, command registration only)

- `kiwifs-forget-undo`: after arg validation, UI sessions get a confirm
  dialog ("Restore forgotten record", target path shown); headless requires
  the literal `--yes` token (stripped before path parsing). Refusal →
  notify + return before `manualOpsGate`/runtime/store access: zero durable
  writes, zero network mutations.
- `kiwifs-proposal`: same policy per action; UI confirm names the action and
  proposal path; headless requires `--yes`. Refusal → cancel notice and
  return before `configGate()`/runtime access.
- Both refusals mirror the existing `/kiwifs-forget` headless refusal
  wording ("requires --yes (record-mutating command)").

## Regression (actual registration composition)

`test/t18-commands.test.ts` additions (3 tests, all through the real
`kiwifsMemory()` registration surface):

1. Registration: all 11 shipped commands registered with callable handlers;
   read-only commands run headless (no UI access thrown getter proves it)
   with no confirmation step.
2. forget-undo matrix: UI confirm shown once naming the path; cancel →
   "cancelled" notice + manual-oplog.jsonl NOT created; accept → proceeds
   (visible retryable refusal from unresolved synthetic credential; no
   network); headless without `--yes` → refused, no oplog; headless with
   `--yes` → past the gate, no crash, no oplog (credential unresolved).
3. proposal matrix: UI confirm for approve/reject/undo; cancel →
   "proposal cancelled", zero runtime access; accept → proceeds to the
   lifecycle-unavailable notice; headless without `--yes` → refused with
   zero confirms and zero durable writes; `--yes` → past the gate.

Test-authoring defect caught and fixed (in the test helper, not production):
spreading the headless context object literal invoked its `get ui()` thrower;
the helper now builds the context without spreading the getter.

## Gates (measured)

- `npm run check`: pass — typecheck clean, prettier clean, suite 504/504
  (prior 501 + 3 new). Last full-suite run at commit time remains the
  commit worker's responsibility.
- Secret scan (`git diff src/index.ts`, `git diff test/t18-commands.test.ts`
  grep for bearer/token/secret/password/api-key): clean — env-var names and
  `KIWIFS_T18_SYNTHETIC_TOKEN` references only.
- Preserved: all Q02 working-tree changes, `t19-budget-report.json` jitter,
  unrelated plan/log edits. No commits, no push.
