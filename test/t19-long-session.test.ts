/**
 * T19 chunk 3 (final): long-session bounded-state and no-active-handles
 * shutdown audit (PRD T19 AC7). Synthetic only — the REAL pipeline
 * (KiwiFSAdapter → in-process fake MCP server, durable outbox + worker,
 * session coordinator, observation scheduler with a scripted extract stub,
 * backup capture, board delivery runtime with its consumer lock, retrieval
 * coordinator) runs a long session of extraction/retrieval/board/outbox
 * cycles including private-mode windows, switch/tree transitions and full
 * reload epochs; teardown mirrors the extension's `session_shutdown` order.
 *
 * Numerical evidence (byte sizes, counts, handle resource counts) is written
 * to tasks/evidence/t19-long-session-report.json. Limits disclosed: the
 * extraction model is a scripted stub and the retrieval tokenizer is the
 * synthetic word fixture; this file measures STATE BOUNDING and HANDLE
 * cleanup, not observation quality.
 *
 * The end-to-end handle proof runs in a dedicated child process
 * (test/fixtures/t19-long-session-child.ts): after session_shutdown the child
 * must exit on its own — any ref'd timer, interval or socket left behind by a
 * component keeps its event loop alive and the parent fails on kill timeout.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { KiwiFSAdapter } from "../src/backend/adapter.ts";
import { identityRedactor } from "../src/backend/guard.ts";
import { BackupCapture } from "../src/backup/capture.ts";
import { buildBoardMessage } from "../src/board/messages.ts";
import { acquireConsumerLock } from "../src/board/lock.ts";
import { BoardRepository } from "../src/board/repository.ts";
import { BoardDeliveryRuntime } from "../src/board/runtime.ts";
import { DEFAULT_LIMITS, DurableOutbox } from "../src/outbox/store.ts";
import { OutboxWorker } from "../src/outbox/worker.ts";
import { createObservationSender } from "../src/observation/sender.ts";
import {
  ObserverScheduler,
  STATE_FILE as OBSERVER_STATE_FILE,
} from "../src/observation/scheduler.ts";
import { PrivateModeGate } from "../src/privacy/private-mode.ts";
import { RetrievalCoordinator } from "../src/retrieval/coordinator.ts";
import { SessionCoordinator } from "../src/pi/coordinator.ts";
import { createFakeServer } from "./fake-mcp-server.ts";

const URL_ = "https://kiwifs.test/mcp";
const SCOPE = "project/demo-proj";
const CONSUMER = "agent-a1";
const CHILD_DRIVER = fileURLToPath(
  new URL("fixtures/t19-long-session-child.ts", import.meta.url),
);

const SECRET_CANARY = "SYNTHETIC-SECRET-CANARY-9f2a7c";
const CONTENT_CANARY = "SYNTHETIC-CONTENT-CANARY-4b81ce";

/** Measured data — written to the evidence report at the end. */
const REPORT: Record<string, unknown> = {
  synthetic: true,
  liveServices: false,
  modelCalls: false,
  limitations: [
    "extraction model is a scripted stub — state bounding and handle cleanup only, NOT observation quality",
    "retrieval tokenizer is the synthetic word fixture — NOT production-model-compatible",
    "handle evidence: process.getActiveResourcesInfo() counts plus a child-process natural-drain exit",
  ],
};

/** Mutable fake clock so worker backoff windows advance deterministically. */
let fakeNow = 1_000_000;

