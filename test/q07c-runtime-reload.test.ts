/**
 * Q07C: production runtime reload — the single live-config owner wired into
 * the SHIPPED runtime/controls/status/commands, plus the enqueue-time
 * delivery-target pin (Q07A §3 queue-hazard contract).
 *
 * Acceptance demonstrations (Q07 evidence contract a–e, Q07C slice):
 * - production reload sequence through buildSessionRuntime + the shipped
 *   worker: INVALID config ⇒ fail-closed hold (zero requests); then
 *   valid+private ⇒ held (zero requests); then public ⇒ delivered exactly
 *   once under the original opId.
 * - snapshot changes mid-session (endpoint edit) do NOT reconfigure the
 *   running runtime: delivery keeps flowing to the ORIGINAL loopback target;
 *   the edited target receives nothing.
 * - session rebuild with a CHANGED endpoint ⇒ retained pinned job HELD
 *   (zero requests to the new target, never dropped, never quarantined);
 *   rebuild with the RESTORED config ⇒ delivered exactly once, original
 *   opId. Same for a changed record scope. Same-ref credential rotation ⇒
 *   delivery proceeds. Legacy fingerprint-less job ⇒ unchanged behavior
 *   (documented Q07A §3 additive default).
 * - status truthfulness: status text distinguishes live vs snapshot
 *   settings and never claims snapshot fields apply live.
 *
 * Synthetic only: credential-isolated 127.0.0.1 loopback listeners (the
 * audited fake-provider harness pattern from q02a), temp config files
 * (mode 0600), throwaway env, no live service, no real model calls, no
 * secrets, no real endpoints.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { after, describe, it } from "node:test";
import { buildSessionRuntime } from "../src/index.ts";
import { resolveStatusText } from "../src/runtime/status.ts";
import { setPrivateModeInFile } from "../src/runtime/controls.ts";
import { createFakeServer } from "./fake-mcp-server.ts";

const TOKEN_ENV = "KIWIFS_Q07C_SYNTHETIC_TOKEN";

interface Loopback {
  url: string;
  /** URLs of requests that reached this target (delivery evidence). */
  requests: string[];
  close: () => Promise<void>;
}

/**
 * Credential-isolated 127.0.0.1 loopback that fronts the AUDITED fake
 * provider (fake-mcp-server.ts, the same in-process fake the T04/T17 suites
 * use) with a real HTTP listener — the shipped runtime's global fetch must
 * reach it, so no fetchImpl injection exists here. No live service, no real
 * model calls, no secrets.
 */
async function startLoopback(): Promise<Loopback> {
  const fake = createFakeServer();
  const requests: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push(req.url ?? "");
      const body = Buffer.concat(chunks).toString("utf8");
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
      const init: RequestInit = {
        method: req.method ?? "GET",
        headers,
        ...(body !== "" ? { body } : {}),
      };
      void fake
        .fetch(`http://127.0.0.1${req.url}`, init)
        .then(async (r: Response) => {
          const text = await r.text();
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(text);
        })
        .catch(() => {
          res.writeHead(500);
          res.end("{}");
        });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function writeConfig(
  cfgFile: string,
  overrides: Record<string, unknown>,
): void {
  const base = {
    schemaVersion: 1,
    enabled: true,
    privateMode: false,
    projectIdentity: "example.local/q07c",
    mcp: {
      url: "http://127.0.0.1:1/mcp",
      auth: { kind: "env", ref: TOKEN_ENV },
    },
    model: {
      route: "openrouter/z-ai/glm-5.3-flash",
      auth: { kind: "env", ref: TOKEN_ENV },
    },
  };
  writeFileSync(cfgFile, JSON.stringify({ ...base, ...overrides }), {
    mode: 0o600,
  });
}

interface Env {
  dir: string;
  cfgFile: string;
  stateDir: string;
  write: (text: string) => void;
  restore: () => void;
}

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q07c-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeConfig(cfgFile, {});
  process.env["KIWIFS_MEMORY_CONFIG"] = cfgFile;
  process.env["KIWIFS_MEMORY_STATE_DIR"] = stateDir;
  process.env[TOKEN_ENV] = "synthetic-token-value";
  return {
    dir,
    cfgFile,
    stateDir,
    write: (text: string) => writeFileSync(cfgFile, text, { mode: 0o600 }),
    restore: () => {
      delete process.env["KIWIFS_MEMORY_CONFIG"];
      delete process.env["KIWIFS_MEMORY_STATE_DIR"];
      delete process.env[TOKEN_ENV];
    },
  };
}

