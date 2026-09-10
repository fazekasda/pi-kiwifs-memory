/**
 * Q06C2: the observation / proposal / forget / personal-note command
 * registration moved out of index into src/commands/registration.ts with
 * explicit deps. These tests execute the ACTUAL registration functions
 * (not copies) against an ExtensionAPI-shaped stub, plus the real index
 * composition (kiwifsMemory) to prove the moved group is still registered
 * in the shipped entrypoint.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  registerForgetCommands,
  registerObservationCommands,
  registerPersonalNoteCommand,
  registerProposalCommands,
  type CommandRegistrationDeps,
} from "../src/commands/registration.ts";
import kiwifsMemory from "../src/index.ts";

type Command = Parameters<
  import("@earendil-works/pi-coding-agent").ExtensionAPI["registerCommand"]
>[1];

function makeApi(): {
  commands: Map<string, Command>;
  api: unknown;
} {
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

function makeDeps(): CommandRegistrationDeps {
  return {
    runtimeBox: {
      getRuntime: () => undefined,
      getRuntimeError: () => "runtime unavailable",
    },
    configGate: () => ({ ok: false, notice: "config: INVALID" }),
  };
}

function makeCtx() {
  const notes: string[] = [];
  return {
    notes,
    ctx: {
      hasUI: true,
      cwd: "/tmp",
      ui: {
        notify: (message: string) => notes.push(message),
        confirm: async () => false,
      },
      sessionManager: {
        getSessionId: () => "s",
        getEntries: () => [],
      },
    },
  };
}

test("Q06C2: extracted registration functions register the four command groups", () => {
  const { commands, api } = makeApi();
  const deps = makeDeps();
  registerObservationCommands(api as never, deps);
  registerProposalCommands(api as never, deps);
  registerForgetCommands(api as never, deps);
  registerPersonalNoteCommand(api as never, deps);
  for (const name of [
    "kiwifs-extract-now",
    "kiwifs-reflect-now",
    "kiwifs-proposal",
    "kiwifs-forget",
    "kiwifs-forget-undo",
    "kiwifs-personal-note",
  ]) {
    assert.ok(commands.has(name), `${name} registered by the moved module`);
  }
});

test("Q06C2: moved handlers preserve gate semantics (config gate holds before runtime access)", async () => {
  const { commands, api } = makeApi();
  const deps = makeDeps();
  registerObservationCommands(api as never, deps);
  const { ctx, notes } = makeCtx();
  await commands.get("kiwifs-extract-now")!.handler("", ctx as never);
  assert.deepEqual(notes, ["config: INVALID"]);
});

test("Q06C2: shipped index composition still registers the moved commands (one-way direction)", async () => {
  const { commands, api } = makeApi();
  kiwifsMemory(api as never);
  for (const name of [
    "kiwifs-extract-now",
    "kiwifs-reflect-now",
    "kiwifs-proposal",
    "kiwifs-forget",
    "kiwifs-forget-undo",
    "kiwifs-personal-note",
  ]) {
    assert.ok(commands.has(name), `${name} registered through index`);
  }
});
