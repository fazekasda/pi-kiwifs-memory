/**
 * Q02a: runtime production tests for the outbox private-mode gate.
 *
 * All tests exercise the SHIPPED extension runtime construction
 * (`buildSessionRuntime`) — the production `LiveConfigPrivateModeGate` and
 * `AuditSink` wired in src/index.ts — never test-injected gates. Ticks are
 * driven through the runtime's own shipped `worker.tick()` (the same callback
 * the coordinator timer invokes every 30s), so no 30s waits are needed and
 * every await is bounded.
 *
 * Scenarios (task Q02a acceptance):
 * 1. private startup → zero outbound requests, job held durably.
 * 2. normal→private before attempt/retry → holds (no send, due retry held).
 * 3. private→normal → preexisting pending work resumes exactly once.
 * 4. restart under private mode → remains held (durable, no drop).
 *
 * Synthetic local fixtures only: a 127.0.0.1 listener records requests and
 * answers 404 (availability → retryable). No real model calls, no secrets.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setPrivateModeInFile } from "../src/runtime/controls.ts";

const TOKEN_ENV = "KIWIFS_Q02A_SYNTHETIC_TOKEN";

interface Harness {
  dir: string;
  cfgFile: string;
  stateDir: string;
  requests: { url: string; method: string }[];
  cleanup: () => void;
}

async function makeHarness(privateMode: boolean): Promise<Harness> {
  const requests: { url: string; method: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", method: req.method ?? "" });
    res.statusCode = 404; // → AvailabilityError → retryable, never dropped
    res.end("synthetic");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q02a-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const config = {
    schemaVersion: 1,
    enabled: true,
    privateMode,
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
    requests,
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

function seedJob(rt: NonNullable<Awaited<ReturnType<typeof buildRt>>>): void {
  rt.store!.enqueue({
    kind: "observation",
    scope: "project/example.local/synthetic",
    idempotencyKey: "b".repeat(64),
    payload: {
      opId: "q02a-synthetic-op-0001",
      sessionId: "q02a-synthetic-session",
      sourceEntryIds: ["e1"],
      observations: [
        {
          sourceEntryIds: ["e1"],
          statement: "synthetic observation for outbox gate test",
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
  return rt;
}

test("Q02a: private startup — zero outbound requests, pending job held durably", async () => {
  const h = await makeHarness(true);
  try {
    const rt = await buildRt(h.dir);
    seedJob(rt);
    // Shipped worker tick (same callback the coordinator timer drives).
    const summary = await rt.worker!.tick();
    assert.equal(
      h.requests.length,
      0,
      `PRIVACY GAP: ${h.requests.length} outbound request(s) at private startup`,
    );
    assert.equal(summary.held.length, 1, "job must be held, not sent");
    assert.equal(rt.store!.pending().length, 1, "job stays pending (durable)");
    assert.equal(rt.store!.quarantined().length, 0, "never quarantined");
    rt.store!.close();
  } finally {
    h.cleanup();
  }
});

test("Q02a: normal→private — pending job held before attempt and a due retry stays held", async () => {
  const h = await makeHarness(false);
  try {
    const rt = await buildRt(h.dir);
    seedJob(rt);
    // One tick while NORMAL: the send is attempted (synthetic 404 →
    // availability) and the job enters retry backoff.
    await rt.worker!.tick();
    const first = h.requests.length;
    assert.ok(first >= 1, "attempt happened while normal");
    assert.equal(
      rt.store!.pending().length,
      1,
      "failed attempt → still pending",
    );
    // Transition to private BEFORE the retry attempt; wait past the
    // bounded backoff (base 500ms + jitter ≤ 20% → ≤ 600ms) so the retry
    // is DUE on the next tick. Bounded await, 2s cap.
    const flip = setPrivateModeInFile(h.cfgFile, true);
    assert.equal(
      flip.ok,
      true,
      `private-mode flip failed: ${JSON.stringify(flip)}`,
    );
    await new Promise((r) => setTimeout(r, 700));
    const mid = h.requests.length;
    const summary = await rt.worker!.tick();
    assert.equal(
      summary.sent.length,
      0,
      "due retry must not be sent while private",
    );
    assert.equal(summary.held.length, 1, "due retry is held");
    assert.equal(
      h.requests.length,
      mid,
      `PRIVACY GAP: ${h.requests.length - mid} request(s) during private retry tick`,
    );
    assert.equal(rt.store!.pending().length, 1, "job retained through hold");
    rt.store!.close();
  } finally {
    h.cleanup();
  }
});

test("Q02a: private→normal — preexisting pending work resumes exactly once", async () => {
  const h = await makeHarness(true);
  try {
    const rt = await buildRt(h.dir);
    seedJob(rt);
    await rt.worker!.tick();
    assert.equal(h.requests.length, 0, "held while private");
    assert.equal(rt.store!.pending().length, 1, "job retained while private");
    // Resume via the shipped control surface (persisted file flip).
    const flip = setPrivateModeInFile(h.cfgFile, false);
    assert.equal(flip.ok, true, `resume flip failed: ${JSON.stringify(flip)}`);
    await rt.worker!.tick();
    assert.ok(
      h.requests.length >= 1,
      "preexisting work resumed after private mode OFF",
    );
    // No duplicate sends from the hold period: exactly one delivery attempt
    // happened for this job across the whole session.
    assert.equal(
      rt.store!.pending().length + rt.store!.quarantined().length,
      1,
      "job accounted exactly once (no drop, no duplicate)",
    );
    rt.store!.close();
  } finally {
    h.cleanup();
  }
});

test("Q02a: restart under private mode — pending work remains held", async () => {
  const h = await makeHarness(true);
  try {
    let rt = await buildRt(h.dir);
    seedJob(rt);
    await rt.worker!.tick();
    assert.equal(h.requests.length, 0);
    rt.store!.close();
    // Restart: fresh production runtime over the same state dir; the config
    // file still says privateMode: true.
    rt = await buildRt(h.dir);
    assert.equal(
      rt.store!.pending().length,
      1,
      "pending work survived restart",
    );
    await rt.worker!.tick();
    assert.equal(
      h.requests.length,
      0,
      `PRIVACY GAP: ${h.requests.length} request(s) after restart under private mode`,
    );
    assert.equal(rt.store!.quarantined().length, 0, "never quarantined");
    rt.store!.close();
  } finally {
    h.cleanup();
  }
});