function seedJob(
  rt: ReturnType<typeof buildSessionRuntime>,
  opId = "11111111-1111-4111-8111-111111111111",
): void {
  rt.store!.enqueue({
    kind: "observation",
    scope: "project/example.local/q07c",
    idempotencyKey: "c".repeat(64),
    // The payload opId must equal the persisted job opId (sender validation),
    // so the caller-supplied opId rides the SAME durable write (T16 shape).
    opId,
    payload: {
      opId,
      sessionId: "q07c-synthetic-session",
      sourceEntryIds: ["e1"],
      observations: [
        {
          sourceEntryIds: ["e1"],
          statement: "synthetic q07c observation",
          uncertainty: "low",
        },
      ],
    },
  });
}

/** Teardown a runtime exactly like session_shutdown (index.ts order). */
function teardown(rt: ReturnType<typeof buildSessionRuntime>): void {
  rt.observer?.dispose();
  rt.liveGate?.dispose();
  try {
    rt.audit?.close();
  } catch {
    /* best effort */
  }
  rt.coordinator.onShutdown();
  try {
    rt.store?.close();
  } catch {
    /* best effort */
  }
}

describe("Q07C: production reload sequence (invalid → private → public)", () => {
  it("fails closed on invalid config, holds under private, delivers exactly once on public", async () => {
    const env = makeEnv();
    const target = await startLoopback();
    try {
      writeConfig(env.cfgFile, {
        mcp: { url: target.url, auth: { kind: "env", ref: TOKEN_ENV } },
      });
      const rt = buildSessionRuntime(env.dir);
      assert.ok(rt.worker && rt.store);
      seedJob(rt);
      // (1) INVALID: unparseable config ⇒ every live gate fails closed.
      env.write("{ this is not json");
      const s1 = await rt.worker.tick();
      assert.equal(target.requests.length, 0, "invalid config: zero requests");
      assert.equal(s1.sent.length, 0);
      assert.equal(s1.held.length, 1, "held, not dropped");
      assert.equal(rt.store.pending().length, 1);
      // (2) VALID + PRIVATE: config valid again, private mode persisted.
      writeConfig(env.cfgFile, {
        mcp: { url: target.url, auth: { kind: "env", ref: TOKEN_ENV } },
        privateMode: true,
      });
      const s2 = await rt.worker.tick();
      assert.equal(target.requests.length, 0, "private: zero requests");
      assert.equal(s2.held.length, 1);
      assert.equal(rt.store.pending().length, 1);
      // (3) PUBLIC: private flag cleared ⇒ the same pending job delivers
      // exactly once under the original opId (no cached permit, no loss).
      writeConfig(env.cfgFile, {
        mcp: { url: target.url, auth: { kind: "env", ref: TOKEN_ENV } },
      });
      const s3 = await rt.worker.tick();
      assert.equal(s3.sent.length, 1, "delivered on the public boundary");
      assert.equal(rt.store.pending().length, 0);
      assert.equal(rt.store.quarantined().length, 0);
      assert.ok(target.requests.length >= 1, "delivery reached the target");
      assert.equal(
        rt.store.hasOpId("11111111-1111-4111-8111-111111111111"),
        true,
      );
      teardown(rt);
    } finally {
      env.restore();
      await target.close();
    }
  });
});