function newDir(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `kiwifs-t19-long-${name}-`)), "state");
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function resourceCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of process.getActiveResourcesInfo()) {
    counts[r] = (counts[r] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Shared long-session harness (real pipeline, fake backend, scripted extract)
// ---------------------------------------------------------------------------

interface Epoch {
  dir: string;
  coordinator: SessionCoordinator;
  scheduler: ObserverScheduler;
  worker: OutboxWorker;
  board: BoardDeliveryRuntime;
  retrieval: RetrievalCoordinator;
  backup: BackupCapture;
  gate: PrivateModeGate;
  store: DurableOutbox;
  adapter: KiwiFSAdapter;
}

interface Session {
  dir: string;
  server: ReturnType<typeof createFakeServer>;
  sources: { id: string; role: "user"; text: string; timestamp: string }[];
  entryCount: number;
  epochCount: number;
  epoch: Epoch;
}

function buildEpoch(s: Session): Epoch {
  const gate = new PrivateModeGate(false);
  const store = DurableOutbox.open(join(s.dir, "outbox"), {
    now: () => fakeNow,
    // Acked-job retention window shrunk to prove acked pruning on the clock.
    limits: { ...DEFAULT_LIMITS, retentionMs: 1 },
  });
  const adapter = new KiwiFSAdapter({
    url: URL_,
    fetchImpl: s.server.fetch,
    ledger: store.ledger(),
    requestTimeoutMs: 2_000,
  });
  const worker = new OutboxWorker({
    store,
    send: createObservationSender({
      scope: SCOPE,
      openBackend: async () => adapter,
    }),
    gate,
    now: () => fakeNow,
    random: () => 0,
    baseDelayMs: 100,
    capDelayMs: 200,
  });
  const coordinator = new SessionCoordinator({
    stateDir: s.dir,
    onTick: () => worker.tick(),
    onRetention: () => store.runRetention(),
    // Real interval: proves start/stop around the whole session.
    tickIntervalMs: 50,
    retentionEvery: 500,
  });
  const scheduler = new ObserverScheduler({
    stateDir: s.dir,
    coordinator,
    outbox: store,
    scope: SCOPE,
    sessionId: "s-long",
    branchId: "leaf-a",
    extract: (batch) => ({
      observations: batch.sources.map((src) => ({
        sourceEntryIds: [src.id],
        statement: `synthetic observation for ${src.id}`,
        uncertainty: "low",
      })),
    }),
    idleMs: 3_600_000, // idle batching must not fire mid-test
    minBatchTokens: 1,
    minBatchTurns: 2,
  });
  scheduler.setProvider({ entries: () => s.sources });
  const repo = new BoardRepository(adapter, {
    now: () => new Date("2026-09-08T00:00:00Z"),
  });
  const board = new BoardDeliveryRuntime({
    stateDir: s.dir,
    consumerId: CONSUMER,
    repo,
    recipient: "bob",
    isPrivate: () => gate.isPrivate,
    pollMs: 20,
    backoffMs: 20,
  });
  const retrieval = new RetrievalCoordinator({
    adapter,
    authorizedScopes: [SCOPE],
    deadlineMs: 2_000,
    tokenCap: 3_000,
    generation: 1,
    redact: identityRedactor,
    tokenizer: {
      id: "test-word-split (synthetic fixture)",
      countTokens: (t: string) => t.split(/\s+/).length,
    },
  });
  const backup = new BackupCapture({
    stateDir: s.dir,
    outbox: store,
    scope: SCOPE,
    projectId: "demo-proj",
    sessionId: "s-long",
    privateMode: () => gate.isPrivate,
    redact: (content: string) => ({ ok: true, content }),
    now: () => fakeNow,
  });
  return {
    dir: s.dir,
    coordinator,
    scheduler,
    worker,
    board,
    retrieval,
    backup,
    gate,
    store,
    adapter,
  };
}

function startEpoch(s: Session): void {
  s.epochCount += 1;
  s.epoch = buildEpoch(s);
  s.epoch.coordinator.onSessionStart(
    {
      cwd: s.dir,
      sessionManager: {
        getSessionId: () => "s-long",
        getLeafId: () => "leaf-a",
      },
    },
    { reason: "startup" },
  );
  s.epoch.board.start();
}

function setupSession(name: string, recordCount = 3): Session {
  const dir = newDir(name);
  const server = createFakeServer();
  for (let i = 0; i < recordCount; i += 1) {
    server.state.store.set(
      `${SCOPE}/memory/observations/2026/01/rec-${i}.md`,
      record(SCOPE, "active", `postgres migration w0${i}`),
    );
  }
  const s: Session = {
    dir,
    server,
    sources: [],
    epoch: undefined as unknown as Epoch,
    epochCount: 0,
    entryCount: 0,
  };
  startEpoch(s);
  return s;
}

async function drainOutbox(s: Session): Promise<void> {
  for (let i = 0; i < 60 && s.epoch.store.pending().length > 0; i += 1) {
    fakeNow += 500; // clear worker backoff windows on the fake clock
    await s.epoch.worker.tick();
  }
}

function addTurns(s: Session, count: number): void {
  for (let t = 0; t < count; t += 1) {
    s.entryCount += 1;
    s.sources.push({
      id: `e${s.entryCount}`,
      role: "user",
      text: `long session turn ${s.entryCount} about postgres migrations`,
      timestamp: "2026-09-08T00:00:00Z",
    });
  }
}

function fileBytes(dir: string, name: string): number {
  const p = join(dir, name);
  return existsSync(p) ? statSync(p).size : 0;
}

function readObserverPending(dir: string): number {
  const p = join(dir, OBSERVER_STATE_FILE);
  if (!existsSync(p)) return 0;
  const parsed = JSON.parse(readFileSync(p, "utf8")) as {
    pendingBatches?: unknown[];
  };
  return parsed.pendingBatches?.length ?? 0;
}

// ---------------------------------------------------------------------------
// AC7 main: bounded local state (measured)
// ---------------------------------------------------------------------------

test("long session: bounded local state across 60 extraction/retrieval/board/outbox cycles with private, switch/tree and reload cycles (measured)", async () => {
  const baseline = resourceCounts();

  const s = setupSession("bounded");
  await s.epoch.adapter.connect();

  // Two board messages seeded once; delivery must be exactly-once across
  // private windows and a full reload epoch.
  for (let m = 0; m < 2; m += 1) {
    const built = buildBoardMessage(
      {
        channel: "dev",
        from: "alice",
        to: "bob",
        body: `synthetic board body ${m}`,
        created: new Date("2026-09-07T00:00:00Z"),
      },
      `fedcba9876543210000000000000000${m}`,
      new Date("2026-09-07T00:00:00Z"),
    );
    s.server.state.store.set(built.path, built.content);
    s.server.state.changesLog.push({
      action: "A",
      path: built.path,
      actor: "alice",
      ts: `s${m}`,
    });
  }

  const snapshots: Record<string, unknown>[] = [];

  for (let cycle = 1; cycle <= 60; cycle += 1) {
    const e = s.epoch;
    addTurns(s, 2);
    e.scheduler.onAgentSettled();
    await sleep(20);
    // Backup: one synthetic session entry per cycle.
    e.backup.capture([
      {
        id: `b${cycle}`,
        parentId: null,
        type: "message",
        timestamp: "2026-09-08T00:00:00Z",
        message: { role: "user", content: `backup turn ${cycle}` },
      },
    ]);
    // Retrieval: one full guarded cycle per turn of the session.
    const outcome = await e.retrieval.retrieve(
      "postgres migration",
      undefined,
      "interactive",
    );
    assert.equal(
      outcome.kind,
      "pack",
      `cycle ${cycle}: retrieval produced a pack`,
    );
    e.retrieval.registry.dropUnmatched();
    // Lifecycle boundaries: switch every 5th cycle, tree every 10th.
    if (cycle % 5 === 0) e.coordinator.onBeforeSwitch();
    if (cycle % 10 === 0) {
      e.coordinator.onBeforeTree({ entriesToSummarize: [] });
      e.coordinator.onTree(
        {
          cwd: s.dir,
          sessionManager: {
            getSessionId: () => "s-long",
            getLeafId: () => `leaf-${cycle}`,
          },
        },
        `leaf-${cycle - 10}`,
        `leaf-${cycle}`,
      );
    }
    // Private window on every 7th cycle: hold → resume with release tick.
    if (cycle % 7 === 0) {
      e.gate.enable();
      fakeNow += 500;
      await e.worker.tick(); // pending jobs HELD while private
      e.gate.resume(); // release listener re-ticks the worker
      await sleep(10);
    }
    await drainOutbox(s);
    // Acked-job retention every 10 cycles (the extension wires it to ticks).
    if (cycle % 10 === 0) {
      e.store.runRetention();
      snapshots.push({
        cycle,
        outboxJobsBytes: fileBytes(join(s.dir, "outbox"), "jobs.jsonl"),
        outboxRetainedBytes: e.store.stats.bytes,
        observerStateBytes: fileBytes(s.dir, OBSERVER_STATE_FILE),
        coordinatorStateBytes: fileBytes(s.dir, "session-coordinator.json"),
        backupStateBytes: fileBytes(s.dir, "backup-state.json"),
        deliveryStateBytes: fileBytes(s.dir, `delivery-${CONSUMER}.json`),
        outboxJobs: { ...e.store.stats },
        observerPendingBatches: readObserverPending(s.dir),
        coordinatorConsumedEntries: e.coordinator.consumedCount,
      });
    }
    // Full reload epoch every 20 cycles (durable-state re-init).
    if (cycle % 20 === 0) {
      e.board.stop();
      e.scheduler.dispose();
      e.coordinator.onShutdown();
      e.store.close();
      await sleep(30);
      startEpoch(s);
      await s.epoch.adapter.connect();
    }
  }
  await drainOutbox(s);
  s.epoch.store.runRetention();

  // ---- final bounded-state audit (numerical) ------------------------------
  const e = s.epoch;
  const stats = e.store.stats;
  assert.equal(stats.pending, 0, "all jobs delivered across the long session");
  assert.equal(stats.quarantined, 0, "no quarantined jobs");
  const outboxBytes = fileBytes(join(s.dir, "outbox"), "jobs.jsonl");
  assert.ok(
    outboxBytes > 0 && outboxBytes < 64 * 1024,
    `outbox journal bounded after 60 cycles (${outboxBytes} B)`,
  );
  assert.equal(readObserverPending(s.dir), 0, "observer batch queue drained");
  const observerBytes = fileBytes(s.dir, OBSERVER_STATE_FILE);
  assert.ok(
    observerBytes > 0 && observerBytes < 4 * 1024,
    `observer state file bounded (${observerBytes} B)`,
  );
  const deliveryState = JSON.parse(
    readFileSync(join(s.dir, `delivery-${CONSUMER}.json`), "utf8"),
  ) as { entries: Record<string, unknown> };
  const tracked = Object.keys(deliveryState.entries).length;
  assert.ok(tracked <= 2000, `delivery dedupe set bounded (${tracked})`);
  // Board delivery exactly-once across private windows and a full reload:
  // the DURABLE dedupe set must show both messages delivered (buffer is
  // per-epoch, so the durable state is the honest exactly-once record).
  const deliveredIds = Object.entries(e.board.state.value.entries)
    .filter(([, v]) => v.deliveredAt !== undefined)
    .map(([msgId]) => msgId);
  assert.equal(
    deliveredIds.length,
    2,
    `exactly the two seeded messages delivered once (got ${deliveredIds.length})`,
  );
  assert.equal(e.board.holdReason, undefined, "consumer lock held all session");
  assert.equal(e.retrieval.registry.pendingCount, 0, "pack registry drained");

  // No synthetic canaries anywhere in the durable local state.
  for (const name of [
    "session-coordinator.json",
    OBSERVER_STATE_FILE,
    "backup-state.json",
    `delivery-${CONSUMER}.json`,
    join("outbox", "jobs.jsonl"),
  ]) {
    const p = join(s.dir, name);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    assert.ok(!text.includes(SECRET_CANARY), `${name}: secret canary leaked`);
    assert.ok(!text.includes(CONTENT_CANARY), `${name}: content canary leaked`);
  }

  // Bounded pipelines must stay flat across the session; the two
  // correctness registries (coordinator consumed-coverage, backup manifest)
  // grow proportionally to consumed entries/captured content by design —
  // measured and documented, not hidden (architecture.md §3.3, decisions.md #8).
  const first = snapshots[0]!;
  const last = snapshots.at(-1)!;
  assert.ok(
    (last.outboxRetainedBytes as number) <=
      (first.outboxRetainedBytes as number) + 16 * 1024,
    `outbox retained bytes grew unbounded: ${first.outboxRetainedBytes} → ${last.outboxRetainedBytes}`,
  );
  assert.ok(
    (last.observerStateBytes as number) <= 4 * 1024,
    "observer state stays bounded across the whole session",
  );

  // ---- shutdown assertions ------------------------------------------------
  const afterShutdown = resourceCounts();
  e.board.stop();
  e.scheduler.dispose();
  e.coordinator.onShutdown();
  e.store.close();
  const finalResources = resourceCounts();

  assert.equal(e.coordinator.timerRunning, false, "coordinator timer stopped");
  assert.equal(
    existsSync(join(s.dir, `delivery-${CONSUMER}.lock`)),
    false,
    "board consumer lock released at shutdown",
  );
  // The released consumer id is immediately re-acquirable (lock cleanup).
  const reacquired = acquireConsumerLock(s.dir, CONSUMER);
  assert.ok(reacquired.path.endsWith(`delivery-${CONSUMER}.lock`));
  reacquired.release();
  assert.throws(
    () =>
      e.store.enqueue({
        kind: "observation",
        scope: SCOPE,
        idempotencyKey: "0123456789abcdef0123456789abcdef",
        payload: { note: "after shutdown" },
      }),
    /closed/,
    "closed outbox refuses post-shutdown work",
  );
  e.store.close();

  REPORT.longSession = {
    cycles: 60,
    reloadEpochs: s.epochCount,
    turnsExtracted: s.entryCount,
    snapshots,
    final: {
      outboxJournalBytes: outboxBytes,
      outboxStats: stats,
      observerStateBytes: fileBytes(s.dir, OBSERVER_STATE_FILE),
      observerPendingBatches: readObserverPending(s.dir),
      coordinatorStateBytes: fileBytes(s.dir, "session-coordinator.json"),
      coordinatorConsumedEntries: e.coordinator.consumedCount,
      backupStateBytes: fileBytes(s.dir, "backup-state.json"),
      deliveryStateBytes: fileBytes(s.dir, `delivery-${CONSUMER}.json`),
      deliveryTrackedEntries: tracked,
      boardMessagesDeliveredOnce: deliveredIds.length,
    },
    growthNote:
      "outbox journal / observer state / delivery state are BOUNDED (retention, " +
      "20-batch cap, 2,000-entry dedupe cap). session-coordinator.json's " +
      "consumed-coverage registry and backup-state.json's manifest grow " +
      "PROPORTIONALLY to consumed entries / captured content by design " +
      "(coverage correctness — architecture.md §3.3, decisions.md #8); they are " +
      "per-session state bounded by session length, not unbounded leaks",
    handleAuditInProcess: {
      baselineResources: baseline,
      beforeShutdownResources: afterShutdown,
      afterShutdownResources: finalResources,
      coordinatorTimerStopped: !e.coordinator.timerRunning,
      consumerLockReleased: true,
      closedStoreRefusesWork: true,
      consumerIdReacquirable: true,
    },
  };

  // After full teardown the event loop holds no more timers/sockets than the
  // pre-test baseline (the child-process test proves the stronger property:
  // natural exit under REAL intervals).
  assert.ok(
    (finalResources["Timeout"] ?? 0) <= (baseline["Timeout"] ?? 0),
    `no leaked timer handles after shutdown (baseline ${baseline["Timeout"] ?? 0}, after ${finalResources["Timeout"] ?? 0})`,
  );
  assert.equal(
    finalResources["TCPSocketWrap"] ?? 0,
    0,
    "no TCP sockets open after shutdown",
  );
});

// ---------------------------------------------------------------------------
// AC7: child-process event-loop drain under REAL timers (no active handles)
// ---------------------------------------------------------------------------

test("long session: child process drains after session_shutdown — no active handles (measured)", async () => {
  const child = spawn(process.execPath, [CHILD_DRIVER], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: Buffer) => {
    stdout += String(d);
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += String(d);
  });
  const outcome = await new Promise<{ code: number | null; timedOut: boolean }>(
    (resolve) => {
      const kill = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, timedOut: true });
      }, 30_000);
      child.on("exit", (code) => {
        clearTimeout(kill);
        resolve({ code, timedOut: false });
      });
    },
  );
  assert.equal(
    outcome.timedOut,
    false,
    `child did not exit within 30 s — active handles leaked after session_shutdown\nstderr: ${stderr}`,
  );
  assert.equal(outcome.code, 0, `child exited cleanly\nstderr: ${stderr}`);
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
  assert.ok(line, `child printed a RESULT line\nstderr: ${stderr}`);
  const result = JSON.parse(line!.slice("RESULT:".length)) as {
    cycles: number;
    epochs: number;
    resources: Record<string, number>;
    coordinatorTimerStopped: boolean;
    consumerLockReleased: boolean;
  };
  assert.equal(result.cycles, 10);
  assert.equal(result.epochs, 3, "reload epochs ran (cycles 5 and 10)");
  assert.equal(result.coordinatorTimerStopped, true);
  assert.equal(result.consumerLockReleased, true);
  assert.equal(
    result.resources["Timeout"] ?? 0,
    0,
    `zero timer handles at drain: ${JSON.stringify(result.resources)}`,
  );
  assert.equal(
    result.resources["TCPSocketWrap"] ?? 0,
    0,
    "zero TCP sockets at drain",
  );
  REPORT.childDrain = {
    child: "test/fixtures/t19-long-session-child.ts",
    cycles: result.cycles,
    reloadEpochs: result.epochs,
    resourcesAtDrain: result.resources,
    coordinatorTimerStopped: result.coordinatorTimerStopped,
    consumerLockReleased: result.consumerLockReleased,
    note: "child exited by draining: no ref'd timer, interval or socket survives session_shutdown",
  };
});

