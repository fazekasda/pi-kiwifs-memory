/**
 * T19 chunk: budgets + quality measurement harness (PRD T19 AC 5/6).
 *
 * AC5 — budgets (measured, not estimated): retrieval latency against the
 * confirmed 2 s total deadline (§13 row 1), context usage against the
 * confirmed 3,000-token evidence cap (§13 row 2, enforced with the synthetic
 * tokenizer fixture over the COMPLETE framed payload), and extraction call
 * volume against the [P] batching budgets (6,000/3,000-token batches,
 * threshold ≥2,000 tok or ≥10 turns or 5 min idle, 20-batch queue — §13 row
 * 9). All synthetic: in-process fake MCP server, scripted extract stub, the
 * deterministic synthetic tokenizer fixture — zero live services, zero
 * network, zero model calls. Measured values are written to
 * tasks/evidence/t19-budget-report.json for the documented baselines
 * (docs/t19-quality-baselines.md).
 *
 * AC6 — named retrieval-relevance and observation source-coverage fixtures
 * with EXPLICIT deterministic expectations (exact paths, exact notes, exact
 * batch membership). Deterministic counts, never invented percentages.
 *
 * Mock-model limit (honest labeling): the extract stub returns scripted
 * observations; these fixtures measure SCHEDULING/COVERAGE/CALL-VOLUME
 * behavior, NOT observation quality, and the synthetic tokenizer is NOT
 * compatible with any production model (docs/t19-quality-baselines.md).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { KiwiFSAdapter } from "../src/backend/adapter.ts";
import { createMemoryLedger } from "../src/backend/opid.ts";
import { identityRedactor } from "../src/backend/guard.ts";
import {
  RetrievalCoordinator,
  frameEvidence,
  type EvidenceItem,
  type EvidencePack,
} from "../src/retrieval/coordinator.ts";
import { loadConfiguredTokenizer } from "../src/retrieval/tokenizer.ts";
import { ObserverScheduler, STATE_FILE } from "../src/observation/scheduler.ts";
import { SessionCoordinator } from "../src/pi/coordinator.ts";
import { DurableOutbox } from "../src/outbox/store.ts";
import { createFakeServer } from "./fake-mcp-server.ts";

const URL_ = "https://kiwifs.test/mcp";
const SCOPE = "project/demo-proj";

/** Collected measured data — written to the evidence report at the end. */
const REPORT: Record<string, unknown> = {
  synthetic: true,
  liveServices: false,
  modelCalls: false,
  limitations: [
    "synthetic tokenizer is NOT production-model-compatible (word/punct fixture)",
    "extraction model is a scripted stub — scheduling/coverage/volume only, NOT observation quality",
  ],
};

