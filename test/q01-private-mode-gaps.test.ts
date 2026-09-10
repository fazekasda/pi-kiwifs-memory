/**
 * Q01: bounded local reproduction of audit defects through PRODUCTION
 * composition (buildSessionRuntime), not safer injected gates.
 *
 * Defect hypotheses (prior audit, HEAD 4e4b06e):
 * 1. OutboxWorker is constructed without a production PrivateModeGate →
 *    pending outbox jobs are delivered over the network while private mode
 *    is ON.
 * 2. The observation scheduler/extractor has no private-mode gate →
 *    extractNow() attempts a model call while private mode is ON.
 *
 * These tests are EXPECTED FAILING on HEAD until Q06 fixes production.
 * No test skips, no inverted claims. Synthetic local fixtures only: a
 * 127.0.0.1 listener records requests; the model fetch is intercepted and
 * recorded (never a real model call). No secrets.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setPrivateModeInFile } from "../src/runtime/controls.ts";

const TOKEN_ENV = "KIWIFS_Q01_SYNTHETIC_TOKEN";

interface Harness {
  dir: string;
  cfgFile: string;
  server: Server;
  requests: { url: string; method: string }[];
  url: string;
  cleanup: () => void;
}

/** Synthetic 127.0.0.1 listener that records every request (fail-closed 404). */
async function makeListener(): Promise<Harness> {
  const requests: { url: string; method: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", method: req.method ?? "" });
    res.statusCode = 404;
    res.end("synthetic");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q01-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const config = {
    schemaVersion: 1,
    enabled: true,
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
    server,
    requests,
    url,
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

test("Q01: private mode does not hold outbox delivery (worker lacks production gate)", async () => {
  const h = await makeListener();
  try {
    const mod = await import("../src/index.ts");
    const rt = mod.buildSessionRuntime(h.dir);
    assert.ok(rt.store, "runtime outbox store must exist");
    // Seed one pending observation job in the PRODUCTION durable outbox.
    rt.store!.enqueue({
      kind: "observation",
      scope: "project/example.local/synthetic",
      idempotencyKey: "a".repeat(64),
      payload: {
        opId: "q01-synthetic-op-0001",
        sessionId: "q01-synthetic-session",
        sourceEntryIds: ["e1"],
        observations: [
          {
            sourceEntryIds: ["e1"],
            statement: "synthetic observation for repro",
            uncertainty: "low",
          },
        ],
      },
    });
    // Start the session through the SHIPPED coordinator path — this is what
    // arms the production outbox tick timer (30s default interval).
    rt.coordinator.onSessionStart(
      {
        cwd: h.dir,
        sessionManager: {
          getSessionId: () => "q01-synthetic-session",
          getLeafId: () => null,
        },
      } as never,
      { reason: "startup" } as never,
    );
    assert.equal(rt.coordinator.timerRunning, true, "tick timer armed");
    // Flip private mode ON via the SHIPPED control surface (persisted file).
    const r = setPrivateModeInFile(h.cfgFile, true);
    assert.equal(r.ok, true, `private-mode flip failed: ${JSON.stringify(r)}`);
    // Production tick driver is ONLY the coordinator timer (30s default).
    // Bounded await: one tick, hard cap 40s, then close.
    const sawRequest = new Promise<boolean>((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (h.requests.length > 0) {
          clearInterval(iv);
          resolve(true);
        } else if (Date.now() - t0 > 40_000) {
          clearInterval(iv);
          resolve(false);
        }
      }, 250);
    });
    const sentDuringPrivate = await sawRequest;
    rt.coordinator.onShutdown(); // stop the coordinator tick timer
    rt.store!.close();
    // DESIRED: private mode holds the job; zero backend requests.
    // ACTUAL (HEAD): the coordinator tick delivered the job → this fails.
    assert.equal(
      sentDuringPrivate,
      false,
      `PRIVACY GAP: outbox worker delivered ${h.requests.length} request(s) while private mode was ON (production worker has no gate): ${JSON.stringify(h.requests)}`,
    );
  } finally {
    h.cleanup();
  }
});

test("Q01: extraction runs the model while private mode is ON (scheduler unguarded)", async () => {
  const h = await makeListener();
  const prevFetch = globalThis.fetch;
  const modelCalls: string[] = [];
  // Intercept ALL fetch during extractNow: model requests are recorded, never
  // sent to the real endpoint. Returns a synthetic 500 so extraction fails
  // cleanly (the batch stays pending — which is fine for the repro).
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("openrouter")) {
      modelCalls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response("synthetic-error", { status: 500 });
    }
    return prevFetch(input as never, init as never);
  }) as typeof fetch;
  try {
    const mod = await import("../src/index.ts");
    const rt = mod.buildSessionRuntime(h.dir);
    assert.ok(
      rt.observer,
      "observer must be built (enabled config + scope + model auth)",
    );
    // Same provider adapter shape index.ts installs; synthetic entries.
    rt.observer!.setProvider({
      entries: () => [
        {
          id: "q01-e1",
          role: "user",
          text: "synthetic session content for repro ".repeat(80),
          timestamp: new Date(0).toISOString(),
        },
      ],
    });
    const flip = setPrivateModeInFile(h.cfgFile, true);
    assert.equal(
      flip.ok,
      true,
      `private-mode flip failed: ${JSON.stringify(flip)}`,
    );
    // Shipped manual extraction path (same pipeline as /kiwifs-extract-now).
    rt.observer!.extractNow();
    // Bounded drain so the intercepted fetch actually fires.
    await new Promise((r) => setTimeout(r, 250));
    // DESIRED: private mode refuses NEW model calls → zero model requests.
    // ACTUAL (HEAD): the scheduler attempted the openrouter call → fails.
    assert.deepEqual(
      modelCalls,
      [],
      `PRIVACY GAP: scheduler attempted ${modelCalls.length} model call(s) while private mode was ON: ${JSON.stringify(modelCalls)}`,
    );
  } finally {
    globalThis.fetch = prevFetch;
    h.cleanup();
  }
});
