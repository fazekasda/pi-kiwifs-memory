# Rollback, downgrade, and state preservation runbook

How to install, upgrade, downgrade, and roll back the KiwiFS memory
extension without losing pending work. Facts here are pinned by the
runtime code: the outbox journal (`src/outbox/store.ts`), the board
cursor (`src/outbox/cursor.ts`), record frontmatter (`src/domain/records.ts`),
and the config schema (`src/config/schema.ts`).

The one rule this document exists to enforce: **never delete pending
outbox work to recover from a bad version.** Pending jobs are durable,
idempotent, and survive every transition below. Deleting them discards
observations, backups and board sends that have not yet reached the
backend, with no recovery path.

## What state exists and where

- **Config file** — path from `KIWIFS_MEMORY_CONFIG`. Not rewritten by
  the extension; a newer `schemaVersion` there is refused, never
  destructively rewritten (see "Downgrade" below).
- **Local durable state** — `<project>/.kiwifs/memory/` (or
  `KIWIFS_MEMORY_STATE_DIR`), mode `0700`: the outbox journal (JSONL +
  lock file), board delivery state and cursors, session-coordinator
  state, manual-op logs, and board-cleanup preview files.
- **Backend records** — written through the durable outbox with a
  persisted `opId` before each side effect. Replayed jobs are no-ops
  (read-before-write idempotency); nothing is ever overwritten.

All extension state is independent of the installed package. Installing,
upgrading, downgrading, or removing the package never touches
`.kiwifs/`, the config file, or backend records.

## Install (first time)

1. Install per README: `pi install git:github.com/fazekasda/pi-kiwifs-memory`
   (for the beta, pinned to the release tag) or from a local checkout.
2. Write the config file and export `KIWIFS_MEMORY_CONFIG` and the
   referenced secrets. See `docs/configuration.md`.
3. Start Pi and run `/kiwifs-status`. Expect `healthy` or a visible
   degradation note naming the cause. Nothing runs partially on an
   invalid config — fix the named key.

State preserved: a fresh install creates no assumptions about existing
state; an existing `.kiwifs/` from a prior checkout is loaded as-is.

## Upgrade

1. **Optional but recommended: `/kiwifs-private-mode on`.** This stops
   new captures, backend reads and writes, and board delivery while you
   swap the package. Pending jobs are held, never deleted.
2. Install the new version over the old one (`pi install` of the new
   source or git ref). The old installation is replaced; local state is
   untouched.
3. Restart Pi (snapshot-scoped config and delivery adapters rebuild at
   the session boundary; `privateMode` alone is live).
4. Run `/kiwifs-status` and `/kiwifs-queue`. Expect the queue to show
   the same pending counts as before the upgrade.
5. If you enabled private mode: `/kiwifs-private-mode off`. Held jobs
   release through the normal delivery path. A released, replayed job
   lands on the same deterministic path with the same content — no
   duplicate confirmed delivery is possible; a path conflict with
   different content fails closed and quarantines visibly.

**Delivery-target pin:** if the upgrade changes your `mcp.url`,
credential reference, or project identity, previously enqueued jobs are
held visibly (original `opId`, never delivered to the new target, never
dropped) until the config matches the original target again. This is
expected behavior, not data loss — see `docs/configuration.md`.

## Downgrade (newer package → older package)

1. `/kiwifs-private-mode on`.
2. Install the older package version over the current one; restart Pi.
3. `/kiwifs-status` and `/kiwifs-queue`. State written by the newer
   version is read under these rules:
   - **Outbox journal:** a corrupt or unparsable journal line fails
     closed — the queue holds visibly with a typed error naming the
     line; nothing is reset or truncated. Fix nothing by hand while the
     runner is running; report the error instead.
   - **Board cursors / delivery state:** a `schemaVersion` newer than
     the downgraded code supports is read-only fail-safe: the file is
     retained untouched, delivery for that cursor holds, and a
     reconcile flag is set. The authoritative sequence is never reset
     (a reset would re-feed ranges).
   - **Record frontmatter:** backend records carrying a newer
     `schemaVersion` fail safely rather than being misparsed.
   - **Config file:** a newer `schemaVersion` is rejected with a
     visible message and never rewritten. To downgrade the config
     itself, hand-edit it back to `schemaVersion: 1` (the only
     currently supported value) while the extension is disabled or
     pointed elsewhere, then re-enable.
4. If the downgraded version refuses to parse newer state (typed
   corrupt/newer-version errors in `/kiwifs-status`), your options, in
   order of preference:
   a. Re-upgrade to the newer version and resolve there.
   b. Wait: held state is stable and idle; do not delete it.
   c. As a last resort, copy `.kiwifs/memory/` aside for forensics
   (preserve, do not move) — the copy is for later analysis, not a
   license to discard the live copy.
5. `/kiwifs-private-mode off` when status is healthy.

## Rollback of a release (runbook entry point)

Use this when a beta candidate misbehaves after install and you want to
return to the previous known-good version **without losing anything**.

1. **Enter private mode first:** `/kiwifs-private-mode on`. This stops
   delivery, new captures, model calls, and all backend traffic in all
   three domains. Pending outbox jobs are held — this is the entire
   point: state freezes in place, nothing half-delivers during the
   swap.
2. **Preserve state:** do not delete or edit `<project>/.kiwifs/memory/`,
   the config file, or anything in the backend. If you want a snapshot
   for forensics, `cp -a` the state directory (0700 permissions) while
   private mode keeps it quiescent. Optionally run
   `/kiwifs-queue` and note the pending/quarantined counts, and
   `/kiwifs-erasure-report` if you need an inventory of where content
   is retained.
3. **Stop delivery** — already done by private mode; verify with
   `/kiwifs-status` showing `private`. If Pi is running, you may also
   simply quit Pi; the outbox journal is durable and reloads on the
   next start.
4. Install the previous version (pin the git ref or local path), restart
   Pi, and confirm `/kiwifs-status` and `/kiwifs-queue` show the same
   pending counts.
5. **Return to the candidate safely:** after fixing or replacing the
   candidate, install it again, restart, `/kiwifs-private-mode off`.
   Held jobs deliver idempotently through the same durable `opId`
   path as above.
6. If a defect in the candidate corrupted nothing but you want it gone:
   `pi remove` the package. Pending jobs stay in `.kiwifs/memory/` until
   a compatible version is installed again — removal never deletes
   them.

## Invariants across every transition

- Pending outbox jobs are never dropped, in any mode, ever.
- Confirmed deliveries are never duplicated (deterministic paths +
  read-before-write idempotency).
- Destructive state edits (cursor resets, journal truncation, config
  rewrites) do not happen automatically; failures are visible and
  fail closed.
- Private mode is the safe quiesce point for every state-touching
  operation.
