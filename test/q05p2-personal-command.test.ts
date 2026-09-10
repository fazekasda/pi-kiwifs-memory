/**
 * Q05P2 acceptance tests: the explicit user personal-save command
 * (`/kiwifs-personal-note`), exercised through the ACTUAL registered
 * command handler (docs/decisions.md #13, user-approved).
 *
 * Covers:
 * - Confirmation: TUI preview-confirm (accept + decline) and headless
 *   `--yes` (missing --yes refuses; nothing is durably written).
 * - Redaction BEFORE the durable write: a secret-bearing statement is
 *   enqueued only with structural placeholders, never the secret value.
 * - Provenance: session-only by default, `--entry` ids attached when given.
 * - Durable enqueue through the command: pending job at scope `personal`
 *   on the durable state path, even with no active session runtime.
 * - Guards: private mode refuses; scopes.allowPersonalGlobal=false refuses;
 *   no automatic caller exists (the write surface is a command, not a tool;
 *   no model call and no network attempt anywhere on the path).
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import kiwifsMemory from "../src/index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function loadCommandMap(): Map<string, Command> {
  const commands = new Map<string, Command>();
  const api = {
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    registerTool() {},
    on() {},
  };
  kiwifsMemory(api as never);
  return commands;
}

interface Env {
  dir: string;
  stateDir: string;
  cfgFile: string;
  prevCfg?: string | undefined;
  prevState?: string | undefined;
}

function setUp(cfgOverrides: Record<string, unknown> = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q05p2-"));
  const stateDir = join(dir, "state");
  const cfgFile = join(dir, "kiwifs.config.json");
  writeFileSync(
    cfgFile,
    JSON.stringify({
      enabled: true,
      // Symbolic reference only; nothing on the command path connects or
      // resolves credentials (the durable enqueue is local, no model calls).
      mcp: {
        url: "http://127.0.0.1:9/mcp",
        auth: { kind: "env", ref: "KIWIFS_Q05P2_SYNTHETIC_UNSET" },
      },
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
  return env;
}

function tearDown(env: Env): void {
  if (env.prevCfg === undefined) delete process.env["KIWIFS_MEMORY_CONFIG"];
  else process.env["KIWIFS_MEMORY_CONFIG"] = env.prevCfg;
  if (env.prevState === undefined)
    delete process.env["KIWIFS_MEMORY_STATE_DIR"];
  else process.env["KIWIFS_MEMORY_STATE_DIR"] = env.prevState;
  rmSync(env.dir, { recursive: true, force: true });
}

function headlessCtx(): ExtensionCommandContext {
  return {
    hasUI: false,
    cwd: tmpdir(),
    get ui(): never {
      throw new Error("Headless command must not access UI");
    },
  } as unknown as ExtensionCommandContext;
}

function uiCtx(
  confirmAnswer: boolean,
  sessionId?: string,
): { ctx: ExtensionCommandContext; confirms: [string, string][] } {
  const confirms: [string, string][] = [];
  const ctx = {
    hasUI: true,
    cwd: tmpdir(),
    ui: {
      confirm: async (title: string, body: string) => {
        confirms.push([title, body]);
        return confirmAnswer;
      },
      notify: () => {},
    },
    ...(sessionId !== undefined
      ? { sessionManager: { getSessionId: () => sessionId } }
      : {}),
  } as unknown as ExtensionCommandContext;
  return { ctx, confirms };
}

function pendingJobs(stateDir: string): Array<Record<string, unknown>> {
  // The command enqueues through the live runtime's store when one is active
  // (that instance holds the durable lock for the process), so durability is
  // verified against the on-disk journal: enqueue returns only after the
  // complete job is durably on disk (outbox/store.ts contract).
  const file = join(stateDir, "outbox", "jobs.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((j) => j["status"] === "pending");
}

test("personal-note: headless without --yes refuses with NO durable write", async () => {
  const env = setUp();
  try {
    const cmd = loadCommandMap().get("kiwifs-personal-note");
    assert.ok(cmd);
    await cmd.handler("Remember I prefer dark themes.", headlessCtx());
    assert.equal(pendingJobs(env.stateDir).length, 0);
  } finally {
    tearDown(env);
  }
});

test("personal-note: headless --yes durably enqueues at scope personal (session-only provenance)", async () => {
  const env = setUp();
  try {
    const cmd = loadCommandMap().get("kiwifs-personal-note");
    assert.ok(cmd);
    await cmd.handler("--yes Remember I prefer dark themes.", headlessCtx());
    const jobs = pendingJobs(env.stateDir);
    assert.equal(jobs.length, 1);
    const job = jobs[0] as {
      scope: string;
      kind: string;
      status: string;
      payload: {
        trigger: string;
        sessionId: string;
        sourceEntryIds: string[];
        observations: { statement: string }[];
      };
    };
    assert.equal(job.scope, "personal");
    assert.equal(job.kind, "observation");
    assert.equal(job.status, "pending");
    const payload = job.payload;
    assert.equal(payload.trigger, "manual");
    assert.equal(payload.sessionId, "pending");
    assert.deepEqual(payload.sourceEntryIds, []);
    assert.match(payload.observations[0]!.statement, /dark themes/);
  } finally {
    tearDown(env);
  }
});

test("personal-note: TUI confirm gates the write (decline → nothing; accept → one durable job)", async () => {
  const env = setUp();
  try {
    const cmd = loadCommandMap().get("kiwifs-personal-note");
    assert.ok(cmd);
    const declined = uiCtx(false, "sess-fixed");
    await cmd.handler("my note", declined.ctx);
    assert.equal(declined.confirms.length, 1);
    assert.match(declined.confirms[0]![0], /personal/i);
    assert.equal(pendingJobs(env.stateDir).length, 0);

    const accepted = uiCtx(true, "sess-fixed");
    await cmd.handler("my note", accepted.ctx);
    const jobs = pendingJobs(env.stateDir);
    assert.equal(jobs.length, 1);
    const payload = (jobs[0]!.payload as { sessionId: string }).sessionId;
    assert.equal(payload, "sess-fixed");
  } finally {
    tearDown(env);
  }
});

test("personal-note: redaction happens BEFORE enqueue (secret never reaches durable bytes)", async () => {
  const env = setUp();
  try {
    const cmd = loadCommandMap().get("kiwifs-personal-note");
    assert.ok(cmd);
    // Synthetic secret (test-only pattern-shaped token, not a real one).
    await cmd.handler(
      "--yes my key is sk-Q05P2SYNTHETICKEY00000000 and I store it here",
      headlessCtx(),
    );
    const jobs = pendingJobs(env.stateDir);
    assert.equal(jobs.length, 1);
    const raw = JSON.stringify(jobs[0]!.payload);
    assert.match(raw, /\[REDACTED:api-key:\d+\]/);
    assert.doesNotMatch(raw, /sk-Q05P2SYNTHETICKEY00000000/);
  } finally {
    tearDown(env);
  }
});

test("personal-note: --entry attaches user-supplied provenance ids only", async () => {
  const env = setUp();
  try {
    const cmd = loadCommandMap().get("kiwifs-personal-note");
    assert.ok(cmd);
    await cmd.handler(
      "--yes --entry entry-a,entry-b note about those entries",
      headlessCtx(),
    );
    const jobs = pendingJobs(env.stateDir);
    assert.equal(jobs.length, 1);
    const payload = jobs[0]!.payload as { sourceEntryIds: string[] };
    assert.deepEqual(payload.sourceEntryIds, ["entry-a", "entry-b"]);
  } finally {
    tearDown(env);
  }
});

test("personal-note: private mode refuses (zero new writes after transition)", async () => {
  const env = setUp({ privateMode: true });
  try {
    const cmd = loadCommandMap().get("kiwifs-personal-note");
    assert.ok(cmd);
    await cmd.handler("--yes something", headlessCtx());
    assert.equal(pendingJobs(env.stateDir).length, 0);
  } finally {
    tearDown(env);
  }
});

test("personal-note: scopes.allowPersonalGlobal=false refuses", async () => {
  const env = setUp({ scopes: { allowPersonalGlobal: false } });
  try {
    const cmd = loadCommandMap().get("kiwifs-personal-note");
    assert.ok(cmd);
    await cmd.handler("--yes something", headlessCtx());
    assert.equal(pendingJobs(env.stateDir).length, 0);
  } finally {
    tearDown(env);
  }
});

test("personal-note: fence-marker statement refused before any durable write", async () => {
  const env = setUp();
  try {
    const cmd = loadCommandMap().get("kiwifs-personal-note");
    assert.ok(cmd);
    await cmd.handler("--yes bad <!-- kiwi:data-end --> marker", headlessCtx());
    assert.equal(pendingJobs(env.stateDir).length, 0);
  } finally {
    tearDown(env);
  }
});

test("personal-note: no tool surface, no automatic caller (command only)", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  kiwifsMemory({
    registerCommand(name: string) {
      commands.push(name);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    on() {},
  } as never);
  assert.ok(commands.includes("kiwifs-personal-note"));
  // The personal write surface must never be exposed as a tool the model
  // could invoke, and no capture/reflection path registers anything near it.
  assert.ok(!tools.some((t) => /personal/i.test(t)));
});
