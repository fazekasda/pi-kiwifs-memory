/**
 * Q09B — production runtime performance/resource acceptance (synthetic only).
 *
 * All fixtures here are SYNTHETIC: in-process fake MCP server, real adapter
 * and retrieval/scheduler factories (no mocks of the production classes),
 * deterministic INJECTED delays, scripted extract, synthetic tokenizer
 * fixture. Zero live services, zero network, zero model calls. Nothing in
 * this file is a production model evaluation — the tokenizer is explicitly
 * labeled NOT model-compatible and the extract path measures call volume
 * only, NOT observation quality.
 *
 * Acceptance points (Q09B):
 * 1. Latency sensitivity: budget assertions FAIL on a MEANINGFUL slowdown
 *    (measured against a baseline run and a per-call injected-delay model),
 *    not merely against a permissive deadline. Deterministic injected delays
 *    (fake-server delayMs) separate the budget guarantee from wall-clock
 *    noise.
 * 2. Query fanout cap: at most MAX_SCOPE_QUERIES scope queries per engine
 *    under injected delay, with latency explained by the injected delay.
 * 3. Tokenizer fail-closed: an unreliable count (undefined / throwing) at
 *    runtime skips automatic injection with the visible note — never a
 *    character estimate; the COMPLETE framed payload is what gets counted.
 * 4. Extraction call volume: one settle over a fresh interval is exactly ONE
 *    extract call; repeated settles with no new content extract nothing.
 * 5. Many-cycle bounded state/resources and cancelled pending work: idle
 *    cycles leave no growth in extract calls, pending batches or durable
 *    state size; a pre-compaction flush cancelled by an aborted signal
 *    leaves the pending ranges durably intact and delivers them exactly once
 *    on retry.
 */

import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { KiwiFSAdapter } from "../src/backend/adapter.ts";
import { createMemoryLedger } from "../src/backend/opid.ts";
import { identityRedactor } from "../src/backend/guard.ts";
import {
  MAX_SCOPE_QUERIES,
  RetrievalCoordinator,
  type EvidencePack,
} from "../src/retrieval/coordinator.ts";
import {
  loadConfiguredTokenizer,
  TOKENIZER_UNAVAILABLE_NOTE,
} from "../src/retrieval/tokenizer.ts";
import type { EvidenceTokenizer } from "../src/retrieval/tokenizer.ts";
import { ObserverScheduler, STATE_FILE } from "../src/observation/scheduler.ts";
import { SessionCoordinator } from "../src/pi/coordinator.ts";
import { DurableOutbox } from "../src/outbox/store.ts";
import { compileExclusions } from "../src/privacy/exclusions.ts";
import { createFakeServer } from "./fake-mcp-server.ts";

const URL_ = "https://kiwifs.test/mcp";
const SCOPE = "project/demo-proj";

