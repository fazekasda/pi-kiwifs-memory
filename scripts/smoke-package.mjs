import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "kiwifs-smoke-"));
let child;
let exited;
try {
  const [pack] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", tmp],
      { encoding: "utf8" },
    ),
  );
  execFileSync("tar", ["-xzf", join(tmp, pack.filename), "-C", tmp]);
  child = spawn(
    process.execPath,
    [
      resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "-e",
      join(tmp, "package/src/index.ts"),
    ],
    {
      cwd: tmp,
      // Do not expose the developer's credentials or installed extensions.
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        PI_CODING_AGENT_DIR: join(tmp, "agent"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  exited = once(child, "close");
  await new Promise((resolve, reject) => {
    let buffer = "";
    let errors = "";
    let notified = false;
    const timer = setTimeout(
      () => fail(new Error(`RPC smoke timed out: ${errors}`)),
      20_000,
    );
    function fail(error) {
      clearTimeout(timer);
      reject(error);
    }
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("exit", (code) => fail(new Error(`Pi exited ${code}: ${errors}`)));
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      errors = (errors + chunk).slice(-8000);
    });
    function send(command) {
      child.stdin.write(JSON.stringify(command) + "\n");
    }
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          assert.notEqual(msg.type, "extension_error", line);
          if (msg.id === "commands") {
            assert.equal(msg.success, true, line);
            assert.ok(
              msg.data.commands.some((c) => c.name === "kiwifs-status"),
              "Packed extension did not register its command",
            );
            send({ id: "status", type: "prompt", message: "/kiwifs-status" });
          }
          if (msg.type === "extension_ui_request" && msg.method === "notify") {
            assert.match(
              msg.message,
              /state: (disabled|private|degraded|healthy)/,
            );
            assert.equal(msg.notifyType, "info");
            notified = true;
          }
          if (msg.id === "status") {
            assert.equal(msg.success, true, line);
            assert.ok(notified, "Missing status notification");
            clearTimeout(timer);
            resolve();
          }
        } catch (error) {
          fail(error);
        }
      }
    });
    send({ id: "commands", type: "get_commands" });
  });
  console.log("Packed extension loads in Pi RPC and reports scaffold status.");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await exited?.catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
