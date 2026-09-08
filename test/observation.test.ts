/**
 * T09 acceptance tests: incremental observer scheduling (PRD T09,
 * architecture.md §3.2, decisions.md #6).
 *
 * Covers:
 * - A source interval is processed once logically despite repeated triggers.
 * - New content during an extraction schedules a later non-overlapping batch.
 * - Empty/irrelevant batches never invoke the model.
 * - Pre-compaction flush is bounded by self-timeout and the event signal;
 *   never blocks compaction, never returns cancel.
 * - The durable cursor advances only when related work is durably accepted
 *   (outbox acceptance); unprocessed ranges survive crash and restart.
 * - Extraction jobs persist opId, source entries and batch parameters before
 *   the model call; results are persisted as durable outbox jobs before any
 *   backend write; re-derivation reuses the same opId (no duplicate
 *   observations).
 */

import assert from "node:assert/strict";
import {
  existsSync as existsSync2,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SessionCoordinator } from "../src/pi/coordinator.ts";
import { DurableOutbox } from "../src/outbox/store.ts";
import { idempotencyKey } from "../src/domain/idempotency.ts";
import {
  ObserverScheduler,
  STATE_FILE,
  estimateTokens,
  toSourceViews,
} from "../src/observation/scheduler.ts";
import { compileExclusions } from "../src/privacy/exclusions.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kiwifs-obs-"));
}

