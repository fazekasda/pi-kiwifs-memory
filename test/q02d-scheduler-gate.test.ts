/**
 * Q02 chunk 2: live private-mode gate wired into the PRODUCTION extraction/
 * reflection factories and the scheduler boundaries (settled/idle/manual/
 * precompact) — through `buildSessionRuntime`, not injected gates.
 *
 * Acceptance targets:
 * - Q01 Gap 2 witness flips green (no model call while private).
 * - Held pre-private pending batches survive the private period and resume
 *   on the next boundary after normal mode returns (no duplicates, no drops).
 * - Entries captured DURING private mode are classified private-session:
 *   consumed WITHOUT extraction, never replayed on resume (visible gap).
 * - In-flight extraction is cancelled best-effort on a transition (push via
 *   the runtime's shared live gate).
 *
 * Synthetic local fixtures only: fetch intercepted to a recorder, no real
 * model calls, temp config/state dirs, no secrets.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setPrivateModeInFile } from "../src/runtime/controls.ts";

const TOKEN_ENV = "KIWIFS_Q02D_SYNTHETIC_TOKEN";

interface Harness {
  dir: string;
  cfgFile: string;
  url: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q02d-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const config = {
    schemaVersion: 1,
    enabled: true,
    projectIdentity: "example.local/synthetic",
    mcp: {
      url: "http://127.0.0.1:1/mcp",
      auth: { kind: "env", ref: TOKEN_ENV },
    },
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
    url: config.mcp.url,
    cleanup() {
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

function entry(id: string, text: string) {
  return {
    id,
    role: "user" as const,
    text: text.repeat(120), // comfortably above batch thresholds
    timestamp: new Date(0).toISOString(),
  };
}

/** Installs a model-call recorder; returns { restore, modelCalls }. */
function interceptModelCalls() {
  const modelCalls: string[] = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("openrouter")) {
      modelCalls.push(`${init?.method ?? "GET"} ${url}`);
      // Synthetic 500: extraction fails cleanly, the batch stays pending.
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

async function drain(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

test("Q02: extractNow during private mode refuses NEW model calls (boundary gate)", async () => {
  const h = makeHarness();
  const calls = interceptModelCalls();
  try {
    const mod = await import("../src/index.ts");
    const rt = mod.buildSessionRuntime(h.dir);
    assert.ok(
      rt.observer,
      "observer must be built (enabled config + scope + auth)",
    );
    rt.observer!.setProvider({ entries: () => [entry("e1", "pre-private ")] });
    assert.equal(setPrivateModeInFile(h.cfgFile, true).ok, true);
    const summary = rt.observer!.extractNow();
    await drain();
    assert.equal(summary.scheduled, 0);
    assert.equal(summary.skippedReason, "private-mode");
    assert.deepEqual(calls.modelCalls, [], "zero model calls while private");
    assert.equal(rt.observer!.pendingBatches.length, 0, "no batch created");
    // Refusal does NOT classify: entries remain unprocessed for the next
    // settled/compact boundary (or post-resume extraction) to handle.
    assert.equal(rt.observer!.selectUnprocessed().length, 1);
  } finally {
    calls.restore();
    h.cleanup();
  }
});

test("Q02: settled boundary during private classifies private-period entries (never replayed on resume)", async () => {
  const h = makeHarness();
  const calls = interceptModelCalls();
  try {
    const mod = await import("../src/index.ts");
    const rt = mod.buildSessionRuntime(h.dir);
    assert.ok(rt.observer);
    // Entry already present BEFORE the transition.
    rt.observer!.setProvider({ entries: () => [entry("e1", "pre-private ")] });
    assert.equal(setPrivateModeInFile(h.cfgFile, true).ok, true);
    // Entry captured DURING private mode.
    rt.observer!.setProvider({
      entries: () => [
        entry("e1", "pre-private "),
        entry("e2", "private-period "),
      ],
    });
    const summary = rt.observer!.onAgentSettled();
    await drain();
    assert.equal(summary.scheduled, 0);
    assert.equal(summary.skippedReason, "private-mode");
    assert.deepEqual(calls.modelCalls, [], "zero model calls while private");
    // Classified private-session: consumed WITHOUT extraction.
    assert.equal(rt.coordinator.isConsumed("e2"), true);
    const status = rt.observer!.pendingStatus().join("\n");
    assert.match(status, /private mode classified private-session/);
    // Resume: normal mode restored, a NEW post-resume entry is extracted but
    // the private-period entry is NEVER selected again.
    assert.equal(setPrivateModeInFile(h.cfgFile, false).ok, true);
    rt.observer!.setProvider({
      entries: () => [
        entry("e1", "pre-private "),
        entry("e2", "private-period "),
        entry("e3", "post-resume "),
      ],
    });
    rt.observer!.extractNow();
    await drain();
    assert.ok(
      calls.modelCalls.length === 1,
      `expected exactly the post-resume batch to reach the model, got ${JSON.stringify(calls.modelCalls)}`,
    );
    const batchEntryIds = rt.observer!.pendingBatches.flatMap(
      (b) => b.entryIds,
    );
    assert.ok(
      !batchEntryIds.includes("e2"),
      "private-period entry never replayed",
    );
    assert.ok(!rt.observer!.selectUnprocessed().some((e) => e.id === "e2"));
  } finally {
    calls.restore();
    h.cleanup();
  }
});

test("Q02: precompact during private: no model call, entries classified, preexisting pending batches retained", async () => {
  const h = makeHarness();
  const calls = interceptModelCalls();
  try {
    const mod = await import("../src/index.ts");
    const rt = mod.buildSessionRuntime(h.dir);
    assert.ok(rt.observer);
    // Create a PRE-PRIVATE pending batch (500 → stays durably pending).
    rt.observer!.setProvider({ entries: () => [entry("e1", "pre-private ")] });
    rt.observer!.extractNow();
    await drain();
    assert.deepEqual(calls.modelCalls.length, 1);
    assert.equal(rt.observer!.pendingBatches.length, 1);
    const preOpId = rt.observer!.pendingBatches[0]!.opId;
    // Transition, then compact.
    assert.equal(setPrivateModeInFile(h.cfgFile, true).ok, true);
    rt.observer!.setProvider({
      entries: () => [
        entry("e1", "pre-private "),
        entry("e2", "private-period "),
      ],
    });
    const flush = await rt.observer!.onBeforeCompact();
    await drain();
    assert.equal(flush.flushed, false);
    assert.equal(flush.reason, "private-mode");
    assert.deepEqual(
      calls.modelCalls.length,
      1,
      "no NEW model call while private",
    );
    assert.equal(
      rt.coordinator.isConsumed("e2"),
      true,
      "private-period entry classified",
    );
    // Preexisting pending batch survived untouched (same opId, not dropped).
    assert.equal(rt.observer!.pendingBatches.length, 1);
    assert.equal(rt.observer!.pendingBatches[0]!.opId, preOpId);
    assert.equal(flush.pendingEntries, 1);
  } finally {
    calls.restore();
    h.cleanup();
  }
});

test("Q02: pre-private pending batch survives the private period and resumes after normal returns (no duplicates, no drops)", async () => {
  const h = makeHarness();
  const calls = interceptModelCalls();
  try {
    const mod = await import("../src/index.ts");
    const rt = mod.buildSessionRuntime(h.dir);
    assert.ok(rt.observer);
    rt.observer!.setProvider({ entries: () => [entry("e1", "pre-private ")] });
    rt.observer!.extractNow();
    await drain();
    assert.equal(rt.observer!.pendingBatches.length, 1);
    const opId = rt.observer!.pendingBatches[0]!.opId;
    // Private period: settle boundaries make no model calls, batch untouched.
    assert.equal(setPrivateModeInFile(h.cfgFile, true).ok, true);
    rt.observer!.setProvider({
      entries: () => [
        entry("e1", "pre-private "),
        entry("e2", "private-period "),
      ],
    });
    rt.observer!.onAgentSettled();
    await drain();
    assert.deepEqual(calls.modelCalls.length, 1);
    assert.equal(rt.observer!.pendingBatches.length, 1);
    assert.equal(rt.observer!.pendingBatches[0]!.opId, opId);
    // Resume: the SAME batch is retried under its ORIGINAL opId (no
    // duplicate observation, no drop). Clear the 500-failure retry cooldown
    // (test seam: pending records are metadata-visible) so the resume
    // boundary is due immediately.
    assert.equal(setPrivateModeInFile(h.cfgFile, false).ok, true);
    const beforeResume = calls.modelCalls.length;
    const pendingRecord = rt.observer!.pendingBatches[0];
    if (pendingRecord) pendingRecord.nextAttemptAt = 0;
    rt.observer!.onAgentSettled();
    await drain();
    assert.ok(
      calls.modelCalls.length === beforeResume + 1,
      `pre-private batch must be retried on resume, got ${JSON.stringify(calls.modelCalls)}`,
    );
    assert.equal(rt.observer!.pendingBatches.length, 1);
    assert.equal(
      rt.observer!.pendingBatches[0]!.opId,
      opId,
      "same opId — no duplicate",
    );
  } finally {
    calls.restore();
    h.cleanup();
  }
});

test("Q02: in-flight extraction cancelled on transition (push via the runtime's shared live gate)", async () => {
  const h = makeHarness();
  const prevFetch = globalThis.fetch;
  let releaseTransport: (() => void) | undefined;
  const transportEntered = new Promise<void>((resolve) => {
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("openrouter")) {
        resolve();
        // Real fetch semantics: the transport only rejects once the attempt's
        // AbortSignal fires (cancel hook) — like a hung provider call.
        await new Promise<void>((_, reject) => {
          releaseTransport = () => reject(new Error("aborted by cancel"));
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          );
        });
        return new Response("unreachable", { status: 500 });
      }
      return prevFetch(input as never, init as never);
    }) as typeof fetch;
  });
  try {
    const mod = await import("../src/index.ts");
    const rt = mod.buildSessionRuntime(h.dir);
    assert.ok(rt.observer);
    assert.ok(rt.liveGate, "production live gate must be exposed");
    rt.observer!.setProvider({ entries: () => [entry("e1", "in-flight ")] });
    const run = rt.observer!.extractNow();
    await transportEntered; // model attempt is in flight
    // Transition via the SHARED gate's cancel hook (the exact path the
    // command bridge exercises).
    assert.equal(setPrivateModeInFile(h.cfgFile, true).ok, true);
    rt.liveGate!.notifyTransition();
    const summary = await run;
    assert.equal(summary.scheduled, 1, "batch was created pre-transition");
    await drain();
    assert.equal(
      rt.observer!.pendingBatches.length,
      1,
      "cancelled batch stays durably pending",
    );
    assert.equal(rt.observer!.lastError, "ExtractionModelError");
  } finally {
    releaseTransport?.();
    globalThis.fetch = prevFetch;
    h.cleanup();
  }
});
