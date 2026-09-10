/**
 * Q08A: concurrency barriers for board/outbox/observer (synthetic only).
 *
 * Focus:
 * 1. Interleaved ticks are SINGLE-FLIGHT through the SHIPPED runtime: two
 *    overlapping `worker.tick()` calls must never double-deliver one pending
 *    job (the second queues behind the in-flight tick on the worker's
 *    serialization barrier). Ordering is proven with deferred promises, not
 *    fixed sleeps.
 * 2. Cancellation BEFORE send (private boundary holds, zero requests) and
 *    the unknown-outcome-after-send window (send resolved + acked, then
 *    transition/tick overlap) never produce duplicate delivery.
 * 3. Board delivery: `stop()` overlapping an in-flight poll cycle completes
 *    best-effort and a restart over the same durable state dedupes —
 *    exactly one logical delivery across generations.
 *
 * All waits are bounded event waits / deferred barriers. No live services,
 * no secrets, no private sessions. Preserves t19 benchmark behavior
 * (untouched files).
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { setPrivateModeInFile } from "../src/runtime/controls.ts";
import {
  BoardDeliveryRuntime,
  type BoardDeliveryRuntimeOptions,
} from "../src/board/runtime.ts";
import { BoardRepository } from "../src/board/repository.ts";
import { KiwiFSAdapter } from "../src/backend/adapter.ts";
import { createMemoryLedger } from "../src/backend/opid.ts";
import { buildBoardMessage } from "../src/board/messages.ts";
import { createFakeServer } from "./fake-mcp-server.ts";

const TOKEN_ENV = "KIWIFS_Q08A_SYNTHETIC_TOKEN";

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("bounded wait expired");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** Deferred barrier: release() resolves every current and future waiters. */
function barrier(): {
  wait: () => Promise<void>;
  release: () => void;
  released: () => boolean;
} {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  let done = false;
  return {
    wait: () => {
      if (done) return Promise.resolve();
      return promise;
    },
    release: () => {
      done = true;
      release();
    },
    released: () => done,
  };
}

// ---------------------------------------------------------------------------
// Outbox runtime harness (shipped buildSessionRuntime + local HTTP listener)
// ---------------------------------------------------------------------------

interface WriteGate {
  dir: string;
  cfgFile: string;
  /** Resolved when the first tools/call write has ARRIVED (request seen). */
  firstWriteSeen: () => Promise<void>;
  /** Holds the first tools/call response until released. */
  hold: () => Promise<void>;
  releaseHold: () => void;
  readonly writes: number;
  cleanup: () => void;
}

