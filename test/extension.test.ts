import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import kiwifsMemory, { STATUS_MESSAGE } from "../src/index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function loadCommand(): Command {
  const commands = new Map<string, Command>();
  const api = {
    registerCommand(name: string, command: Command) {
      assert.equal(commands.has(name), false);
      commands.set(name, command);
    },
  } satisfies Pick<ExtensionAPI, "registerCommand">;

  // Deliberately expose only registration: unexpected startup effects fail.
  kiwifsMemory(api as ExtensionAPI);
  assert.deepEqual([...commands.keys()], ["kiwifs-status"]);
  const command = commands.get("kiwifs-status");
  assert.ok(command);
  return command;
}

test("registers a namespaced status command", () => {
  assert.equal(
    loadCommand().description,
    "Show KiwiFS memory extension status",
  );
});

test("reports scaffold status without claiming memory works", async () => {
  const notifications: unknown[][] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (...args: unknown[]) => notifications.push(args) },
  } as unknown as ExtensionCommandContext;
  await loadCommand().handler("", ctx);
  assert.deepEqual(notifications, [[STATUS_MESSAGE, "info"]]);
  assert.match(STATUS_MESSAGE, /not implemented yet/);
});

test("does not access UI in headless mode", async () => {
  const ctx = {
    hasUI: false,
    get ui(): never {
      throw new Error("Headless command must not access UI");
    },
  } as unknown as ExtensionCommandContext;
  await loadCommand().handler("", ctx);
});
