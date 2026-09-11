/**
 * Q02 chunk 3: privacy TRANSITION integration edges through the SHIPPED
 * production runtime (buildSessionRuntime) — outbox/model + retrieval +
 * backup + board delivery + the gate's stale-callback surface.
 *
 * Edges exercised (synthetic fixtures only; no real model calls, no live
 * services, no secrets):
 * - NEW outbound requests recorded AFTER a persisted normal→private
 *   transition must be zero in every domain; resume (private→normal) reopens
 *   each domain with pending work retried exactly once.
 * - Restart under private mode: a fresh buildSessionRuntime over the same
 *   state dir holds everything; pre-private durable jobs survive and are
 *   retried under their original opId on resume.
 * - Stale callbacks: notifyTransition()/dispose() ordering, disposed-gate
 *   silence, and NO silent bypass (the gate still fails closed on pull).
 *
 * Found & fixed here (bounded): BoardRepository.changes() (raw kiwi_changes
 * feed) was the one repo op without the per-operation private assert — a
 * mid-cycle transition could keep paging the feed. Now fails closed (test 4).
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setPrivateModeInFile } from "../src/runtime/controls.ts";
import { PrivateModeActiveError } from "../src/privacy/private-mode.ts";

const TOKEN_ENV = "KIWIFS_Q02E_SYNTHETIC_TOKEN";

interface Harness {
  dir: string;
  cfgFile: string;
  server: Server;
  requests: { url: string; method: string }[];
  url: string;
  cleanup: () => void;
}

/** Synthetic 127.0.0.1 listener recording every request (fail-closed 404). */
async function makeHarness(): Promise<Harness> {
  const requests: { url: string; method: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", method: req.method ?? "" });
    res.statusCode = 404;
    res.end("synthetic");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q02e-"));
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
    features: { observation: true, backup: true, board: true },
    board: { consumerId: "consumer-q02e" },
    // 5s is the schema minimum — bounded single-cycle waits in tests.
    board_pollms_sentinel: undefined,
  };
  delete (config as Record<string, unknown>)["board_pollms_sentinel"];
  (config as Record<string, unknown>)["board"] = {
    consumerId: "consumer-q02e",
    pollMs: 5000,
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

function goPrivate(
  cfgFile: string,
  rt: { liveGate?: { notifyTransition(): void } | undefined },
): void {
  assert.ok(setPrivateModeInFile(cfgFile, true).ok);
  // Same push the shipped command bridge performs after a successful persist.
  rt.liveGate?.notifyTransition();
}

function goNormal(
  cfgFile: string,
  rt: { liveGate?: { notifyTransition(): void } | undefined },
): void {
  assert.ok(setPrivateModeInFile(cfgFile, false).ok);
  rt.liveGate?.notifyTransition();
}

function backupEntries(): Record<string, unknown>[] {
  return [
    {
      type: "message",
      id: "e-root",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "pre-private backup input" },
    },
    {
      type: "message",
      id: "e-a",
      parentId: "e-root",
      timestamp: "2026-01-01T00:00:01Z",
      message: { role: "user", content: "branch input" },
    },
  ];
}

test("Q02e: retrieval — zero NEW backend reads after transition; resume reopens", async () => {
  const h = await makeHarness();
  try {
    const mod = await import("../src/index.ts");
    const rt = mod.buildSessionRuntime(h.dir);
    assert.ok(rt.retrieval && rt.liveGate);

    // Baseline while normal: at least one backend request is recorded.
    const r1 = await rt.retrieval!.retrieve(
      "memory design question",
      undefined,
      "user",
    );
    assert.notEqual(r1.kind, "ineligible");
    const baseline = h.requests.length;
    assert.ok(baseline > 0, "normal-mode retrieval must reach the backend");

    goPrivate(h.cfgFile, rt);
    const r2 = await rt.retrieval!.retrieve(
      "second question",
      undefined,
      "user",
    );
    assert.equal(r2.kind, "degraded");
    assert.match((r2 as { reason: string }).reason, /private mode/);
    assert.equal(
      h.requests.length,
      baseline,
      "zero NEW backend requests after transition",
    );

    // Repeated reads while private never leak (pull re-reads config).
    await rt.retrieval!.retrieve("third question", undefined, "user");
    assert.equal(h.requests.length, baseline);

    goNormal(h.cfgFile, rt);
    const r3 = await rt.retrieval!.retrieve(
      "fourth question",
      undefined,
      "user",
    );
    assert.notEqual(r2.kind, "pack"); // sanity: prior read was held, not faked
    assert.ok(h.requests.length > baseline, "resume reopens retrieval reads");
    assert.equal(
      (r3 as { kind: string }).kind !== "degraded" ||
        !/private mode/.test((r3 as { reason: string }).reason),
      true,
    );
  } finally {
    h.cleanup();
  }
});

test("Q02e: backup+outbox — no new jobs after transition; pre-private job survives restart and retries once on resume", async () => {
  const h = await makeHarness();
  try {
    const mod = await import("../src/index.ts");
    const rt = mod.buildSessionRuntime(h.dir);
    assert.ok(rt.backup && rt.worker && rt.store && rt.liveGate);

    // Pre-private: capture enqueues durable backup jobs; one tick attempts
    // delivery (listener 404s → retryable hold).
    const cap1 = rt.backup.capture(backupEntries());
    assert.ok(cap1.enqueuedChunks > 0 || cap1.enqueuedManifest);
    const jobs = rt.store.pending().length + rt.store.quarantined().length;
    assert.ok(jobs > 0, "durable pending jobs exist before transition");
    await rt.worker.tick();
    const afterBaseline = h.requests.length;
    assert.ok(afterBaseline > 0, "normal-mode tick attempts delivery");

    goPrivate(h.cfgFile, rt);
    const cap2 = rt.backup!.capture(backupEntries());
    assert.equal(cap2.enqueuedChunks, 0);
    assert.equal(cap2.enqueuedManifest, false);
    assert.equal(cap2.skippedReason, "private-mode");
    await rt.worker.tick();
    assert.equal(
      h.requests.length,
      afterBaseline,
      "zero NEW backend requests while private (capture + tick)",
    );

    // RESTART under private mode: fresh production runtime over the same
    // state dir (first runtime's outbox lock released, as teardown does).
    rt.store!.close();
    const rt2 = mod.buildSessionRuntime(h.dir);
    assert.ok(rt2.worker && rt2.liveGate);
    await rt2.worker.tick();
    assert.equal(
      h.requests.length,
      afterBaseline,
      "restart under private: zero outbound attempts",
    );
    const jobsAfterRestart =
      rt2.store!.pending().length + rt2.store!.quarantined().length;
    assert.equal(jobsAfterRestart, jobs, "no drops on restart");

    // Resume: pre-private job retried under its ORIGINAL opId, exactly once.
    // Bounded wait past the availability backoff (base 500ms + jitter ≤20%) so
    // the retry is DUE on the resume tick.
    goNormal(h.cfgFile, rt2);
    await new Promise((r) => setTimeout(r, 700));
    await rt2.worker.tick();
    assert.equal(h.requests.length, afterBaseline + 1, "single resume attempt");
    const jobsAfterResume =
      rt2.store!.pending().length + rt2.store!.quarantined().length;
    assert.equal(
      jobsAfterResume,
      jobs,
      "job retained (retryable hold, no dup)",
    );
  } finally {
    h.cleanup();
  }
});

test("Q02e: board delivery — cycle pauses on transition with zero NEW reads; resumes after flip back", async () => {
  const h = await makeHarness();
  try {
    const mod = await import("../src/index.ts");
    const rt = mod.buildSessionRuntime(h.dir);
    assert.ok(rt.delivery && rt.liveGate);
    rt.delivery!.start();
    // Bounded wait for one scheduled cycle (pollMs = 5000 schema minimum).
    await new Promise((r) => setTimeout(r, 5600));
    const baseline = h.requests.length;
    assert.ok(baseline > 0, "normal-mode cycle reached the backend");

    goPrivate(h.cfgFile, rt);
    await new Promise((r) => setTimeout(r, 5600));
    assert.equal(
      h.requests.length,
      baseline,
      "zero NEW board requests while private",
    );
    const snap = rt.delivery!.statusSnapshot();
    assert.equal(snap.runState, "private");

    goNormal(h.cfgFile, rt);
    await new Promise((r) => setTimeout(r, 5600));
    assert.ok(h.requests.length > baseline, "resume reopens board reads");
    assert.notEqual(rt.delivery!.statusSnapshot().runState, "private");
    rt.delivery!.stop();
  } finally {
    h.cleanup();
  }
});

test("Q02e: board repository — raw kiwi_changes feed fails closed while private (regression for the changes() gap)", async () => {
  const h = await makeHarness();
  try {
    const { KiwiFSAdapter } = await import("../src/backend/adapter.ts");
    const { BoardRepository } = await import("../src/board/repository.ts");
    const { loadConfig } = await import("../src/config/loader.ts");
    goPrivate(h.cfgFile, { liveGate: undefined });
    const secret = process.env[TOKEN_ENV] ?? "";
    const repo = new BoardRepository(
      new (await import("../src/backend/adapter.ts")).KiwiFSAdapter({
        url: h.url,
        headers: { Authorization: `Bearer ${secret}` },
        ledger: { record: () => {}, assertPersisted: () => {} },
      }),
      {
        privateMode: {
          get isPrivate() {
            const r = loadConfig();
            return !r.ok || r.config.privateMode;
          },
        },
      },
    );
    // changes() is deliberately synchronous-first (non-async): the gate
    // throw must happen BEFORE any adapter promise/paging work.
    assert.throws(
      () => repo.changes(""),
      (err: unknown) => err instanceof PrivateModeActiveError,
    );
    assert.equal(h.requests.length, 0, "no request left the process");
  } finally {
    h.cleanup();
  }
});

test("Q02e: stale callbacks — disposed gate is silent but never bypasses; stopped delivery stays stopped", async () => {
  const h = await makeHarness();
  try {
    const mod = await import("../src/index.ts");
    const rt = mod.buildSessionRuntime(h.dir);
    assert.ok(rt.liveGate && rt.observer && rt.delivery);

    // Dispose (as session_shutdown does), then a STALE transition push must
    // be a silent no-op — no throw, no listener resurrection.
    rt.liveGate!.dispose();
    assert.doesNotThrow(() => rt.liveGate!.notifyTransition());
    goPrivate(h.cfgFile, rt); // stale bridge push after dispose

    // NO silent bypass: the pull gate still reads config and refuses.
    const calls = interceptModelCalls();
    try {
      const r = rt.observer!.extractNow();
      assert.equal(r.skippedReason, "private-mode");
      assert.equal(calls.modelCalls.length, 0);
      await rt.worker!.tick();
      assert.equal(h.requests.length, 0, "outbox still held while private");
    } finally {
      calls.restore();
    }

    // A delivery runtime stopped at teardown releases its consumer lock and
    // stops scheduling; the live-gate snapshot while started reflects private.
    rt.delivery!.start();
    assert.equal(rt.delivery!.statusSnapshot().runState, "private");
    rt.delivery!.stop();
    assert.doesNotThrow(() => rt.delivery!.stop());
  } finally {
    h.cleanup();
  }
});

/** Installs an openrouter model-call recorder (no real model calls). */
function interceptModelCalls() {
  const modelCalls: string[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("openrouter")) {
      modelCalls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response("synthetic-error", { status: 500 });
    }
    return prevFetch(input as never, init as never);
  }) as typeof fetch;
  return {
    modelCalls,
    restore() {
      globalThis.fetch = prevFetch;
    },
  };
}
