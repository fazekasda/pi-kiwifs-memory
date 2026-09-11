/**
 * B07b: fresh-install smoke — packed candidate installed in a credential-
 * isolated temporary HOME, started, restarted, rolled back, and re-adopted.
 *
 * No external network: built-in defaults disable the MCP backend, so the
 * extension starts in its documented offline disabled state (same as
 * smoke-package.mjs). No durable state is deleted: the project state
 * directory (.kiwifs/memory) is snapshotted after the first start and
 * byte-compared after restart and after rollback + re-adopt.
 *
 * Exits 0 with a summary line, or non-zero on the first failed assertion.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "kiwifs-fresh-install-"));
const home = join(tmp, "home");
const proj = join(tmp, "proj");
const stateDir = join(proj, ".kiwifs", "memory");
mkdirSync(home, { recursive: true });
mkdirSync(proj, { recursive: true });

let child;
let exited;
const failures = [];

async function stopChild() {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await exited?.catch(() => {});
  child = undefined;
}

try {
  const [pack] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", tmp],
      { encoding: "utf8" },
    ),
  );
  execFileSync("tar", ["-xzf", join(tmp, pack.filename), "-C", tmp]);
  const entry = join(tmp, "package/src/index.ts");

  /** Hash every file under dir (relative path → sha256). */
  function snapshot(dir) {
    const out = {};
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        for (const [k, v] of Object.entries(snapshot(p))) {
          out[`${name}/${k}`] = v;
        }
      } else {
        out[name] = createHash("sha256").update(readFileSync(p)).digest("hex");
      }
    }
    return out;
  }

  /** Lock files carry pids and the coordinator checkpoint carries run state;
   *  both legitimately change between runs. Durable data is jobs + writes. */
  function durableSnapshot(dir) {
    const out = {};
    for (const [k, v] of Object.entries(snapshot(dir))) {
      if (k.endsWith(".lock") || k === "session-coordinator.json") continue;
      out[k] = v;
    }
    return out;
  }

  /**
   * Start pi RPC with the packed extension in the isolated HOME, verify the
   * extension registers its command and reaches the safe offline state, then
   * stop the process. Resolves after the assertion pass (process still up).
   */
  function runOnce(label) {
    return new Promise((resolvePromise, reject) => {
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
          entry,
        ],
        {
          cwd: proj,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            PI_CODING_AGENT_DIR: join(home, "agent"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      exited = once(child, "close");
      let buffer = "";
      let errors = "";
      let notified = false;
      const timer = setTimeout(
        () => fail(new Error(`${label} timed out: ${errors}`)),
        20_000,
      );
      function fail(error) {
        clearTimeout(timer);
        reject(error);
      }
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.on("exit", (code) =>
        fail(new Error(`${label}: pi exited ${code}: ${errors}`)),
      );
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
            assert.notEqual(msg.type, "extension_error", `${label}: ${line}`);
            if (msg.id === "commands") {
              assert.equal(msg.success, true, `${label}: ${line}`);
              assert.ok(
                msg.data.commands.some((c) => c.name === "kiwifs-status"),
                `${label}: packed extension did not register its command`,
              );
              send({ id: "status", type: "prompt", message: "/kiwifs-status" });
            }
            if (
              msg.type === "extension_ui_request" &&
              msg.method === "notify"
            ) {
              assert.match(
                msg.message,
                /state: (disabled|private|degraded|healthy)/,
              );
              notified = true;
            }
            if (msg.id === "status") {
              assert.equal(msg.success, true, `${label}: ${line}`);
              assert.ok(notified, `${label}: missing status notification`);
              clearTimeout(timer);
              resolvePromise();
              return;
            }
          } catch (error) {
            fail(error);
            return;
          }
        }
      });
      send({ id: "commands", type: "get_commands" });
    });
  }

  // 1. First start from a clean HOME with built-in defaults (offline).
  await runOnce("first start");
  await stopChild();
  mkdirSync(stateDir, { recursive: true });
  // A durable artifact written outside the smoke so restart/rollback must
  // preserve it (synthetic content only).
  mkdirSync(join(stateDir, "outbox"), { recursive: true });
  writeFileSync(join(stateDir, "outbox", "smoke-pinned.txt"), "synthetic\n");
  const before = snapshot(stateDir);
  assert.ok(Object.keys(before).length > 0, "state dir snapshot is empty");
  const beforeDurable = durableSnapshot(stateDir);
  assert.ok(
    Object.keys(beforeDurable).includes("outbox/smoke-pinned.txt"),
    "durable snapshot missing pinned outbox file",
  );

  // 2. Restart with the state dir already populated.
  await runOnce("restart");
  await stopChild();
  const afterRestart = snapshot(stateDir);
  // No durable file may disappear; lock/session files may legitimately change.
  for (const [name, hash] of Object.entries(beforeDurable)) {
    assert.equal(
      afterRestart[name],
      hash,
      `restart altered durable state file ${name}`,
    );
  }

  // 3. Rollback: remove the packed install, verify state survives, then
  //    re-adopt (return to the candidate) with state still intact.
  rmSync(join(tmp, "package"), { recursive: true, force: true });
  const afterRollback = durableSnapshot(stateDir);
  assert.deepEqual(
    afterRollback,
    beforeDurable,
    "rollback deleted durable state",
  );
  execFileSync("tar", ["-xzf", join(tmp, pack.filename), "-C", tmp]);
  await runOnce("re-adopt");
  await stopChild();
  const afterReadopt = durableSnapshot(stateDir);
  assert.deepEqual(
    afterReadopt,
    beforeDurable,
    "re-adopt altered durable state",
  );

  console.log(
    `fresh-install OK: ${pack.name}@${pack.version} — start, restart, rollback, re-adopt all preserved durable state (${Object.keys(beforeDurable).length} durable files, ${Object.keys(before).length} total) with no network access.`,
  );
} catch (error) {
  failures.push(error);
  console.error(error?.message ?? error);
} finally {
  await stopChild().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length > 0) process.exit(1);
