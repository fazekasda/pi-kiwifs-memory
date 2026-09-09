/**
 * T08 acceptance tests: Pi session coordinator (PRD T08, architecture §3.3).
 *
 * Covers: startup / new session / resume / fork / branch navigation / reload
 * / shutdown; stale-generation rejection; shared-ancestor no-recapture;
 * duplicate delivery and repeated teardown; headless/RPC safety (no TUI
 * APIs); stale-work cancellation; periodic outbox tick + retention.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  GenerationAbortedError,
  SessionCoordinator,
  StateSchemaError,
} from "../src/pi/coordinator.ts";
import {
  buildSessionRuntime,
  registerSessionHandlers,
  resolveStatusText,
  setCoordinatorErrorProbe,
} from "../src/index.ts";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "kiwifs-coord-"));
}

function fakeCtx(
  sessionId: string,
  leafId: string | null,
): {
  cwd: string;
  sessionManager: {
    getSessionId: () => string;
    getSessionFile: () => string;
    getLeafId: () => string | null;
  };
} {
  return {
    cwd: "/proj",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getLeafId: () => leafId,
    },
  };
}

let dirs: string[] = [];
beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  setCoordinatorErrorProbe(undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshCoordinator(
  opts?: Partial<ConstructorParameters<typeof SessionCoordinator>[0]>,
): { coordinator: SessionCoordinator; dir: string } {
  const dir = tempStateDir();
  dirs.push(dir);
  return {
    coordinator: new SessionCoordinator({ stateDir: dir, ...opts }),
    dir,
  };
}

test("lifecycle: startup, new session, resume, fork, tree navigation, reload, shutdown", () => {
  const { coordinator } = freshCoordinator();

  // Startup
  const g0 = coordinator.onSessionStart(fakeCtx("s1", "leaf-a"), {
    reason: "startup",
  });
  assert.equal(g0, 1);
  assert.equal(coordinator.sessionId, "s1");
  assert.equal(coordinator.branchId, "leaf-a");

  // New session (Pi: session_before_switch → shutdown → start{reason:new})
  coordinator.onBeforeSwitch();
  coordinator.onShutdown();
  const g1 = coordinator.onSessionStart(fakeCtx("s2", "leaf-b"), {
    reason: "new",
  });
  assert.equal(g1, 2);
  assert.equal(coordinator.sessionId, "s2");

  // Resume the same session after shutdown
  coordinator.onShutdown();
  const g2 = coordinator.onSessionStart(fakeCtx("s2", "leaf-b"), {
    reason: "resume",
  });
  assert.equal(g2, 3);

  // Fork (Pi: before_fork → shutdown → start{reason:fork})
  coordinator.onBeforeFork();
  coordinator.onShutdown();
  const g3 = coordinator.onSessionStart(fakeCtx("s2", "leaf-fork"), {
    reason: "fork",
  });
  assert.equal(g3, 4);
  assert.equal(coordinator.branchId, "leaf-fork");

  // Branch navigation within the session (tree, no shutdown between)
  const g4 = coordinator.onTree(fakeCtx("s2", "leaf-c"), "leaf-fork", "leaf-c");
  assert.equal(g4, 5);
  assert.equal(coordinator.branchId, "leaf-c");

  // Reload (Pi: shutdown → start{reason:reload})
  coordinator.onShutdown();
  const g5 = coordinator.onSessionStart(fakeCtx("s2", "leaf-c"), {
    reason: "reload",
  });
  assert.equal(g5, 6);

  coordinator.onShutdown();
  assert.equal(coordinator.timerRunning, false);
});

test("delayed results from a previous generation cannot alter current context or cursors", () => {
  const { coordinator } = freshCoordinator();
  const g0 = coordinator.onSessionStart(fakeCtx("s1", "leaf-a"), {
    reason: "startup",
  });

  let cursorWrites = 0;
  // Navigate to a new branch: g0 becomes stale.
  coordinator.onTree(fakeCtx("s1", "leaf-b"), "leaf-a", "leaf-b");

  // Navigating BACK to the recorded leaf after appended messages (leaf moved
  // without a session_tree event) is still a genuine navigation: the pair
  // (oldLeafId, newLeafId) differs from the previous delivery, so it must
  // re-mint and the late result for the old generation stays discarded.
  const gBack = coordinator.onTree(fakeCtx("s1", "leaf-a"), "leaf-b", "leaf-a");
  assert.ok(gBack > g0);
  assert.equal(
    coordinator.applyIfCurrent(g0, () => assert.fail("stale applied"), "x"),
    false,
  );

  // A retrieval pack / cursor update computed for g0 arrives late.
  const appliedStale = coordinator.applyIfCurrent(
    g0,
    () => {
      cursorWrites += 1;
    },
    "stale-pack",
  );
  assert.equal(appliedStale, false);
  assert.equal(cursorWrites, 0);

  const gNow = coordinator.generation;
  const appliedFresh = coordinator.applyIfCurrent(
    gNow,
    (v) => {
      cursorWrites += 1;
      assert.equal(v, "fresh-pack");
    },
    "fresh-pack",
  );
  assert.equal(appliedFresh, true);
  assert.equal(cursorWrites, 1);
});

test("shared ancestor entries are not recaptured because a fork occurs", () => {
  const { coordinator, dir } = freshCoordinator();
  coordinator.onSessionStart(fakeCtx("s1", "leaf-a"), { reason: "startup" });
  coordinator.markConsumed(["e1", "e2"]);

  // Fork: before_fork → shutdown → start{reason:fork}. New generation,
  // same durable consumed registry — ancestors stay consumed.
  coordinator.onBeforeFork();
  coordinator.onShutdown();
  const g = coordinator.onSessionStart(fakeCtx("s1", "leaf-fork"), {
    reason: "fork",
  });
  assert.ok(g > 1);
  assert.equal(coordinator.isConsumed("e1"), true);
  assert.equal(coordinator.isConsumed("e2"), true);

  // Restart (new process / extension reload) reloads the registry too.
  const revived = new SessionCoordinator({ stateDir: dir });
  assert.equal(revived.isConsumed("e1"), true);
  assert.equal(revived.generation, g); // loaded durable counter, no mint yet
  const gNew = revived.onSessionStart(fakeCtx("s1", "leaf-a"), {
    reason: "startup",
  });
  assert.ok(gNew > g); // monotonic across restarts
  assert.equal(revived.isConsumed("e1"), true);
});

test("duplicate event delivery and repeated teardown are harmless", () => {
  const { coordinator } = freshCoordinator();
  const ctx = fakeCtx("s1", "leaf-a");
  const g0 = coordinator.onSessionStart(ctx, { reason: "startup" });

  // Duplicate session_start for the live session: no re-mint.
  const gAgain = coordinator.onSessionStart(ctx, { reason: "startup" });
  assert.equal(gAgain, g0);

  // Duplicate session_tree deliveries of the identical (old,new) pair: no re-mint.
  const gTree = coordinator.onTree(ctx, "leaf-a", "leaf-a");
  assert.equal(gTree, g0);
  const gTreeAgain = coordinator.onTree(ctx, "leaf-a", "leaf-a");
  assert.equal(gTreeAgain, g0);

  // Repeated teardown is a no-op.
  coordinator.onShutdown();
  coordinator.onShutdown();
  coordinator.onShutdown();
  assert.equal(coordinator.timerRunning, false);

  // And the session can be restarted cleanly afterwards.
  const g2 = coordinator.onSessionStart(ctx, { reason: "resume" });
  assert.ok(g2 > g0);
});

test("stale work is cancelled: tokens abort and runExclusive fails fast", () => {
  const { coordinator } = freshCoordinator();
  const g0 = coordinator.onSessionStart(fakeCtx("s1", "leaf-a"), {
    reason: "startup",
  });
  const token = coordinator.registerWork(g0);
  assert.equal(token.aborted, false);

  coordinator.onTree(fakeCtx("s1", "leaf-b"), "leaf-a", "leaf-b");
  assert.equal(token.aborted, true);

  // runExclusive on a stale generation throws immediately.
  assert.throws(
    () => coordinator.runExclusive(g0, () => "never"),
    GenerationAbortedError,
  );

  // Fresh generation work runs and its token is tracked then released.
  const gNow = coordinator.generation;
  const result = coordinator.runExclusive(gNow, (t) => {
    assert.equal(t.aborted, false);
    return 42;
  });
  assert.equal(result, 42);

  // Shutdown aborts remaining in-flight work.
  const t2 = coordinator.registerWork(coordinator.generation);
  coordinator.onShutdown();
  assert.equal(t2.aborted, true);
});

test("before_tree stashes shared-ancestor entries; session_tree commits them", () => {
  const { coordinator } = freshCoordinator();
  const ctx = fakeCtx("s1", "leaf-a");
  coordinator.onSessionStart(ctx, { reason: "startup" });
  coordinator.onBeforeTree(
    { entriesToSummarize: [{ id: "anc1" }, { id: "anc2" }] },
    new AbortController().signal,
  );
  // Not yet consumed: before_tree is cancellable, consumption is deferred.
  assert.equal(coordinator.isConsumed("anc1"), false);
  assert.equal(coordinator.isConsumed("anc2"), false);

  // Navigation completes → durable consumption, committed once.
  coordinator.onTree(fakeCtx("s1", "leaf-b"), "leaf-a", "leaf-b");
  assert.equal(coordinator.isConsumed("anc1"), true);
  assert.equal(coordinator.isConsumed("anc2"), true);

  // Duplicate tree delivery does not double-commit or re-consume.
  coordinator.onTree(fakeCtx("s1", "leaf-b"), "leaf-a", "leaf-b");
  assert.equal(coordinator.consumedCount, 2);

  // Already-aborted navigation stashes nothing.
  const controller = new AbortController();
  controller.abort();
  coordinator.onBeforeTree(
    { entriesToSummarize: [{ id: "anc3" }] },
    controller.signal,
  );
  coordinator.onTree(fakeCtx("s1", "leaf-c"), "leaf-b", "leaf-c");
  assert.equal(coordinator.isConsumed("anc3"), false);
});

test("cancelled or absent session_tree leaves stashed entries unconsumed", () => {
  const { coordinator } = freshCoordinator();
  coordinator.onSessionStart(fakeCtx("s1", "leaf-a"), { reason: "startup" });

  // Navigation cancelled: before_tree stashed, but session_tree never fires.
  coordinator.onBeforeTree(
    { entriesToSummarize: [{ id: "pend1" }, { id: "pend2" }] },
    new AbortController().signal,
  );
  assert.equal(coordinator.isConsumed("pend1"), false);
  assert.equal(coordinator.isConsumed("pend2"), false);

  // Teardown without a tree event: pending entries are dropped, NOT marked
  // consumed — no invisible coverage gap.
  coordinator.onShutdown();
  assert.equal(coordinator.isConsumed("pend1"), false);
  assert.equal(coordinator.isConsumed("pend2"), false);
  assert.equal(coordinator.consumedCount, 0);

  // The same entries can still be captured by a later navigation.
  coordinator.onSessionStart(fakeCtx("s1", "leaf-a"), { reason: "resume" });
  coordinator.onBeforeTree(
    { entriesToSummarize: [{ id: "pend1" }] },
    new AbortController().signal,
  );
  coordinator.onTree(fakeCtx("s1", "leaf-b"), "leaf-a", "leaf-b");
  assert.equal(coordinator.isConsumed("pend1"), true);
});

test("headless/RPC safety: handlers never require TUI-only APIs", async () => {
  const dir = tempStateDir();
  dirs.push(dir);
  const handlers = new Map<
    string,
    (event: unknown, ctx: unknown) => Promise<void>
  >();
  const api = {
    registerCommand: () => {},
    registerTool: () => {},
    on(
      event: string,
      handler: (event: unknown, ctx: unknown) => Promise<void>,
    ) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  registerSessionHandlers(api, (cwd) => buildSessionRuntime(cwd));

  // ctx.ui is a throwing getter: any TUI access fails loudly.
  const ctx = {
    cwd: dir,
    get ui(): never {
      throw new Error("headless path must not access UI");
    },
    sessionManager: fakeCtx("s1", "leaf-a").sessionManager,
  } as unknown as ExtensionContext;

  for (const event of [
    "session_start",
    "session_before_fork",
    "session_before_switch",
    "session_before_tree",
    "session_tree",
    "session_shutdown",
  ]) {
    await handlers.get(event)?.(
      event === "session_start"
        ? { reason: "startup" }
        : event === "session_before_tree"
          ? {
              preparation: { entriesToSummarize: [] },
              signal: new AbortController().signal,
            }
          : event === "session_tree"
            ? { oldLeafId: "leaf-a", newLeafId: "leaf-a" }
            : {},
      ctx,
    );
  }

  const state = JSON.parse(
    readFileSync(
      join(dir, ".kiwifs", "memory", "session-coordinator.json"),
      "utf8",
    ),
  ) as { generation: number };
  assert.equal(state.generation >= 1, true);
});

test("newer state schemaVersion fails closed with a visible error", () => {
  const { dir } = freshCoordinator();
  writeFileSync(
    join(dir, "session-coordinator.json"),
    JSON.stringify({ schemaVersion: 99, generation: 7, consumedEntries: [] }),
  );
  assert.throws(
    () => new SessionCoordinator({ stateDir: dir }),
    StateSchemaError,
  );

  // Wiring disables the coordinator visibly instead of crashing startup.
  const handlers = new Map<
    string,
    (event: unknown, ctx: unknown) => Promise<void>
  >();
  const api = {
    registerCommand: () => {},
    registerTool: () => {},
    on(
      event: string,
      handler: (event: unknown, ctx: unknown) => Promise<void>,
    ) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  setCoordinatorErrorProbe(undefined);
  registerSessionHandlers(api, () => {
    throw new StateSchemaError(99);
  });
  const ctx = {
    cwd: dir,
    sessionManager: fakeCtx("s1", null).sessionManager,
  } as unknown as ExtensionContext;
  void handlers.get("session_start")?.({ reason: "startup" }, ctx);
  assert.match(resolveStatusText(), /session coordinator: DISABLED/);
});

test("periodic outbox tick and retention run between start and shutdown", async () => {
  let ticks = 0;
  let retentions = 0;
  const { coordinator } = freshCoordinator({
    onTick: () => {
      ticks += 1;
    },
    onRetention: () => {
      retentions += 1;
    },
    tickIntervalMs: 10,
    retentionEvery: 2,
  });

  coordinator.onSessionStart(fakeCtx("s1", null), { reason: "startup" });
  assert.equal(coordinator.timerRunning, true);
  await new Promise((r) => setTimeout(r, 90));
  coordinator.onShutdown();
  assert.equal(coordinator.timerRunning, false);
  const ticksAtShutdown = ticks;
  assert.ok(ticksAtShutdown >= 2, `expected ticks, got ${ticksAtShutdown}`);
  assert.ok(retentions >= 1, `expected retention, got ${retentions}`);
  assert.ok(retentions <= ticksAtShutdown);

  // No ticks after shutdown.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ticks, ticksAtShutdown);
});
