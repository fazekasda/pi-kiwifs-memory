/**
 * B07b: fresh-install smoke as a test. Runs scripts/fresh-install.mjs (packed
 * candidate in an isolated temporary HOME; offline, state-preserving) and
 * asserts the script succeeds. Skipped automatically when the packed pi CLI
 * dependency is not installed, so the suite stays runnable in minimal trees.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";

const piCli = "node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

test(
  "fresh-install smoke: packed install, start, restart, rollback, re-adopt",
  { timeout: 120_000 },
  () => {
    if (!existsSync(piCli)) {
      test.skip("pi coding agent dependency not installed");
      return;
    }
    const stdout = execFileSync(
      process.execPath,
      ["scripts/fresh-install.mjs"],
      {
        encoding: "utf8",
        timeout: 110_000,
      },
    );
    assert.match(stdout, /fresh-install OK/);
  },
);
