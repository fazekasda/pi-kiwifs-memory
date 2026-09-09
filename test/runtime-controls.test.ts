/**
 * T18: user-configurable delivery bounds (schema validation, fail closed)
 * and the private-mode control surface (atomic persisted flip, no secret
 * exposure, validated before rename).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateConfig } from "../src/config/schema.ts";
import { setPrivateModeInFile } from "../src/runtime/controls.ts";

test("board delivery bounds: in-range values validate", () => {
  const r = validateConfig({
    schemaVersion: 1,
    board: {
      consumerId: "alpha",
      pollMs: 30_000,
      backoffMs: 10_000,
      backlogPauseAt: 100,
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.config.board, {
      consumerId: "alpha",
      pollMs: 30_000,
      backoffMs: 10_000,
      backlogPauseAt: 100,
    });
  }
});

test("board delivery bounds: out-of-range values are validation errors, never clamped", () => {
  for (const bad of [
    { pollMs: 1_000 },
    { pollMs: 3_600_001 },
    { backoffMs: 4_999 },
    { backlogPauseAt: 0 },
    { backlogPauseAt: 10_001 },
    { pollMs: 30_000.5 },
  ]) {
    const r = validateConfig({
      schemaVersion: 1,
      board: { consumerId: "alpha", ...bad },
    });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test("unknown board keys still fail validation", () => {
  const r = validateConfig({
    schemaVersion: 1,
    board: { consumerId: "alpha", nope: 1 },
  });
  assert.equal(r.ok, false);
});

function tmpFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-ctl-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 });
  return file;
}

test("setPrivateModeInFile flips the flag and preserves every other key verbatim", () => {
  const file = tmpFile({
    schemaVersion: 1,
    enabled: true,
    mcp: {
      url: "https://mcp.example.test",
      auth: { kind: "env", ref: "KIWI_TOKEN" },
    },
    board: { consumerId: "alpha", pollMs: 60_000 },
  });
  const res = setPrivateModeInFile(file, true);
  assert.equal(res.ok, true, JSON.stringify(res));
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.privateMode, true);
  assert.equal(after.enabled, true);
  assert.deepEqual(after.mcp.auth, { kind: "env", ref: "KIWI_TOKEN" });
  assert.equal(after.board.pollMs, 60_000);
  // No temp file left behind.
  assert.equal(readFileSync(file, "utf8").includes(".tmp"), false);
});

test("setPrivateModeInFile refuses to corrupt an unparseable file", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-ctl-"));
  const file = join(dir, "config.json");
  writeFileSync(file, "{not json", { mode: 0o600 });
  const res = setPrivateModeInFile(file, true);
  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.reason : "", /NOT changed/);
  assert.equal(readFileSync(file, "utf8"), "{not json");
});

test("setPrivateModeInFile validates the edited file before renaming", () => {
  const file = tmpFile({ schemaVersion: 99 }); // newer schema fails validation
  const res = setPrivateModeInFile(file, false);
  assert.equal(res.ok, false);
  // Original untouched.
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.privateMode, undefined);
});
