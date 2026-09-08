import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import kiwifsMemory, {
  STATUS_MESSAGE,
  resolveStatusText,
} from "../src/index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function loadCommand(): Command {
  const commands = new Map<string, Command>();
  const events: string[] = [];
  const api = {
    registerCommand(name: string, command: Command) {
      assert.equal(commands.has(name), false);
      commands.set(name, command);
    },
    on(event: string) {
      events.push(event);
    },
  } satisfies Pick<ExtensionAPI, "registerCommand"> & {
    on: (event: string) => void;
  };

  // Registration must be synchronous and side-effect free; session handlers
  // (T08) are registered by event name only.
  kiwifsMemory(api as unknown as ExtensionAPI);
  assert.deepEqual([...commands.keys()], ["kiwifs-status"]);
  assert.deepEqual([...events].sort(), [
    "session_before_fork",
    "session_before_switch",
    "session_before_tree",
    "session_shutdown",
    "session_start",
    "session_tree",
  ]);
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
  assert.equal(notifications.length, 1);
  const [text, level] = notifications[0] as [string, string];
  assert.equal(level, "info");
  assert.ok(text.startsWith(STATUS_MESSAGE));
  assert.match(text, /not implemented yet/);
});

test("status output resolves nonsecret config and stays secret-free", () => {
  const text = resolveStatusText();
  assert.ok(text.startsWith(STATUS_MESSAGE));
  assert.match(text, /enabled: false/);
  assert.match(text, /credentials: none/);
  assert.match(text, /cross-project reads denied by default/);
  assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._-]{16,}/);
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