async function makeServerHarness(): Promise<WriteGate> {
  let firstWrite!: () => void;
  const firstWritePromise = new Promise<void>((r) => (firstWrite = r));
  let releaseHold!: () => void;
  const holdPromise = new Promise<void>((r) => (releaseHold = r));
  let writes = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      const respond = (result: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      };
      let method = "";
      let rpcId: unknown = null;
      try {
        const parsed = JSON.parse(body || "{}") as {
          method?: unknown;
          id?: unknown;
        };
        method = String(parsed.method ?? "");
        rpcId = parsed.id ?? null;
      } catch {
        method = "";
      }
      if (method === "initialize") {
        respond({
          jsonrpc: "2.0",
          id: rpcId,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "kiwifs-synthetic", version: "0.0.0" },
          },
        });
        return;
      }
      if (method === "tools/list") {
        respond({
          jsonrpc: "2.0",
          id: rpcId,
          result: {
            tools: [
              { name: "kiwi_read", inputSchema: {} },
              { name: "kiwi_write", inputSchema: {} },
              { name: "kiwi_append", inputSchema: {} },
              { name: "kiwi_delete", inputSchema: {} },
              { name: "kiwi_search", inputSchema: {} },
              { name: "kiwi_search_semantic", inputSchema: {} },
              { name: "kiwi_search_hybrid", inputSchema: {} },
              { name: "kiwi_brief", inputSchema: {} },
              { name: "kiwi_changes", inputSchema: {} },
              { name: "kiwi_query_meta", inputSchema: {} },
              { name: "kiwi_forget", inputSchema: {} },
            ],
          },
        });
        return;
      }
      // tools/call: kiwi_read is writeImmutable's read-back (answer "not
      // found" so the deterministic path counts as absent); kiwi_write is
      // the delivered write — hold the FIRST one on a barrier so the test
      // controls exactly when the send completes.
      if (method === "tools/call") {
        const tool = String(
          (JSON.parse(body || "{}") as { params?: { name?: unknown } }).params
            ?.name ?? "",
        );
        if (tool === "kiwi_read") {
          respond({
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              isError: true,
              content: [{ type: "text", text: "not found" }],
            },
          });
          return;
        }
        if (tool === "kiwi_write") {
          writes += 1;
          const isFirst = writes === 1;
          if (isFirst) firstWrite();
          void (
            isFirst && firstWriteHeld ? holdPromise : Promise.resolve()
          ).then(() => {
            respond({
              jsonrpc: "2.0",
              id: rpcId,
              result: { content: [{ type: "text", text: "ok" }] },
            });
          });
          return;
        }
        respond({ jsonrpc: "2.0", id: rpcId, result: {} });
        return;
      }
      respond({ jsonrpc: "2.0", id: rpcId, result: {} });
    });
  });
  let firstWriteHeld = true;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q08a-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const config = {
    schemaVersion: 1,
    enabled: true,
    privateMode: false,
    projectIdentity: "example.local/synthetic",
    mcp: { url, auth: { kind: "env", ref: TOKEN_ENV } },
    model: {
      route: "openrouter/z-ai/glm-5.3-flash",
      auth: { kind: "env", ref: TOKEN_ENV },
    },
    features: { observation: true, backup: false, board: false },
  };
  writeFileSync(cfgFile, JSON.stringify(config));
  const prevCfg = process.env["KIWIFS_MEMORY_CONFIG"];
  const prevState = process.env["KIWIFS_MEMORY_STATE_DIR"];
  const prevToken = process.env[TOKEN_ENV];
  process.env["KIWIFS_MEMORY_CONFIG"] = cfgFile;
  process.env["KIWIFS_MEMORY_STATE_DIR"] = stateDir;
  process.env[TOKEN_ENV] = "synthetic-token-value";
  return {
    dir,
    cfgFile,
    firstWriteSeen: () => firstWritePromise,
    hold: () => holdPromise,
    releaseHold: () => {
      firstWriteHeld = false;
      releaseHold();
    },
    get writes() {
      return writes;
    },
    cleanup() {
      server.close();
      if (prevCfg === undefined) delete process.env["KIWIFS_MEMORY_CONFIG"];
      else process.env["KIWIFS_MEMORY_CONFIG"] = prevCfg;
      if (prevState === undefined)
        delete process.env["KIWIFS_MEMORY_STATE_DIR"];
      else process.env["KIWIFS_MEMORY_STATE_DIR"] = prevState;
      if (prevToken === undefined) delete process.env[TOKEN_ENV];
      else process.env[TOKEN_ENV] = prevToken;
    },
  };
}

const OP_ID = randomUUID();

function seedJob(rt: { store: { enqueue(job: unknown): unknown } }): void {
  rt.store.enqueue({
    kind: "observation",
    scope: "project/example.local/synthetic",
    idempotencyKey: "a".repeat(64),
    opId: OP_ID,
    payload: {
      opId: OP_ID,
      sessionId: "q08a-synthetic-session",
      sourceEntryIds: ["e1"],
      observations: [
        {
          sourceEntryIds: ["e1"],
          statement: "synthetic observation for concurrency barrier test",
          uncertainty: "low",
        },
      ],
    },
  });
}

async function buildRt(dir: string) {
  const mod = await import("../src/index.ts");
  const rt = mod.buildSessionRuntime(dir);
  assert.ok(rt.worker, "production outbox worker must exist");
  assert.ok(rt.store, "production durable outbox must exist");
  assert.ok(rt.liveGate, "production live gate must exist");
  return rt;
}

/** Bounded await; the promise itself must settle within ms. */
const bounded = <T>(p: Promise<T>, ms = 5000): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("bounded wait expired")), ms),
    ),
  ]);

test("Q08A: interleaved ticks are single-flight — overlapping ticks never double-deliver", async () => {
  const h = await makeServerHarness();
  try {
    const rt = await buildRt(h.dir);
    seedJob({ store: rt.store! });
    // Tick 1 in flight: its send is stalled on the server barrier.
    const t1 = rt.worker!.tick();
    await h.firstWriteSeen();
    // Two more callers overlap while tick 1's send is in flight (timer tick +
    // gate-release-listener analogue). With single-flight serialization they
    // queue behind t1; a racy worker would send the SAME pending job again.
    const t2 = rt.worker!.tick();
    const t3 = rt.worker!.tick();
    h.releaseHold();
    const s1 = await bounded(t1);
    const s2 = await bounded(t2);
    const s3 = await bounded(t3);
    assert.equal(
      s1.sent.length,
      1,
      "exactly one send reported by the owning tick",
    );
    assert.equal(
      s2.sent.length + s3.sent.length,
      0,
      "overlapping ticks delivered nothing (no duplicate)",
    );
    assert.equal(h.writes, 1, "backend received exactly one delivery");
    assert.equal(rt.store!.pending().length, 0, "job acked exactly once");
    assert.equal(rt.store!.quarantined().length, 0);
    rt.store!.close();
  } finally {
    h.cleanup();
  }
});

