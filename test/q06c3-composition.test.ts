/**
 * Q06C3: the remaining board (cleanup/gc), backup-verify and control
 * (status/private-mode/queue/erasure-report) command registration moved out
 * of index into focused modules under src/commands/ with explicit deps.
 * These tests exercise the ACTUAL registration functions (not copies) and
 * the shipped composition (kiwifsMemory), and prove the composition
 * contract: a registration call with MISSING required dependencies fails
 * closed at composition time (never a silent mid-command no-op).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  registerBoardCleanupCommand,
  registerBoardGcCommand,
} from "../src/commands/board-commands.ts";
import { registerBackupVerifyCommand } from "../src/commands/backup-commands.ts";
import {
  registerErasureReportCommand,
  registerPrivateModeCommand,
  registerQueueCommand,
  registerStatusCommand,
} from "../src/commands/control-commands.ts";
import {
  registerObservationCommands,
  type CommandRegistrationDeps,
} from "../src/commands/registration.ts";
import kiwifsMemory from "../src/index.ts";

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

function makeDeps(): CommandRegistrationDeps {
  return {
    runtimeBox: {
      getRuntime: () => undefined,
      getRuntimeError: () => "runtime unavailable",
    },
    configGate: () => ({ ok: false, notice: "config: INVALID" }),
  };
}

const ALL_COMMANDS = [
  "kiwifs-status",
  "kiwifs-backup-verify",
  "kiwifs-private-mode",
  "kiwifs-extract-now",
  "kiwifs-reflect-now",
  "kiwifs-proposal",
  "kiwifs-forget",
  "kiwifs-forget-undo",
  "kiwifs-personal-note",
  "kiwifs-board-cleanup",
  "kiwifs-board-gc",
  "kiwifs-queue",
  "kiwifs-erasure-report",
] as const;

test("Q06C3: focused registration functions register their commands verbatim", () => {
  const { commands, api } = makeApi();
  const pi = api as Parameters<typeof kiwifsMemory>[0];

  registerStatusCommand(pi);
  registerBackupVerifyCommand(pi);
  registerPrivateModeCommand(pi, {
    controlSurface: () => {
      throw new Error("not called at registration time");
    },
  });
  registerObservationCommands(pi, makeDeps());
  registerBoardCleanupCommand(pi, makeDeps());
  registerBoardGcCommand(pi, makeDeps());
  registerQueueCommand(pi, makeDeps());
  registerErasureReportCommand(pi);

  // The commands registered by THESE modules (Q06C2's proposal/forget/
  // personal-note groups are exercised by test/q06c2-commands.test.ts).
  const expected = [
    "kiwifs-status",
    "kiwifs-backup-verify",
    "kiwifs-private-mode",
    "kiwifs-extract-now",
    "kiwifs-reflect-now",
    "kiwifs-board-cleanup",
    "kiwifs-board-gc",
    "kiwifs-queue",
    "kiwifs-erasure-report",
  ] as const;
  for (const name of expected) {
    const cmd = commands.get(name as string);
    assert.ok(cmd, `${name} must be registered`);
    if (!cmd) continue;
    assert.equal(typeof cmd.handler, "function", `${name} needs a handler`);
    assert.match(cmd.description ?? "", /\S/, `${name} keeps its description`);
  }
  assert.equal(commands.size, expected.length);
});

test("Q06C3: shipped composition registers the full command set", () => {
  const { commands, api } = makeApi();
  kiwifsMemory(api as Parameters<typeof kiwifsMemory>[0]);
  for (const name of ALL_COMMANDS) {
    assert.ok(commands.has(name), `${name} must come from index composition`);
  }
  assert.equal(commands.size, ALL_COMMANDS.length);
});

test("Q06C3: missing required dependencies fail closed at composition time", () => {
  const { api } = makeApi();
  const pi = api as Parameters<typeof kiwifsMemory>[0];
  const badDeps = makeDeps();
  const broken: CommandRegistrationDeps = {
    ...badDeps,
    runtimeBox: { getRuntime: undefined as never, getRuntimeError: () => "" },
  };

  assert.throws(
    () => registerObservationCommands(pi, undefined as never),
    /fail closed/,
  );
  assert.throws(() => registerObservationCommands(pi, broken), /fail closed/);
  assert.throws(
    () => registerBoardCleanupCommand(pi, undefined as never),
    /fail closed/,
  );
  assert.throws(() => registerBoardCleanupCommand(pi, broken), /fail closed/);
  assert.throws(
    () => registerBoardGcCommand(pi, undefined as never),
    /fail closed/,
  );
  assert.throws(() => registerBoardGcCommand(pi, broken), /fail closed/);
  assert.throws(
    () => registerQueueCommand(pi, undefined as never),
    /fail closed/,
  );
  assert.throws(() => registerQueueCommand(pi, broken), /fail closed/);
  // Private-mode toggle without a control-surface factory must never
  // silently no-op: it would persist nothing and cancel nothing.
  assert.throws(
    () => registerPrivateModeCommand(pi, undefined as never),
    /fail closed/,
  );
  assert.throws(
    () => registerPrivateModeCommand(pi, {} as never),
    /fail closed/,
  );
});

test("Q06C3: buildRuntimeControlSurface moved to runtime/controls.ts, re-exported by index", async () => {
  const fromIndex = await import("../src/index.ts");
  const fromControls = await import("../src/runtime/controls.ts");
  assert.equal(
    fromIndex.buildRuntimeControlSurface,
    fromControls.buildRuntimeControlSurface,
  );
  assert.equal(typeof fromControls.buildRuntimeControlSurface, "function");
});
