/**
 * Q06B2: lifecycle integration/ownership regressions for the extracted
 * runtime (src/runtime/session.ts) exercised through the ACTUAL Pi hook
 * wiring (`registerSessionHandlers` + shipped `buildSessionRuntime`) —
 * never test-injected gates or hand-built resources.
 *
 * Scenarios:
 * 1. Session-scoped ownership: `session_shutdown` releases the runtime so
 *    the next session in the SAME process rebuilds — the audit lock is
 *    re-owned (single-owner close), and the shared private-mode gate is
 *    replaced (the disposed gate's cancel subscribers must never fire for a
 *    later session's transition; the fresh gate's must).
 * 2. Idempotent teardown + retained outbox: double `session_shutdown` is
 *    harmless; private-mode-held jobs stay pending (never dropped, never
 *    duplicated, never quarantined) across teardown.
 * 3. Partial initialization: held domains (unresolved scope / unresolvable
 *    credential) tear down cleanly — only what was actually built is
 *    disposed, the audit lock is released, and a fresh runtime re-acquires.
 * 4. Stale tokenizer callback: a previous session's async tokenizer-attach
 *    note must never surface through status after a session switch.
 *
 * Synthetic local fixtures only: 127.0.0.1 listener (404s), synthetic env
 * token, temp config/state dirs. No real model calls, no secrets.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as index from "../src/index.ts";
import { setPrivateModeInFile } from "../src/runtime/controls.ts";

const TOKEN_ENV = "KIWIFS_Q06B2_SYNTHETIC_TOKEN";

interface Harness {
  dir: string;
  cfgFile: string;
  stateDir: string;
  requests: { url: string; method: string }[];
  server: Server;
  writeConfig: (cfg: unknown) => void;
  setPrivate: (value: boolean) => void;
  cleanup: () => void;
}

async function makeHarness(privateMode: boolean): Promise<Harness> {
  const requests: { url: string; method: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", method: req.method ?? "" });
    res.statusCode = 404; // availability gap → retryable, never dropped
    res.end("synthetic");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q06b2-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const config = {
    schemaVersion: 1,
    enabled: true,
    privateMode,
    projectIdentity: "example.local/synthetic",
    mcp: {
      url: `http://127.0.0.1:${port}/mcp`,
      auth: { kind: "env", ref: TOKEN_ENV },
    },
    model: {
      route: "openrouter/z-ai/glm-5.3-flash",
      auth: { kind: "env", ref: TOKEN_ENV },
    },
    features: { observation: true, backup: false, board: true },
    board: { consumerId: "agent-q06b2" },
  };
  writeFileSync(cfgFile, JSON.stringify(config));
  process.env["KIWIFS_MEMORY_CONFIG"] = cfgFile;
  process.env["KIWIFS_MEMORY_STATE_DIR"] = stateDir;
  process.env[TOKEN_ENV] = "synthetic-token-value";
  return {
    dir,
    cfgFile,
    stateDir,
    requests,
    server,
    writeConfig(cfg: unknown) {
      writeFileSync(cfgFile, JSON.stringify(cfg));
    },
    setPrivate(value: boolean) {
      const r = setPrivateModeInFile(cfgFile, value);
      assert.ok(r.ok, `setPrivateModeInFile failed: ${r.ok ? "" : r.reason}`);
    },
    cleanup() {
      server.close();
      delete process.env["KIWIFS_MEMORY_CONFIG"];
      delete process.env["KIWIFS_MEMORY_STATE_DIR"];
      delete process.env[TOKEN_ENV];
    },
  };
}

/** Capture-API wiring: real shipped handlers + shipped runtime factory. */
function wire(h: Harness) {
  const handlers = new Map<
    string,
    (event?: unknown, ctx?: unknown) => unknown
  >();
  const fakePi = {
    registerCommand: () => {},
    registerTool: () => {},
    on: (name: string, fn: (event?: unknown, ctx?: unknown) => unknown) =>
      handlers.set(name, fn),
  };
  const box = index.registerSessionHandlers(fakePi as never, (cwd: string) =>
    index.buildSessionRuntime(cwd),
  );
  const ctx = () => ({
    cwd: h.dir,
    sessionManager: {
      getSessionId: () => "q06b2-synthetic-session",
      getLeafId: () => "leaf-1",
      getEntries: () => [],
    },
  });
  const fire = async (name: string) => {
    await handlers.get(name)?.({}, ctx());
  };
  return { handlers, box, ctx, fire };
}

