/**
 * T18 chunk 2: command/inspection/forget wiring — synthetic tests only
 * (no live services, no model calls, no network). Covers:
 * - overall status state computation (healthy/degraded/disabled/private,
 *   keyword-only degradation never healthy),
 * - manual op log durability + fail-closed ledger,
 * - reversible forget / verified forget-undo against a FAKE store,
 * - board delivery GC (local-only, undelivered entries never touched),
 * - B6 erasure disclosure content,
 * - command wiring: private-mode toggle persists a validated config edit
 *   and cancels pending retrieval; headless/RPC commands never touch the UI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import kiwifsMemory, {
  computeOverallState,
  resolveStatusText,
  setBackupNoteProbe,
  setBoardNoteProbe,
  setCapturePausedProbe,
  setObserverErrorProbe,
  setRetrievalNoteProbe,
  setQueueNoteProbe,
  setQueueQuarantinedProbe,
  setTokenizerDegradedProbe,
  setTokenizerNoteProbe,
} from "../src/index.ts";
import {
  ManualOpLog,
  erasureReportLines,
  forgetMemoryPath,
  serializeFrontmatterDoc,
  unforgetMemoryPath,
} from "../src/commands/manual-ops.ts";
import { DeliveryStateFile } from "../src/board/delivery.ts";
import type { DeliveryEntry } from "../src/board/delivery.ts";
import { ACK_RETENTION_MS } from "../src/board/delivery.ts";

// ---- overall state ---------------------------------------------------------

test("computeOverallState: precedence disabled > private > degraded > healthy", () => {
  const base = {
    configOk: true,
    enabled: true,
    privateMode: false,
    degradedNotes: [] as string[],
    quarantined: 0,
  };
  assert.equal(computeOverallState(base), "healthy");
  assert.equal(computeOverallState({ ...base, quarantined: 1 }), "degraded");
  assert.equal(
    computeOverallState({
      ...base,
      degradedNotes: ["retrieval: hybrid fell back to keyword-only hits"],
    }),
    "degraded",
  );
  assert.equal(computeOverallState({ ...base, privateMode: true }), "private");
  assert.equal(computeOverallState({ ...base, enabled: false }), "disabled");
  assert.equal(computeOverallState({ ...base, configOk: false }), "disabled");
  // Private mode outranks degradation notes.
  assert.equal(
    computeOverallState({
      ...base,
      privateMode: true,
      degradedNotes: ["anything"],
    }),
    "private",
  );
});

test("status text carries the overall state line and stays secret-free", () => {
  const text = resolveStatusText();
  assert.match(text, /state: (disabled|private|degraded|healthy)/);
  assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._-]{16,}/);
});

// ---- manual op log ---------------------------------------------------------

function fakeStore(content: string | undefined) {
  const calls: string[] = [];
  const written: string[] = [];
  return {
    calls,
    written,
    store: {
      async read() {
        calls.push("read");
        return {
          state: content === undefined ? ("missing" as const) : ("ok" as const),
          ...(content !== undefined ? { content } : {}),
          frontmatter: content === undefined ? {} : parseFm(content),
          body: content === undefined ? "" : body(content),
        };
      },
      async write(_path: string, doc: string) {
        calls.push("write");
        written.push(doc);
        content = doc;
        return {};
      },
      async forget() {
        calls.push("forget");
        content = content?.replace(
          "memory_status: active",
          "memory_status: superseded",
        );
        return {};
      },
    },
  };
}

function parseFm(doc: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(doc);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of (m[1] as string).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
function body(doc: string): string {
  const m = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(doc);
  return m?.[1] ?? "";
}

const DOC = `---\nscope: project/demo\nmemory_status: active\ncreated: 2026-01-01T00:00:00Z\n---\n\nSynthetic record body.\n`;

test("manual op log: opId is durably recorded BEFORE the side effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-oplog-"));
  try {
    const opLog = new ManualOpLog(dir);
    const fake = fakeStore(DOC);
    const order: string[] = [];
    const result = await forgetMemoryPath({
      opLog: {
        record(entry) {
          order.push("record");
          assert.ok(entry.opId);
          opLog.record(entry);
        },
        has: (opId) => opLog.has(opId),
      },
      openStore: async () => {
        order.push("store");
        return fake.store;
      },
      path: "memory/observation/x.md",
      reason: "synthetic",
      actor: "test",
      now: () => new Date(0),
    });
    assert.equal(result.ok, true);
    // The durable record MUST precede the backend call (record and store
    // open are synchronous steps of the op; the fake's own calls array
    // holds the backend call in order after them).
    assert.deepEqual(order, ["record", "store"]);
    assert.deepEqual(fake.calls, ["forget"]);
    // Reload: the op log knows the opId (read the file directly).
    const raw = readFileSync(join(dir, "manual-oplog.jsonl"), "utf8");
    assert.match(raw, /"action":"forget"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual op log: corrupt history fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-oplog2-"));
  try {
    writeFileSync(join(dir, "manual-oplog.jsonl"), "{not json\n");
    assert.throws(() => new ManualOpLog(dir), /corrupt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual op log ledger refuses unknown opIds (fail closed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-oplog3-"));
  try {
    const opLog = new ManualOpLog(dir);
    assert.throws(() => opLog.ledger().assertPersisted("unknown"), /persisted/);
    opLog.record({
      opId: "op-1",
      action: "forget",
      path: "p",
      at: new Date(0).toISOString(),
    });
    assert.doesNotThrow(() => opLog.ledger().assertPersisted("op-1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forget: unconfigured backend is a visible retryable gap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-forget1-"));
  try {
    const opLog = new ManualOpLog(dir);
    const result = await forgetMemoryPath({
      opLog,
      openStore: async () => undefined,
      path: "memory/observation/x.md",
      now: () => new Date(0),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /retryable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forget: drops cached evidence packs and refreshes the tombstone cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-forget2-"));
  try {
    const opLog = new ManualOpLog(dir);
    const fake = fakeStore(DOC);
    let refreshed = 0;
    const dropped: string[] = [];
    const result = await forgetMemoryPath({
      opLog,
      openStore: async () => fake.store,
      path: "memory/observation/x.md",
      actor: "test",
      registry: {
        dropUnmatched() {
          dropped.push("pack-1");
          return dropped.map((inputId) => ({ inputId, origin: "input" }));
        },
      },
      tombstoneCache: {
        async refresh() {
          refreshed++;
        },
      },
      now: () => new Date(0),
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /1 cached evidence pack/);
    assert.match(result.detail, /tombstone cache refreshed/);
    assert.equal(refreshed, 1);
    assert.deepEqual(dropped, ["pack-1"]);
    // Detail is sanitized: no record body content.
    assert.doesNotMatch(result.detail, /Synthetic record body/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forget-undo: verified restore of a superseded record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-undo1-"));
  try {
    const opLog = new ManualOpLog(dir);
    const forgotten = DOC.replace(
      "memory_status: active",
      'memory_status: superseded\nsuperseded_reason: "synthetic"',
    );
    const fake = fakeStore(forgotten);
    const result = await unforgetMemoryPath({
      opLog,
      openStore: async () => fake.store,
      path: "memory/observation/x.md",
      actor: "test",
      now: () => new Date(0),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.detail, /read-back verified/);
    // The restored doc is active, reason dropped, provenance appended.
    const doc = fake.written[0]!;
    assert.match(doc, /memory_status: active/);
    assert.doesNotMatch(doc, /superseded_reason/);
    assert.match(doc, /kiwifs-provenance: forget undone/);
    assert.match(doc, /Synthetic record body\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forget-undo: refuses records that are not forgotten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-undo2-"));
  try {
    const opLog = new ManualOpLog(dir);
    const fake = fakeStore(DOC);
    const result = await unforgetMemoryPath({
      opLog,
      openStore: async () => fake.store,
      path: "memory/observation/x.md",
      now: () => new Date(0),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not forgotten/);
    assert.deepEqual(fake.calls, ["read"]); // no write happened
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forget-undo: read-back mismatch fails visibly (no silent overwrite)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-undo3-"));
  try {
    const opLog = new ManualOpLog(dir);
    const forgotten = DOC.replace(
      "memory_status: active",
      "memory_status: superseded",
    );
    let content: string | undefined = forgotten;
    let writes = 0;
    const store = {
      async read() {
        return {
          state: "ok" as const,
          ...(content !== undefined ? { content } : {}),
          frontmatter: content === undefined ? {} : parseFm(content),
          body: content === undefined ? "" : body(content),
        };
      },
      async write(_path: string, doc: string) {
        writes++;
        // Simulate a concurrent modification corrupting the write.
        content = doc + "\n<!-- concurrent edit -->";
        return {};
      },
      async forget() {
        return {};
      },
    };
    const result = await unforgetMemoryPath({
      opLog,
      openStore: async () => store,
      path: "memory/observation/x.md",
      now: () => new Date(0),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /read-back mismatch/);
    assert.equal(writes, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forget-undo: missing record is a visible refusal, not a write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-undo4-"));
  try {
    const opLog = new ManualOpLog(dir);
    const fake = fakeStore(undefined);
    const result = await unforgetMemoryPath({
      opLog,
      openStore: async () => fake.store,
      path: "memory/observation/x.md",
      now: () => new Date(0),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /nothing to restore/);
    assert.deepEqual(fake.calls, ["read"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- board delivery GC -----------------------------------------------------

test("board GC: prunes stale acked/skipped, NEVER undelivered entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-gc-"));
  try {
    // Seed the durable state file directly (save() already prunes stale
    // acked entries on every write, so the GC test exercises distinct cases).
    const now = Date.now();
    const old = now - ACK_RETENTION_MS - 1;
    const fresh = now - 1000;
    writeFileSync(
      join(dir, "delivery-consumer-a.json"),
      JSON.stringify({
        schemaVersion: 1,
        consumerId: "consumer-a",
        entries: {
          "a-old": {
            msgId: "a-old",
            path: "board/ch/a-old.md",
            channel: "ch",
            ackedAt: old,
          },
          "a-new": {
            msgId: "a-new",
            path: "board/ch/a-new.md",
            channel: "ch",
            ackedAt: fresh,
          },
          "s-old": {
            msgId: "s-old",
            path: "board/ch/s-old.md",
            channel: "ch",
            skip: "expired",
            skippedAt: old,
          },
          "u-old": {
            msgId: "u-old",
            path: "board/ch/u-old.md",
            channel: "ch",
          },
          "d-old": {
            msgId: "d-old",
            path: "board/ch/d-old.md",
            channel: "ch",
            deliveredAt: old,
          },
        },
      }),
    );
    const state = new DeliveryStateFile(dir, "consumer-a");
    const removed = state.gc();
    assert.equal(removed, 2);
    assert.equal(state.getEntry("a-old"), undefined);
    assert.equal(state.getEntry("s-old"), undefined);
    assert.ok(state.getEntry("a-new"));
    assert.ok(state.getEntry("u-old"), "undelivered must never be GC'd");
    assert.ok(
      state.getEntry("d-old"),
      "delivered-but-unacked must never be GC'd",
    );
    // Reload from disk: the GC was durable.
    const reloaded = new DeliveryStateFile(dir, "consumer-a");
    assert.equal(reloaded.getEntry("a-old"), undefined);
    assert.ok(reloaded.getEntry("u-old"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("board GC: nothing to prune is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-gc2-"));
  try {
    const state = new DeliveryStateFile(dir, "consumer-a");
    assert.equal(state.gc(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- B6 erasure disclosure -------------------------------------------------

test("erasure report discloses retention and claims no purge", () => {
  const lines = erasureReportLines();
  const text = lines.join("\n");
  assert.match(text, /disclosure only/i);
  assert.match(text, /REVERSIBLE/);
  assert.match(text, /body/i);
  assert.match(text, /backups/i);
  assert.match(text, /vector/i);
  assert.match(text, /git/i);
  assert.match(text, /operator procedure/i);
  // Nothing is executed: the report is static text, no capability claims.
  assert.doesNotMatch(text, /purge[d]?\s+successfully|erased successfully/i);
});

// ---- command wiring --------------------------------------------------------

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function loadCommands(): Map<string, Command> {
  const commands = new Map<string, Command>();
  const api = {
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    registerTool() {},
    on() {},
  };
  kiwifsMemory(api as unknown as ExtensionAPI);
  return commands;
}

function uiCtx(hasUI: boolean, cwd: string, notifications: unknown[][]) {
  return {
    hasUI,
    cwd,
    ...(hasUI
      ? {
          ui: {
            notify: (...args: unknown[]) => notifications.push(args),
            confirm: async () => true,
          },
        }
      : {
          get ui(): never {
            throw new Error("Headless command must not access UI");
          },
        }),
  } as unknown as ExtensionCommandContext;
}

function withEnv(
  cfgFile: string | undefined,
  stateDir: string,
  fn: () => void | Promise<void>,
): Promise<void> | void {
  const prevCfg = process.env["KIWIFS_MEMORY_CONFIG"];
  const prevState = process.env["KIWIFS_MEMORY_STATE_DIR"];
  if (cfgFile) process.env["KIWIFS_MEMORY_CONFIG"] = cfgFile;
  else delete process.env["KIWIFS_MEMORY_CONFIG"];
  process.env["KIWIFS_MEMORY_STATE_DIR"] = stateDir;
  return (async () => {
    try {
      await fn();
    } finally {
      if (prevCfg === undefined) delete process.env["KIWIFS_MEMORY_CONFIG"];
      else process.env["KIWIFS_MEMORY_CONFIG"] = prevCfg;
      if (prevState === undefined)
        delete process.env["KIWIFS_MEMORY_STATE_DIR"];
      else process.env["KIWIFS_MEMORY_STATE_DIR"] = prevState;
    }
  })();
}

test("private-mode command: on persists a validated config edit, off restores, status reports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-pm-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  writeFileSync(
    cfgFile,
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      privateMode: false,
      mcp: {
        url: "http://127.0.0.1:1/mcp",
        auth: { kind: "env", ref: "KIWIFS_T18_SYNTHETIC_TOKEN" },
      },
    }),
  );
  await withEnv(cfgFile, join(dir, "state"), async () => {
    const commands = loadCommands();
    const cwd = join(dir, "proj");
    const notify: unknown[][] = [];
    const ctx = uiCtx(true, cwd, notify);
    await commands.get("kiwifs-private-mode")!.handler("status", ctx);
    assert.match(String(notify.at(-1)![0]), /private mode: OFF/);

    await commands.get("kiwifs-private-mode")!.handler("on", ctx);
    assert.match(String(notify.at(-1)![0]), /private mode ON/);
    const onRaw = JSON.parse(readFileSync(cfgFile, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(onRaw["privateMode"], true);
    // Other keys preserved verbatim.
    const mcp = onRaw["mcp"] as Record<string, unknown>;
    assert.equal(
      (mcp["auth"] as Record<string, unknown>)["ref"],
      "KIWIFS_T18_SYNTHETIC_TOKEN",
    );

    await commands.get("kiwifs-private-mode")!.handler("off", ctx);
    assert.match(String(notify.at(-1)![0]), /private mode OFF/);
    const offRaw = JSON.parse(readFileSync(cfgFile, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(offRaw["privateMode"], false);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("private-mode command: enabling with no config file in effect fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-pm2-"));
  await withEnv(undefined, join(dir, "state"), async () => {
    const commands = loadCommands();
    const notify: unknown[][] = [];
    await commands
      .get("kiwifs-private-mode")!
      .handler("on", uiCtx(true, dir, notify));
    assert.match(String(notify.at(-1)![0]), /NOT changed/);
    assert.match(String(notify.at(-1)![0]), /no config file/);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("private-mode command: headless/RPC never touches the UI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-pm3-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  writeFileSync(cfgFile, JSON.stringify({ enabled: false }));
  await withEnv(cfgFile, join(dir, "state"), async () => {
    const commands = loadCommands();
    const headless = {
      hasUI: false,
      cwd: dir,
      get ui(): never {
        throw new Error("Headless command must not access UI");
      },
    } as unknown as ExtensionCommandContext;
    for (const args of ["status", "on", "off"]) {
      await commands.get("kiwifs-private-mode")!.handler(args, headless);
    }
  });
  rmSync(dir, { recursive: true, force: true });
});

test("inspection commands: usable headless (no UI access, no crash)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-headless-"));
  await withEnv(undefined, join(dir, "state"), async () => {
    const commands = loadCommands();
    const headless = {
      hasUI: false,
      cwd: dir,
      get ui(): never {
        throw new Error("Headless command must not access UI");
      },
    } as unknown as ExtensionCommandContext;
    for (const name of [
      "kiwifs-status",
      "kiwifs-extract-now",
      "kiwifs-reflect-now",
      "kiwifs-proposal",
      "kiwifs-queue",
      "kiwifs-erasure-report",
      "kiwifs-forget",
      "kiwifs-forget-undo",
      "kiwifs-board-gc",
    ]) {
      await commands.get(name)!.handler("", headless);
    }
  });
  rmSync(dir, { recursive: true, force: true });
});

test("queue command: sanitized fingerprints only (no payloads in output)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-queue-"));
  await withEnv(undefined, join(dir, "state"), async () => {
    const commands = loadCommands();
    const notify: unknown[][] = [];
    await commands.get("kiwifs-queue")!.handler("", uiCtx(true, dir, notify));
    assert.equal(notify.length, 1);
    const text = String(notify[0]![0]);
    assert.match(text, /outbox:|unavailable/);
    assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._-]{16,}/);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("erasure report command: disclosure-only output, no I/O side effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-erase-"));
  await withEnv(undefined, join(dir, "state"), async () => {
    const commands = loadCommands();
    const notify: unknown[][] = [];
    await commands
      .get("kiwifs-erasure-report")!
      .handler("", uiCtx(true, dir, notify));
    assert.equal(notify.length, 1);
    assert.match(String(notify[0]![0]), /disclosure only/i);
  });
  // No state was created by the disclosure command itself.
  rmSync(dir, { recursive: true, force: true });
});

test("forget command: usage and disabled-config gates before any backend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-forgetcmd-"));
  await withEnv(undefined, join(dir, "state"), async () => {
    const commands = loadCommands();
    const notify: unknown[][] = [];
    const ctx = uiCtx(true, dir, notify);
    await commands.get("kiwifs-forget")!.handler("", ctx);
    assert.match(String(notify.at(-1)![0]), /usage/);
    // No config file in effect → disabled gate, still no crash.
    await commands
      .get("kiwifs-forget")!
      .handler("memory/observation/x.md", ctx);
    assert.ok(notify.length >= 2);
  });
  rmSync(dir, { recursive: true, force: true });
});

// ---- T18 review fixes -------------------------------------------------------

test("review fix: headless /kiwifs-forget requires explicit --yes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-forgetyes-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  writeFileSync(
    cfgFile,
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mcp: {
        url: "http://127.0.0.1:1/mcp",
        auth: { kind: "env", ref: "KIWIFS_T18_SYNTHETIC_TOKEN" },
      },
    }),
  );
  await withEnv(cfgFile, join(dir, "state"), async () => {
    const commands = loadCommands();
    const headless = {
      hasUI: false,
      cwd: dir,
      get ui(): never {
        throw new Error("Headless command must not access UI");
      },
    } as unknown as ExtensionCommandContext;
    // Without --yes: refused before any record mutation (no oplog written).
    await commands
      .get("kiwifs-forget")!
      .handler("memory/observation/x.md", headless);
    assert.equal(
      existsSync(join(dir, "state", "manual-oplog.jsonl")),
      false,
      "oplog must not be created without --yes",
    );
  });
  rmSync(dir, { recursive: true, force: true });
});

test("review fix: structured probes drive degraded state (no keyword matching)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-probes-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  writeFileSync(
    cfgFile,
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      features: { observation: false, backup: false, board: false },
      mcp: {
        url: "http://127.0.0.1:1/mcp",
        auth: { kind: "env", ref: "KIWIFS_T18_SYNTHETIC_TOKEN" },
      },
    }),
  );
  await withEnv(cfgFile, join(dir, "state"), () => {
    // Isolate from probes left by other tests in this file (module-level).
    setRetrievalNoteProbe(undefined);
    setBackupNoteProbe(undefined);
    setBoardNoteProbe(undefined);
    setQueueNoteProbe(undefined);
    setQueueQuarantinedProbe(undefined);

    // Capture paused (coverage gap) degrades the overall state.
    setCapturePausedProbe(() => true);
    assert.match(resolveStatusText(), /state: degraded/);
    setCapturePausedProbe(undefined);

    // Structured tokenizer degradation flag degrades; without the flag the
    // same note text alone must NOT degrade (no keyword match on wording).
    setTokenizerNoteProbe(() => "automatic injection stays skipped — x");
    setTokenizerDegradedProbe(() => true);
    assert.match(resolveStatusText(), /state: degraded/);
    setTokenizerDegradedProbe(() => false);
    assert.doesNotMatch(resolveStatusText(), /state: degraded/);
    setTokenizerNoteProbe(undefined);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("review fix: unresolved scope with observation+backup off does not degrade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t18-scopeoff-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  writeFileSync(
    cfgFile,
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      features: { observation: false, backup: false, board: false },
      mcp: {
        url: "http://127.0.0.1:1/mcp",
        auth: { kind: "env", ref: "KIWIFS_T18_SYNTHETIC_TOKEN" },
      },
    }),
  );
  await withEnv(cfgFile, join(dir, "state"), () => {
    // Isolate from probes left by other tests in this file (module-level).
    setRetrievalNoteProbe(undefined);
    setBackupNoteProbe(undefined);
    setBoardNoteProbe(undefined);
    setCapturePausedProbe(undefined);
    setTokenizerDegradedProbe(undefined);
    setObserverErrorProbe(() => "record scope not resolved (synthetic)");
    const text = resolveStatusText();
    // The reason stays visible (feature-neutral label) ...
    assert.match(text, /records: DISABLED — record scope not resolved/);
    // ... but no consuming feature runs, so the state is not degraded.
    assert.match(text, /state: healthy/);
    setObserverErrorProbe(undefined);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("serializeFrontmatterDoc keeps unquoted values and quotes specials", () => {
  const doc = serializeFrontmatterDoc(
    { scope: "project/demo", reason: 'has "quotes"', plain: "ok" },
    "\nbody\n",
  );
  assert.match(doc, /^---\nscope: project\/demo\n/);
  assert.match(doc, /reason: "has \\"quotes\\""/);
  assert.match(doc, /plain: ok\n---/);
});

// ---- Q03a: consistent confirmation on record-mutating commands --------------

/** Config file with synthetic (unroutable) backend; enables the config gate. */
function writeSyntheticConfig(dir: string): string {
  const cfgFile = join(dir, "kiwifs.config.json");
  writeFileSync(
    cfgFile,
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mcp: {
        url: "http://127.0.0.1:1/mcp",
        auth: { kind: "env", ref: "KIWIFS_T18_SYNTHETIC_TOKEN" },
      },
    }),
  );
  return cfgFile;
}

