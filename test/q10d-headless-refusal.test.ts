/**
 * Q10D: headless refusal notices are OBSERVABLE.
 *
 * Q10B privacy audit finding (non-blocking, fixed here): the headless
 * refusal branches for the four record-mutating commands wrapped their
 * `ui.notify` in `if (ctx.hasUI)` INSIDE a `!ctx.hasUI` branch — dead code,
 * so a headless/RPC caller without `--yes` was refused silently (fail-closed,
 * zero writes, but no signal). The fix emits the refusal unconditionally via
 * a try/catch-guarded notify (same semantics as the /kiwifs-board-cleanup
 * registration), so the refusal is observable in every run mode.
 *
 * Synthetic only: ExtensionAPI-shaped stub + recorder UI, no backend, no
 * model calls, no durable writes. Each case asserts (a) the refusal notice
 * IS emitted in headless mode, (b) it names the required `--yes` token, and
 * (c) nothing else happened (no store/runtime access on the refusal path).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  registerForgetCommands,
  registerPersonalNoteCommand,
  registerProposalCommands,
  type CommandRegistrationDeps,
} from "../src/commands/registration.ts";

type Command = Parameters<
  import("@earendil-works/pi-coding-agent").ExtensionAPI["registerCommand"]
>[1];

function makeApi(): { commands: Map<string, Command>; api: unknown } {
  const commands = new Map<string, Command>();
  const api = {
    registerTool: () => {},
    on: () => {},
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
  };
  return { commands, api };
}

/** Recording deps: config gate is VALID and all runtime access is observed. */
function makeDeps(observed: {
  runtimeAccessed: boolean;
  configAccessed: boolean;
}): CommandRegistrationDeps {
  return {
    runtimeBox: {
      getRuntime: () => {
        observed.runtimeAccessed = true;
        return undefined;
      },
      getRuntimeError: () => {
        observed.runtimeAccessed = true;
        return undefined;
      },
    },
    configGate: () => {
      observed.configAccessed = true;
      return {
        ok: true,
        config: {
          mcp: { url: "http://127.0.0.1:1", auth: "synthetic" },
          scopes: { allowPersonalGlobal: true },
        } as never,
        configFile: undefined,
      };
    },
  };
}

function makeHeadlessCtx() {
  const notes: { message: string; level?: string | undefined }[] = [];
  return {
    notes,
    ctx: {
      hasUI: false,
      cwd: "/tmp",
      ui: {
        notify: (message: string, level?: string) =>
          notes.push({ message, level }),
        confirm: async () => {
          throw new Error("confirm must not be called headless");
        },
      },
      sessionManager: {
        getSessionId: () => "s",
        getEntries: () => [],
      },
    },
  };
}

test("Q10D: headless forget without --yes emits an observable refusal, zero writes", async () => {
  const { commands, api } = makeApi();
  const observed = { runtimeAccessed: false, configAccessed: false };
  registerForgetCommands(api as never, makeDeps(observed));
  const { notes, ctx } = makeHeadlessCtx();
  await commands
    .get("kiwifs-forget")!
    .handler("project/demo/memory/x.md", ctx as never);
  assert.equal(notes.length, 1, "refusal must be emitted headless");
  assert.match(notes[0]!.message, /refused — headless forget requires --yes/);
  assert.equal(notes[0]!.level, "error");
  // Refusal path must not touch the runtime (fail-closed, zero mutations).
  assert.equal(observed.runtimeAccessed, false);
});

test("Q10D: headless forget-undo without --yes emits an observable refusal", async () => {
  const { commands, api } = makeApi();
  const observed = { runtimeAccessed: false, configAccessed: false };
  registerForgetCommands(api as never, makeDeps(observed));
  const { notes, ctx } = makeHeadlessCtx();
  await commands
    .get("kiwifs-forget-undo")!
    .handler("project/demo/memory/x.md", ctx as never);
  assert.equal(notes.length, 1, "refusal must be emitted headless");
  assert.match(
    notes[0]!.message,
    /refused — headless forget-undo requires --yes/,
  );
  assert.equal(notes[0]!.level, "error");
  assert.equal(observed.runtimeAccessed, false);
});

test("Q10D: headless proposal transition without --yes emits an observable refusal", async () => {
  const { commands, api } = makeApi();
  const observed = { runtimeAccessed: false, configAccessed: false };
  registerProposalCommands(api as never, makeDeps(observed));
  const { notes, ctx } = makeHeadlessCtx();
  await commands
    .get("kiwifs-proposal")!
    .handler("approve proposals/p.md", ctx as never);
  assert.equal(notes.length, 1, "refusal must be emitted headless");
  assert.match(
    notes[0]!.message,
    /refused — headless proposal transitions require --yes/,
  );
  assert.equal(notes[0]!.level, "error");
  assert.equal(observed.runtimeAccessed, false);
});

test("Q10D: headless personal-note without --yes emits an observable refusal", async () => {
  const { commands, api } = makeApi();
  const observed = { runtimeAccessed: false, configAccessed: false };
  registerPersonalNoteCommand(api as never, makeDeps(observed));
  const { notes, ctx } = makeHeadlessCtx();
  await commands
    .get("kiwifs-personal-note")!
    .handler("synthetic note statement", ctx as never);
  assert.equal(notes.length, 1, "refusal must be emitted headless");
  assert.match(
    notes[0]!.message,
    /refused — headless personal-note requires --yes/,
  );
  assert.equal(notes[0]!.level, "error");
  assert.equal(observed.runtimeAccessed, false);
});

test("Q10D: headless refusals survive a bare headless host that throws on ui access", async () => {
  const { commands, api } = makeApi();
  registerForgetCommands(
    api as never,
    makeDeps({ runtimeAccessed: false, configAccessed: false }),
  );
  // ctx.ui present but notify throws (bare headless host) — handler must
  // still refuse (return, zero writes) without crashing.
  await commands.get("kiwifs-forget")!.handler("project/demo/memory/x.md", {
    hasUI: false,
    cwd: "/tmp",
    ui: {
      notify: () => {
        throw new Error("no UI object in this host");
      },
    },
    sessionManager: { getSessionId: () => "s", getEntries: () => [] },
  } as never);
  assert.ok(true, "handler returned without throwing");
});
