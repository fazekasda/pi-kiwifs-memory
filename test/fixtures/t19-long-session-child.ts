/**
 * T19 AC7 child-process driver: full long-session pipeline under REAL timers,
 * then session_shutdown, then natural event-loop drain.
 *
 * Spawned (and killed on hang) by `test/t19-long-session.test.ts`. The child
 * builds the REAL pipeline (fake MCP server + KiwiFSAdapter + durable outbox
 * + worker + session coordinator tick interval + observation scheduler +
 * backup capture + board delivery runtime with its consumer lock + retrieval
 * coordinator), runs extraction/retrieval/board/outbox cycles including
 * private-mode toggles, switch/tree transitions and a full reload epoch,
 * then tears everything down the way the extension's `session_shutdown`
 * handler does and EXITS BY DRAINING.
 *
 * The exit is the assertion: any ref'd timer, interval or socket left behind
 * by a component keeps the event loop alive, the child never exits, and the
 * parent test kills it with a timeout failure. Before returning, the child
 * prints one `RESULT:{...}` line with `process.getActiveResourcesInfo()`
 * counts (numerical handle evidence; the parent asserts zero timers/sockets).
 *
 * Synthetic only: in-process fake server, no network, no model calls, no
 * live service.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiwiFSAdapter } from "../../src/backend/adapter.ts";
import { identityRedactor } from "../../src/backend/guard.ts";
import { BackupCapture } from "../../src/backup/capture.ts";
import { BoardRepository } from "../../src/board/repository.ts";
import { BoardDeliveryRuntime } from "../../src/board/runtime.ts";
import { buildBoardMessage } from "../../src/board/messages.ts";
import { DurableOutbox } from "../../src/outbox/store.ts";
import { OutboxWorker } from "../../src/outbox/worker.ts";
import { createObservationSender } from "../../src/observation/sender.ts";
import { ObserverScheduler } from "../../src/observation/scheduler.ts";
import { PrivateModeGate } from "../../src/privacy/private-mode.ts";
import { RetrievalCoordinator } from "../../src/retrieval/coordinator.ts";
import { SessionCoordinator } from "../../src/pi/coordinator.ts";
import { createFakeServer } from "../fake-mcp-server.ts";

const URL_ = "https://kiwifs.test/mcp";
const SCOPE = "project/demo-proj";
const CONSUMER = "agent-a1";

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

let entryCounter = 0;
const sources: { id: string; role: "user"; text: string; timestamp: string }[] =
  [];

interface Epoch {
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

async function main(): Promise<void> {
  const dir = join(mkdtempSync(join(tmpdir(), "kiwifs-t19-long-child-")), "s");
  const server = createFakeServer();
  for (let i = 0; i < 3; i++) {
    server.state.store.set(
      `${SCOPE}/memory/observations/2026/01/rec-${i}.md`,
      record(SCOPE, "active", `postgres migration w0${i}`),
    );
  }
  const built = buildBoardMessage(
    {
      channel: "dev",
      from: "alice",
      to: "bob",
      body: "synthetic board body",
      created: new Date("2026-09-07T00:00:00Z"),
    },
    "0123456789abcdef0123456789abcdef",
    new Date("2026-09-07T00:00:00Z"),
  );
  server.state.store.set(built.path, built.content);
  server.state.changesLog.push({
    action: "A",
    path: built.path,
    actor: "alice",
    ts: "s1",
  });

  let epoch: Epoch | undefined;
  let epochNo = 0;

  const newTurn = (): void => {
    entryCounter += 1;
    sources.push({
      id: `e${entryCounter}`,
      role: "user",
      text: `long session turn ${entryCounter} about postgres migrations`,
      timestamp: "2026-09-08T00:00:00Z",
    });
  };

  const fakeCtx = (leaf: string) => ({
    cwd: dir,
    sessionManager: { getSessionId: () => "s-long", getLeafId: () => leaf },
  });

  const startEpoch = (): Epoch => {
    epochNo += 1;
    const gate = new PrivateModeGate(false);
    const store = DurableOutbox.open(join(dir, "outbox"));
    const adapter = new KiwiFSAdapter({
      url: URL_,
      fetchImpl: server.fetch,
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
      baseDelayMs: 5,
      capDelayMs: 10,
    });
    const coordinator = new SessionCoordinator({
      stateDir: dir,
      onTick: () => worker.tick(),
      onRetention: () => store.runRetention(),
      // REAL ref'd interval — must be stopped at session_shutdown or the
      // child never exits (which is exactly what the parent asserts).
      tickIntervalMs: 10,
      retentionEvery: 20,
    });
    const scheduler = new ObserverScheduler({
      stateDir: dir,
      coordinator,
      outbox: store,
      scope: SCOPE,
      sessionId: "s-long",
      branchId: "leaf-a",
      extract: (batch) => ({
        observations: batch.sources.map((s) => ({
          sourceEntryIds: [s.id],
          statement: `synthetic observation for ${s.id}`,
          uncertainty: "low",
        })),
      }),
      idleMs: 3_600_000,
      minBatchTokens: 1,
      minBatchTurns: 2,
    });
    scheduler.setProvider({ entries: () => sources });
    const repo = new BoardRepository(adapter, {
      now: () => new Date("2026-09-08T00:00:00Z"),
    });
    const board = new BoardDeliveryRuntime({
      stateDir: dir,
      consumerId: CONSUMER,
      repo,
      isPrivate: () => gate.isPrivate,
      // REAL rescheduling poll chain — must stop at session_shutdown.
      pollMs: 10,
      backoffMs: 10,
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
      stateDir: dir,
      outbox: store,
      scope: SCOPE,
      projectId: "demo-proj",
      sessionId: "s-long",
      privateMode: () => gate.isPrivate,
      redact: (content: string) => ({ ok: true, content }),
    });
    coordinator.onSessionStart(fakeCtx("leaf-a"), {
      reason: epochNo === 1 ? "startup" : "resume",
    });
    board.start();
    return {
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
  };

  epoch = startEpoch();
  await epoch.adapter.connect();

  const drainOutbox = async (): Promise<void> => {
    for (let i = 0; i < 40 && epoch!.store.pending().length > 0; i += 1) {
      await epoch!.worker.tick();
      await sleep(5);
    }
  };

  for (let cycle = 1; cycle <= 10; cycle += 1) {
    const e = epoch;
    // Extraction: threshold-triggered batch, drained to durable acceptance.
    for (let t = 0; t < 2; t += 1) {
      entryCounter += 1;
      sources.push({
        id: `e${entryCounter}`,
        role: "user",
        text: `long session turn ${entryCounter} about postgres migrations`,
        timestamp: "2026-09-08T00:00:00Z",
      });
    }
    e.scheduler.onAgentSettled();
    await sleep(30);
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
    await e.retrieval.retrieve("postgres migration", undefined, "interactive");
    e.retrieval.registry.dropUnmatched();
    // Lifecycle boundaries: switch every 3rd cycle, tree every 4th.
    if (cycle % 3 === 0) e.coordinator.onBeforeSwitch();
    if (cycle % 4 === 0) {
      e.coordinator.onBeforeTree({ entriesToSummarize: [] });
      e.coordinator.onTree(
        fakeCtx(`leaf-${cycle}`),
        `leaf-${cycle - 1}`,
        `leaf-${cycle}`,
      );
    }
    // Private window on every 3rd cycle: hold → resume.
    if (cycle % 3 === 0) {
      e.gate.enable();
      await e.worker.tick();
      e.gate.resume();
      await sleep(5);
    }
    await drainOutbox();
    // Full reload epoch every 5 cycles (durable-state re-init).
    if (cycle % 5 === 0) {
      e.board.stop();
      e.scheduler.dispose();
      e.coordinator.onShutdown();
      e.store.close();
      await sleep(20);
      epoch = startEpoch();
      await epoch.adapter.connect();
    }
  }
  await drainOutbox();

  // ---- session_shutdown equivalent (src/index.ts teardown order) ----------
  epoch.board.stop();
  epoch.scheduler.dispose();
  epoch.coordinator.onShutdown();
  epoch.store.close();
  // Let in-flight chain/poll work settle, then audit.
  await sleep(80);

  const resources = process.getActiveResourcesInfo();
  const counts: Record<string, number> = {};
  for (const r of resources) counts[r] = (counts[r] ?? 0) + 1;

  console.log(
    `RESULT:${JSON.stringify({
      cycles: 10,
      epochs: epochNo,
      resources: counts,
      coordinatorTimerStopped: !epoch.coordinator.timerRunning,
      consumerLockReleased: !existsSync(join(dir, `delivery-${CONSUMER}.lock`)),
    })}`,
  );
  // Natural exit: the event loop must drain on its own. Any ref'd timer,
  // interval or socket kept alive by the pipeline hangs this process and the
  // parent test fails on its kill timeout.
}

main().catch((err: unknown) => {
  console.error("CHILD FAILED", err);
  process.exit(1);
});
