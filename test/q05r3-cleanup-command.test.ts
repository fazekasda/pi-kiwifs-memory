/**
 * Q05R3 acceptance tests: the explicit manual REMOTE board cleanup command
 * (`/kiwifs-board-cleanup`), exercised through the ACTUAL registered
 * command handler (decisions.md #14, user-approved manual cleanup).
 *
 * Synthetic only: fake MCP server behind a stubbed global fetch — no live
 * service, no real model, no network beyond the in-process fake.
 *
 * Covers the Q05R3 task contract:
 * - distinct name/semantics from /kiwifs-board-gc (local prune untouched;
 *   `--yes` here is REFUSED — an old local flag never deletes remotely)
 * - headless two-step: plain run = preview only + confirmation token
 *   binding the EXACT candidate set; `--confirm <token>` executes only
 *   when the token binds a FRESH re-plan; mismatched/changed set refuses
 *   with zero deletes
 * - TUI preview + ui.confirm binds the exact preview object (decline = no
 *   deletes; body discloses the no-CAS race and MCP-level deletion)
 * - production wiring: command path performs NO backend writes without
 *   explicit consent; deletes ride the guarded executor (fresh rechecks,
 *   persist-before-side-effect opIds, local ack state untouched)
 * - fail-closed guards: private mode, disabled board feature, bad sender
 *   grammar, unresolvable credential
 * - no tool surface for cleanup (command-only; no model/automatic caller)
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import kiwifsMemory from "../src/index.ts";
import { KiwiFSAdapter } from "../src/backend/adapter.ts";
import { createMemoryLedger, mintOpId } from "../src/backend/opid.ts";
import { BoardRepository } from "../src/board/repository.ts";
import { GC_GRACE_MS } from "../src/board/cleanup-rules.ts";
import { createFakeServer, type FakeServerState } from "./fake-mcp-server.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

const URL_ = "https://kiwifs.test/mcp";
const OWN = "agent-a";
const CHANNEL = "project-alpha";
/** Own + TTL-expired far beyond the 30-day grace → eligible. */
const OLD = new Date(Date.now() - GC_GRACE_MS - 40 * 24 * 60 * 60 * 1000);

function loadCommandMap(): {
  commands: Map<string, Command>;
  toolNames: string[];
} {
  const commands = new Map<string, Command>();
  const toolNames: string[] = [];
  const api = {
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    registerTool(tool: { name: string }) {
      toolNames.push(tool.name);
    },
    on() {},
  };
  kiwifsMemory(api as never);
  return { commands, toolNames };
}

interface Env {
  dir: string;
  stateDir: string;
  cfgFile: string;
  prevCfg?: string | undefined;
  prevState?: string | undefined;
}

function setUp(cfgOverrides: Record<string, unknown> = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q05r3-"));
  const stateDir = join(dir, "state");
  const cfgFile = join(dir, "kiwifs.config.json");
  writeFileSync(
    cfgFile,
    JSON.stringify({
      enabled: true,
      mcp: {
        // Never dialed for real: the fetch stub routes to the in-process
        // fake server; the credential env var is a synthetic dummy value.
        url: URL_,
        auth: { kind: "env", ref: "KIWIFS_Q05R3_SYNTHETIC_CRED" },
      },
      board: { consumerId: "consumer-q05r3" },
      ...cfgOverrides,
    }),
  );
  const env: Env = {
    dir,
    stateDir,
    cfgFile,
    prevCfg: process.env["KIWIFS_MEMORY_CONFIG"],
    prevState: process.env["KIWIFS_MEMORY_STATE_DIR"],
  };
  process.env["KIWIFS_MEMORY_CONFIG"] = cfgFile;
  process.env["KIWIFS_MEMORY_STATE_DIR"] = stateDir;
  process.env["KIWIFS_Q05R3_SYNTHETIC_CRED"] = "synthetic-not-a-secret";
  return env;
}

function tearDown(env: Env): void {
  if (env.prevCfg === undefined) delete process.env["KIWIFS_MEMORY_CONFIG"];
  else process.env["KIWIFS_MEMORY_CONFIG"] = env.prevCfg;
  if (env.prevState === undefined)
    delete process.env["KIWIFS_MEMORY_STATE_DIR"];
  else process.env["KIWIFS_MEMORY_STATE_DIR"] = env.prevState;
  delete process.env["KIWIFS_Q05R3_SYNTHETIC_CRED"];
  rmSync(env.dir, { recursive: true, force: true });
}

