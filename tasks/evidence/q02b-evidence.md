# Q02b evidence — model HTTP request boundary gate (HEAD 4e4b06e + uncommitted fixes)

Command: `npx tsx --test test/q02b-model-gate.test.ts` — **5/5 pass**, ~0s
Typecheck: `npm run typecheck` — clean
Regression: `npx tsx --test test/observation-model.test.ts test/reflection.test.ts` — **43/43 pass** (no behavior change without a gate; options are optional, all existing call sites valid)
Q01 suite state: `npx tsx --test test/q01-private-mode-gaps.test.ts` — Gap 1 (outbox) passes; **Gap 2 (scheduler→model runtime wiring) still fails as expected** — `PRIVACY GAP: scheduler attempted 1 model call(s) while private mode was ON` — because `buildSessionRuntime` does not yet pass the gate into `createModelExtractor`/`createModelReflector`. Runtime hookup is explicitly deferred to Q06; the boundary seam itself is now live.

## Seam (production code, model modules only)

- `src/observation/model.ts`:
  - New exported `ModelRequestGate` interface: `assertModelCallAllowed()` (throw before any bytes sent) + `onCancel(listener)` (best-effort in-flight cancel).
  - `ModelExtractorOptions.gate?: ModelRequestGate` (optional — existing call sites unchanged).
  - `ExtractionModelFailureReason` gains `"private-mode"`.
  - `createModelExtractor` calls `gate.assertModelCallAllowed()` immediately before EVERY `transport(req)` — initial attempt AND corrective validation retry — mirroring `assertNetworkAllowed` re-check semantics. `PrivateModeActiveError` is mapped to a sanitized `ExtractionModelError("private-mode", "private mode active; model request refused")` (name+reason only, safe for durable fingerprints).
  - Cancel: extractor registers with the gate once; on cancel it aborts the live attempt's (already timeout-armed) `AbortController`; an abort while cancel is requested maps to reason `"private-mode"` (not `"timeout"`).
- `src/observation/reflection.ts`: same treatment for `ReflectionModelOptions.gate?` / `ReflectionModelError` (`"private-mode"` reason added, checked before the single transport call, same cancel plumbing).
- No scheduler/index changes; no transport change (gate sits at the transport callers).

## Test coverage (test/q02b-model-gate.test.ts, deterministic fakes only, no network)

1. Private → extractor refuses: typed `ExtractionModelError("private-mode")`, recorder shows **zero** fetches.
2. Gate re-checked before validation retry: gate flips private after malformed first response → retry blocked, exactly **1** fetch (no retry leak).
3. Normal mode unchanged: private=false → happy path identical (no budget/retry regression).
4. Reflector private → `ReflectionModelError("private-mode")`, zero fetches.
5. Cancel in-flight (bounded): gate emits cancel mid-attempt → transport's `AbortSignal` flips to aborted; attempt rejects with `"private-mode"` reason. Fake transport honors the signal exactly like real `fetch`.

## Ambiguities reported (not redesigned, per instructions)

- `LiveConfigPrivateModeGate` has **no cancel/abort surface today**; `onRelease` is deliberately registration-only (fire-on-tick, Q02a re-entrancy rationale). A transition-time cancel hook does not exist on the shared gate.
- Pull-style (`isPrivate` checked per attempt — implemented here) fully blocks NEW attempts, but cannot cancel in-flight attempts unless the gate provides a push hook. Whether `LiveConfigPrivateModeGate` gains `cancelActive(reason)` (push) or the extractor polls per attempt (pull) is a Q06/Q07 composition decision — flagged, not implemented. The `onCancel` seam accepts either (a no-op cancel listener works with pull-only wiring).
- Scheduler-level durably-pending behavior (test outline item 5's `extractNow` variant) is exercised at the boundary only; the end-to-end scheduler/gate composition test remains Q01's Gap 2 witness and flips green with Q06 wiring.

No commit made. All prior uncommitted edits preserved.
