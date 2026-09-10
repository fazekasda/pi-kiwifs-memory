/**
 * Q06C1: status-ownership extraction regressions
 * (src/runtime/status.ts + src/runtime/session.ts).
 *
 * Scenarios:
 * 1. UI status degradation still surfaced after the extraction: a FAILING
 *    configured tokenizer surfaces its note AND the structured degraded flag
 *    through `resolveStatusText` (state: degraded) — driven through the
 *    ACTUAL `registerSessionHandlers` wiring, never test-injected probes.
 * 2. A successful tokenizer attach surfaces a non-degraded note.
 * 3. Initialized/stopped state: after `session_start` the runtime-derived
 *    probes are live; after `session_shutdown` the runtime is released and
 *    the stale probes no longer report session state.
 * 4. Held state: an unresolvable credential surfaces the retryable hold via
 *    the runtime-derived retrieval note (state: degraded).
 * 5. Stale session callbacks: a previous session's late tokenizer note never
 *    surfaces through status after a session switch (sink-orphan fix: the
 *    note is runtime-owned; no sink exists to leak through).
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
import {
  computeOverallState,
  resolveStatusText,
  setTokenizerDegradedProbe,
  setTokenizerNoteProbe,
  STATUS_MESSAGE,
} from "../src/runtime/status.ts";

const TOKEN_ENV = "KIWIFS_Q06C1_SYNTHETIC_TOKEN";

interface Harness {
  dir: string;
  cfgFile: string;
  stateDir: string;
  server: Server;
  writeConfig: (cfg: unknown) => void;
  cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
  const server = createServer((req, res) => {
    void req;
    res.statusCode = 404; // availability gap → retryable, never dropped
    res.end("synthetic");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q06c1-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const config = {
    schemaVersion: 1,
    enabled: true,
    privateMode: false,
    projectIdentity: "example.local/synthetic",
    mcp: {
      url: `http://127.0.0.1:${port}/mcp`,
      auth: { kind: "env", ref: TOKEN_ENV },
    },
    model: {
      route: "openrouter/z-ai/glm-5.3-flash",
      auth: { kind: "env", ref: TOKEN_ENV },
    },
    features: { observation: true, backup: false, board: false },
  };
  writeFileSync(cfgFile, JSON.stringify(config));
  process.env["KIWIFS_MEMORY_CONFIG"] = cfgFile;
  process.env["KIWIFS_MEMORY_STATE_DIR"] = stateDir;
  process.env[TOKEN_ENV] = "synthetic-token-value";
  return {
    dir,
    cfgFile,
    stateDir,
    server,
    writeConfig(cfg: unknown) {
      writeFileSync(cfgFile, JSON.stringify(cfg));
    },
    cleanup() {
      server.close();
      delete process.env["KIWIFS_MEMORY_CONFIG"];
      delete process.env["KIWIFS_MEMORY_STATE_DIR"];
      delete process.env[TOKEN_ENV];
    },
  };
}

const BASE_CFG = {
  schemaVersion: 1,
  enabled: true,
  privateMode: false,
  projectIdentity: "example.local/synthetic",
  mcp: { url: "http://127.0.0.1:9/mcp", auth: { kind: "env", ref: TOKEN_ENV } },
  model: {
    route: "openrouter/z-ai/glm-5.3-flash",
    auth: { kind: "env", ref: TOKEN_ENV },
  },
  features: { observation: true, backup: false, board: false },
};

/** Real shipped wiring: registerSessionHandlers + shipped runtime factory. */
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
      getSessionId: () => "q06c1-synthetic-session",
      getLeafId: () => "leaf-1",
      getEntries: () => [],
    },
  });
  const fire = async (name: string) => {
    await handlers.get(name)?.({}, ctx());
  };
  return { box, fire };
}

test("Q06C1: computeOverallState precedence via the extracted status module", () => {
  const base = {
    configOk: true,
    enabled: true,
    privateMode: false,
    degradedNotes: [] as string[],
    quarantined: 0,
  };
  assert.equal(computeOverallState(base), "healthy");
  assert.equal(computeOverallState({ ...base, quarantined: 1 }), "degraded");
  assert.equal(computeOverallState({ ...base, privateMode: true }), "private");
  assert.equal(computeOverallState({ ...base, enabled: false }), "disabled");
  assert.equal(computeOverallState({ ...base, configOk: false }), "disabled");
  assert.equal(STATUS_MESSAGE, "KiwiFS memory extension loaded.");
});

test("Q06C1: a failing configured tokenizer still degrades the shipped status surface", async () => {
  const h = await makeHarness();
  const tokDir = mkdtempSync(join(tmpdir(), "kiwifs-q06c1-tok-"));
  // Malformed tokenizer module → load fails closed (visible, degraded).
  writeFileSync(
    join(tokDir, "bad-tokenizer.mjs"),
    `export const tokenizer = { id: "" };`,
  );
  try {
    h.writeConfig({
      ...BASE_CFG,
      budgets: { tokenizer: { module: join(tokDir, "bad-tokenizer.mjs") } },
    });
    const wired = wire(h);
    await wired.fire("session_start");
    const rt = wired.box.getRuntime(h.dir)!;
    assert.ok(rt, "runtime built at session_start");
    await new Promise((r) => setTimeout(r, 150));
    assert.match(rt.tokenizerNote ?? "", /automatic injection stays skipped/);
    assert.equal(rt.tokenizerDegraded, true, "structured degradation flag set");
    const text = index.resolveStatusText();
    assert.match(text, /tokenizer: automatic injection stays skipped/);
    assert.match(text, /state: degraded/);
    await wired.fire("session_shutdown");
  } finally {
    h.cleanup();
  }
});

