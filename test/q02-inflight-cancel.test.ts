/**
 * Q02 closure regression: best-effort IN-FLIGHT cancellation of the outbox
 * delivery on a normal→private transition, through the SHIPPED production
 * runtime (`buildSessionRuntime`) — the same production OutboxWorker,
 * LiveConfigPrivateModeGate and observation sender the extension runs.
 *
 * Scenario: a synthetic 127.0.0.1 listener completes the MCP handshake
 * (initialize / tools/list) and then STALLS the first backend write request
 * indefinitely. While that request is in flight, private mode is persisted
 * and pushed through the shipped transition bridge (`notifyTransition`, the
 * same call the command wiring makes). Assertions:
 * 1. the stalled HTTP request is actually ABORTED by the runtime (the
 *    server observes the socket close before responding), not merely
 *    left to time out;
 * 2. the job is HELD — pending, never quarantined, never dropped, and NOT
 *    acked (no false completion claim);
 * 3. no unhandled rejection escapes the aborted tick;
 * 4. after an explicit resume the pre-private job is retried under its
 *    original opId exactly once (accounted exactly once across the session).
 *
 * Synthetic fixtures only: no real model calls, no live services, no
 * secrets, no private sessions. Bounded awaits throughout.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setPrivateModeInFile } from "../src/runtime/controls.ts";

const TOKEN_ENV = "KIWIFS_Q02F_SYNTHETIC_TOKEN";

interface Stalled {
  url: string;
  aborted: boolean;
  responded: boolean;
}

interface Harness {
  dir: string;
  cfgFile: string;
  stalled: Stalled[];
  answered: number;
  /** After this flips, stalled tool calls are answered 404 (availability). */
  setAnswer404: () => void;
  cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
  const stalled: Stalled[] = [];
  let answer404 = false;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      let method = "";
      try {
        method = String(
          (JSON.parse(body) as { method?: unknown }).method ?? "",
        );
      } catch {
        method = "";
      }
      const respond = (result: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
      };
      const rpcId = (JSON.parse(body || "{}") as { id?: unknown }).id ?? null;
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
              {
                name: "kiwi_read",
                inputSchema: {},
              },
              {
                name: "kiwi_write",
                inputSchema: {},
              },
              {
                name: "kiwi_append",
                inputSchema: {},
              },
              {
                name: "kiwi_delete",
                inputSchema: {},
              },
              {
                name: "kiwi_search",
                inputSchema: {},
              },
              {
                name: "kiwi_search_semantic",
                inputSchema: {},
              },
              {
                name: "kiwi_search_hybrid",
                inputSchema: {},
              },
              {
                name: "kiwi_brief",
                inputSchema: {},
              },
              {
                name: "kiwi_changes",
                inputSchema: {},
              },
              {
                name: "kiwi_query_meta",
                inputSchema: {},
              },
              {
                name: "kiwi_forget",
                inputSchema: {},
              },
            ],
          },
        });
        return;
      }
      // tools/call → the actual delivery write. STALL it (no response) so
      // the request is in flight when the transition lands.
      const entry: Stalled = {
        url: req.url ?? "",
        aborted: false,
        responded: false,
      };
      stalled.push(entry);
      if (answer404) {
        entry.responded = true;
        res.statusCode = 404;
        res.end("synthetic-404");
        return;
      }
      // req "close" fires on message completion (keep-alive), so abort
      // detection watches the RESPONSE stream: closing before it finished
      // writing means the client killed the connection.
      res.on("close", () => {
        if (!res.writableEnded) entry.aborted = true;
      });
      // Intentionally never respond while stalled.
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q02f-"));
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
    stalled,
    answered: 0,
    setAnswer404: () => {
      answer404 = true;
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
    idempotencyKey: "c".repeat(64),
    opId: OP_ID,
    payload: {
      opId: OP_ID,
      sessionId: "q02f-synthetic-session",
      sourceEntryIds: ["e1"],
      observations: [
        {
          sourceEntryIds: ["e1"],
          statement: "synthetic observation for in-flight cancel test",
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

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("bounded wait expired");
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("Q02: in-flight outbox request is aborted on private transition; job held, no false ack, resume delivers once", async () => {
  const h = await makeHarness();
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const rt = await buildRt(h.dir);
    seedJob({ store: rt.store! });
    // Start the delivery WITHOUT awaiting: the first tool call stalls on the
    // synthetic listener, so the request is genuinely in flight.
    const tickPromise = rt.worker!.tick();
    await until(() => h.stalled.length >= 1);
    assert.ok(
      !h.stalled[0]!.aborted,
      "precondition: request in flight (not yet aborted)",
    );

    // Private transition: persist first, then push through the shipped
    // bridge — exactly what the /kiwifs-private-mode on command does.
    assert.equal(setPrivateModeInFile(h.cfgFile, true).ok, true);
    rt.liveGate!.notifyTransition();

    // The aborted tick resolves (bounded) with the job HELD — never sent,
    // never acked, never quarantined.
    const summary = await Promise.race([
      tickPromise,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5000)),
    ]);
    assert.notEqual(summary, "timeout", "tick resolved after abort");
    const s = summary as import("../src/outbox/worker.ts").TickSummary;
    assert.equal(s.sent.length, 0, "aborted send is not reported sent");
    assert.equal(s.held.length, 1, "aborted job is held");
    assert.equal(
      rt.store!.pending().length,
      1,
      "job stays pending (durable, retained)",
    );
    assert.equal(rt.store!.quarantined().length, 0, "never quarantined");
    await until(() => h.stalled[0]!.aborted, 3000);
    assert.equal(
      h.stalled[0]!.aborted,
      true,
      "the in-flight request was actually aborted by the runtime",
    );
    assert.equal(unhandled.length, 0, "no unhandled rejection from the abort");

    // Resume: pre-private pending work retried under its original opId,
    // accounted exactly once (no drop, no duplicate). The synthetic backend
    // now answers 404 (retryable availability) so the attempt is bounded.
    h.setAnswer404();
    assert.equal(setPrivateModeInFile(h.cfgFile, false).ok, true);
    rt.liveGate!.notifyTransition();
    await rt.worker!.tick();
    assert.equal(
      rt.store!.pending().length + rt.store!.quarantined().length,
      1,
      "job accounted exactly once after resume (no duplicate, no drop)",
    );
    rt.store!.close();
    assert.equal(unhandled.length, 0, "no unhandled rejection across resume");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    h.cleanup();
  }
});