describe("Q07C: snapshot changes mid-session (no invented live reconfiguration)", () => {
  it("keeps delivery on the ORIGINAL endpoint while the config file changes", async () => {
    const env = makeEnv();
    const original = await startLoopback();
    const edited = await startLoopback();
    try {
      writeConfig(env.cfgFile, {
        mcp: { url: original.url, auth: { kind: "env", ref: TOKEN_ENV } },
      });
      const rt = buildSessionRuntime(env.dir);
      assert.ok(rt.worker && rt.store);
      seedJob(rt);
      // Mid-session edit of snapshot settings (endpoint + budgets).
      writeConfig(env.cfgFile, {
        mcp: { url: edited.url, auth: { kind: "env", ref: TOKEN_ENV } },
        budgets: { ragDeadlineMs: 1234, evidenceTokenCap: 42 },
      });
      const s = await rt.worker.tick();
      assert.equal(s.sent.length, 1);
      assert.ok(
        original.requests.length >= 1,
        "snapshot endpoint unchanged: delivery flowed to the ORIGINAL target",
      );
      assert.equal(
        edited.requests.length,
        0,
        "the edited (next-session) endpoint received nothing",
      );
      teardown(rt);
    } finally {
      env.restore();
      await original.close();
      await edited.close();
    }
  });
});

