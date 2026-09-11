/**
 * Q07B1: live-config owner (`readConfigLive`) — the ONE fail-closed
 * predicate, plus the collapse of the per-site duplicated
 * `!ok || privateMode` implementations onto it.
 *
 * Acceptance demonstrations (Q07 evidence contract a + b):
 * - invalid config (unparseable + validation issues + unreadable file) ⇒ the
 *   owner reports `ok:false, privateMode:true, enabled:false` (fail closed),
 *   with a sanitized `invalidReason` for status only.
 * - transient invalid window: invalid at read N, valid at N+1 ⇒ N fails
 *   closed, N+1 proceeds — no cached permit, no crash.
 * - predicate equivalence: `liveConfigPrivateMode()` (the shared gate's
 *   read) equals the independently computed `!ok || privateMode` for every
 *   config state.
 * - gate integration through the SHIPPED `LiveConfigPrivateModeGate`:
 *   invalid file ⇒ private; transition notification fires the cancel
 *   subscribers exactly once per observed normal→private transition
 *   (Q02c semantics unchanged); private→normal resumes lazily.
 * - shipped runtime (`buildSessionRuntime`) pull path: private-mode flip and
 *   invalid-config window are observed live through the same owner.
 *
 * Synthetic only: temp config files (mode 0600), throwaway env, no network,
 * no real model calls, no secrets.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/loader.ts";
import {
  liveConfigPrivateMode,
  LiveConfigPrivateModeGate,
  readConfigLive,
} from "../src/privacy/live-gate.ts";
import { buildSessionRuntime } from "../src/index.ts";

const TOKEN_ENV = "KIWIFS_Q07B1_SYNTHETIC_TOKEN";

interface Cfg {
  dir: string;
  cfgFile: string;
  stateDir: string;
  restore: () => void;
  /** Rewrite the config file contents (atomic-enough for tests). */
  write: (text: string) => void;
}