interface SourceView {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

function entry(
  id: string,
  text: string,
  role: "user" | "assistant" = "user",
): SourceView {
  return { id, role, text, timestamp: "2026-09-08T00:00:00Z" };
}

interface ExtractCall {
  opId: string;
  trigger: string;
  sources: { id: string; text: string }[];
}

interface Fixture {
  dir: string;
  coordinator: SessionCoordinator;
  store: DurableOutbox;
  scheduler: ObserverScheduler;
  sources: SourceView[];
  extractCalls: ExtractCall[];
  // Controllable manual extract: tests resolve extraction explicitly.
  release: ((result?: unknown) => void)[];
}

function fresh(opts: {
  minBatchTokens?: number;
  minBatchTurns?: number;
  idleMs?: number;
  maxPendingBatches?: number;
  compactFlushTimeoutMs?: number;
  exclusions?: Parameters<typeof compileExclusions>[0];
  manualExtract?: boolean;
}): Fixture {
  const dir = tempDir();
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
  const extractCalls: ExtractCall[] = [];
  const release: ((result?: unknown) => void)[] = [];
  const compiled = opts.exclusions
    ? compileExclusions(opts.exclusions)
    : { ok: true as const, compiled: [] };
  if (!compiled.ok) throw new Error(compiled.reason);
  const scheduler = new ObserverScheduler({
    stateDir: dir,
    coordinator,
    outbox: store,
    scope: "proj/demo",
    sessionId: "s1",
    branchId: "leaf-a",
    ...(opts.minBatchTokens !== undefined
      ? { minBatchTokens: opts.minBatchTokens }
      : {}),
    ...(opts.minBatchTurns !== undefined
      ? { minBatchTurns: opts.minBatchTurns }
      : {}),
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
    ...(opts.maxPendingBatches !== undefined
      ? { maxPendingBatches: opts.maxPendingBatches }
      : {}),
    ...(opts.compactFlushTimeoutMs !== undefined
      ? { compactFlushTimeoutMs: opts.compactFlushTimeoutMs }
      : {}),
    extract: (batch) => {
      extractCalls.push({
        opId: batch.opId,
        trigger: batch.trigger,
        sources: batch.sources.map((s) => ({ id: s.id, text: s.text })),
      });
      if (opts.manualExtract) {
        return new Promise<unknown>((resolve) => {
          release.push((result) => resolve(result ?? [{ note: "obs" }]));
        });
      }
      return [{ note: "obs" }];
    },
    exclusions: compiled.compiled,
  });
  scheduler.setProvider({ entries: () => sources });
  return {
    dir,
    coordinator,
    store,
    scheduler,
    sources,
    extractCalls,
    release,
  };
}

let fixtures: Fixture[] = [];
beforeEach(() => {
  fixtures = [];
});
afterEach(() => {
  for (const f of fixtures) {
    f.scheduler?.dispose();
    if (f.dir) rmSync(f.dir, { recursive: true, force: true });
  }
});

function track(f: Fixture): Fixture {
  fixtures.push(f);
  return f;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- AC 1: an interval is processed once logically -----------------------

test("repeated triggers over the same coverage never re-extract", async () => {
  const f = track(fresh({ minBatchTokens: 1, minBatchTurns: 1 }));
  f.sources.push(entry("e1", "hello world one"));

  const first = f.scheduler.onAgentSettled();
  assert.equal(first.deferred, false);
  assert.equal(first.scheduled, 1);
  await sleep(20);
  assert.equal(f.extractCalls.length, 1);
  assert.equal(f.coordinator.isConsumed("e1"), true);
  assert.equal(
    f.store.pending().filter((j) => j.kind === "observation").length,
    1,
  );

  // Second settle with NO new content: nothing re-extracted, no duplicate job.
  const second = f.scheduler.onAgentSettled();
  assert.equal(second.scheduled, 0);
  assert.equal(second.deferred, false);
  await sleep(20);
  assert.equal(f.extractCalls.length, 1);
  assert.equal(f.store.pending().length, 1);
});

// ---- AC 2: new content during extraction → non-overlapping batch ---------

test("content arriving during an extraction schedules a later disjoint batch", async () => {
  const f = track(
    fresh({ minBatchTokens: 1, minBatchTurns: 1, manualExtract: true }),
  );
  f.sources.push(entry("e1", "first turn text"));

  const first = f.scheduler.onAgentSettled();
  assert.equal(first.scheduled, 1);
  // Extraction is in flight (manual, unreleased).
  await sleep(5);
  assert.equal(f.extractCalls.length, 1);

  // New content arrives while the first extraction is still running: a later
  // batch is scheduled. Batches are disjoint: e1 in one, e2 in the other.
  f.sources.push(entry("e2", "second turn text"));
  const second = f.scheduler.onAgentSettled();
  assert.equal(second.scheduled, 1);
  const pending = f.scheduler.pendingBatches;
  assert.equal(pending.length, 2);
  const idSets = pending.map((b) => [...b.entryIds].sort());
  const overlap = idSets[0]!.filter((id) => idSets[1]!.includes(id));
  assert.equal(overlap.length, 0);

  // Both complete without duplication (second batch runs after the first
  // settles — serialization keeps pending-state mutations single-threaded).
  f.release[0]!();
  await sleep(20);
  assert.equal(f.extractCalls.length, 2);
  for (const r of f.release) r();
  await sleep(20);

  // Both complete and consume without duplication.
  for (const r of f.release) r();
  await sleep(20);
  assert.equal(f.coordinator.isConsumed("e1"), true);
  assert.equal(f.coordinator.isConsumed("e2"), true);
  assert.equal(f.scheduler.pendingBatches.length, 0);
});

// ---- AC 3: empty/irrelevant batches never invoke the model ---------------

test("empty or irrelevant coverage does not invoke the model", async () => {
  const f = track(
    fresh({
      minBatchTokens: 1,
      minBatchTurns: 1,
      exclusions: [{ pattern: "INTERNAL-ONLY" }],
    }),
  );
  // Empty text, extension-internal custom entries, excluded content.
  f.sources.push(entry("blank", "   "));
  f.sources.push(entry("excl", "INTERNAL-ONLY rotation key"));
  const summary = f.scheduler.onAgentSettled();
  assert.equal(summary.scheduled, 0);
  await sleep(20);
  assert.equal(f.extractCalls.length, 0);
  assert.equal(f.scheduler.pendingBatches.length, 0);
});

test("toSourceViews skips extension-internal entries and non-message entries", () => {
  const views = toSourceViews([
    {
      type: "custom_message",
      customType: "kiwifs.evidence",
      content: "injected evidence pack",
      display: true,
      id: "c1",
      parentId: null,
      timestamp: "",
    },
    {
      type: "custom",
      customType: "kiwifs.state",
      id: "c2",
      parentId: null,
      timestamp: "",
    },
    { type: "model_change", id: "m1", parentId: null, timestamp: "" },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "t",
      message: { role: "user", content: "real user text" },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "t",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "assistant reply" }],
      },
    },
    {
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "t",
      message: { role: "toolResult", content: "tool output" },
    },
  ]);
  assert.deepEqual(
    views.map((v) => v.id),
    ["u1", "a1"],
  );
});