test("Q06C1: a successful tokenizer attach surfaces a non-degraded note", async () => {
  const h = await makeHarness();
  const tokDir = mkdtempSync(join(tmpdir(), "kiwifs-q06c1-tok-ok-"));
  writeFileSync(
    join(tokDir, "ok-tokenizer.mjs"),
    `export const tokenizer = { id: "q06c1-ok", countTokens: (t) => t.length };`,
  );
  try {
    h.writeConfig({
      ...BASE_CFG,
      budgets: { tokenizer: { module: join(tokDir, "ok-tokenizer.mjs") } },
    });
    const wired = wire(h);
    await wired.fire("session_start");
    const rt = wired.box.getRuntime(h.dir)!;
    await new Promise((r) => setTimeout(r, 150));
    assert.match(rt.tokenizerNote ?? "", /tokenizer attached \(q06c1-ok\)/);
    assert.equal(rt.tokenizerDegraded, false);
    const text = index.resolveStatusText();
    assert.match(text, /tokenizer: model-compatible tokenizer attached/);
    assert.doesNotMatch(text, /state: degraded/);
    await wired.fire("session_shutdown");
  } finally {
    h.cleanup();
  }
});

test("Q06C1: initialized → stopped — the runtime-derived probes release with the session", async () => {
  const h = await makeHarness();
  try {
    const wired = wire(h);
    await wired.fire("session_start");
    const rt = wired.box.getRuntime(h.dir)!;
    assert.ok(rt);
    await wired.fire("session_shutdown");
    assert.equal(
      rt.audit.status().lock,
      "unavailable",
      "audit lock released at teardown (session-scoped ownership)",
    );
    // A later status render still works and no longer reports session state.
    const text = index.resolveStatusText();
    assert.match(text, /state: (healthy|disabled|private|degraded)/);
  } finally {
    h.cleanup();
  }
});

test("Q06C1: held state — unresolvable credential surfaces the retryable hold via the runtime probe", async () => {
  const h = await makeHarness();
  try {
    process.env[TOKEN_ENV] = "";
    h.writeConfig(BASE_CFG);
    const wired = wire(h);
    await wired.fire("session_start");
    const rt = wired.box.getRuntime(h.dir)!;
    assert.equal(rt.retrieval, undefined, "retrieval held");
    assert.match(rt.retrievalHeldReason ?? "", /does not resolve/);
    const text = index.resolveStatusText();
    assert.match(text, /retrieval: degraded — .*does not resolve/);
    assert.match(text, /state: degraded/);
    await wired.fire("session_shutdown");
  } finally {
    process.env[TOKEN_ENV] = "synthetic-token-value";
    h.cleanup();
  }
});

test("Q06C1: stale session callbacks — a previous session's late tokenizer note never surfaces", async () => {
  const h = await makeHarness();
  const tokDir = mkdtempSync(join(tmpdir(), "kiwifs-q06c1-tok-stale-"));
  // Delayed module: the attach note lands only AFTER session 2 started.
  writeFileSync(
    join(tokDir, "slow-tokenizer.mjs"),
    `await new Promise((r) => setTimeout(r, 250));
export const tokenizer = { id: "q06c1-stale-tokenizer", countTokens: () => 1 };`,
  );
  try {
    h.writeConfig({
      ...BASE_CFG,
      budgets: { tokenizer: { module: join(tokDir, "slow-tokenizer.mjs") } },
    });
    const wired = wire(h);
    await wired.fire("session_start");
    const rt1 = wired.box.getRuntime(h.dir)!;
    await wired.fire("session_shutdown");
    h.writeConfig(BASE_CFG); // session 2: no tokenizer configured
    await wired.fire("session_start");
    const rt2 = wired.box.getRuntime(h.dir)!;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(rt2.tokenizerNote, undefined, "no stale note in session 2");
    assert.equal(rt2.tokenizerDegraded, false);
    assert.doesNotMatch(index.resolveStatusText(), /q06c1-stale-tokenizer/);
    // Session 1's own runtime still owns its note (never a shared global).
    assert.match(rt1.tokenizerNote ?? "", /q06c1-stale-tokenizer/);
    await wired.fire("session_shutdown");
  } finally {
    h.cleanup();
  }
});

test("Q06C1: the migrated inspection seams still work through the extracted module", async () => {
  const h = await makeHarness();
  try {
    // A valid config in effect so the state line reflects the probes.
    const wired = wire(h);
    await wired.fire("session_start");
    setTokenizerNoteProbe(() => "automatic injection stays skipped — x");
    setTokenizerDegradedProbe(() => true);
    assert.match(index.resolveStatusText(), /state: degraded/);
    assert.match(index.resolveStatusText(), /tokenizer: automatic injection/);
    setTokenizerDegradedProbe(() => false);
    assert.doesNotMatch(index.resolveStatusText(), /state: degraded/);
    // index re-exports remain intact for the existing public API consumers.
    assert.equal(typeof index.setTokenizerNoteProbe, "function");
    assert.equal(typeof index.setCoordinatorErrorProbe, "function");
    await wired.fire("session_shutdown");
  } finally {
    setTokenizerNoteProbe(undefined);
    setTokenizerDegradedProbe(undefined);
    h.cleanup();
  }
});