test("Q08A: cancel-before-send holds with zero requests; resume delivers exactly once; acked job never re-delivered", async () => {
  const h = await makeServerHarness();
  try {
    // Start PRIVATE: the shipped gate cancels every send before it begins.
    assert.equal(setPrivateModeInFile(h.cfgFile, true).ok, true);
    const rt = await buildRt(h.dir);
    seedJob({ store: rt.store! });
    const held = await rt.worker!.tick();
    assert.equal(held.sent.length, 0, "cancel-before-send: nothing sent");
    assert.equal(held.held.length, 1, "job held at the boundary");
    assert.equal(h.writes, 0, "zero backend requests while private");
    assert.equal(rt.store!.pending().length, 1, "job retained, not dropped");

    // Resume through the shipped transition bridge; overlapping ticks.
    assert.equal(setPrivateModeInFile(h.cfgFile, false).ok, true);
    rt.liveGate!.notifyTransition();
    // Release the write barrier so the resumed send completes (bounded).
    h.releaseHold();
    await rt.worker!.tick();
    await until(() => h.writes >= 1);
    assert.equal(rt.store!.pending().length, 0, "delivered and acked once");
    const writesAfterSend = h.writes;

    // Unknown-outcome overlap AFTER the send resolved: a private transition
    // plus more ticks must not re-deliver the acked job.
    assert.equal(setPrivateModeInFile(h.cfgFile, true).ok, true);
    rt.liveGate!.notifyTransition();
    await Promise.all([rt.worker!.tick(), rt.worker!.tick()]);
    assert.equal(
      h.writes,
      writesAfterSend,
      "no duplicate delivery after ack (unknown outcome cannot unsend)",
    );
    assert.equal(rt.store!.pending().length, 0, "stays acked");
    rt.store!.close();
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Board delivery: stop() overlapping an in-flight cycle
// ---------------------------------------------------------------------------

interface BoardHarness {
  dir: string;
  releaseChanges: () => void;
  changesSeen: () => Promise<void>;
  makeRt: (opts?: { consumerId?: string }) => BoardDeliveryRuntime;
}

function makeBoardHarness(): BoardHarness {
  let releaseChanges!: () => void;
  const changesPromise = new Promise<void>((r) => (releaseChanges = r));
  let changesSeen = false;
  const server = createFakeServer();
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q08a-board-"));
  // Seed one board message for the consumer (same shape as t17 integration).
  const built = buildBoardMessage(
    {
      channel: "dev",
      from: "bob",
      to: "agent-alpha",
      body: "hello from q08a",
    },
    "op-q08a-1",
    new Date("2026-09-07T00:00:00Z"),
  );
  server.state.store.set(built.path, built.content);
  server.state.changesLog.push({
    action: "A",
    path: built.path,
    actor: "bob",
    ts: "2026-09-07T01:00:00Z",
  });
  // Gate the FIRST kiwi_changes request on a barrier so a poll cycle is
  // genuinely in flight when stop() lands.
  const gatedFetch: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("kiwi_changes") && !changesSeen) {
      changesSeen = true;
      await changesPromise;
    }
    return server.fetch(input, init);
  };
  const adapter = new KiwiFSAdapter({
    url: "https://kiwifs.test/mcp",
    requestTimeoutMs: 10_000,
    ledger: createMemoryLedger(),
    fetchImpl: gatedFetch,
  });
  const repo = new BoardRepository(adapter, {
    now: () => new Date("2026-09-08T00:00:00Z"),
  });
  const makeRt = (opts?: { consumerId?: string }) =>
    new BoardDeliveryRuntime({
      stateDir: dir,
      consumerId: opts?.consumerId ?? "agent-alpha",
      repo,
      isPrivate: () => false,
      pollMs: 15,
      backoffMs: 15,
    });
  return {
    dir,
    releaseChanges: () => releaseChanges(),
    changesSeen: async () => {
      await until(() => changesSeen);
    },
    makeRt,
  };
}

test("Q08A: board stop() overlapping an in-flight cycle completes best-effort; restart dedupes to one delivery", async () => {
  const h = await makeBoardHarness();
  try {
    const rt1 = h.makeRt();
    rt1.start();
    await h.changesSeen();
    // stop() while the changes fetch is held in flight.
    rt1.stop();
    h.releaseChanges();
    // The in-flight cycle completes best-effort; give it a bounded window,
    // then verify exactly one logical delivery across the generation change.
    const rt2 = h.makeRt();
    rt2.start();
    await until(() => rt2.inbox(10).unread === 1, 3000);
    rt2.stop();
    assert.equal(rt2.inbox(10).unread, 1, "exactly one unread across restart");
    assert.equal(
      rt2.inbox(10).buffered.length,
      1,
      "delivered exactly once (no duplicate notification)",
    );
  } finally {
    // no persistent resources
  }
});
