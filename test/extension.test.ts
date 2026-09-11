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
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

function loadCommand(): { status: Command; verify: Command } {
  const commands = new Map<string, Command>();
  const tools = new Map<string, Tool>();
  const events: string[] = [];
  const api = {
    registerCommand(name: string, command: Command) {
      assert.equal(commands.has(name), false);
      commands.set(name, command);
    },
    registerTool(tool: Tool) {
      assert.equal(tools.has(tool.name), false);
      tools.set(tool.name, tool);
    },
    on(event: string) {
      events.push(event);
    },
  } satisfies Pick<ExtensionAPI, "registerCommand"> & {
    registerTool: (tool: Tool) => void;
    on: (event: string) => void;
  };

  // Registration must be synchronous and side-effect free; session handlers
  // (T08) are registered by event name only.
  kiwifsMemory(api as unknown as ExtensionAPI);
  // T18 chunk 2: full command surface.
  assert.deepEqual(
    [
      "kiwifs-backup-verify",
      "kiwifs-board-cleanup",
      "kiwifs-board-gc",
      "kiwifs-erasure-report",
      "kiwifs-extract-now",
      "kiwifs-forget",
      "kiwifs-forget-undo",
      "kiwifs-personal-note",
      "kiwifs-private-mode",
      "kiwifs-proposal",
      "kiwifs-queue",
      "kiwifs-reflect-now",
      "kiwifs-status",
    ],
    [...commands.keys()].sort(),
  );
  // T13/T16/T17: recall tools, board tools, delivery inbox + local ack.
  assert.deepEqual([...tools.keys()].sort(), [
    "kiwifs_board_ack",
    "kiwifs_board_inbox",
    "kiwifs_board_list",
    "kiwifs_board_read",
    "kiwifs_board_send",
    "kiwifs_memory_read",
    "kiwifs_memory_search",
  ]);
  for (const tool of tools.values()) {
    assert.ok(tool.description.length > 0);
    assert.ok(tool.execute);
  }
  assert.deepEqual([...events].sort(), [
    "agent_settled",
    "before_agent_start",
    "context",
    "input",
    "session_before_compact",
    "session_before_fork",
    "session_before_switch",
    "session_before_tree",
    "session_shutdown",
    "session_start",
    "session_tree",
  ]);
  const statusCommand = commands.get("kiwifs-status");
  const verifyCommand = commands.get("kiwifs-backup-verify");
  assert.ok(statusCommand);
  assert.ok(verifyCommand);
  return { status: statusCommand!, verify: verifyCommand! };
}

test("registers a namespaced status command", () => {
  assert.equal(
    loadCommand().status.description,
    "Show KiwiFS memory extension status",
  );
});

// T15: the verification command is registered with a non-empty description
// and stays usable headless (no UI access on the early-exit paths).
test("registers the backup verification command", async () => {
  const { verify } = loadCommand();
  assert.match(verify.description ?? "", /Verify/);
  // No args + default (disabled) config → visible disabled notice, never a
  // crash. Usage message only fires once the extension is enabled.
  const notifications: unknown[][] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (...args: unknown[]) => notifications.push(args) },
  } as unknown as ExtensionCommandContext;
  await verify.handler("", ctx);
  assert.equal(notifications.length, 1);
  assert.match(String(notifications[0]![0]), /extension disabled/);
  // Headless early-exit must not touch the UI.
  const headless = {
    hasUI: false,
    get ui(): never {
      throw new Error("Headless command must not access UI");
    },
  } as unknown as ExtensionCommandContext;
  await verify.handler("", headless);
});

// T15 (review fix B1): private mode must hold ALL backup-domain backend
// reads. With an enabled, private-mode config, the verify command must emit
// the hold notice and never construct/connect the adapter — proven by an
// mcp.url pointing at a local listener that records every request.
test("private mode holds backup-verify backend reads", async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-t15-private-"));
  const cfgFile = join(dir, "kiwifs.config.json");
  writeFileSync(
    cfgFile,
    JSON.stringify({
      enabled: true,
      privateMode: true,
      mcp: {
        url: `http://127.0.0.1:${port}/mcp`,
        auth: { kind: "env", ref: "KIWIFS_T15_SYNTHETIC_TOKEN" },
      },
    }),
  );
  const prev = process.env["KIWIFS_MEMORY_CONFIG"];
  process.env["KIWIFS_MEMORY_CONFIG"] = cfgFile;
  try {
    const notifications: unknown[][] = [];
    const ctx = {
      hasUI: true,
      ui: { notify: (...args: unknown[]) => notifications.push(args) },
    } as unknown as ExtensionCommandContext;
    await loadCommand().verify.handler("synthetic-session", ctx);
    assert.equal(notifications.length, 1);
    const [text, level] = notifications[0] as [string, string];
    assert.match(text, /private mode active/);
    assert.match(text, /backup verify holds all backend reads/);
    assert.equal(level, "info");
    // The gate must fire before any adapter construction or connect: the
    // local listener must have received zero requests.
    assert.deepEqual(requests, []);
  } finally {
    if (prev === undefined) delete process.env["KIWIFS_MEMORY_CONFIG"];
    else process.env["KIWIFS_MEMORY_CONFIG"] = prev;
    server.close();
  }
});

test("status reports the disabled state without claiming memory works", async () => {
  const notifications: unknown[][] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (...args: unknown[]) => notifications.push(args) },
  } as unknown as ExtensionCommandContext;
  await loadCommand().status.handler("", ctx);
  assert.equal(notifications.length, 1);
  const [text, level] = notifications[0] as [string, string];
  assert.equal(level, "info");
  assert.ok(text.startsWith(STATUS_MESSAGE));
  assert.match(text, /enabled: false/);
  assert.match(text, /state: disabled/);
});

test("status output resolves nonsecret config and stays secret-free", () => {
  const text = resolveStatusText();
  assert.ok(text.startsWith(STATUS_MESSAGE));
  assert.match(text, /enabled: false/);
  assert.match(text, /credentials: none/);
  assert.match(text, /cross-project reads denied by default/);
  assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._-]{16,}/);
});

test("does not access UI in headless mode", async () => {
  const ctx = {
    hasUI: false,
    get ui(): never {
      throw new Error("Headless command must not access UI");
    },
  } as unknown as ExtensionCommandContext;
  await loadCommand().status.handler("", ctx);
});