// ---- AC 4: bounded pre-compaction flush ----------------------------------

test("pre-compaction flush times out, never cancels compaction, keeps pending visible", async () => {
  const f = track(
    fresh({
      minBatchTokens: 1,
      minBatchTurns: 1,
      compactFlushTimeoutMs: 30,
      manualExtract: true,
    }),
  );
  f.sources.push(entry("e1", "pre-compaction content"));

  const controller = new AbortController();
  const started = Date.now();
  const result = await f.scheduler.onBeforeCompact(controller.signal);
  const elapsed = Date.now() - started;

  assert.equal(result.flushed, false);
  assert.equal(result.reason, "timeout");
  // Bounded: returned near the self-timeout, not after the slow extraction.
  assert.ok(elapsed < 200, `flush took ${elapsed}ms`);
  // Entry stays durably pending with visible status (no silent drop).
  assert.equal(f.coordinator.isConsumed("e1"), false);
  assert.equal(f.scheduler.pendingStatus().length >= 1, true);
  assert.match(f.scheduler.pendingStatus()[0] ?? "", /pending/);
  // Nothing was written to the backend queue before acceptance.
  assert.equal(f.store.pending().length, 0);

  // The extraction eventually resolves; the release is a no-op for compaction.
  for (const r of f.release) r();
  await sleep(20);
});

test("pre-compaction flush honors an already-aborted signal and a mid-flight abort", async () => {
  const f = track(
    fresh({
      minBatchTokens: 1,
      minBatchTurns: 1,
      compactFlushTimeoutMs: 5_000,
      manualExtract: true,
    }),
  );
  f.sources.push(entry("e1", "content"));

  // Already aborted: immediate skip, nothing scheduled.
  const aborted = new AbortController();
  aborted.abort();
  const skip = await f.scheduler.onBeforeCompact(aborted.signal);
  assert.equal(skip.flushed, false);
  assert.equal(skip.reason, "signal-aborted");
  assert.equal(f.extractCalls.length, 0);

  // Mid-flight abort: flush returns promptly, batch stays pending.
  const controller = new AbortController();
  const pending = f.scheduler.onBeforeCompact(controller.signal);
  await sleep(5); // batch persisted, extract invoked
  controller.abort();
  const result = await pending;
  assert.equal(result.flushed, false);
  assert.equal(result.reason, "signal-aborted");
  assert.equal(f.coordinator.isConsumed("e1"), false);
  for (const r of f.release) r();
});

test("successful pre-compaction flush accepts work durably and consumes entries", async () => {
  const f = track(fresh({ minBatchTokens: 1, minBatchTurns: 1 }));
  f.sources.push(entry("e1", "content"));
  f.sources.push(entry("e2", "more content"));

  const result = await f.scheduler.onBeforeCompact(
    new AbortController().signal,
  );
  assert.equal(result.flushed, true);
  assert.equal(f.coordinator.isConsumed("e1"), true);
  assert.equal(f.coordinator.isConsumed("e2"), true);
  const jobs = f.store.pending().filter((j) => j.kind === "observation");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.scope, "proj/demo");
});

// ---- AC 5: durable cursor advances only on outbox acceptance -------------

test("failed outbox acceptance leaves entries unconsumed and pending", async () => {
  const f = track(fresh({ minBatchTokens: 1, minBatchTurns: 1 }));
  f.sources.push(entry("e1", "content"));

  // Force the enqueue to fail (persist fault → OutboxPersistError).
  f.store.persistFault = new Error("ENOSPC");
  f.scheduler.onAgentSettled();
  await sleep(20);
  assert.equal(f.extractCalls.length, 1); // model ran
  assert.equal(f.coordinator.isConsumed("e1"), false); // cursor NOT advanced
  assert.equal(f.scheduler.pendingBatches.length, 1);
  assert.equal(f.store.pending().length, 0);

  // Recovery: clear the fault; the pending batch re-runs under the SAME opId
  // and the cursor advances only after the new enqueue is durable.
  f.store.persistFault = null;
  await f.scheduler.retryPending();
  await sleep(20);
  assert.equal(f.coordinator.isConsumed("e1"), true);
  assert.equal(f.store.pending().length, 1);
  assert.equal(f.scheduler.pendingBatches.length, 0);
});