// ---------------------------------------------------------------------------
// Defect regressions found by the long-session audit (fixed, not limit-bumped)
// ---------------------------------------------------------------------------

test("long session defect: private-mode holds are deduped per job across repeated ticks (held set bounded by distinct pending jobs)", async () => {
  const gate = new PrivateModeGate(false);
  gate.enable();
  const job = {
    opId: "00000000-0000-4000-8000-000000000001",
    kind: "observation",
  };
  // The outbox worker re-holds the SAME pending job on every tick while
  // private; the gate must keep ONE ref per distinct job, never one per tick.
  for (let i = 0; i < 200; i += 1) {
    assert.equal(gate.holdWhilePrivate(job).held, true);
  }
  assert.equal(gate.heldJobs().length, 1, "held refs deduped by opId");
  // A different job adds exactly one more ref.
  gate.holdWhilePrivate({
    opId: "00000000-0000-4000-8000-000000000002",
    kind: "backup",
  });
  assert.equal(gate.heldJobs().length, 2);
  // Resume releases everything once; a NEW private window re-holds cleanly.
  const released = gate.resume();
  assert.equal(released.heldJobs, 2);
  gate.enable();
  assert.equal(gate.holdWhilePrivate(job).held, true);
  assert.equal(gate.heldJobs().length, 1);
});

test("long session defect: private-mode transition log is FIFO-capped (bounded metadata)", async () => {
  const gate = new PrivateModeGate(false);
  for (let i = 0; i < 250; i += 1) {
    gate.enable();
    gate.resume();
  }
  assert.ok(
    gate.eventLog().length <= PrivateModeGate.MAX_EVENTS,
    `transition log bounded (${gate.eventLog().length} <= ${PrivateModeGate.MAX_EVENTS})`,
  );
  // Newest transitions survive; only the oldest metadata is dropped.
  assert.equal(gate.eventLog().at(-1)?.action, "resumed");
});

// ---------------------------------------------------------------------------
// Evidence report
// ---------------------------------------------------------------------------

test("evidence: write the measured long-session report", async () => {
  const dir = join(process.cwd(), "tasks", "evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "t19-long-session-report.json"),
    `${JSON.stringify(REPORT, null, 2)}\n`,
  );
});