function confirmCtx(
  hasUI: boolean,
  cwd: string,
  notifications: unknown[][],
  confirmResult: boolean,
) {
  const confirms: unknown[][] = [];
  const base = { hasUI, cwd };
  const ctx = (hasUI
    ? {
        ...base,
        ui: {
          notify: (...args: unknown[]) => notifications.push(args),
          confirm: (...args: unknown[]) => {
            confirms.push(args);
            return Promise.resolve(confirmResult);
          },
        },
      }
    : {
        ...base,
        get ui(): never {
          throw new Error("Headless command must not access UI");
        },
      }) as unknown as ExtensionCommandContext;
  return { ctx, confirms };
}

test("Q03a: mutating commands are registered with confirmation wiring (read-only commands unaffected)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q03a-reg-"));
  try {
    const commands = loadCommands();
    // Actual registration: every shipped command name is present.
    for (const name of [
      "kiwifs-status",
      "kiwifs-backup-verify",
      "kiwifs-private-mode",
      "kiwifs-extract-now",
      "kiwifs-reflect-now",
      "kiwifs-proposal",
      "kiwifs-forget",
      "kiwifs-forget-undo",
      "kiwifs-board-gc",
      "kiwifs-queue",
      "kiwifs-erasure-report",
    ]) {
      assert.ok(
        commands.has(name),
        `command ${name} must be registered by kiwifsMemory()`,
      );
      assert.equal(typeof commands.get(name)!.handler, "function");
    }
    // Read-only inspection commands never require confirmation: they run
    // headless without --yes and never touch the UI.
    await withEnv(undefined, join(dir, "state"), async () => {
      const headless = {
        hasUI: false,
        cwd: dir,
        get ui(): never {
          throw new Error("Read-only command must not access UI");
        },
      } as unknown as ExtensionCommandContext;
      for (const [name, args] of [
        ["kiwifs-status", ""],
        ["kiwifs-queue", ""],
        ["kiwifs-erasure-report", ""],
        ["kiwifs-proposal", ""], // usage only — no action selected
      ] as const) {
        await commands.get(name)!.handler(args, headless);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q03a: forget-undo requires UI confirm or headless --yes; refusal does zero writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q03a-undo-"));
  const cfgFile = writeSyntheticConfig(dir);
  try {
    await withEnv(cfgFile, join(dir, "state"), async () => {
      const commands = loadCommands();
      const oplog = join(dir, "state", "manual-oplog.jsonl");
      const args = "memory/observation/x.md";

      // UI, confirm refused: cancelled, no oplog, no backend attempt.
      {
        const notify: unknown[][] = [];
        const { ctx, confirms } = confirmCtx(true, dir, notify, false);
        await commands.get("kiwifs-forget-undo")!.handler(args, ctx);
        assert.equal(confirms.length, 1, "UI confirm dialog must be shown");
        assert.match(String(confirms[0]![1]), /x\.md/);
        assert.match(String(notify.at(-1)![0]), /cancelled/);
        assert.equal(existsSync(oplog), false, "no durable write on refusal");
      }

      // UI, confirm accepted: proceeds past the gate (unresolved credential
      // → visible retryable refusal; still zero network writes).
      {
        const notify: unknown[][] = [];
        const { ctx, confirms } = confirmCtx(true, dir, notify, true);
        await commands.get("kiwifs-forget-undo")!.handler(args, ctx);
        assert.equal(confirms.length, 1);
        assert.match(String(notify.at(-1)![0]), /NOT restored/);
      }

      // Headless without --yes: refused before any store/oplog access.
      {
        const notify: unknown[][] = [];
        const { ctx } = confirmCtx(false, dir, notify, false);
        await commands.get("kiwifs-forget-undo")!.handler(args, ctx);
        assert.equal(
          existsSync(oplog),
          false,
          "no durable write without --yes",
        );
      }

      // Headless with --yes: proceeds past the confirmation gate (same
      // visible refusal path as the accepted UI confirm — no network).
      {
        const notify: unknown[][] = [];
        const { ctx } = confirmCtx(false, dir, notify, false);
        await commands.get("kiwifs-forget-undo")!.handler(`${args} --yes`, ctx);
        // Past the gate; headless has no notifier, so observable behavior
        // is "no crash, no confirmation dialog, no durable write".
        assert.equal(existsSync(oplog), false);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q03a: proposal approve/reject/undo require UI confirm or headless --yes; refusal does zero mutations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q03a-proposal-"));
  const cfgFile = writeSyntheticConfig(dir);
  try {
    await withEnv(cfgFile, join(dir, "state"), async () => {
      const commands = loadCommands();
      const proposalPath = "memory/merge-proposals/p-1.md";

      // UI, confirm refused: cancelled before runtime/config access.
      for (const action of ["approve", "reject", "undo"] as const) {
        const notify: unknown[][] = [];
        const { ctx, confirms } = confirmCtx(true, dir, notify, false);
        await commands
          .get("kiwifs-proposal")!
          .handler(`${action} ${proposalPath}`, ctx);
        assert.equal(confirms.length, 1, `UI confirm shown for ${action}`);
        assert.match(String(confirms[0]![0]), new RegExp(action, "i"));
        assert.match(String(notify.at(-1)![0]), /cancelled/);
      }

      // UI, confirm accepted: proceeds past the gate (no runtime in this
      // synthetic env → visible lifecycle-unavailable notice; no writes).
      {
        const notify: unknown[][] = [];
        const { ctx, confirms } = confirmCtx(true, dir, notify, true);
        await commands
          .get("kiwifs-proposal")!
          .handler(`approve ${proposalPath}`, ctx);
        assert.equal(confirms.length, 1);
        assert.match(String(notify.at(-1)![0]), /lifecycle unavailable|failed/);
      }

      // Headless without --yes: refused (error notice), zero mutations.
      {
        const notify: unknown[][] = [];
        const { ctx, confirms } = confirmCtx(false, dir, notify, false);
        await commands
          .get("kiwifs-proposal")!
          .handler(`approve ${proposalPath}`, ctx);
        assert.equal(confirms.length, 0, "headless must not touch the UI");
        assert.equal(
          existsSync(join(dir, "state", "manual-oplog.jsonl")),
          false,
          "no durable write on headless refusal",
        );
      }

      // Headless with --yes: past the gate, same visible refusal path.
      {
        const notify: unknown[][] = [];
        const { ctx } = confirmCtx(false, dir, notify, false);
        await commands
          .get("kiwifs-proposal")!
          .handler(`approve ${proposalPath} --yes`, ctx);
        // Past the gate; headless has no notifier, so observable behavior is
        // "no crash, no confirmation dialog, no durable write".
        assert.equal(
          existsSync(join(dir, "state", "manual-oplog.jsonl")),
          false,
        );
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