function writeConfig(
  cfgFile: string,
  overrides: Record<string, unknown>,
): void {
  const base = {
    schemaVersion: 1,
    enabled: true,
    privateMode: false,
    projectIdentity: "example.local/synthetic",
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

function makeCfgEnv(privateMode = false): Cfg {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q07b1-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeConfig(cfgFile, { privateMode });
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

test("Q07B1: owner — valid config classifies ok/enabled/privateMode truthfully", () => {
  const c = makeCfgEnv(false);
  try {
    const v = readConfigLive();
    assert.equal(v.ok, true);
    assert.equal(v.privateMode, false);
    assert.equal(v.enabled, true);
    assert.equal(v.invalidReason, undefined);
    assert.ok(v.config, "loaded config object present when ok");
    assert.equal(v.file, c.cfgFile);
  } finally {
    c.restore();
  }
});

test("Q07B1: owner — persisted private mode ⇒ privateMode true (ok stays true)", () => {
  const c = makeCfgEnv(true);
  try {
    const v = readConfigLive();
    assert.equal(v.ok, true);
    assert.equal(v.privateMode, true);
    assert.equal(v.enabled, true);
  } finally {
    c.restore();
  }
});

test("Q07B1: owner — unparseable JSON fails closed with sanitized reason", () => {
  const c = makeCfgEnv(false);
  try {
    c.write("{ not json ]");
    const v = readConfigLive();
    assert.equal(v.ok, false);
    assert.equal(v.privateMode, true);
    assert.equal(v.enabled, false);
    assert.ok(v.invalidReason && v.invalidReason.includes("not valid JSON"));
    assert.equal(v.config, undefined);
  } finally {
    c.restore();
  }
});

test("Q07B1: owner — non-object JSON fails closed", () => {
  const c = makeCfgEnv(false);
  try {
    c.write("[1,2,3]");
    const v = readConfigLive();
    assert.equal(v.ok, false);
    assert.equal(v.privateMode, true);
    assert.equal(v.enabled, false);
    assert.ok(v.invalidReason && v.invalidReason.includes("not a JSON object"));
  } finally {
    c.restore();
  }
});

test("Q07B1: owner — validation issues fail closed with issue summary", () => {
  const c = makeCfgEnv(false);
  try {
    // schemaVersion wrong type → validation issues (not a fatal parse error).
    c.write(JSON.stringify({ schemaVersion: "nope" }));
    const v = readConfigLive();
    assert.equal(v.ok, false);
    assert.equal(v.privateMode, true);
    assert.equal(v.enabled, false);
    assert.ok(
      v.invalidReason && v.invalidReason.includes("config validation issue"),
    );
  } finally {
    c.restore();
  }
});

test("Q07B1: owner — unreadable config file fails closed", () => {
  const c = makeCfgEnv(false);
  try {
    chmodSync(c.cfgFile, 0o000);
    try {
      const v = readConfigLive();
      assert.equal(v.ok, false);
      assert.equal(v.privateMode, true);
      assert.equal(v.enabled, false);
      assert.ok(v.invalidReason && v.invalidReason.includes("unreadable"));
    } finally {
      chmodSync(c.cfgFile, 0o600);
    }
  } finally {
    c.restore();
  }
});

test("Q07B1: owner — no config file resolves to defaults (enabled:false), not private", () => {
  // Existing loader contract pinned: absent file ⇒ defaults (enabled false).
  // Fail-closed for commands comes from enabled:false; nothing is configured,
  // so nothing can be private. Explicitly NOT a cached permit of any kind.
  delete process.env["KIWIFS_MEMORY_CONFIG"];
  try {
    const v = readConfigLive();
    assert.equal(v.ok, true);
    assert.equal(v.privateMode, false);
    assert.equal(v.enabled, false);
  } finally {
    if (process.env["KIWIFS_MEMORY_CONFIG"] === undefined) {
      process.env["KIWIFS_MEMORY_CONFIG"] = "";
      delete process.env["KIWIFS_MEMORY_CONFIG"];
    }
  }
});

test("Q07B1: transient invalid window — invalid read fails closed, next valid read proceeds (no cached permit)", () => {
  const c = makeCfgEnv(false);
  try {
    c.write("{ broken");
    const bad = readConfigLive();
    assert.equal(bad.privateMode, true);
    assert.equal(bad.ok, false);
    // restore a fully valid config — the NEXT read must succeed with zero
    // residual failure state (no cache, no retry loop).
    writeConfig(c.cfgFile, {});
    const good = readConfigLive();
    assert.equal(good.ok, true);
    assert.equal(good.privateMode, false);
    assert.equal(good.enabled, true);
  } finally {
    c.restore();
  }
});

test("Q07B1: predicate equivalence — liveConfigPrivateMode === (!ok || privateMode) across states", () => {
  const states: Array<() => void> = [];
  const c = makeCfgEnv(false);
  try {
    const check = (label: string) => {
      const r = loadConfig();
      const expected = !r.ok || (r.ok && r.config.privateMode);
      assert.equal(liveConfigPrivateMode(), expected, label);
      assert.equal(readConfigLive().privateMode, expected, label);
    };
    check("valid normal");
    c.write(
      JSON.stringify({
        ...JSON.parse('{"x":1}'),
        privateMode: true,
        enabled: false,
        schemaVersion: 1,
      }),
    );
    states.push(() => {});
    check("valid private+disabled");
    c.write("{ broken");
    check("unparseable");
    c.write("[]");
    check("non-object");
    c.write(JSON.stringify({ schemaVersion: "bad" }));
    check("validation issues");
    writeConfig(c.cfgFile, {});
    check("restored valid");
  } finally {
    c.restore();
  }
});

test("Q07B1: gate integration — invalid file observes private; transition fires cancel subscribers exactly once; resume clears", () => {
  const c = makeCfgEnv(false);
  try {
    const gate = new LiveConfigPrivateModeGate();
    assert.equal(gate.isPrivate, false);
    const fires: string[] = [];
    gate.onCancel((reason) => fires.push(reason));
    // normal → private (persisted flip): observe() fires cancel once.
    writeConfig(c.cfgFile, { privateMode: true });
    assert.equal(gate.isPrivate, true);
    assert.deepEqual(fires, ["private mode enabled"]);
    // Repeated reads while private do not re-fire.
    assert.equal(gate.isPrivate, true);
    assert.deepEqual(fires, ["private mode enabled"]);
    // Invalid config window stays private; no NEW transition (no refire).
    c.write("{ broken");
    assert.equal(gate.isPrivate, true);
    assert.deepEqual(fires, ["private mode enabled"]);
    // Push path through the same owner: notifyTransition re-reads live.
    gate.notifyTransition();
    assert.deepEqual(fires, ["private mode enabled"]);
    // Resume: valid, non-private config clears held refs lazily.
    writeConfig(c.cfgFile, {});
    assert.equal(gate.isPrivate, false);
    assert.deepEqual(gate.heldJobs(), []);
    gate.dispose();
  } finally {
    c.restore();
  }
});

test("Q07B1: shipped runtime — private-mode flip and invalid window observed live via the shared gate", async () => {
  const c = makeCfgEnv(false);
  try {
    const mod = await import("../src/index.ts");
    const rt = mod.buildSessionRuntime(c.dir);
    assert.ok(rt.liveGate, "production live gate must exist");
    assert.equal(rt.liveGate.isPrivate, false);
    // Persisted private flip: next pull read (no push) reports private.
    writeConfig(c.cfgFile, { privateMode: true });
    assert.equal(rt.liveGate.isPrivate, true);
    // Invalid window: still fail closed through the SAME owner.
    c.write("{ broken");
    assert.equal(rt.liveGate.isPrivate, true);
    // Restore: resume lazily; runtime objects were built under the valid
    // snapshot and are untouched (no live reconfiguration in Q07B).
    writeConfig(c.cfgFile, {});
    assert.equal(rt.liveGate.isPrivate, false);
    rt.liveGate.dispose();
    rt.store?.close();
  } finally {
    c.restore();
  }
});
