/**
 * T16 chunk 2 — agent board tools + outbox delivery integration (synthetic
 * only: fake MCP server, temp-dir outbox; no credentials, no live service).
 *
 * Covers the remaining PRD T16 acceptance surface:
 * - send tool → durable outbox job (opId + created persisted in the SAME
 *   durable write), safe status output only (no body echo)
 * - worker tick → sendBoardJob → backend write; worker replay → no-op
 * - differing-content collision at the deterministic path → job
 *   quarantined with a visible reason, original intact
 * - private mode: ZERO backend reads/writes for all three tools, no new
 *   board jobs enqueued
 * - redaction gate before enqueue; secret-bearing body screened at enqueue
 * - list/read tool output framing: safe ids, untrusted-data framing,
 *   routing-not-confidentiality disclosure present
 * - board feature disabled / runtime held → visible refusals
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiwiFSAdapter } from "../src/backend/adapter.ts";
import { createFakeServer } from "./fake-mcp-server.ts";
import { identityRedactor } from "../src/backend/guard.ts";
import { DurableOutbox } from "../src/outbox/store.ts";
import { OutboxWorker } from "../src/outbox/worker.ts";
import { createObservationSender } from "../src/observation/sender.ts";
import {
  buildBoardReadTool,
  buildBoardListTool,
  buildBoardSendTool,
  type BoardRuntime,
  type BoardToolsDeps,
} from "../src/board/tools.ts";
import { parseBoardMessage } from "../src/board/messages.ts";

const URL_ = "https://kiwifs.test/mcp";
const BASE_MS = Date.parse("2026-02-01T00:00:00Z");

type ToolResult = { content: { type: string; text: string }[] };
type AnyTool = {
  execute: (
    toolCallId: string,
    params: never,
    signal?: AbortSignal,
    ...rest: never[]
  ) => Promise<ToolResult>;
};

async function runTool(
  tool: AnyTool,
  params: Record<string, unknown>,
): Promise<string> {
  const result = await tool.execute("id", params as never);
  return result.content.map((c) => c.text).join("\n");
}

function makeEnv(opts: { redact?: BoardToolsDeps["redact"] } = {}) {
  const server = createFakeServer();
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-board-tools-"));
  const store = DurableOutbox.open(join(dir, "outbox"));
  const adapter = new KiwiFSAdapter({
    url: URL_,
    requestTimeoutMs: 250,
    fetchImpl: server.fetch,
    ledger: store.ledger(),
  });
  const runtime: BoardRuntime = {
    adapter,
    outbox: store,
    boardEnabled: true,
  };
  let offsetMs = 0;
  let envPrivate = false;
  const deps: BoardToolsDeps = {
    getRuntime: () => runtime,
    getHeldReason: () => undefined,
    privateMode: () => envPrivate,
    redact: opts.redact ?? identityRedactor,
    now: () => new Date(BASE_MS + offsetMs),
  };
  const sendTool = buildBoardSendTool(() => deps) as unknown as AnyTool;
  const listTool = buildBoardListTool(() => deps) as unknown as AnyTool;
  const readTool = buildBoardReadTool(() => deps) as unknown as AnyTool;
  const worker = new OutboxWorker({
    store,
    send: createObservationSender({
      scope: undefined, // board delivery must not require a project scope
      openBackend: async () => adapter,
    }),
    maxAttempts: 1,
  });
  return {
    server,
    store,
    adapter,
    worker,
    sendTool,
    listTool,
    readTool,
    runTool,
    advance: (ms: number) => {
      offsetMs += ms;
    },
    setPrivate: (v: boolean) => {
      envPrivate = v;
    },
    boardFiles: () =>
      [...server.state.store.keys()].filter((p) => p.startsWith("board/")),
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const SEND = {
  channel: "standup",
  from: "agent-a",
  to: "agent-b",
  body: "synthetic body content",
};

// ---------- send tool: durable enqueue + safe output ----------

test("send tool enqueues a durable job; opId and created persisted; output has safe ids only", async () => {
  const t = makeEnv();
  try {
    const out = await t.runTool(t.sendTool, SEND);
    assert.match(out, /queued/);
    assert.match(out, /msg_id=[0-9a-f]{16}/);
    assert.match(out, /path=board\/standup\//);
    // Routing-not-confidentiality disclosure is visible on every send.
    assert.match(out, /Routing labels only/);
    assert.match(out, /no per-path authorization/);
    // Safe output: the body content itself is never echoed back.
    assert.ok(!out.includes(SEND.body));
    // Job is durable with opId + created persisted BEFORE any side effect;
    // zero backend requests so far (the tool never sends on the wire).
    const jobs = t.store.pending();
    assert.equal(jobs.length, 1);
    const job = jobs[0]!;
    assert.equal(job.kind, "board-message");
    const payload = job.payload as Record<string, unknown>;
    assert.equal(payload.opId, job.opId);
    assert.equal(payload.channel, SEND.channel);
    assert.equal(payload.from, SEND.from);
    assert.equal(payload.to, SEND.to);
    assert.equal(payload.body, SEND.body);
    assert.equal(payload.created, "2026-02-01T00:00:00.000Z");
    assert.equal(t.server.state.requests.length, 0);
    assert.equal(t.boardFiles().length, 0);
  } finally {
    t.cleanup();
  }
});

test("send tool redaction gate fails closed before any queue byte", async () => {
  const t = makeEnv({
    redact: () => ({ ok: false, reason: "secret-shaped content" }),
  });
  try {
    const out = await t.runTool(t.sendTool, SEND);
    assert.match(out, /privacy gate/);
    assert.equal(t.store.pending().length, 0);
    assert.equal(t.boardFiles().length, 0);
  } finally {
    t.cleanup();
  }
});

test("secret-bearing body screened at enqueue (defense in depth) — nothing queued", async () => {
  const t = makeEnv();
  try {
    const out = await t.runTool(t.sendTool, {
      ...SEND,
      body: "token: sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ",
    });
    assert.match(out, /secret-bearing|refused/);
    assert.equal(t.store.pending().length, 0);
    assert.equal(t.boardFiles().length, 0);
  } finally {
    t.cleanup();
  }
});

// ---------- private mode / held runtime ----------

test("private mode: send enqueues nothing and list/read make zero backend requests", async () => {
  const t = makeEnv();
  try {
    t.setPrivate(true);
    const before = t.server.state.requests.length;
    assert.match(await t.runTool(t.sendTool, SEND), /private mode/);
    assert.equal(t.store.pending().length, 0);
    assert.match(
      await t.runTool(t.listTool, { channel: "standup" }),
      /private mode/,
    );
    assert.match(
      await t.runTool(t.readTool, {
        path: "board/standup/aaaaaaaaaaaaaaaa.md",
      }),
      /private mode/,
    );
    assert.equal(t.server.state.requests.length, before);
    assert.equal(t.boardFiles().length, 0);
  } finally {
    t.cleanup();
  }
});

test("held runtime and disabled board feature refuse visibly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-board-held-"));
  try {
    const store = DurableOutbox.open(join(dir, "outbox"));
    const held: BoardToolsDeps = {
      getRuntime: () => undefined,
      getHeldReason: () => "backend credential reference does not resolve",
      privateMode: () => false,
    };
    const out = await runTool(buildBoardSendTool(() => held) as AnyTool, SEND);
    assert.match(out, /held/);
    assert.match(out, /credential/);
    const disabled: BoardToolsDeps = {
      getRuntime: () => ({
        adapter: undefined as never,
        outbox: store,
        boardEnabled: false,
      }),
      getHeldReason: () => undefined,
      privateMode: () => false,
    };
    const out2 = await runTool(
      buildBoardSendTool(() => disabled) as AnyTool,
      SEND,
    );
    assert.match(out2, /disabled/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- outbox delivery integration ----------

test("worker tick delivers the queued board job; replayed tick stays one message", async () => {
  const t = makeEnv();
  try {
    const out = await t.runTool(t.sendTool, SEND);
    const path = /path=(\S+)/.exec(out)![1]!;
    const msgId = /msg_id=([0-9a-f]{16})/.exec(out)![1]!;
    await t.adapter.connect();
    const s1 = await t.worker.tick();
    assert.equal(s1.sent.length, 1);
    assert.equal(t.boardFiles().length, 1);
    assert.equal(t.boardFiles()[0], path);
    const raw = t.server.state.store.get(path)!;
    const parsed = parseBoardMessage(raw, new Date(BASE_MS + 1000));
    assert.ok(parsed.ok);
    assert.equal(parsed.message.frontmatter.id, msgId);
    assert.equal(
      parsed.message.frontmatter.created,
      "2026-02-01T00:00:00.000Z",
    );
    assert.equal(parsed.message.frontmatter.to, SEND.to);
    // Worker replay (crash between remote write and local ack): same path,
    // byte-identical content, no duplicate.
    const contentBefore = t.server.state.store.get(path);
    const s2 = await t.worker.tick();
    assert.ok(s2.sent.length === 0 || s2.pendingAck.length > 0);
    assert.equal(t.server.state.store.get(path), contentBefore);
    assert.equal(t.boardFiles().length, 1);
    // Job is acked after successful delivery (at-least-once + B2 no-op).
    assert.equal(t.store.pending().length, 0);
  } finally {
    t.cleanup();
  }
});

test("differing-content collision at the deterministic path → job quarantined, original intact", async () => {
  const t = makeEnv();
  try {
    const out = await t.runTool(t.sendTool, SEND);
    const path = /path=(\S+)/.exec(out)![1]!;
    await t.adapter.connect();
    // A previous partial write left DIFFERENT content at the deterministic
    // path (e.g. a crashed job from another payload). The tick must fail
    // closed: ConflictError → permanent failure → visible quarantine.
    t.server.state.store.set(path, "---\nid: other\n---\nforeign content\n");
    const seq = t.store.pending()[0]!.seq;
    const s = await t.worker.tick();
    assert.equal(s.sent.length, 0);
    assert.equal(s.quarantined.length, 1);
    const q = t.store.quarantined()[0]!;
    assert.equal(q.seq, seq);
    assert.match(q.lastError ?? "", /conflict|quarantin/i);
    // Nothing was overwritten: the foreign content at the path is intact
    // and the queued content was never written.
    const raw = t.server.state.store.get(path);
    assert.ok(raw!.includes("foreign content"));
    assert.ok(!raw!.includes(SEND.body));
    assert.equal(t.boardFiles().length, 1);
  } finally {
    t.cleanup();
  }
});

// ---------- list / read tools ----------

test("list tool returns client-side filtered paths with disclosure; bad channel refused without network", async () => {
  const t = makeEnv();
  try {
    const out = await t.runTool(t.sendTool, SEND);
    const path = /path=(\S+)/.exec(out)![1]!;
    await t.adapter.connect();
    const s = await t.worker.tick();
    assert.equal(s.sent.length, 1);
    const list = await t.runTool(t.listTool, {
      channel: "standup",
      to: "agent-b",
    });
    assert.ok(list.includes(path));
    assert.match(list, /Routing labels only/);
    // Path-grammar-invalid channel refused before any network I/O.
    const before = t.server.state.requests.length;
    const bad = await t.runTool(t.listTool, { channel: "../escape" });
    assert.match(bad, /refused/);
    assert.equal(t.server.state.requests.length, before);
  } finally {
    t.cleanup();
  }
});

test("read tool: untrusted framing, TTL client-side, includeExpired override, opaque body", async () => {
  const t = makeEnv();
  try {
    await t.runTool(t.sendTool, { ...SEND, ttlSeconds: 60 });
    await t.adapter.connect();
    await t.worker.tick();
    const path = t.boardFiles()[0]!;
    // Not yet expired (created = BASE_MS, ttl 60 s, still inside window).
    const fresh = await t.runTool(t.readTool, { path });
    assert.match(fresh, /UNTRUSTED DATA/);
    // Past the TTL: expired is a visible typed refusal (B5 — client-side).
    t.advance(61_000);
    const refused = await t.runTool(t.readTool, { path });
    assert.match(refused, /expired/);
    const ok = await t.runTool(t.readTool, { path, includeExpired: true });
    const out = ok;
    assert.match(out, /EXPIRED/);
    assert.match(out, /msg_id=[0-9a-f]{16}/);
    assert.ok(out.includes(SEND.body));
    assert.match(out, /Routing labels only/);
  } finally {
    t.cleanup();
  }
});

test("tool outputs never disclose credentials", async () => {
  const t = makeEnv();
  try {
    await t.runTool(t.sendTool, SEND);
    await t.adapter.connect();
    await t.worker.tick();
    const list = await t.runTool(t.listTool, { channel: "standup" });
    const read = await t.runTool(t.readTool, { path: t.boardFiles()[0]! });
    for (const out of [list, read]) {
      assert.ok(!/Bearer\s/i.test(out));
      assert.ok(!/api[_-]?key/i.test(out));
    }
  } finally {
    t.cleanup();
  }
});