// ---- AC 6: durable batch record before model call; same opId re-derivation

test("batch is durably persisted with opId/entries/params before the model call", async () => {
  const f = track(
    fresh({ minBatchTokens: 1, minBatchTurns: 1, manualExtract: true }),
  );
  f.sources.push(entry("e1", "content"));

  f.scheduler.onAgentSettled();
  // The model call has been invoked; the batch record with the SAME opId was
  // already on disk BEFORE the extract call resolved (extract is unreleased).
  await sleep(5);
  assert.equal(f.extractCalls.length, 1);
  const stateFile = join(f.dir, STATE_FILE);
  assert.equal(existsSync2(stateFile), true);
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
    pendingBatches: {
      opId: string;
      entryIds: string[];
      inputBudgetTokens: number;
      outputBudgetTokens: number;
    }[];
  };
  assert.equal(state.pendingBatches.length, 1);
  assert.equal(state.pendingBatches[0]!.opId, f.extractCalls[0]!.opId);
  assert.deepEqual(state.pendingBatches[0]!.entryIds, ["e1"]);
  assert.ok(state.pendingBatches[0]!.inputBudgetTokens > 0);
  assert.ok(state.pendingBatches[0]!.outputBudgetTokens > 0);

  // Acceptance: the durable outbox job carries the same opId plus a
  // deterministic idempotency key derived from the sources.
  f.release[0]!();
  await sleep(20);
  const job = f.store.pending().find((j) => j.kind === "observation")!;
  assert.ok(job);
  assert.equal((job.payload as { opId: string }).opId, f.extractCalls[0]!.opId);
  assert.match(job.idempotencyKey, /^[0-9a-f]{32}$/);

  // Re-deriving the same sources yields the SAME idempotency key (replay of a
  // crashed extraction cannot create a duplicate observation identity).
  const key2 = idempotencyKey({
    kind: "observation",
    scope: "proj/demo",
    sources: [{ sessionId: "s1", branchId: "leaf-a", entryIds: ["e1"] }],
  });
  assert.equal(job.idempotencyKey, key2);
});

