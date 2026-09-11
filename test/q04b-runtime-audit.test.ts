/**
 * Q04b acceptance: the DURABLE audit sink is instantiated in the SHIPPED
 * production composition (`buildSessionRuntime`) — not a test-injected
 * sink — and captures the outbox worker's delivery / retry / quarantine /
 * private-transition events as bounded, content-free JSONL under the state
 * dir. Also proves the sanitized visible audit-failure surface and the
 * single-owner lifecycle (shutdown releases the lock; a fresh runtime can
 * then own it again — no second-writer degradation from stale locks).
 *
 * Synthetic fixtures only: a 127.0.0.1 MCP listener (ok / HTTP 404 /
 * JSON-RPC error modes), no real model calls, no secrets, no private
 * sessions. All file access is local.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setPrivateModeInFile } from "../src/runtime/controls.ts";
import { FileAuditStore } from "../src/privacy/audit-store.ts";
import * as index from "../src/index.ts";

const TOKEN_ENV = "KIWIFS_Q04B_SYNTHETIC_TOKEN";

type ServerMode = "ok" | "http404" | "rpcError";

interface Harness {
  dir: string;
  cfgFile: string;
  stateDir: string;
  server: Server;
  setMode: (m: ServerMode) => void;
  cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
  let mode: ServerMode = "ok";
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
      let toolName = "";
      try {
        toolName = String(
          (JSON.parse(body) as { params?: { name?: unknown } }).params?.name ??
            "",
        );
      } catch {
        toolName = "";
      }
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
      if (toolName === "kiwi_read") {
        // Deterministic-path read-back: a fresh path is a typed missing READ.
        respond({
          jsonrpc: "2.0",
          id: rpcId,
          result: {
            isError: true,
            content: [{ type: "text", text: "not found: synthetic" }],
          },
        });
        return;
      }
      if (mode === "http404") {
        res.statusCode = 404;
        res.end("synthetic-404");
        return;
      }
      if (mode === "rpcError") {
        respond({
          jsonrpc: "2.0",
          id: rpcId,
          error: { code: -32601, message: "synthetic protocol error" },
        });
        return;
      }
      respond({
        jsonrpc: "2.0",
        id: rpcId,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q04b-"));
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
    stateDir,
    server,
    setMode: (m) => {
      mode = m;
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
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedJob(
  store: NonNullable<ReturnType<typeof index.buildSessionRuntime>["store"]>,
): void {
  const opId = randomUUID();
  store.enqueue({
    kind: "observation",
    scope: "project/example.local/synthetic",
    idempotencyKey:
      randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    opId,
    payload: {
      opId,
      sessionId: "q04b-synthetic-session",
      sourceEntryIds: ["e1"],
      observations: [
        {
          sourceEntryIds: ["e1"],
          statement: "synthetic audit wiring observation",
          uncertainty: "low",
        },
      ],
    },
  });
}

function readAuditLines(stateDir: string): Record<string, unknown>[] {
  const raw = readFileSync(join(stateDir, "audit.log"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const until = async (
  cond: () => boolean | Promise<boolean>,
  ms = 5000,
): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("bounded wait expired");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const ALLOWED_KEYS = new Set([
  "ts",
  "kind",
  "feature",
  "scope",
  "targetId",
  "byteCounts",
  "decision",
  "degraded",
  "snippet",
]);

function assertAllowlisted(line: Record<string, unknown>): void {
  for (const key of Object.keys(line)) {
    assert.ok(
      ALLOWED_KEYS.has(key),
      `audit line carries non-allowlisted key ${key}`,
    );
  }
}

test("Q04b: production composition instantiates the durable audit sink and audits sent/retry/quarantine/hold", async () => {
  const h = await makeHarness();
  try {
    const rt = index.buildSessionRuntime(h.dir);
    // REAL runtime wiring: the shipped worker holds the shipped durable
    // store (no manual injection anywhere in this test).
    assert.ok(rt.worker, "production outbox worker must exist");
    assert.ok(rt.audit instanceof FileAuditStore, "durable audit sink wired");

    // Delivery (sent): the sender completes against the synthetic listener.
    h.setMode("ok");
    seedJob(rt.store!);
    await rt.worker!.tick();
    await until(() => rt.audit.status().persisted >= 1);
    let lines = readAuditLines(h.stateDir);
    assert.ok(
      lines.some(
        (l) =>
          l["kind"] === "outbox" &&
          l["decision"] === "sent" &&
          l["scope"] === "project/example.local/synthetic",
      ),
      `expected a 'sent' audit line, got ${JSON.stringify(lines)}`,
    );
    for (const l of lines) assertAllowlisted(l);

    // Permanent failure → quarantine record (JSON-RPC protocol error is
    // non-retryable by design; production maxAttempts never exhausts).
    h.setMode("rpcError");
    seedJob(rt.store!);
    await rt.worker!.tick();
    await until(() => readAuditLines(h.stateDir).length >= lines.length + 1);
    lines = readAuditLines(h.stateDir);
    assert.ok(
      lines.some((l) => String(l["decision"]).startsWith("quarantined (")),
      `expected quarantined line, got ${JSON.stringify(lines)}`,
    );

    // Private transition: held jobs are audited, metadata-only.
    assert.equal(
      setPrivateModeInFile(h.cfgFile, true).ok,
      true,
      "private mode flip must persist",
    );
    seedJob(rt.store!);
    await rt.worker!.tick();
    await until(() =>
      readAuditLines(h.stateDir).some(
        (l) => l["decision"] === "held (private mode)",
      ),
    );
    lines = readAuditLines(h.stateDir);
    const heldLine = lines.find((l) => l["decision"] === "held (private mode)");
    assert.equal(heldLine?.["feature"], "observation");
    // The held job is still pending (never dropped, never acked).
    assert.ok(rt.store!.pending().length >= 1, "held job must stay pending");

    // Resume: explicit flip back; the next tick delivers (metadata 'sent').
    assert.equal(setPrivateModeInFile(h.cfgFile, false).ok, true);
    h.setMode("ok");
    await until(
      async () =>
        (await rt.worker!.tick()) &&
        rt.store!.pending().length === 0 &&
        readAuditLines(h.stateDir).filter((l) => l["decision"] === "sent")
          .length >= 2,
    );

    // Transient failure → retry line (availability 404 is retryable). This
    // phase runs LAST: the retried job stays in backoff and would otherwise
    // block the per-scope head during the private-hold phase above.
    h.setMode("http404");
    seedJob(rt.store!);
    await rt.worker!.tick();
    await until(() =>
      readAuditLines(h.stateDir).some((l) =>
        String(l["decision"]).startsWith("retry "),
      ),
    );
    lines = readAuditLines(h.stateDir);
    const retryLine = lines.find((l) =>
      String(l["decision"]).startsWith("retry "),
    );
    assert.equal(retryLine?.["degraded"], true);
    // No raw request/URL/response text may leak into audit lines.
    for (const l of lines) {
      const s = JSON.stringify(l);
      assert.ok(!s.includes("http://"), "audit line must not carry URLs");
      assert.ok(!s.includes("kiwifs-q04b"), "audit line must not carry paths");
    }
    rt.audit.close();
  } finally {
    h.cleanup();
  }
});

test("Q04b: audit sink failure degrades visibly in status, sanitized and content-free; shutdown releases the lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q04b-status-"));
  const cfg = {
    schemaVersion: 1,
    enabled: true,
    projectIdentity: "example.local/synthetic",
    mcp: {
      url: "http://127.0.0.1:9/mcp",
      auth: { kind: "env", ref: "KIWIFS_TEST_TOKEN" },
    },
    model: {
      route: "openrouter/z-ai/glm-5.3-flash",
      auth: { kind: "env", ref: "KIWIFS_TEST_TOKEN" },
    },
    features: { observation: true, backup: false, board: false },
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const prevCfg = process.env["KIWIFS_MEMORY_CONFIG"];
  const prevState = process.env["KIWIFS_MEMORY_STATE_DIR"];
  const prevToken = process.env["KIWIFS_TEST_TOKEN"];
  process.env["KIWIFS_MEMORY_CONFIG"] = join(dir, "config.json");
  process.env["KIWIFS_MEMORY_STATE_DIR"] = stateDir;
  process.env["KIWIFS_TEST_TOKEN"] = "test-token-value";
  try {
    const handlers = new Map<string, Function>();
    const fakePi = {
      registerCommand: () => {},
      registerTool: () => {},
      on: (name: string, fn: Function) => handlers.set(name, fn),
    };
    const box = index.registerSessionHandlers(fakePi as never, (cwd: string) =>
      index.buildSessionRuntime(cwd),
    );
    const wiringCtx = () => ({
      cwd: dir,
      sessionManager: {
        getSessionId: () => "sess-q04b",
        getSessionFile: () => "/tmp/sess-q04b.jsonl",
        getLeafId: () => null,
        getEntries: () => [],
      },
    });
    await handlers.get("session_start")!({}, wiringCtx());
    const rt = box.getRuntime(dir);
    assert.ok(rt, "runtime built by the shipped handler wiring");
    const audit = rt!.audit;
    assert.ok(audit instanceof FileAuditStore);
    // Silent while healthy.
    assert.ok(
      !index.resolveStatusText().includes("audit: DEGRADED"),
      "healthy audit sink must not show a degraded note",
    );
    // Force a sanitized failure: make the audit dir read-only so the append
    // fails with EACCES (real fault, local, no network).
    chmodSync(stateDir, 0o500);
    const ev = audit.record({ kind: "probe", decision: "probe write" });
    assert.equal(ev.degraded, true, "failed write must be flagged degraded");
    const status = audit.status();
    assert.equal(status.lastError, "EACCES");
    assert.equal(status.lock, "owned");
    // Status JSON is content-free: no paths, no reasons, no identifiers.
    const statusJson = JSON.stringify(status);
    assert.ok(!statusJson.includes(dir), "status must not carry paths");
    assert.ok(!statusJson.includes("probe"), "status must not carry payloads");
    chmodSync(stateDir, 0o700);
    const text = index.resolveStatusText();
    assert.match(
      text,
      /audit: DEGRADED — buffered=\d+ writeFailures=\d+ lastError=EACCES/,
    );
    assert.match(text, /state: degraded/);
    // Still content-free in the visible surface.
    assert.ok(!text.includes(dir), "status text must not carry paths");
    // Lifecycle: shutdown releases the lock (idempotent double-shutdown).
    await handlers.get("session_shutdown")!({}, wiringCtx());
    await handlers.get("session_shutdown")!({}, wiringCtx());
    assert.equal(audit.status().lock, "unavailable");
    // Single-owner handover: a FRESH runtime over the same state dir can own
    // the lock again and record (no stale-lock second-writer degradation).
    const rt2 = index.buildSessionRuntime(dir);
    assert.equal(rt2.audit.status().lock, "owned");
    const ev2 = rt2.audit.record({ kind: "probe2", decision: "handover" });
    assert.equal(ev2.degraded, undefined);
    rt2.audit.close();
  } finally {
    try {
      chmodSync(stateDir, 0o700);
    } catch {
      /* already restored */
    }
    if (prevCfg === undefined) delete process.env["KIWIFS_MEMORY_CONFIG"];
    else process.env["KIWIFS_MEMORY_CONFIG"] = prevCfg;
    if (prevState === undefined) delete process.env["KIWIFS_MEMORY_STATE_DIR"];
    else process.env["KIWIFS_MEMORY_STATE_DIR"] = prevState;
    if (prevToken === undefined) delete process.env["KIWIFS_TEST_TOKEN"];
    else process.env["KIWIFS_TEST_TOKEN"] = prevToken;
    rmSync(dir, { recursive: true, force: true });
  }
});
