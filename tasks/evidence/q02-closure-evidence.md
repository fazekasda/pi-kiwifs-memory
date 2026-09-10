# Q02 closure evidence — best-effort in-flight cancellation (outbox)

## What the previous receipt deferred, and why it was a Q02 requirement

The Q01/Q02 final receipt (commit af996c4) described outbox IN-FLIGHT
cancellation as a future follow-up. Q02's acceptance (code-quality-plan ground
rules) requires: "private mode prevents NEW … requests after transition AND
best-effort cancels in-flight requests where supported." The prior state
satisfied only the first half for the outbox domain:

- Model extractor/reflector DID abort in-flight attempts on transition
  (Q02b/c: `gate.onCancel` → `activeController.abort()`).
- The outbox worker had NO cancellation seam: `JobSender` took no signal, the
  production `createObservationSender` never propagated one, and the transport
  (which supports a caller `AbortSignal` end-to-end, including body reads)
  was never given one. An in-flight delivery ran to its own timeout.

## Verified transition-path inspection (read-only, before any fix)

- New requests blocked after transition: YES for outbox (gate `isPrivate`
  hold in `tick()` + `assertNetworkAllowed` immediately before send),
  retrieval/backup/board (`changes()` Q02e fix), model (Q02b per-attempt).
- Active fetch aborted where supported: model YES; outbox NO (gap above);
  this closure adds the outbox path.
- No loss / false ack: ack happens only after `send` resolves; an aborted
  send throws, so the job stays pending. The new catch-side hold guarantees
  the aborted job is HELD, never retried into the private window, never
  quarantined, never dropped.
- queueMicrotask dispatch deferral: NOT PRESENT in this tree (HEAD af996c4
  and working tree — verified by repo-wide grep, `src/` and `test/`). There
  is no microtask-deferred dispatch to audit; the only deferred dispatch is
  the constructor-registered `onRelease → void this.tick()`, whose promise
  rejection cannot occur (tick never throws; per-job faults are contained in
  `deliver`). Nothing to fix; no dropped pending work or unhandled rejection
  path exists from microtask deferral.

## Bounded fix (production path, no redesign of Q06/Q07)

- `src/outbox/worker.ts`: `JobSender` widened to
  `(job, signal?) => Promise<void>`. `deliver()` arms a per-delivery
  `AbortController` (`activeSend`), passes its signal to the sender, and
  clears it in `finally`. At construction the worker registers
  `gate.onCancel(() => activeSend?.abort())`. The catch path now re-checks
  the gate FIRST: if private (transition landed mid-send, whatever error the
  abort surfaced), the job is HELD — fail closed, never retry/quarantine.
  `PrivateModeActiveError` handling unchanged.
- `src/observation/sender.ts`, `src/observation/reflection.ts`,
  `src/backup/capture.ts`, `src/board/job.ts`: the optional signal is
  threaded into the existing `writeImmutable`/`write` `opts.signal`
  (already supported end-to-end by `KiwiFSAdapter` and `McpHttpTransport` —
  fetch abort + `CancelledError` mapping, body-read abort included).
  No behavior change when no signal is passed (all pre-existing callers and
  tests unchanged).
- `src/privacy/private-mode.ts`: `PrivateModeGateAdapter.onCancel?` added as
  an OPTIONAL seam (the stateful `PrivateModeGate` satisfies it
  structurally only when subscribed; the worker invokes it optionally).
- `src/privacy/live-gate.ts`: transition cancel listeners are now invoked
  best-effort — one throwing subscriber cannot break the fail-closed gate
  read that observed the transition (remaining listeners still fire).

## Regression through production composition

`test/q02-inflight-cancel.test.ts` (1 test, native `node --test`, synthetic
127.0.0.1 listener only — no real model calls, no live services, no secrets):

Drives `buildSessionRuntime` (shipped runtime, production worker/gate/sender)
with a listener that completes the MCP handshake then STALLS the first
backend write. While the request is genuinely in flight, private mode is
persisted via `setPrivateModeInFile` and pushed through the shipped bridge
(`liveGate.notifyTransition()` — the same call the command wiring makes).
Assertions:

1. the stalled HTTP request is ACTUALLY aborted by the runtime (the listener
   observes the socket close before responding — not a timeout);
2. tick resolves held: `sent: []`, `held: 1`, job stays pending (durable),
   zero quarantined — no loss, no false ack;
3. zero unhandled rejections across the abort AND the subsequent resume
   (process-level listener);
4. after an explicit resume the pre-private job is accounted exactly once
   (pending + quarantined = 1; retried under its original opId, no duplicate,
   no drop).

Results (this session, measured):

- `node --test test/q02-inflight-cancel.test.ts` — 1/1 pass
- Full suite: `npm test` — **501/501 pass, fail 0**; `npm run typecheck` clean
- `npm run check` (typecheck + format + 501 tests) — pass
- Exact Node floor, LAST full-suite run: `npx -y node@22.19.0 --test
test/*.test.ts` — fail 0; budget report re-pinned to `v22.19.0`

## Honest scope notes

- Sent bytes cannot be recalled: the abort only stops waiting/reading — an
  already-fully-sent request that completes server-side before the abort
  lands is handled by the existing crash-window rules (durable replay under
  the same opId is a B2 no-op; never a false ack).
- The pre-existing in-memory `PrivateModeGate` gains no new state; the
  optional `onCancel` seam is satisfied by `LiveConfigPrivateModeGate` (the
  production gate).
- Known Q02e trade-off (settled-boundary classification of not-yet-processed
  pre-private entries) is unchanged — flagged for Q06, not addressed here.
- No commits made (final worker owns the commit); no push/publication.
