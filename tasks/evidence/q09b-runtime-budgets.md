# Q09B — Production runtime performance/resource acceptance evidence

Status: COMPLETE (uncommitted; staged with the final Q09 commit gate).

Scope: runtime budget/resource acceptance tests against the ACTUAL production
factories — `KiwiFSAdapter` (real backend class over the in-process fake MCP
server), `RetrievalCoordinator` (real retrieval/fanout/framing/token-cap
pipeline), `SessionCoordinator` + `DurableOutbox` + `ObserverScheduler` (real
observation/extraction pipeline). No behavior or policy changes; test-only
addition.

**Synthetic labeling (explicit):** every fixture in
`test/q09b-runtime-budgets.test.ts` is synthetic and offline — in-process fake
MCP server, deterministic injected delays, scripted extract, synthetic
tokenizer fixtures labeled `NOT model-compatible`. Zero live services, zero
network, zero model calls. NOTHING here is a production model evaluation; the
extract fixtures measure call volume/scheduling only, NOT observation quality,
and the tokenizer fixtures measure fail-closed/ framing accounting, NOT
production token counts.

## What the tests assert (and how they differ from T19)

T19 (`test/t19-budgets-quality.test.ts`) measured baselines against the
documented budgets. Q09B adds **latency-sensitivity** acceptance that FAILS on
a meaningful slowdown rather than accepting a permissive deadline-only bound,
using **deterministic injected per-request delays** (fake-server `delayMs`,
40 ms) to separate the budget guarantee from wall-clock noise:

1. **Latency linearity + tight baseline** (`inject` test):
   - baseline run (no injected delay) must complete < 500 ms — far tighter than
     the 2 s deadline, so a runtime slowdown FAILS;
   - with 40 ms injected per-request delay, measured latency must be
     explained by the injected-delay model: `>= calls×40ms − 10ms` and
     `<= calls×40ms + slack` — hidden retries, polling or loops fail;
   - backend call count is deterministic and equal between baseline and
     delayed runs (≤ 24, no retry storm).
2. **Query fanout cap**: with 6 authorized scopes (> `MAX_SCOPE_QUERIES = 4`),
   at most 4 FTS and 4 semantic scope queries fire; the skipped scopes surface
   as the visible sanitized `fanout bound reached` degraded note; measured
   latency stays inside the injected-delay model over all backend calls.
3. **Tokenizer fail-closed at runtime**: a tokenizer returning `undefined`
   for the framed payload (and a throwing countTokens wrapped by
   `loadConfiguredTokenizer`, end-to-end) yields `injectionAllowed: false`,
   `tokenCount: undefined` (NO character-estimate fallback), the visible
   `TOKENIZER_UNAVAILABLE_NOTE`, evidence still gathered — deterministic
   across runs. The count is taken over the COMPLETE framed payload.
4. **Extraction call volume**: one settle over a fresh interval = exactly ONE
   extract call; 50 subsequent idle settles add ZERO calls and leave the
   durable scheduler state byte-identical (no unbounded growth).
5. **Many-cycle bounded state**: 100 settle cycles with continuous small input
   produce exactly one extract per cycle (no re-extraction storms), zero
   residual pending batches, exactly one durable observation job per cycle,
   and durable state < 256 KB.
6. **Cancelled pending work**: a pre-compaction flush aborted mid-flight
   returns `signal-aborted` (never `cancel`), writes nothing to the backend
   queue before acceptance, and the in-flight batch settles exactly once —
   one extract call, one durable observation job, `retryPending()` afterwards
   delivers nothing more (no duplicate, no lost range).

## Reproduction

```
npx tsc --noEmit
node --experimental-strip-types --test test/q09b-runtime-budgets.test.ts
npm run check   # typecheck + prettier + full test suite
```

Measured this run: 6/6 Q09B tests pass; full suite **675 pass / 0 fail**
(was 669 before Q09B); `tsc --noEmit` clean; prettier clean.

## T19 legacy evidence

`tasks/evidence/t19-budget-report.json` (and `t19-live-report.json`,
`t19-long-session-report.json`) are the T19 legacy measured baselines and were
NOT rewritten or restaged as new Q09B results; the working-tree jitter in
`t19-budget-report.json` from the Q09A session remains unstaged and untouched,
preserved for deliberate handling under the Q09 evidence consolidation.