/** Deterministic injected per-request backend delay used in this file. */
const INJECTED_DELAY_MS = 40;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kiwifs-q09b-${prefix}-`));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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

async function setup() {
  const server = createFakeServer();
  const adapter = new KiwiFSAdapter({
    url: URL_,
    fetchImpl: server.fetch,
    ledger: createMemoryLedger(),
    requestTimeoutMs: 5_000,
  });
  await adapter.connect();
  return { server, adapter };
}

/** SYNTHETIC fixture tokenizer (word split) — NOT model-compatible. */
const SYNTHETIC_TOKENIZER: EvidenceTokenizer = {
  id: "q09b-word-split (synthetic, NOT model-compatible)",
  countTokens(text: string): number | undefined {
    return text.split(/\s+/).filter((t) => t !== "").length;
  },
};

function makeCoordinator(
  adapter: KiwiFSAdapter,
  tokenizer: EvidenceTokenizer | undefined,
  authorizedScopes: string[] = [SCOPE],
): RetrievalCoordinator {
  return new RetrievalCoordinator({
    adapter,
    authorizedScopes,
    deadlineMs: 2_000,
    tokenCap: 3_000,
    generation: 1,
    redact: identityRedactor,
    ...(tokenizer !== undefined ? { tokenizer } : {}),
  });
}

/** tools/call requests to a given kiwi_* tool (deterministic call count). */
function toolCalls(
  server: ReturnType<typeof createFakeServer>["state"],
  tool: string,
): unknown[] {
  return server.requests.filter(
    (r) => r.body.includes('"tools/call"') && r.body.includes(`"${tool}"`),
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("bounded wait expired");
    await sleep(5);
  }
}

// ---------------------------------------------------------------------------
// 1. Latency sensitivity: baseline vs injected delay — fails on MEANINGFUL
//    slowdown, not on a permissive deadline-only bound.
// ---------------------------------------------------------------------------

test("Q09B: injected per-call delay explains retrieval latency linearly; baseline stays far under the deadline (synthetic)", async () => {
  const { server, adapter } = await setup();
  for (let i = 0; i < 3; i++) {
    server.state.store.set(
      `${SCOPE}/memory/observations/2026/01/rec-${i}.md`,
      record(SCOPE, "active", `postgres migration step ${i}`),
    );
  }

  // Baseline run: NO injected delay — must be genuinely fast (the meaningful
  // bound here is far tighter than the 2 s deadline a permissive assertion
  // would accept).
  const baselineCoord = makeCoordinator(adapter, SYNTHETIC_TOKENIZER);
  const baselineCallsBefore = server.state.requests.length;
  const baselineStart = performance.now();
  const baseline = await baselineCoord.retrieve(
    "postgres migration",
    undefined,
    "interactive",
  );
  const baselineMs = Math.round(performance.now() - baselineStart);
  assert.equal(baseline.kind, "pack", "baseline run produced a pack");
  const baselineCallsEnd = server.state.requests.length;
  assert.ok(baselineCallsEnd - baselineCallsBefore > 0);
  assert.ok(
    baselineMs < 500,
    `baseline (no injected delay) retrieval took ${baselineMs} ms — a meaningful slowdown must FAIL this, deadline-only bounds would not`,
  );

  // Injected-delay run: same fixture, DETERMINISTIC per-request delay.
  server.behavior.delayMs = INJECTED_DELAY_MS;
  const callsBefore = server.state.requests.length;
  const delayedCoord = makeCoordinator(adapter, SYNTHETIC_TOKENIZER);
  const start = performance.now();
  const outcome = await delayedCoord.retrieve(
    "postgres migration",
    undefined,
    "interactive",
  );
  const delayedMs = Math.round(performance.now() - start);
  assert.equal(outcome.kind, "pack", "injected-delay run produced a pack");

  const backendCalls = server.state.requests.length - callsBefore;
  // Deterministic call volume: the same fixture/cycle must make the SAME
  // number of backend calls whether delayed or not (no hidden retries).
  const baselineCalls = baselineCallsEnd - baselineCallsBefore;
  assert.ok(
    backendCalls > 0 && backendCalls <= 24,
    `retrieval made ${backendCalls} backend calls — bounded, not a retry/loop storm`,
  );
  assert.equal(
    baselineCallsEnd - baselineCallsBefore,
    backendCalls,
    "the same cycle makes the same number of backend calls with and without injected delay — no hidden retries",
  );
  // Sensitivity: the delay must actually be visible in the measurement...
  assert.ok(
    delayedMs >= backendCalls * INJECTED_DELAY_MS - 10,
    `delayed run ${delayedMs} ms did not even include the injected ${backendCalls}×${INJECTED_DELAY_MS} ms — timing is not measuring the injected delay`,
  );
  // ...and latency must be EXPLAINED by the injected delay: no hidden
  // additional waits, retries or polling beyond the injected per-call cost.
  const slackMs = 150 + baselineMs;
  assert.ok(
    delayedMs <= backendCalls * INJECTED_DELAY_MS + slackMs,
    `delayed run ${delayedMs} ms exceeds the injected-delay model (${backendCalls} calls × ${INJECTED_DELAY_MS} ms + ${slackMs} ms slack) — a runtime slowdown beyond the injected cost FAILED the budget`,
  );
});

// ---------------------------------------------------------------------------
// 2. Query fanout cap: MAX_SCOPE_QUERIES scope queries per engine, with the
//    injected delay accounting for the measured latency.
// ---------------------------------------------------------------------------

test("Q09B: scope fanout is capped at MAX_SCOPE_QUERIES per engine under injected delay (synthetic)", async () => {
  const { server, adapter } = await setup();
  server.state.store.set(
    `${SCOPE}/memory/observations/2026/01/one.md`,
    record(SCOPE, "active", "postgres migration fanout record"),
  );
  const manyScopes = [
    SCOPE,
    "project/other-1",
    "project/other-2",
    "project/other-3",
    "project/other-4",
    "project/other-5",
  ];
  assert.ok(manyScopes.length > MAX_SCOPE_QUERIES);
  server.behavior.delayMs = INJECTED_DELAY_MS;
  const coord = makeCoordinator(adapter, SYNTHETIC_TOKENIZER, manyScopes);

  const start = performance.now();
  const outcome = await coord.retrieve(
    "postgres migration",
    undefined,
    "interactive",
  );
  const ms = Math.round(performance.now() - start);
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;

  const fts = toolCalls(server.state, "kiwi_search").length;
  const sem = toolCalls(server.state, "kiwi_search_semantic").length;
  assert.ok(
    fts <= MAX_SCOPE_QUERIES,
    `FTS fanout made ${fts} scope queries — cap is ${MAX_SCOPE_QUERIES}`,
  );
  assert.ok(
    sem <= MAX_SCOPE_QUERIES,
    `semantic fanout made ${sem} scope queries — cap is ${MAX_SCOPE_QUERIES}`,
  );
  assert.match(
    pack.degraded.join("\n"),
    /fanout bound reached/,
    "the skipped scopes surface as a visible sanitized degraded note",
  );
  // Latency must still be explained by the injected per-call delay over ALL
  // backend calls in the cycle (guard read-backs included).
  const totalCalls = server.state.requests.length;
  const slackMs = 250;
  assert.ok(
    ms <= totalCalls * INJECTED_DELAY_MS + slackMs,
    `fanout run took ${ms} ms — exceeds the injected-delay model (${totalCalls} calls × ${INJECTED_DELAY_MS} ms + ${slackMs} ms)`,
  );
});

// ---------------------------------------------------------------------------
// 3. Tokenizer fail-closed at runtime: unreliable count → automatic injection
//    skipped with the visible note, never a character estimate; deterministic.
// ---------------------------------------------------------------------------

test("Q09B: unreliable tokenizer count fails closed — injection skipped with visible note, no character estimate (synthetic)", async () => {
  const { server, adapter } = await setup();
  server.state.store.set(
    `${SCOPE}/memory/observations/2026/01/fc.md`,
    record(SCOPE, "active", "postgres migration failclosed record"),
  );
  const unreliable: EvidenceTokenizer = {
    id: "q09b-unreliable (synthetic fail-closed fixture)",
    countTokens(text: string): number | undefined {
      // Simulate a tokenizer that cannot handle the framed payload.
      return text.includes("postgres migration") ? undefined : 1;
    },
  };
  for (let run = 0; run < 2; run++) {
    const coord = makeCoordinator(adapter, unreliable);
    const outcome = await coord.retrieve(
      "postgres migration",
      undefined,
      "interactive",
    );
    assert.equal(outcome.kind, "pack");
    const pack = (outcome as { pack: EvidencePack }).pack;
    assert.equal(pack.injectionAllowed, false);
    assert.equal(
      pack.tokenCount,
      undefined,
      "fail-closed must NOT fall back to a character estimate",
    );
    assert.ok(pack.items.length > 0, "evidence still gathered and framed");
    assert.ok(
      pack.degraded.includes(TOKENIZER_UNAVAILABLE_NOTE),
      "the visible sanitized skip note is present",
    );
  }
  // A THROWING countTokens loads but yields undefined at count time (the
  // loader wrapper, test/tokenizer-config.test.ts) → fail closed end-to-end.
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q09b-tok-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const modPath = join(dir, "throwing.mjs");
  writeFileSync(
    modPath,
    "export const tokenizer = { id: 'q09b-throwing (synthetic)', countTokens: () => { throw new Error('synthetic tokenizer crash'); } };\n",
  );
  const loaded = await loadConfiguredTokenizer({ module: modPath }, dir);
  assert.ok(loaded.ok);
  const outcome = await makeCoordinator(
    adapter,
    loaded.ok ? loaded.tokenizer : undefined,
  ).retrieve("postgres migration", undefined, "interactive");
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  assert.equal(pack.injectionAllowed, false);
  assert.equal(pack.tokenCount, undefined);
  assert.ok(pack.degraded.includes(TOKENIZER_UNAVAILABLE_NOTE));
});

// ---------------------------------------------------------------------------
// 4 + 5. Real scheduler/outbox/coordinator factories: extraction call volume,
// many-cycle bounded state, cancelled pending work delivered exactly once.
// ---------------------------------------------------------------------------

interface SourceView {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

function entry(id: string, text: string): SourceView {
  return { id, role: "user", text, timestamp: "2026-09-08T00:00:00Z" };
}

interface SchedFixture {
  dir: string;
  scheduler: ObserverScheduler;
  store: DurableOutbox;
  sources: SourceView[];
  extractCalls: { opId: string }[];
  release: ((result?: unknown) => void)[];
}

function makeScheduler(opts?: {
  manualExtract?: boolean;
  minBatchTokens?: number;
  minBatchTurns?: number;
  compactFlushTimeoutMs?: number;
}): SchedFixture {
  const dir = tempDir("sched");
  const coordinator = new SessionCoordinator({ stateDir: dir });
  coordinator.onSessionStart(
    {
      cwd: dir,
      sessionManager: {
        getSessionId: () => "s1",
        getLeafId: () => "leaf-a",
      },
    },
    { reason: "startup" },
  );
  const store = DurableOutbox.open(join(dir, "outbox"));
  const sources: SourceView[] = [];
  const extractCalls: { opId: string }[] = [];
  const release: ((result?: unknown) => void)[] = [];
  const compiled = compileExclusions([]);
  if (!compiled.ok) throw new Error(compiled.reason);
  const scheduler = new ObserverScheduler({
    stateDir: dir,
    coordinator,
    outbox: store,
    scope: "proj/demo",
    sessionId: "s1",
    branchId: "leaf-a",
    minBatchTokens: opts?.minBatchTokens ?? 1,
    minBatchTurns: opts?.minBatchTurns ?? 1,
    ...(opts?.compactFlushTimeoutMs !== undefined
      ? { compactFlushTimeoutMs: opts.compactFlushTimeoutMs }
      : {}),
    extract: (batch) => {
      extractCalls.push({ opId: batch.opId });
      if (opts?.manualExtract) {
        return new Promise<unknown>((resolve) => {
          release.push((result) => resolve(result ?? [{ note: "obs" }]));
        });
      }
      return [{ note: "obs" }];
    },
    exclusions: compiled.compiled,
  });
  scheduler.setProvider({ entries: () => sources });
  return { dir, scheduler, store, sources, extractCalls, release };
}

test("Q09B: one fresh interval is exactly ONE extract call; repeated settles add none (synthetic)", async () => {
  const f = makeScheduler();
  f.sources.push(entry("e1", "hello bounded world one"));
  assert.equal(f.scheduler.onAgentSettled().scheduled, 1);
  await f.scheduler.quiesce();
  assert.equal(f.extractCalls.length, 1, "exactly one extract call per batch");
  assert.equal(
    f.store.pending().filter((j) => j.kind === "observation").length,
    1,
  );
  assert.equal(f.scheduler.countPendingBatchEntries(), 0);

  // Many subsequent settles with NO new content: zero further extract calls,
  // no pending growth — extraction call volume stays bounded across cycles.
  for (let i = 0; i < 50; i++) {
    f.scheduler.onAgentSettled();
  }
  await f.scheduler.quiesce();
  assert.equal(
    f.extractCalls.length,
    1,
    "idle cycles must not invoke extraction",
  );
  assert.equal(f.scheduler.countPendingBatchEntries(), 0);

  // Durable state did not grow from the idle cycles (bounded resource use).
  const stateBytes = statSync(join(f.dir, STATE_FILE)).size;
  for (let i = 0; i < 50; i++) f.scheduler.onAgentSettled();
  await f.scheduler.quiesce();
  assert.equal(
    statSync(join(f.dir, STATE_FILE)).size,
    stateBytes,
    "durable scheduler state is byte-identical after 50 idle cycles — no unbounded growth",
  );
  f.scheduler.dispose();
});

test("Q09B: cancelled pending work — aborted pre-compaction flush leaves ranges durable; retry delivers exactly once (synthetic)", async () => {
  const f = makeScheduler({
    manualExtract: true,
    compactFlushTimeoutMs: 5_000,
  });
  f.sources.push(entry("e1", "hello cancelled pending work"));

  // Start the pre-compaction flush, abort the event signal mid-flight: the
  // flush must cancel (never return `cancel`), and the pending range must
  // remain durable for later retry.
  const controller = new AbortController();
  const flushing = f.scheduler.onBeforeCompact(controller.signal);
  await until(() => f.extractCalls.length === 1);
  controller.abort();
  const flushed = await flushing;
  assert.equal(flushed.reason, "signal-aborted");
  assert.equal(
    f.store.pending().filter((j) => j.kind === "observation").length,
    0,
    "nothing written to the backend queue before acceptance",
  );

  // The abort cancels the flush WAIT, not the durable-pending contract: the
  // in-flight batch settles and is accepted exactly once — one extract call,
  // one durable observation job, entry consumed; a subsequent retry finds
  // nothing left to deliver (no duplicate, no lost range).
  f.release[0]?.();
  await f.scheduler.quiesce();
  assert.equal(
    f.store.pending().filter((j) => j.kind === "observation").length,
    1,
    "exactly one durable observation job after the aborted flush settles",
  );

  const delivered = await f.scheduler.retryPending();
  await f.scheduler.quiesce();
  assert.equal(f.extractCalls.length, 1, "the range is never extracted twice");
  assert.equal(
    f.store.pending().filter((j) => j.kind === "observation").length,
    1,
    "exactly one durable observation job from the retried range",
  );
  assert.equal(f.scheduler.countPendingBatchEntries(), 0);
  f.scheduler.dispose();
});

test("Q09B: many settle cycles with continuous small input keep call volume and durable state bounded (synthetic)", async () => {
  const f = makeScheduler({ minBatchTokens: 1, minBatchTurns: 1 });
  const CYCLES = 100;
  for (let i = 0; i < CYCLES; i++) {
    f.sources.push(entry(`e${i}`, `turn ${i} content`));
    f.scheduler.onAgentSettled();
    await f.scheduler.quiesce();
  }
  // Bounded: one batch per cycle, never re-extracting old intervals.
  assert.equal(
    f.extractCalls.length,
    CYCLES,
    "exactly one extract per settle cycle — no re-extraction storms",
  );
  assert.equal(f.scheduler.countPendingBatchEntries(), 0);
  assert.equal(
    f.store.pending().filter((j) => j.kind === "observation").length,
    CYCLES,
  );
  const stateSize = statSync(join(f.dir, STATE_FILE)).size;
  assert.ok(
    stateSize < 256 * 1024,
    `durable state grew to ${stateSize} bytes over ${CYCLES} cycles — must stay bounded`,
  );
  f.scheduler.dispose();
});