/** Routes EVERY fetch to the in-process fake server (no real network). */
function stubFetch(server: ReturnType<typeof createFakeServer>): () => void {
  const prev = globalThis.fetch;
  globalThis.fetch = server.fetch as typeof fetch;
  return () => {
    globalThis.fetch = prev;
  };
}

/** Seeds eligible (own+expired+past grace) and ineligible board messages. */
async function seed(
  server: ReturnType<typeof createFakeServer>,
  msgs: Array<{ from: string; created: Date; ttlSeconds?: number }>,
): Promise<void> {
  const ledger = createMemoryLedger();
  const adapter = new KiwiFSAdapter({
    url: URL_,
    requestTimeoutMs: 250,
    fetchImpl: server.fetch,
    ledger,
  });
  const repo = new BoardRepository(adapter);
  for (const m of msgs) {
    const opId = mintOpId();
    ledger.record(opId);
    const res = await repo.send(
      {
        channel: CHANNEL,
        from: m.from,
        to: "agent-b",
        body: "body (opaque, never shown by the command)",
        ...(m.ttlSeconds !== undefined ? { ttlSeconds: m.ttlSeconds } : {}),
        created: m.created,
      },
      opId,
    );
    assert.ok(res.ok);
  }
  // The command opens its own adapter; drop this one (no disconnect API).
}

interface HeadlessCtx {
  ctx: ExtensionCommandContext;
  notes: Array<{ message: string; type?: string | undefined }>;
}