describe("Q07C: session rebuild — retained jobs are never redirected", () => {
  it("holds pinned jobs on an endpoint change; restored config delivers exactly once", async () => {
    const env = makeEnv();
    const a = await startLoopback();
    const b = await startLoopback();
    try {
      writeConfig(env.cfgFile, {
        mcp: { url: a.url, auth: { kind: "env", ref: TOKEN_ENV } },
      });
      const rt1 = buildSessionRuntime(env.dir);
      seedJob(rt1, "22222222-2222-4222-8222-22222222222a");
      teardown(rt1); // session boundary; the durable outbox keeps the job
      // Rebuild against a CHANGED endpoint.
      writeConfig(env.cfgFile, {
        mcp: { url: b.url, auth: { kind: "env", ref: TOKEN_ENV } },
      });
      const rt2 = buildSessionRuntime(env.dir);
      assert.ok(rt2.worker && rt2.store);
      const s = await rt2.worker.tick();
      assert.equal(s.held.length, 1, "retained job HELD, not rerouted");
      assert.equal(
        b.requests.length,
        0,
        "zero requests to the NEW target (no reroute)",
      );
      assert.equal(rt2.store.pending().length, 1, "never dropped");
      assert.equal(rt2.store.quarantined().length, 0, "never quarantined");
      teardown(rt2);
      // Restore the ORIGINAL config: same target ⇒ delivery proceeds,
      // exactly once, under the original opId.
      writeConfig(env.cfgFile, {
        mcp: { url: a.url, auth: { kind: "env", ref: TOKEN_ENV } },
      });
      const rt3 = buildSessionRuntime(env.dir);
      const s3 = await rt3.worker!.tick();
      assert.equal(s3.sent.length, 1);
      assert.ok(a.requests.length >= 1, "delivery reached the ORIGINAL target");
      assert.equal(b.requests.length, 0);
      teardown(rt3);
    } finally {
      env.restore();
      await a.close();
      await b.close();
    }
  });

  it("holds pinned jobs on a record-scope change (no silent scope reinterpretation)", async () => {
    const env = makeEnv();
    const target = await startLoopback();
    try {
      writeConfig(env.cfgFile, {
        mcp: { url: target.url, auth: { kind: "env", ref: TOKEN_ENV } },
        projectIdentity: "example.local/q07c",
      });
      const rt1 = buildSessionRuntime(env.dir);
      seedJob(rt1, "22222222-2222-4222-8222-22222222222b");
      teardown(rt1);
      // Scope change across the rebuild.
      writeConfig(env.cfgFile, {
        mcp: { url: target.url, auth: { kind: "env", ref: TOKEN_ENV } },
        projectIdentity: "example.local/q07c-other",
      });
      const rt2 = buildSessionRuntime(env.dir);
      const s = await rt2.worker!.tick();
      assert.equal(s.sent.length, 0, "scope change: nothing delivered");
      assert.equal(s.held.length, 1, "held visibly");
      assert.equal(target.requests.length, 0);
      assert.equal(rt2.store!.pending().length, 1);
      teardown(rt2);
    } finally {
      env.restore();
      await target.close();
    }
  });

  it("delivers when only the credential VALUE rotates (same ref identity)", async () => {
    const env = makeEnv();
    const target = await startLoopback();
    try {
      writeConfig(env.cfgFile, {
        mcp: { url: target.url, auth: { kind: "env", ref: TOKEN_ENV } },
      });
      const rt1 = buildSessionRuntime(env.dir);
      seedJob(rt1, "22222222-2222-4222-8222-22222222222c");
      teardown(rt1);
      process.env[TOKEN_ENV] = "rotated-synthetic-value"; // value-only change
      const rt2 = buildSessionRuntime(env.dir);
      const s = await rt2.worker!.tick();
      assert.equal(s.sent.length, 1, "same ref/url rotation delivers");
      assert.ok(target.requests.length >= 1);
      teardown(rt2);
    } finally {
      env.restore();
      await target.close();
    }
  });

  it("legacy fingerprint-less job keeps today's behavior (additive default)", async () => {
    const env = makeEnv();
    const a = await startLoopback();
    const b = await startLoopback();
    try {
      writeConfig(env.cfgFile, {
        mcp: { url: a.url, auth: { kind: "env", ref: TOKEN_ENV } },
      });
      // Craft a PRE-Q07C journal entry (no `target` field) directly, then
      // rebuild against a changed endpoint.
      const jobsFile = join(env.stateDir, "outbox", "jobs.jsonl");
      mkdirSync(join(env.stateDir, "outbox"), { recursive: true });
      const legacy = {
        seq: 1,
        schemaVersion: 1,
        kind: "observation",
        scope: "project/example.local/q07c",
        opId: "33333333-3333-4333-8333-333333333333",
        idempotencyKey: "d".repeat(64),
        payload: {
          opId: "33333333-3333-4333-8333-333333333333",
          sessionId: "q07c-synthetic-session",
          sourceEntryIds: ["e1"],
          observations: [
            {
              sourceEntryIds: ["e1"],
              statement: "legacy fingerprint-less observation",
              uncertainty: "low",
            },
          ],
        },
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: Date.now(),
        status: "pending",
      };
      writeFileSync(jobsFile, JSON.stringify(legacy) + "\n", { mode: 0o600 });
      writeConfig(env.cfgFile, {
        mcp: { url: b.url, auth: { kind: "env", ref: TOKEN_ENV } },
      });
      const rt = buildSessionRuntime(env.dir);
      const s = await rt.worker!.tick();
      assert.equal(s.sent.length, 1, "legacy job delivers as today");
      teardown(rt);
    } finally {
      env.restore();
      await a.close();
      await b.close();
    }
  });
});

describe("Q07C: status truthfulness (live vs snapshot)", () => {
  it("status text distinguishes live settings from the session snapshot", () => {
    const env = makeEnv();
    try {
      const text = resolveStatusText();
      assert.match(
        text,
        /private mode and command admission \(enabled\) are live/,
      );
      assert.match(
        text,
        /session snapshot — changes apply at the next session/,
      );
      // Never claims everything is live.
      assert.ok(!text.includes("all settings live"));
    } finally {
      env.restore();
    }
  });

  it("status renders invalid config fail-closed through the single owner", () => {
    const env = makeEnv();
    try {
      env.write("{ broken");
      const text = resolveStatusText();
      assert.match(text, /config: INVALID — extension disabled/);
    } finally {
      env.restore();
    }
  });
});