test("crash and restart re-derives the pending batch under the same opId", async () => {
  const dir = tempDir();
  fixtures.push({
    dir,
    coordinator: null as unknown as SessionCoordinator,
    store: null as unknown as DurableOutbox,
    scheduler: null as unknown as ObserverScheduler,
    sources: [],
    extractCalls: [],
    release: [],
  });
  const coordinator = new SessionCoordinator({ stateDir: dir });
  coordinator.onSessionStart(
    {
      cwd: dir,
      sessionManager: { getSessionId: () => "s1", getLeafId: () => "leaf-a" },
    },
    { reason: "startup" },
  );
  const store = DurableOutbox.open(join(dir, "outbox"));
  const sources: SourceView[] = [entry("e1", "content")];
  const extractCalls: ExtractCall[] = [];
  const scheduler = new ObserverScheduler({
    stateDir: dir,
    coordinator,
    outbox: store,
    scope: "proj/demo",
    sessionId: "s1",
    extract: (batch) => {
      extractCalls.push({
        opId: batch.opId,
        trigger: batch.trigger,
        sources: [],
      });
      return [{ obs: batch.opId }];
    },
    minBatchTokens: 1,
    minBatchTurns: 1,
  });
  scheduler.setProvider({ entries: () => sources });

  scheduler.onAgentSettled();
  await sleep(20);
  const firstOpId = extractCalls[0]!.opId;

  // "Crash": rebuild everything from the same state dir. The pending batch
  // (if any) and the consumed registry survive; a retried batch reuses the
  // original opId.
  store.close();
  const coordinator2 = new SessionCoordinator({ stateDir: dir });
  const store2 = DurableOutbox.open(join(dir, "outbox"));
  const scheduler2 = new ObserverScheduler({
    stateDir: dir,
    coordinator: coordinator2,
    outbox: store2,
    scope: "proj/demo",
    sessionId: "s1",
    extract: (batch) => {
      extractCalls.push({
        opId: batch.opId,
        trigger: batch.trigger,
        sources: [],
      });
      return [{ obs: batch.opId }];
    },
    minBatchTokens: 1,
    minBatchTurns: 1,
  });
  scheduler2.setProvider({ entries: () => sources });

  // The first pass already consumed e1 (its job was durably accepted), so a
  // restart must NOT re-extract it.
  assert.equal(coordinator2.isConsumed("e1"), true);
  scheduler2.onAgentSettled();
  await sleep(20);
  assert.equal(extractCalls.length, 1);
  assert.equal(store2.pending().length, 1);
  store2.close();

  // Crash BEFORE acceptance: fabricate a crashed pre-acceptance state — a
  // pending batch persisted with a fixed opId for a fresh entry e3, never
  // enqueued — then rebuild from disk and re-derive under the SAME opId.
  const store3 = DurableOutbox.open(join(dir, "outbox"));
  const statePath = join(dir, STATE_FILE);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      pendingBatches: [
        {
          opId: "crashed-op-id",
          trigger: "threshold",
          entryIds: ["e3"],
          createdAt: 0,
          inputBudgetTokens: 6000,
          outputBudgetTokens: 3000,
        },
      ],
    })}\n`,
  );
  const scheduler4 = new ObserverScheduler({
    stateDir: dir,
    coordinator: coordinator2,
    outbox: store3,
    scope: "proj/demo",
    sessionId: "s1",
    extract: (batch) => {
      extractCalls.push({
        opId: batch.opId,
        trigger: batch.trigger,
        sources: [],
      });
      return [{ obs: batch.opId }];
    },
    minBatchTokens: 1,
    minBatchTurns: 1,
  });
  scheduler4.setProvider({
    entries: () => [...sources, entry("e3", "post-crash")],
  });
  assert.equal(
    scheduler4.pendingBatches.some((b) => b.opId === "crashed-op-id"),
    true,
  );
  await scheduler4.retryPending();
  await sleep(20);
  assert.equal(
    extractCalls.some((c) => c.opId === "crashed-op-id"),
    true,
    "re-derivation reuses the original opId",
  );
  assert.equal(coordinator2.isConsumed("e3"), true);
});

// ---- Queue cap and merge -------------------------------------------------

test("queue cap merges excess into the oldest pending batch, never drops", async () => {
  const f = track(
    fresh({
      minBatchTokens: 1,
      minBatchTurns: 1,
      maxPendingBatches: 2,
      manualExtract: true,
    }),
  );
  f.sources.push(entry("e1", "a"));
  f.scheduler.onAgentSettled();
  f.sources.push(entry("e2", "b"));
  f.scheduler.onAgentSettled();
  await sleep(10);
  assert.equal(f.scheduler.pendingBatches.length, 2);

  f.sources.push(entry("e3", "c"));
  f.scheduler.onAgentSettled();
  await sleep(10);
  // Still two pending batches: the new entries merged into the oldest.
  assert.equal(f.scheduler.pendingBatches.length, 2);
  const oldest = f.scheduler.pendingBatches[0]!;
  assert.deepEqual([...oldest.entryIds].sort(), ["e1", "e3"]);
  // No source entry was dropped: all three are tracked pending or in flight.
  const tracked = new Set(
    f.scheduler.pendingBatches.flatMap((b) => b.entryIds),
  );
  for (const id of ["e1", "e2", "e3"]) {
    assert.ok(tracked.has(id) || f.coordinator.isConsumed(id), id);
  }
  for (const r of f.release) r();
});

// ---- Idle batching -------------------------------------------------------

test("below-threshold coverage is flushed by the idle timer, never dropped", async () => {
  const f = track(
    fresh({ minBatchTokens: 10_000, minBatchTurns: 100, idleMs: 40 }),
  );
  f.sources.push(entry("e1", "small turn"));

  const summary = f.scheduler.onAgentSettled();
  assert.equal(summary.deferred, true);
  assert.equal(f.extractCalls.length, 0); // not yet
  await sleep(80);
  assert.equal(f.extractCalls.length, 1); // idle flush fired
  assert.equal(f.extractCalls[0]!.trigger, "idle");
  await sleep(20);
  assert.equal(f.coordinator.isConsumed("e1"), true);
});

// ---- Threshold + input budget -------------------------------------------

test("threshold trigger respects the input budget across batches", async () => {
  const f = track(
    fresh({ minBatchTokens: 1, minBatchTurns: 1, idleMs: 60_000 }),
  );
  // Each entry ~ 500 tokens; budget default 6,000 → first batch holds ≥ 10.
  for (let i = 0; i < 30; i++) {
    f.sources.push(entry(`e${i}`, "x".repeat(2_000)));
  }
  f.scheduler.onAgentSettled();
  await sleep(20);
  assert.equal(f.extractCalls.length, 1);
  const batchTokenTotal = f.extractCalls[0]!.sources.reduce(
    (s, e) => s + estimateTokens(e.text),
    0,
  );
  assert.ok(
    batchTokenTotal <= 6_000 + 2_000,
    `batch too large: ${batchTokenTotal}`,
  );
  // The rest stays unprocessed for the next batch (non-overlapping successor).
  const remaining = f.scheduler.selectUnprocessed();
  assert.equal(remaining.length > 0, true);
  assert.equal(
    remaining.some((e) =>
      f.extractCalls[0]!.sources.some((s) => s.id === e.id),
    ),
    false,
  );
});

// ---- Stale generation ----------------------------------------------------

test("a result from a stale generation never advances the cursor", async () => {
  const f = track(
    fresh({ minBatchTokens: 1, minBatchTurns: 1, manualExtract: true }),
  );
  f.sources.push(entry("e1", "content"));
  f.scheduler.onAgentSettled();
  await sleep(5);
  // Generation changes while the extraction is in flight (fork to a new
  // session identity).
  f.coordinator.onSessionStart(
    {
      cwd: f.dir,
      sessionManager: { getSessionId: () => "s2", getLeafId: () => "leaf-b" },
    },
    { reason: "new" },
  );
  f.release[0]!();
  await sleep(20);
  assert.equal(f.coordinator.isConsumed("e1"), false);
  assert.equal(f.store.pending().length, 0); // never accepted
  assert.equal(f.scheduler.pendingBatches.length, 1); // re-derivable
});

// ---- Manual extraction ---------------------------------------------------

test("manual extraction flushes below-threshold coverage immediately", async () => {
  const f = track(fresh({ minBatchTokens: 10_000, minBatchTurns: 100 }));
  f.sources.push(entry("e1", "small"));
  const summary = f.scheduler.extractNow();
  assert.equal(summary.scheduled, 1);
  await sleep(20);
  assert.equal(f.extractCalls.length, 1);
  assert.equal(f.extractCalls[0]!.trigger, "manual");
});

// ---- Redaction on the model-call edge -----------------------------------

test("source text is redacted before reaching the model call", async () => {
  const dir = tempDir();
  const coordinator = new SessionCoordinator({ stateDir: dir });
  coordinator.onSessionStart(
    {
      cwd: dir,
      sessionManager: { getSessionId: () => "s1", getLeafId: () => null },
    },
    { reason: "startup" },
  );
  const store = DurableOutbox.open(join(dir, "outbox"));
  const seen: string[] = [];
  const scheduler = new ObserverScheduler({
    stateDir: dir,
    coordinator,
    outbox: store,
    scope: "proj/demo",
    sessionId: "s1",
    extract: (batch) => {
      seen.push(...batch.sources.map((s) => s.text));
      return [];
    },
    minBatchTokens: 1,
    minBatchTurns: 1,
  });
  fixtures.push({
    dir,
    coordinator,
    store,
    scheduler,
    sources: [],
    extractCalls: [],
    release: [],
  });
  scheduler.setProvider({
    entries: () => [
      entry("e1", "key sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here"),
    ],
  });
  scheduler.onAgentSettled();
  await sleep(20);
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? "", /REDACTED/);
  assert.doesNotMatch(seen[0] ?? "", /sk-proj-aaaa/);
});
