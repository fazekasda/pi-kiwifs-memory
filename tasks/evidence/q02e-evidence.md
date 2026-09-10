# Q02 chunk 3 evidence — transition integration edges through production runtime (HEAD 4e4b06e + uncommitted Q01/Q02a–d fixes)

Commands (native `node --test`, no tsx):

- `node --test test/q02e-transition-edges.test.ts` — **5/5 pass**
- `npm test` (full suite) — **500/500 pass** (~41s)
- `npm run typecheck` — clean (after the fix below)

## Production change (one gap, bounded)

- `src/board/repository.ts` `changes()`: the raw `kiwi_changes` feed was the
  ONE `BoardRepository` op without the per-operation private assert
  (`send`/`list`/`read` already assert). A transition mid-delivery-cycle
  could keep paging the feed until the next boundary. Now fails closed:
  `assertNotPrivate()` runs synchronously before any adapter paging work.
  The cursor stays untouched, so the segment replays on resume — no drops,
  no duplicates. Regression: test 4.

**No other production files were changed in this chunk.** `src/board/delivery.ts`
is UNMODIFIED: the mid-cycle stop observed in test 3 comes entirely from the
pre-existing per-message `isPrivate` checks plus `read`/`changes` now throwing
`PrivateModeActiveError` (caught by the existing cycle error handling → the
cycle pauses, `runState: "private"`). There is no `onTransition` hook anywhere.

## Test-file fix (typecheck blocker from review)

- `test/q02e-transition-edges.test.ts` helpers `goPrivate`/`goNormal`: the
  `rt` param type `{ liveGate?: { notifyTransition(): void } }` violated
  `exactOptionalPropertyTypes` when callers passed a `SessionRuntime`
  (`liveGate` is `LiveConfigPrivateModeGate | undefined`). Fixed by adding
  `| undefined` to the property type. Type-only change; no behavior change.

## Coverage (test/q02e-transition-edges.test.ts — synthetic local listeners or intercepted `globalThis.fetch`; zero live network, no secrets, no private sessions)

1. **Retrieval**: baseline read while normal reaches the backend; after
   normal→private, zero NEW backend requests across repeated reads
   (pull re-checks fail closed); resume reopens reads.
2. **Backup + outbox**: pre-private capture enqueues durable jobs and one
   tick attempts delivery; after transition, capture is refused
   (`skippedReason "private-mode"`) and tick sends nothing; RESTART under
   private (fresh `buildSessionRuntime` over the same state dir) sends
   nothing and drops nothing; on resume the pre-private job retries under
   its ORIGINAL opId exactly once (retryable hold, no duplicate).
3. **Board delivery cycle**: normal cycle reaches the backend; after
   transition, zero NEW board requests within a full poll window and
   `statusSnapshot().runState === "private"`; after flip back, reads resume
   and runState leaves "private".
4. **`changes()` regression**: directly constructed repo with fail-closed
   `privateMode` gate; `repo.changes("")` throws `PrivateModeActiveError`
   synchronously before any request leaves the process.
5. **Stale callbacks / no silent bypass**: after `dispose()` (as
   `session_shutdown` does), `notifyTransition()` is a silent no-op, yet the
   pull gate still fails closed — `extractNow` returns
   `skippedReason "private-mode"` with zero model calls and the outbox tick
   sends nothing; started-then-stopped delivery stays stopped, double
   `stop()` is a no-op.

## Privacy invariants

- Zero NEW outbound attempts after an observed transition, in every domain
  exercised (retrieval, backup capture, outbox tick, board delivery, model).
- Best-effort abort of active work via the transition-time cancel push
  (Q02c) plus fail-closed per-operation asserts (Q02a/b/d and the `changes()`
  fix here); already-sent bytes are not recallable and no recall is attempted.
- Pre-private durable work retained (no quarantine, no drop), resumed under
  original opIds; private-period content never replayed (Q02d classification).
- Gate absent in test-helper contexts never implies a production bypass: the
  shipped `buildSessionRuntime` always passes the real gate.

## Known trade-off (flagged for Q06, not a blocker)

At a settled/idle/compact boundary during private, ALL unprocessed entries —
including ones captured pre-private but not yet processed at that boundary —
are classified private-session and consumed without extraction. This is
conservative in the correct privacy direction (no replay of possibly-private
content), but it can silently degrade pre-private coverage; the only
disclosure is the `pendingStatus()` gap line. There is no capture-timestamp
basis to distinguish the two populations today.
