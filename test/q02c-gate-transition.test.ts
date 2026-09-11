/**
 * Q02c chunk 1: shared gate transition notification (cancel subscription).
 *
 * The `LiveConfigPrivateModeGate` gains a transition notification surface
 * (cancel subscription) wired into the actual private-control command
 * bridge: a persisted private-mode flip pushes an immediate observation
 * into the runtime's shared gate, so cancel subscribers fire at TRANSITION
 * time — not at the next tick/pull. Config read failure fails CLOSED
 * (private). Subscriptions are released on shutdown (`dispose()`).
 *
 * No scheduler/model-factory hookup here (Q06). Synthetic fixtures only:
 * injected fail-closed reads plus a real temp config file for the command
 * bridge. No network, no real model calls, no secrets.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  LiveConfigPrivateModeGate,
  liveConfigPrivateMode,
} from "../src/privacy/live-gate.ts";
import { PrivateModeActiveError } from "../src/privacy/private-mode.ts";
import { setPrivateModeInFile } from "../src/runtime/controls.ts";
import {
  buildSessionRuntime,
  buildRuntimeControlSurface,
} from "../src/index.ts";

function tempConfig(privateMode: boolean): {
  dir: string;
  file: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q02c-"));
  const file = join(dir, "kiwifs.config.json");
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      privateMode,
      projectIdentity: "example.local/synthetic",
      mcp: {
        url: "http://127.0.0.1:9/synthetic-mcp",
        auth: { kind: "env", ref: "KIWIFS_Q02C_SYNTHETIC_TOKEN" },
      },
      features: { observation: true, backup: false, board: false },
    }),
  );
  return {
    dir,
    file,
    cleanup() {
      // no persistent env touched here (unit-level file only)
    },
  };
}

test("Q02c: normal→private fires cancel exactly once; off/on repeats re-fire; private reads never re-fire", () => {
  let state = false;
  const gate = new LiveConfigPrivateModeGate(() => state);
  const fired: string[] = [];
  gate.onCancel((reason) => fired.push(reason));

  gate.isPrivate; // initial read: false (not a transition)
  assert.equal(fired.length, 0);

  state = true;
  assert.equal(gate.isPrivate, true);
  assert.equal(fired.length, 1, "one cancel fire on enable");
  // Repeated reads while private: no re-fire.
  assert.equal(gate.isPrivate, true);
  assert.equal(gate.isPrivate, true);
  assert.equal(fired.length, 1);

  state = false; // private→normal: cancel must NOT fire
  assert.equal(gate.isPrivate, false);
  assert.equal(fired.length, 1, "resume does not fire cancel");

  state = true; // repeated on/off cycles: fire again
  assert.equal(gate.isPrivate, true);
  assert.equal(fired.length, 2);
  state = false;
  assert.equal(gate.isPrivate, false);
  state = true;
  assert.equal(gate.isPrivate, true);
  assert.deepEqual(
    fired,
    ["private mode enabled", "private mode enabled", "private mode enabled"],
    "each normal→private cycle fires exactly once",
  );
});

test("Q02c: cancellation ordering — subscribers run after the gate already reports private (fail-closed first)", () => {
  let state = false;
  const gate = new LiveConfigPrivateModeGate(() => state);
  let observedWhenFired: boolean | undefined;
  let assertThrewWhileFiring: unknown;
  gate.onCancel(() => {
    observedWhenFired = gate.isPrivate;
    try {
      gate.assertModelCallAllowed();
    } catch (err) {
      assertThrewWhileFiring = err;
    }
  });
  state = true;
  assert.equal(gate.isPrivate, true);
  assert.equal(
    observedWhenFired,
    true,
    "state is private before listeners run",
  );
  assert.ok(
    assertThrewWhileFiring instanceof PrivateModeActiveError,
    "a listener re-checking the gate at transition time is already refused",
  );
});

test("Q02c: config read failure fails CLOSED to private and fires cancel", () => {
  let fail = false;
  const gate = new LiveConfigPrivateModeGate(() => {
    if (fail) throw new Error("synthetic config read failure");
    return false;
  });
  const fired: string[] = [];
  gate.onCancel((reason) => fired.push(reason));
  assert.equal(gate.isPrivate, false);
  fail = true;
  assert.equal(
    gate.isPrivate,
    true,
    "read failure must count as private (fail closed)",
  );
  assert.equal(fired.length, 1, "read failure is a normal→private transition");
  assert.throws(() => gate.assertModelCallAllowed(), PrivateModeActiveError);
});

test("Q02c: notifyTransition pushes the observation at transition time (no pull needed)", () => {
  let state = false;
  const gate = new LiveConfigPrivateModeGate(() => state);
  const fired: string[] = [];
  gate.onCancel((reason) => fired.push(reason));
  gate.notifyTransition(); // still normal: no fire
  assert.equal(fired.length, 0);
  state = true;
  gate.notifyTransition();
  assert.equal(fired.length, 1, "push fires cancel without any pull read");
  gate.notifyTransition(); // already observed private: no duplicate
  assert.equal(fired.length, 1);
});

test("Q02c: dispose releases subscriptions — no fire after shutdown", () => {
  let state = false;
  const gate = new LiveConfigPrivateModeGate(() => state);
  const fired: string[] = [];
  gate.onCancel((reason) => fired.push(reason));
  gate.dispose();
  state = true;
  assert.equal(gate.isPrivate, true, "gate still reports state after dispose");
  assert.equal(fired.length, 0, "no cancel fire after dispose");
  gate.notifyTransition();
  assert.equal(fired.length, 0);
});

test("Q02c: command bridge pushes the transition into the shared gate after a persisted flip", async () => {
  const cfg = tempConfig(false);
  const prevCfg = process.env["KIWIFS_MEMORY_CONFIG"];
  const prevState = process.env["KIWIFS_MEMORY_STATE_DIR"];
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q02c-rt-"));
  process.env["KIWIFS_MEMORY_CONFIG"] = cfg.file;
  process.env["KIWIFS_MEMORY_STATE_DIR"] = join(dir, "state");
  mkdirSync(join(dir, "state"), { recursive: true });
  try {
    const rt = buildSessionRuntime(dir);
    assert.ok(rt.liveGate, "production runtime exposes the shared live gate");
    const fired: string[] = [];
    rt.liveGate!.onCancel((reason) => fired.push(reason));
    assert.equal(liveConfigPrivateMode(), false, "fixture starts normal");

    const surface = buildRuntimeControlSurface({
      configFile: cfg.file,
      getRetrieval: () => undefined,
      getGeneration: () => 0,
      notifyPrivateTransition: () => rt.liveGate!.notifyTransition(),
    });

    // Bridge path used by the shipped command: persist file FIRST, then the
    // gate observes the transition immediately (push, not next tick).
    const on = surface.setPrivateMode(true);
    assert.equal(on.ok, true, "persist ON failed");
    assert.equal(fired.length, 1, "cancel fired at transition time");
    assert.equal(rt.liveGate!.isPrivate, true);

    // off: no additional cancel fire; resume resolved lazily (held cleared).
    const off = surface.setPrivateMode(false);
    assert.equal(off.ok, true);
    assert.equal(fired.length, 1, "private→normal does not fire cancel");
    assert.equal(rt.liveGate!.isPrivate, false);

    // Failed persist must NOT notify the bridge (gate stays consistent).
    const badFile = join(cfg.dir, "missing-dir", "nope.json");
    const bad = setPrivateModeInFile(badFile, true);
    assert.equal(bad.ok, false);
    assert.equal(fired.length, 1);

    // Shutdown release: dispose clears subscriptions (session_shutdown path).
    rt.liveGate!.dispose();
    await setPrivateModeInFile(cfg.file, true);
    rt.liveGate!.notifyTransition();
    assert.equal(fired.length, 1, "no fire after dispose");
  } finally {
    if (prevCfg === undefined) delete process.env["KIWIFS_MEMORY_CONFIG"];
    else process.env["KIWIFS_MEMORY_CONFIG"] = prevCfg;
    if (prevState === undefined) delete process.env["KIWIFS_MEMORY_STATE_DIR"];
    else process.env["KIWIFS_MEMORY_STATE_DIR"] = prevState;
  }
});

test("Q02c: bridge does not notify when persist fails (fail-closed consistency)", () => {
  const notified: boolean[] = [];
  const surface = buildRuntimeControlSurface({
    configFile: join(tmpdir(), "kiwifs-q02c-nonexistent", "cfg.json"),
    getRetrieval: () => undefined,
    getGeneration: () => 0,
    notifyPrivateTransition: (v) => notified.push(v),
  });
  const result = surface.setPrivateMode(true);
  assert.equal(result.ok, false, "unreadable config → persist fails");
  assert.equal(
    notified.length,
    0,
    "no transition notification on failed persist",
  );
});
