# Q02c chunk 1 evidence — shared gate transition notification (HEAD 4e4b06e + uncommitted Q01/Q02a/Q02b fixes)

Command: `node --test test/q02c-gate-transition.test.ts` — **7/7 pass** (~0.05s, native node --test TS, no tsx)
Typecheck: `npm run typecheck` — clean; Prettier — clean on changed files
Regressions: `node --test test/q02a-outbox-gate.test.ts test/q02b-model-gate.test.ts test/q02c-gate-transition.test.ts` — **16/16 pass**; `node --test test/privacy.test.ts test/outbox.test.ts test/config.test.ts test/runtime-controls.test.ts test/observation-model.test.ts test/reflection.test.ts` — **119/119 pass** (no behavior change without subscribers).
Q01 suite state: Gap 1 (outbox) still passes; **Gap 2 (scheduler→model runtime wiring) still fails as expected** — `PRIVACY GAP: scheduler attempted 1 model call(s) while private mode was ON` — owned by Q06 factory hookup (explicitly NOT done here per instructions).

## Exact API added

`src/privacy/live-gate.ts` — `LiveConfigPrivateModeGate` (same instance the outbox worker already holds):

- `onCancel(listener: (reason: string) => void): void` — cancellation subscription, exactly the `ModelRequestGate.onCancel` shape from Q02b. Fired once per observed normal→private transition, with reason `"private mode enabled"`; never fires for private→normal; repeated reads while private never re-fire.
- `notifyTransition(): void` — push path: forces a fail-closed config read immediately. Used by the command bridge so a persisted flip notifies subscribers at TRANSITION time, not at the next tick/pull. If the observed state is already private (e.g. a prior pull beat it), it does not duplicate the fire.
- `assertModelCallAllowed(): void` — `ModelRequestGate` seam method (throws `PrivateModeActiveError("observation")` when private). The gate now satisfies the Q02b `ModelRequestGate` interface structurally, so Q06 can pass it straight into `createModelExtractor`/`createModelReflector`. **No factory/scheduler hookup was made** (deferred, per instructions).
- `dispose(): void` — releases ALL transition/release subscriptions; called from the extension's `session_shutdown` handler.

Transition semantics (private `observe()`): every read is fail-closed (`read()` throw or invalid config ⇒ private); the FIRST read is not a transition (no spurious cancel at private startup); the fire happens AFTER `lastObserved` is updated, so any listener re-checking the gate during the callback already observes private (ordering guarantee).

## Production wiring (minimal command bridge)

- `src/index.ts` `buildRuntimeControlSurface`: new optional dep `notifyPrivateTransition?: (value: boolean) => void`, invoked ONLY after `setPrivateModeInFile` returns ok — a failed/aborted persist never notifies (gate stays consistent, tested).
- `kiwifsMemory`'s `controlSurface(cwd)` passes the bridge: `notifyPrivateTransition: () => runtimeBox.getRuntime(cwd)?.liveGate?.notifyTransition()` — the actual private-control transition (`/kiwifs-private-mode on|off` → `surface.setPrivateMode`) now pushes into the runtime's shared gate immediately.
- `SessionRuntime` gains `liveGate: LiveConfigPrivateModeGate | undefined` (the shared production instance; exposed for Q06 wiring and tests).
- `session_shutdown` handler: `runtime?.liveGate?.dispose()` — subscriptions released on shutdown.

## Tests (test/q02c-gate-transition.test.ts)

1. Repeated cycles: normal→private fires cancel exactly once per enable; private reads never re-fire; private→normal never fires; three enable cycles → exactly three fires.
2. Cancellation ordering: when a subscriber runs, `gate.isPrivate` is already true and `assertModelCallAllowed()` inside the callback already throws `PrivateModeActiveError` (fail-closed before listeners).
3. Config read failure fails CLOSED: read throws → `isPrivate` true and cancel fired (a read failure IS a normal→private transition).
4. `notifyTransition` push fires without any pull read; second push does not duplicate.
5. `dispose()`: gate still reports state, but no cancel fire ever again (push or pull).
6. Production composition (`buildSessionRuntime`): `rt.liveGate` exists; command-bridge surface flips a real temp config file → cancel fires at transition time (push), off does not fire, failed persist (`setPrivateModeInFile` to an unwritable path) does not notify, `dispose()` silences everything.
7. Bridge fail-closed consistency: persist failure (unreadable config) → `notifyPrivateTransition` never invoked.

Privacy invariants honored: notification is metadata-only (a reason string, no user content); a transition cancels NEW/active sends best-effort — already-sent bytes are unaffected (cannot be recalled); pre-private pending work remains durable (outbox hold semantics untouched).

## Not done here (per instructions)

- No scheduler/model-factory hookup (Q06): the gate now satisfies `ModelRequestGate`, but `createModelExtractor`/`createModelReflector` in `buildSessionRuntime` are untouched; Q01 Gap 2 remains the failing witness.
- No commit made. All prior uncommitted Q01/Q02a/Q02b edits preserved.