const BASE_CFG = {
  schemaVersion: 1,
  enabled: true,
  privateMode: false,
  projectIdentity: "example.local/synthetic",
  mcp: {
    url: "http://127.0.0.1:9/mcp",
    auth: { kind: "env", ref: TOKEN_ENV },
  },
  model: {
    route: "openrouter/z-ai/glm-5.3-flash",
    auth: { kind: "env", ref: TOKEN_ENV },
  },
  features: { observation: true, backup: false, board: false },
};

function seedJob(
  rt: NonNullable<ReturnType<typeof index.buildSessionRuntime>>,
) {
  rt.store!.enqueue({
    kind: "observation",
    scope: "project/example.local/synthetic",
    idempotencyKey: "c".repeat(64),
    payload: {
      opId: "q06b2-synthetic-op-0001",
      sessionId: "q06b2-synthetic-session",
      sourceEntryIds: ["e1"],
      observations: [
        {
          sourceEntryIds: ["e1"],
          statement: "synthetic observation for lifecycle regression",
          uncertainty: "low",
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Session-scoped ownership: shutdown releases, next session rebuilds
// ---------------------------------------------------------------------------

test("Q06B2: shutdown releases runtime ownership — next session re-owns the audit lock and gets a live gate", async () => {
  const h = await makeHarness(false);
  try {
    // Drive through the wiring (the shipped ownership path).
    const wired = wire(h);
    await wired.fire("session_start");
    const first = wired.box.getRuntime(h.dir)!;
    assert.ok(first, "runtime built at session_start");
    assert.equal(
      first.audit.status().lock,
      "owned",
      "audit lock owned during session 1",
    );
    // A pre-shutdown cancel subscriber belongs to the dead session.
    const staleFired: string[] = [];
    first.liveGate!.onCancel(() => staleFired.push("stale"));
    // Teardown.
    await wired.fire("session_shutdown");
    assert.equal(
      first.audit.status().lock,
      "unavailable",
      "audit lock released at teardown (single-owner close)",
    );
    // Session 2 in the SAME process: runtime must be rebuilt, not reused.
    await wired.fire("session_start");
    const second = wired.box.getRuntime(h.dir)!;
    assert.ok(second, "runtime available for session 2");
    assert.notEqual(
      second,
      first,
      "SESSION OWNERSHIP GAP: same runtime instance reused after shutdown — disposed gate/audit lock would be permanent",
    );
    assert.notEqual(second.audit, first.audit);
    assert.notEqual(
      second.liveGate,
      first.liveGate,
      "stale shared gate reused across sessions",
    );
    assert.equal(
      second.audit.status().lock,
      "owned",
      "fresh audit store re-acquires the single-owner lock",
    );
    // Session 2's gate is live: a private-mode transition fires its cancel
    // subscribers (the model-cancel seam).
    const fired: string[] = [];
    second.liveGate!.onCancel((reason) => fired.push(reason));
    h.setPrivate(true);
    second.liveGate!.notifyTransition();
    assert.equal(
      fired.length,
      1,
      "live gate of the NEW session must fire cancel on transition",
    );
    // The disposed session-1 gate must never fire again.
    await wired.fire("session_shutdown");
    assert.equal(
      staleFired.length,
      0,
      "disposed gate never fires stale cancel",
    );
    await wired.fire("session_shutdown");
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Idempotent teardown; held outbox retained
// ---------------------------------------------------------------------------

test("Q06B2: teardown is idempotent and private-held outbox work is retained", async () => {
  const h = await makeHarness(true);
  try {
    const wired = wire(h);
    await wired.fire("session_start");
    const rt = wired.box.getRuntime(h.dir)!;
    assert.ok(rt.worker && rt.store);
    seedJob(rt);
    const summary = await rt.worker!.tick();
    assert.equal(h.requests.length, 0, "private mode: zero outbound requests");
    assert.equal(summary.held.length, 1, "job held by the shipped gate");
    assert.equal(rt.store!.pending().length, 1);
    assert.equal(rt.store!.pending().length, 1, "held job pending at teardown");
    // Double teardown: idempotent, never throws. The durable journal is
    // closed (lock released) but retains every pending job.
    await wired.fire("session_shutdown");
    await wired.fire("session_shutdown");
    assert.equal(rt.coordinator.timerRunning, false, "tick timer stopped");
    // A fresh session over the same state dir sees the same single pending
    // job — no duplicates, no silent drop.
    const rt2 = index.buildSessionRuntime(h.dir);
    assert.equal(
      rt2.store!.pending().length,
      1,
      "job survives across sessions",
    );
    const s2 = await rt2.worker!.tick();
    assert.equal(h.requests.length, 0, "still private: still zero requests");
    assert.equal(s2.held.length, 1, "still held exactly once (no duplicates)");
    rt2.store!.close();
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Partial initialization: held domains clean up safely
// ---------------------------------------------------------------------------

test("Q06B2: partial initialization — only constructed resources are disposed; fresh runtime re-acquires the audit lock", async () => {
  const h = await makeHarness(true);
  try {
    // Credential reference points at an env var that does not resolve →
    // retrieval/delivery held; no projectIdentity and a git-less cwd →
    // scope unresolved → observer/backup held. Only store/worker/gate/
    // audit/coordinator are actually constructed.
    delete process.env[TOKEN_ENV];
    h.writeConfig({
      ...BASE_CFG,
      projectIdentity: undefined,
      mcp: {
        url: "http://127.0.0.1:9/mcp",
        auth: { kind: "env", ref: TOKEN_ENV },
      },
    });
    const wired = wire(h);
    await wired.fire("session_start");
    const rt = wired.box.getRuntime(h.dir)!;
    assert.equal(rt.observer, undefined, "scope unresolved: observer held");
    assert.equal(
      rt.retrieval,
      undefined,
      "credential unresolvable: retrieval held",
    );
    assert.equal(
      rt.delivery,
      undefined,
      "credential unresolvable: delivery held",
    );
    assert.equal(rt.backup, undefined, "scope unresolved: backup held");
    assert.ok(rt.worker && rt.store, "outbox pipeline still constructed");
    assert.equal(rt.audit.status().lock, "owned");
    // Double teardown over a partially-built runtime: no throw.
    await wired.fire("session_shutdown");
    await wired.fire("session_shutdown");
    assert.equal(rt.audit.status().lock, "unavailable", "lock released");
    // A fresh runtime re-acquires the lock.
    const rt2 = index.buildSessionRuntime(h.dir);
    assert.equal(rt2.audit.status().lock, "owned", "lock re-acquired");
    rt2.store!.close();
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Stale tokenizer callback across a session switch
// ---------------------------------------------------------------------------

test("Q06B2: a previous session's async tokenizer note never surfaces after a session switch", async () => {
  const h = await makeHarness(false);
  // Delayed tokenizer module: top-level await holds the attach note back
  // until AFTER session 2 has started.
  const tokDir = mkdtempSync(join(tmpdir(), "kiwifs-q06b2-tok-"));
  const tokModule = join(tokDir, "slow-tokenizer.mjs");
  writeFileSync(
    tokModule,
    `await new Promise((r) => setTimeout(r, 250));
export const tokenizer = { id: "q06b2-stale-tokenizer", countTokens: () => 1 };`,
  );
  try {
    const cfgA = {
      ...BASE_CFG,
      budgets: { tokenizer: { module: tokModule } },
    };
    h.writeConfig(cfgA);
    const wired = wire(h);
    await wired.fire("session_start");
    const rt1 = wired.box.getRuntime(h.dir)!;
    // Switch sessions while session 1's tokenizer load is still in flight.
    await wired.fire("session_shutdown");
    h.writeConfig({ ...BASE_CFG }); // session 2: no tokenizer configured
    await wired.fire("session_start");
    const rt2 = wired.box.getRuntime(h.dir)!;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(
      rt2.tokenizerNote,
      undefined,
      "stale attach note from session 1 leaked into session 2",
    );
    assert.equal(
      rt2.tokenizerDegraded,
      false,
      "degradation flag not poisoned by the stale callback",
    );
    const text = index.resolveStatusText();
    assert.doesNotMatch(text, /q06b2-stale-tokenizer/);
    // Teardown.
    await wired.fire("session_shutdown");
  } finally {
    h.cleanup();
  }
});