/** Headless/RPC context: notify captured; any dialog attempt throws. */
function headlessCtx(): HeadlessCtx {
  const notes: Array<{ message: string; type?: string }> = [];
  const ctx = {
    hasUI: false,
    cwd: tmpdir(),
    ui: {
      notify: (message: string, type?: string | undefined) => {
        notes.push(type === undefined ? { message } : { message, type });
      },
      confirm: async () => {
        throw new Error("headless run must never open a confirm dialog");
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notes };
}

interface UiCtx {
  ctx: ExtensionCommandContext;
  notes: Array<{ message: string; type?: string | undefined }>;
  confirms: Array<{ title: string; body: string }>;
}

function uiCtx(confirmAnswer: boolean): UiCtx {
  const notes: Array<{ message: string; type?: string }> = [];
  const confirms: Array<{ title: string; body: string }> = [];
  const ctx = {
    hasUI: true,
    cwd: tmpdir(),
    ui: {
      notify: (message: string, type?: string | undefined) => {
        notes.push(type === undefined ? { message } : { message, type });
      },
      confirm: async (title: string, body: string) => {
        confirms.push({ title, body });
        return confirmAnswer;
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notes, confirms };
}

/** Count of kiwi_delete calls the fake backend actually served. */
function deleteCount(state: FakeServerState): number {
  return state.requests.filter((r) => r.body.includes("kiwi_delete")).length;
}

// ------------------------------------------------------------ registry ----

test("board-cleanup is a registered COMMAND and is NOT exposed as a tool", () => {
  const { commands, toolNames } = loadCommandMap();
  assert.ok(commands.get("kiwifs-board-cleanup"));
  assert.ok(
    !toolNames.some((n) => n.toLowerCase().includes("cleanup")),
    "cleanup must have no tool surface (no automatic caller, no model path)",
  );
});

// ------------------------------------------------ headless two-step -------

test("headless without --confirm is PREVIEW ONLY: token printed, zero backend writes", async () => {
  const env = setUp();
  const server = createFakeServer();
  const undo = stubFetch(server);
  try {
    await seed(server, [
      { from: OWN, created: OLD, ttlSeconds: 60 },
      { from: "agent-b", created: OLD, ttlSeconds: 60 }, // not ours
    ]);
    const cmd = loadCommandMap().commands.get("kiwifs-board-cleanup");
    assert.ok(cmd);
    const { ctx, notes } = headlessCtx();
    await cmd.handler(`${OWN}`, ctx);
    // No deletes happened: both messages still on the backend.
    assert.equal(deleteCount(server.state), 0);
    assert.equal(server.state.store.size, 2);
    const out = notes.map((n) => n.message).join("\n");
    assert.match(out, /confirmation token: bc-[0-9a-f]{16}/);
    assert.match(out, /PREVIEW ONLY/);
    assert.match(out, /1 candidate/); // only OWN + TTL-expired
    assert.match(out, /no compare-and-swap/); // race disclosure surfaced
  } finally {
    undo();
    tearDown(env);
  }
});

test("headless --confirm with the previewed token deletes exactly the candidates", async () => {
  const env = setUp();
  const server = createFakeServer();
  const undo = stubFetch(server);
  try {
    await seed(server, [
      { from: OWN, created: OLD, ttlSeconds: 60 },
      { from: "agent-b", created: OLD, ttlSeconds: 60 },
    ]);
    const cmd = loadCommandMap().commands.get("kiwifs-board-cleanup");
    assert.ok(cmd);
    const step1 = headlessCtx();
    await cmd.handler(`${OWN}`, step1.ctx);
    const token = /confirmation token: (bc-[0-9a-f]{16})/.exec(
      step1.notes.map((n) => n.message).join("\n"),
    )?.[1];
    assert.ok(token, "preview must print a token");
    const before = new Set([...server.state.store.keys()]);
    const { ctx, notes } = headlessCtx();
    await cmd.handler(`${OWN} --confirm ${token}`, ctx);
    // Exactly one own message deleted; the other consumer's message stays.
    assert.equal(deleteCount(server.state), 1);
    const after = new Set([...server.state.store.keys()]);
    const gone = [...before].filter((p) => !after.has(p));
    assert.equal(gone.length, 1);
    assert.match(gone[0]!, new RegExp(`board/${CHANNEL}/[0-9a-f]{16}\\.md`));
    const out = notes.map((n) => n.message).join("\n");
    assert.match(out, /deleted 1/);
    assert.match(out, /no compare-and-swap/);
    assert.match(out, /local ack state was NOT modified/);
  } finally {
    undo();
    tearDown(env);
  }
});

test("headless --confirm with a WRONG token refuses with zero deletes", async () => {
  const env = setUp();
  const server = createFakeServer();
  const undo = stubFetch(server);
  try {
    await seed(server, [{ from: OWN, created: OLD, ttlSeconds: 60 }]);
    const cmd = loadCommandMap().commands.get("kiwifs-board-cleanup");
    assert.ok(cmd);
    const { ctx, notes } = headlessCtx();
    await cmd.handler(`${OWN} --confirm bc-0000000000000000`, ctx);
    assert.equal(deleteCount(server.state), 0);
    const out = notes.map((n) => n.message).join("\n");
    assert.match(out, /refused/);
    assert.match(out, /Zero deletes were performed/);
  } finally {
    undo();
    tearDown(env);
  }
});

test("a candidate-set change between preview and confirm changes the token — old token refuses", async () => {
  const env = setUp();
  const server = createFakeServer();
  const undo = stubFetch(server);
  try {
    await seed(server, [{ from: OWN, created: OLD, ttlSeconds: 60 }]);
    const cmd = loadCommandMap().commands.get("kiwifs-board-cleanup");
    assert.ok(cmd);
    const step1 = headlessCtx();
    await cmd.handler(`${OWN}`, step1.ctx);
    const token = /confirmation token: (bc-[0-9a-f]{16})/.exec(
      step1.notes.map((n) => n.message).join("\n"),
    )?.[1];
    assert.ok(token);
    // A NEW own eligible message appears after the user saw the preview.
    await seed(server, [{ from: OWN, created: OLD, ttlSeconds: 60 }]);
    const { ctx, notes } = headlessCtx();
    await cmd.handler(`${OWN} --confirm ${token}`, ctx);
    assert.equal(deleteCount(server.state), 0);
    const out = notes.map((n) => n.message).join("\n");
    assert.match(out, /candidate set changed/);
    assert.match(out, /Re-run the preview/);
  } finally {
    undo();
    tearDown(env);
  }
});

test("headless --yes is REFUSED: that flag belongs to the LOCAL /kiwifs-board-gc prune", async () => {
  const env = setUp();
  const server = createFakeServer();
  const undo = stubFetch(server);
  try {
    await seed(server, [{ from: OWN, created: OLD, ttlSeconds: 60 }]);
    const cmd = loadCommandMap().commands.get("kiwifs-board-cleanup");
    assert.ok(cmd);
    const { ctx, notes } = headlessCtx();
    await cmd.handler(`${OWN} --yes`, ctx);
    assert.equal(deleteCount(server.state), 0);
    const out = notes.map((n) => n.message).join("\n");
    assert.match(out, /--yes belongs to \/kiwifs-board-gc/);
    assert.match(out, /--confirm/);
  } finally {
    undo();
    tearDown(env);
  }
});

// ------------------------------------------------------- TUI confirm ------

test("TUI: ui.confirm binds the exact preview — accept deletes, decline does not", async () => {
  const env = setUp();
  const server = createFakeServer();
  const undo = stubFetch(server);
  try {
    const cmd = loadCommandMap().commands.get("kiwifs-board-cleanup");
    assert.ok(cmd);

    // Decline path: nothing deleted, cancellation is explicit.
    await seed(server, [{ from: OWN, created: OLD, ttlSeconds: 60 }]);
    const declined = uiCtx(false);
    await cmd.handler(`${OWN}`, declined.ctx);
    assert.equal(deleteCount(server.state), 0);
    assert.equal(declined.confirms.length, 1);
    assert.match(declined.confirms[0]!.title, /Remote board cleanup/);
    const body = declined.confirms[0]!.body;
    assert.match(body, /no compare-and-swap/);
    assert.match(body, /LOCAL ack state is not modified/);
    assert.match(
      declined.notes.map((n) => n.message).join("\n"),
      /cancelled — nothing was deleted/,
    );

    // Accept path: the exact previewed message is deleted.
    const accepted = uiCtx(true);
    await cmd.handler(`${OWN}`, accepted.ctx);
    console.error("NOTES", JSON.stringify(accepted.notes));
    assert.equal(deleteCount(server.state), 1);
    const out = accepted.notes.map((n) => n.message).join("\n");
    assert.match(out, /deleted 1/);
    assert.match(out, /no history\/index\/backup purge/);
    assert.match(out, /no secure erasure/);
    assert.match(out, /no all-consumer-ack claim/);
  } finally {
    undo();
    tearDown(env);
  }
});

// ------------------------------------------------------- fail-closed ------

test("private mode refuses before ANY backend call", async () => {
  const env = setUp({ privateMode: true });
  const server = createFakeServer();
  const undo = stubFetch(server);
  try {
    const cmd = loadCommandMap().commands.get("kiwifs-board-cleanup");
    assert.ok(cmd);
    const { ctx, notes } = headlessCtx();
    await cmd.handler(`${OWN}`, ctx);
    assert.equal(server.state.requests.length, 0, "zero backend reads/writes");
    assert.match(notes[0]!.message, /private mode active/);
  } finally {
    undo();
    tearDown(env);
  }
});

test("a sender id failing the strict grammar is refused before any backend call", async () => {
  const env = setUp();
  const server = createFakeServer();
  const undo = stubFetch(server);
  try {
    const cmd = loadCommandMap().commands.get("kiwifs-board-cleanup");
    assert.ok(cmd);
    for (const bad of ["../etc", "UPPER", "a_b"]) {
      const { ctx, notes } = headlessCtx();
      await cmd.handler(bad, ctx);
      assert.equal(server.state.requests.length, 0, bad);
      assert.match(notes[0]!.message, /sender identity refused/);
    }
  } finally {
    undo();
    tearDown(env);
  }
});

test("unresolvable backend credential fails closed with a retryable notice", async () => {
  const env = setUp();
  delete process.env["KIWIFS_Q05R3_SYNTHETIC_CRED"];
  const server = createFakeServer();
  const undo = stubFetch(server);
  try {
    const cmd = loadCommandMap().commands.get("kiwifs-board-cleanup");
    assert.ok(cmd);
    const { ctx, notes } = headlessCtx();
    await cmd.handler(`${OWN}`, ctx);
    assert.equal(server.state.requests.length, 0);
    assert.match(
      notes[0]!.message,
      /backend not configured or credential unresolved/,
    );
  } finally {
    undo();
    tearDown(env);
  }
});

test("disabled extension and disabled board feature refuse visibly", async () => {
  const cmd = loadCommandMap().commands.get("kiwifs-board-cleanup");
  assert.ok(cmd);
  const off = setUp({ enabled: false });
  try {
    const { ctx, notes } = headlessCtx();
    await cmd.handler(`${OWN}`, ctx);
    assert.match(notes[0]!.message, /extension disabled/);
  } finally {
    tearDown(off);
  }
  const noBoard = setUp({
    features: { observation: true, backup: true, board: false },
  });
  try {
    const { ctx, notes } = headlessCtx();
    await cmd.handler(`${OWN}`, ctx);
    assert.match(notes[0]!.message, /board feature disabled/);
  } finally {
    tearDown(noBoard);
  }
});

// --------------------------------------- /kiwifs-board-gc stays local -----

test("the LOCAL prune command keeps its own --yes semantics and never touches the backend", async () => {
  const env = setUp();
  const server = createFakeServer();
  const undo = stubFetch(server);
  try {
    const cmd = loadCommandMap().commands.get("kiwifs-board-gc");
    assert.ok(cmd);
    const { ctx } = headlessCtx();
    // Old local flag: still valid for the local prune, still local-only.
    await cmd.handler("--yes", ctx);
    assert.equal(
      server.state.requests.length,
      0,
      "board-gc never calls the backend",
    );
  } finally {
    undo();
    tearDown(env);
  }
});