function newDir(name: string): string {
  return join(
    tmpdir(),
    `kiwifs-t19-q-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function record(scope: string, status: string, body: string): string {
  return [
    "---",
    `scope: ${scope}`,
    `memory_status: ${status}`,
    "---",
    body,
  ].join("\n");
}

/** Body of `words` space-separated synthetic words. */
const TOKENIZER_FIXTURE = fileURLToPath(
  new URL("fixtures/t19-synthetic-tokenizer.mjs", import.meta.url),
);

function bodyWords(words: number, tag: string): string {
  const parts: string[] = [];
  for (let i = 0; i < words; i++) {
    parts.push(`w${i % 40}${tag}`);
  }
  return parts.join(" ");
}

async function setup(behavior: Parameters<typeof createFakeServer>[0] = {}) {
  const server = createFakeServer(behavior);
  const adapter = new KiwiFSAdapter({
    url: URL_,
    fetchImpl: server.fetch,
    ledger: createMemoryLedger(),
    requestTimeoutMs: 5_000,
  });
  await adapter.connect();
  return { server, adapter };
}

function makeCoordinator(
  adapter: KiwiFSAdapter,
  tokenizer: ConstructorParameters<typeof RetrievalCoordinator>[0]["tokenizer"],
  deadlineMs = 2_000,
): RetrievalCoordinator {
  return new RetrievalCoordinator({
    adapter,
    authorizedScopes: [SCOPE],
    deadlineMs,
    tokenCap: 3_000,
    generation: 1,
    redact: identityRedactor,
    ...(tokenizer !== undefined ? { tokenizer } : {}),
  });
}

const TEST_TOKENIZER = {
  id: "test-word-split (synthetic fixture)",
  countTokens(text: string): number | undefined {
    return text.split(/\s+/).filter((t) => t !== "").length;
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// AC5a — retrieval latency vs the confirmed 2 s total deadline
// ---------------------------------------------------------------------------

test("budgets: retrieval latency under simulated 50 ms backend latency stays inside the 2 s deadline (measured, 5 runs)", async () => {
  const { server, adapter } = await setup();
  for (let i = 0; i < 3; i++) {
    server.state.store.set(
      `${SCOPE}/memory/observations/2026/01/rec-${i}.md`,
      record(SCOPE, "active", `postgres migration w0${i} w1${i}`),
    );
  }
  server.behavior.delayMs = 50;
  const coord = makeCoordinator(adapter, TEST_TOKENIZER);
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const outcome = await coord.retrieve(
      "postgres migration",
      undefined,
      "interactive",
    );
    const ms = Math.round(performance.now() - start);
    assert.equal(outcome.kind, "pack", `run ${i} produced a pack`);
    runs.push(ms);
    assert.ok(
      ms < 2_000,
      `measured retrieval latency ${ms} ms must stay inside the 2000 ms deadline budget`,
    );
  }
  REPORT.latency50msPerCall = { runs, budgetDeadlineMs: 2_000, unit: "ms" };
  REPORT.latencyBaselineZeroDelayNote =
    "50 ms simulated per-request backend latency applied to every fake-server call (guard read-backs included)";
});

test("budgets: the deadline is enforced — a slow backend degrades visibly instead of overrunning (measured)", async () => {
  const { server, adapter } = await setup();
  server.state.store.set(
    `${SCOPE}/memory/observations/2026/01/slow.md`,
    record(SCOPE, "active", "postgres migration slow record"),
  );
  server.behavior.delayMs = 600;
  const coord = makeCoordinator(adapter, TEST_TOKENIZER, 400);
  const start = performance.now();
  const outcome = await coord.retrieve(
    "postgres migration",
    undefined,
    "interactive",
  );
  const ms = Math.round(performance.now() - start);
  assert.equal(outcome.kind, "degraded");
  assert.match((outcome as { reason: string }).reason, /deadline/i);
  assert.ok(
    ms < 1_500,
    `deadline-expiry run completed in ${ms} ms — the 400 ms deadline must cut the cycle, not the 600 ms backend delay`,
  );
  REPORT.deadlineEnforcement = {
    backendDelayMs: 600,
    configuredDeadlineMs: 400,
    measuredElapsedMs: ms,
    outcome: "degraded (deadline exceeded, nothing injected)",
  };
});

// ---------------------------------------------------------------------------
// AC5b — context usage vs the confirmed 3,000-token cap (synthetic tokenizer,
// including framing, over the complete payload)
// ---------------------------------------------------------------------------

test("budgets: configured tokenizer loads and enforces the 3,000-token cap over the COMPLETE framed payload (measured)", async () => {
  const loaded = await loadConfiguredTokenizer(
    { module: TOKENIZER_FIXTURE },
    import.meta.dirname,
  );
  assert.ok(loaded.ok, "fixture tokenizer module loads");
  if (!loaded.ok) return;
  assert.match(loaded.tokenizer.id, /NOT model-compatible/);
  const { server, adapter } = await setup();
  const N = 8;
  for (let i = 0; i < N; i++) {
    server.state.store.set(
      `${SCOPE}/memory/observations/2026/01/cap-${i}.md`,
      record(
        SCOPE,
        "active",
        `postgres migration ${bodyWords(400, String(i))}`,
      ),
    );
  }
  const coord = makeCoordinator(adapter, loaded.tokenizer);
  const outcome = await coord.retrieve(
    "postgres migration",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  assert.equal(pack.injectionAllowed, true);
  assert.notEqual(pack.tokenCount, undefined);
  assert.ok(
    pack.tokenCount! <= 3_000,
    `framed pack counted ${pack.tokenCount} tokens — must fit the 3000-token cap`,
  );
  assert.ok(
    pack.items.length < N,
    `cap enforcement dropped evidence: kept ${pack.items.length} of ${N}`,
  );
  // Deterministic accounting: the identical retrieve re-counts identically.
  const again = await makeCoordinator(adapter, loaded.tokenizer).retrieve(
    "postgres migration",
    undefined,
    "interactive",
  );
  assert.equal(
    (again as { pack: EvidencePack }).pack.tokenCount,
    pack.tokenCount,
  );
  // Ranking: the kept set is the highest-scored prefix (FTS scores descend
  // with store insertion order), and every dropped item scored no higher.
  const firstOffered = `${SCOPE}/memory/observations/2026/01/cap-0.md`;
  assert.equal(pack.items[0]!.path, firstOffered);
  REPORT.contextUsage = {
    tokenizerId: loaded.tokenizer.id,
    tokenCap: 3_000,
    recordsOffered: N,
    wordsPerRecord: 400,
    itemsKept: pack.items.length,
    tokenCount: pack.tokenCount,
    framingBaselineTokens: TEST_TOKENIZER.countTokens(
      frameEvidence([] as EvidenceItem[]),
    ),
  };
});

// ---------------------------------------------------------------------------
// AC6 — named retrieval-relevance fixtures with explicit expectations
// ---------------------------------------------------------------------------

test("quality fixtures QF-R1/R2/R3/R4: explicit relevance expectations — exact paths, exact rejections, zero out-of-scope or superseded content", async () => {
  const { server, adapter } = await setup();
  // QF-R1 (positive recall): three active in-scope records.
  server.state.store.set(
    `${SCOPE}/memory/observations/2026/01/r1-a.md`,
    record(SCOPE, "active", "postgres migration r1-a"),
  );
  server.state.store.set(
    `${SCOPE}/memory/observations/2026/01/r1-b.md`,
    record(SCOPE, "active", "postgres migration r1-b"),
  );
  server.state.store.set(
    `${SCOPE}/memory/observations/2026/01/r1-c.md`,
    record(SCOPE, "active", "postgres migration r1-c"),
  );
  // QF-R2 (scope precision): same text in another scope.
  server.state.store.set(
    "project/other-proj/memory/observations/2026/01/r2-other.md",
    record(
      "project/other-proj",
      "active",
      "postgres migration r2-out-of-scope",
    ),
  );
  // QF-R3 (superseded exclusion): a superseded in-scope record.
  server.state.store.set(
    `${SCOPE}/memory/observations/2026/01/r3-superseded.md`,
    record(SCOPE, "superseded", "postgres migration r3-superseded"),
  );
  // QF-R4 (keyword-only hybrid attribution).
  server.state.hybridAttribution.set(
    `${SCOPE}/memory/observations/2026/01/r1-a.md`,
    "keyword only",
  );
  const coord = makeCoordinator(adapter, TEST_TOKENIZER);
  const outcome = await coord.retrieve(
    "postgres migration",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  // EXPLICIT expectation (QF-R1): exactly the three active in-scope records,
  // highest FTS score first (store insertion order → 3.5 > 3.4 > 3.3).
  assert.deepEqual(
    pack.items.map((i) => i.path.split("/").pop()),
    ["r1-a.md", "r1-b.md", "r1-c.md"],
  );
  // EXPLICIT expectation (QF-R2): zero out-of-scope content; the scope-less
  // hybrid leg's candidate is guard-rejected (scope step).
  assert.ok(pack.items.every((i) => i.scope === SCOPE));
  assert.ok(
    pack.degraded.some((d) => /guard step 'scope'/.test(d)),
    `out-of-scope candidate rejected with a scope note: ${pack.degraded.join(" | ")}`,
  );
  // EXPLICIT expectation (QF-R3): the superseded record is guard-rejected
  // (status step) and never enters the pack.
  assert.ok(
    pack.degraded.some((d) => /guard step 'status'/.test(d)),
    `superseded candidate rejected with a status note: ${pack.degraded.join(" | ")}`,
  );
  // EXPLICIT expectation (QF-R4): keyword-only hybrid attribution is
  // disclosed as degraded and never counted as semantic evidence.
  assert.ok(
    pack.degraded.some((d) =>
      /hybrid search degraded: results lack full semantic attribution/.test(d),
    ),
  );
  assert.ok(
    pack.items.every(
      (i) => i.leg !== "hybrid" || i.attribution === "keyword only",
    ),
  );
});

test("quality fixture QF-R5: empty result set is an explicit empty pack with a visible note (no fabrication)", async () => {
  const { adapter } = await setup();
  const coord = makeCoordinator(adapter, TEST_TOKENIZER);
  const outcome = await coord.retrieve(
    "postgres migration",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  assert.deepEqual(pack.items, []);
  assert.ok(
    pack.degraded.some((d) => /no evidence passed the guard pipeline/.test(d)),
  );
});

// ---------------------------------------------------------------------------
// AC5c/AC6 — extraction call volume, batch budgets and source-coverage
// fixtures (scripted extract stub — scheduling behavior, NOT quality)
// ---------------------------------------------------------------------------

interface QFixture {
  dir: string;
  store: DurableOutbox;
  scheduler: ObserverScheduler;
  extractCalls: { opId: string; entryIds: string[] }[];
  sources: {
    id: string;
    role: "user" | "assistant";
    text: string;
    timestamp: string;
  }[];
  failNextExtract: { value: boolean };
}

function qFixture(opts: {
  maxPendingBatches?: number;
  failFirst?: boolean;
  holdAfter?: number;
}): QFixture {
  const dir = newDir("obs");
  const coordinator = new SessionCoordinator({ stateDir: dir });
  coordinator.onSessionStart(
    {
      cwd: dir,
      sessionManager: { getSessionId: () => "s1", getLeafId: () => "leaf-a" },
    },
    { reason: "startup" },
  );
  const store = DurableOutbox.open(join(dir, "outbox"));
  const extractCalls: { opId: string; entryIds: string[] }[] = [];
  const sources: QFixture["sources"] = [];
  const failNextExtract = { value: opts.failFirst ?? false };
  const hold = new Promise<never>(() => undefined);
  const scheduler = new ObserverScheduler({
    stateDir: dir,
    coordinator,
    outbox: store,
    scope: SCOPE,
    sessionId: "s1",
    branchId: "leaf-a",
    ...(opts.maxPendingBatches !== undefined
      ? { maxPendingBatches: opts.maxPendingBatches }
      : {}),
    extract: (batch) => {
      extractCalls.push({
        opId: batch.opId,
        entryIds: batch.sources.map((s) => s.id),
      });
      if (failNextExtract.value) {
        failNextExtract.value = false;
        throw new Error("synthetic extraction fault");
      }
      if (
        opts.holdAfter !== undefined &&
        extractCalls.length > opts.holdAfter
      ) {
        return hold;
      }
      return {
        observations: batch.sources.map((s) => ({
          sourceEntryIds: [s.id],
          statement: `synthetic observation for ${s.id}`,
          uncertainty: "low",
        })),
      };
    },
    idleMs: 3_600_000, // idle batching must not fire mid-test
  });
  scheduler.setProvider({ entries: () => sources });
  return { dir, store, scheduler, extractCalls, sources, failNextExtract };
}

function addTurns(
  fx: QFixture,
  count: number,
  startIdx: number,
  words = 150,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `e${startIdx + i}`;
    ids.push(id);
    fx.sources.push({
      id,
      role: "user",
      text: `turn ${startIdx + i} ${bodyWords(words, "x")}`,
      timestamp: "2026-09-08T00:00:00Z",
    });
  }
  return ids;
}

/** Wait for the scheduler's internal run chain to drain a synchronous extract. */
async function drain(): Promise<void> {
  await sleep(20);
}

test("budgets/coverage QF-C1: 10-turn threshold triggers ONE batch under the 6,000-token input budget with FULL source coverage (measured)", async () => {
  const fx = qFixture({});
  const ids = addTurns(fx, 12, 0);
  const summary = fx.scheduler.onAgentSettled();
  assert.equal(summary.scheduled, 1);
  await drain();
  assert.equal(fx.extractCalls.length, 1, "exactly one model call");
  const job = fx.store.pending()[0]!;
  const payload = job.payload as {
    inputBudgetTokens: number;
    outputBudgetTokens: number;
    sourceEntryIds: string[];
  };
  // EXPLICIT expectation: batch budgets are the confirmed 6,000/3,000.
  assert.equal(payload.inputBudgetTokens, 6_000);
  assert.equal(payload.outputBudgetTokens, 3_000);
  // EXPLICIT expectation (QF-C1): FULL coverage — every source entry is in
  // the batch, none dropped.
  assert.deepEqual([...payload.sourceEntryIds].sort(), [...ids].sort());
  assert.equal(fx.store.stats.pending, 1);
  REPORT.extraction = {
    thresholdTrigger: "12 turns (≥10-turn threshold)",
    batches: 1,
    modelCalls: 1,
    entriesInBatch: payload.sourceEntryIds.length,
    inputBudgetTokens: payload.inputBudgetTokens,
    outputBudgetTokens: payload.outputBudgetTokens,
  };
});

test("coverage QF-C2: input-budget overflow splits into disjoint sequential batches — the union still covers every entry (no drop)", async () => {
  const fx = qFixture({});
  const ids = addTurns(fx, 60, 0); // 60 × ~151 tokens ≈ 9,000 est tokens
  const s1 = fx.scheduler.onAgentSettled();
  assert.equal(s1.scheduled, 1);
  await drain();
  assert.equal(fx.extractCalls.length, 1);
  const first = fx.extractCalls[0]!;
  assert.ok(
    first.entryIds.length < 60,
    `input budget split the batch: ${first.entryIds.length} of 60 entries`,
  );
  const s2 = fx.scheduler.onAgentSettled();
  assert.equal(s2.scheduled, 1);
  await drain();
  assert.equal(fx.extractCalls.length, 2, "second batch → second call");
  const covered = [...first.entryIds, ...fx.extractCalls[1]!.entryIds].sort();
  assert.deepEqual(covered, [...ids].sort());
  const overlap = first.entryIds.filter((id) =>
    fx.extractCalls[1]!.entryIds.includes(id),
  );
  assert.deepEqual(overlap, []);
  REPORT.extractionSplit = {
    entries: 60,
    batch1Entries: first.entryIds.length,
    batch2Entries: fx.extractCalls[1]!.entryIds.length,
    modelCalls: 2,
    unionCoverage: "complete, disjoint",
  };
});

test("coverage QF-C3: pending-queue cap merges overflow into the oldest batch — no source entry is ever lost", async () => {
  const fx = qFixture({ maxPendingBatches: 2, holdAfter: 1 });
  // ~470 est tokens per turn → the 6,000-token input budget caps each batch
  // at ~12 entries; 60 entries therefore need more batches than the queue
  // cap, exercising the merge-into-oldest overflow path deterministically.
  const words = 400;
  const all: string[] = [
    ...addTurns(fx, 10, 0, words),
    ...addTurns(fx, 10, 100, words),
    ...addTurns(fx, 10, 200, words),
    ...addTurns(fx, 10, 300, words),
    ...addTurns(fx, 10, 400, words),
    ...addTurns(fx, 10, 500, words),
  ];
  // Settle until every entry is durably accepted, durably pending in a
  // capped batch, or (transiently) unprocessed — bounded loop.
  let totalScheduled = 0;
  for (let i = 0; i < 12; i++) {
    if (fx.scheduler.selectUnprocessed().length === 0) break;
    totalScheduled += fx.scheduler.onAgentSettled().scheduled;
    await drain();
  }
  // EXPLICIT expectation: more batches were scheduled than the queue cap
  // allows to coexist — the merge-into-oldest overflow path MUST have run.
  assert.ok(
    totalScheduled >= 4,
    `cap exercised: ${totalScheduled} batches scheduled against a 2-batch queue`,
  );
  const batches = pendingBatchEntryIds(fx.dir);
  assert.ok(
    batches.length <= 2,
    `queue capped at 2: ${batches.length} pending batches`,
  );
  assert.equal(
    fx.scheduler.selectUnprocessed().length,
    0,
    "no entry left unconsumed and unbatched",
  );
  // EXPLICIT expectation (QF-C3): COMPLETE coverage with no loss and no
  // duplication — the durably accepted batch's entries plus the durable
  // pending batches' entries together cover EVERY fed source entry.
  const acceptedJob = fx.store.pending()[0]!;
  const accepted = (acceptedJob.payload as { sourceEntryIds: string[] })
    .sourceEntryIds;
  const pending = batches.flat();
  const union = [...new Set([...accepted, ...pending])].sort();
  assert.deepEqual(union, [...all].sort());
  const overlap = accepted.filter((id) => pending.includes(id));
  assert.deepEqual(overlap, []);
  REPORT.queueCap = {
    maxPendingBatches: 2,
    batchesFed: totalScheduled,
    entriesTotal: all.length,
    acceptedEntries: accepted.length,
    pendingBatchCount: batches.length,
    coverage:
      "accepted ∪ pending == all entries, disjoint (merge-into-oldest, nothing dropped)",
  };
});

/** Read the observer's durable pending batches from its state file. */
function pendingBatchEntryIds(dir: string): string[][] {
  const file = join(dir, STATE_FILE);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    pendingBatches?: { entryIds: string[] }[];
  };
  return (parsed.pendingBatches ?? []).map((b) => b.entryIds);
}

test("coverage QF-C4: repeated settles over the SAME coverage never re-extract (call volume is bounded by new content)", async () => {
  const fx = qFixture({});
  addTurns(fx, 12, 0);
  fx.scheduler.onAgentSettled();
  await drain();
  assert.equal(fx.extractCalls.length, 1);
  for (let i = 0; i < 5; i++) {
    const s = fx.scheduler.onAgentSettled();
    assert.equal(s.scheduled, 0, `repeat settle ${i} schedules nothing`);
    assert.equal(s.deferred, false);
  }
  assert.equal(fx.extractCalls.length, 1, "still exactly one model call");
  REPORT.repeatSettleCallVolume = {
    settles: 6,
    modelCalls: 1,
    expectation: "one call per unique source range; repeats cost zero calls",
  };
});

test("coverage QF-C5: a failed extraction keeps the SAME opId and full source coverage durably pending (measured re-derivation)", async () => {
  const fx = qFixture({ failFirst: true });
  const ids = addTurns(fx, 12, 0);
  fx.scheduler.onAgentSettled();
  await drain();
  assert.equal(fx.extractCalls.length, 1);
  assert.equal(fx.scheduler.lastError, "Error");
  // The durable batch record (not an outbox job — acceptance never happened)
  // is what keeps the source range recoverable.
  assert.equal(
    readDurableBatches(fx.dir).length,
    1,
    "batch stays durably pending",
  );
  // Retry inside the cooldown window: the batch stays pending and NO new
  // model call is made (the cooldown protects the provider).
  fx.scheduler.onAgentSettled();
  await drain();
  assert.equal(fx.extractCalls.length, 1);
  // EXPLICIT expectation: the durable record retains the SAME opId and the
  // FULL entry coverage — re-derivation never duplicates or drops.
  const durable = readDurableBatches(fx.dir);
  assert.equal(durable.length, 1);
  assert.equal(
    durable[0]!.opId,
    fx.extractCalls[0]!.opId,
    "SAME opId retained",
  );
  assert.deepEqual([...durable[0]!.entryIds].sort(), [...ids].sort());
  REPORT.failureCoverage = {
    attempts: 1,
    opIdStable: true,
    durableCoverage: `${durable[0]!.entryIds.length}/12 entries retained`,
  };
});

function readDurableBatches(
  dir: string,
): { opId: string; entryIds: string[] }[] {
  const file = join(dir, STATE_FILE);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    pendingBatches?: { opId: string; entryIds: string[] }[];
  };
  return parsed.pendingBatches ?? [];
}

// ---------------------------------------------------------------------------
// Evidence report
// ---------------------------------------------------------------------------

test("evidence: write the measured budget/quality report", async () => {
  REPORT.nodeVersion = process.version;
  REPORT.retrievalFixtures = {
    "QF-R1":
      "positive in-scope recall — exact path set r1-a/r1-b/r1-c in FTS score order",
    "QF-R2":
      "scope precision — out-of-scope candidate guard-rejected (scope step), zero cross-scope items",
    "QF-R3":
      "superseded exclusion — guard-rejected (status step), zero superseded items",
    "QF-R4":
      "keyword-only hybrid attribution disclosed as degraded, never counted as semantic",
    "QF-R5": "empty result set → empty pack + visible note, no fabrication",
    "QF-C1":
      "one batch under the 6,000-token input budget with FULL source coverage",
    "QF-C2":
      "budget overflow splits into disjoint batches; union coverage complete",
    "QF-C3": "queue cap merges overflow into the oldest batch; no entry lost",
    "QF-C4": "repeated settles over the same coverage cost zero model calls",
    "QF-C5":
      "failed extraction retains the SAME opId and full durable coverage",
  };
  const dir = join(process.cwd(), "tasks", "evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "t19-budget-report.json"),
    `${JSON.stringify(REPORT, null, 2)}\n`,
  );
});
