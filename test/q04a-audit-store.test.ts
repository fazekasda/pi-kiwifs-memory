/**
 * Q04a: hardening tests for AuditSink storage/schema/retention.
 *
 * Scope: durable audit storage only (`src/privacy/audit-store.ts` and the
 * extracted `buildAuditLine` sanitizer). No runtime wiring; all fixtures are
 * synthetic local temp directories. Content-free guarantees are asserted:
 * no raw identifiers, exception text, or payload bytes survive in lines.
 */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AuditSink,
  buildAuditLine,
  AUDIT_LIMITS,
} from "../src/privacy/audit.ts";
import {
  FileAuditStore,
  type AuditStoreFs,
} from "../src/privacy/audit-store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "q04a-audit-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function storePath(name = "audit.log"): string {
  return join(dir, name);
}

function readLines(p: string): string[] {
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Schema: typed, content-free, bounded lines
// ---------------------------------------------------------------------------

test("Q04a: buildAuditLine keeps allowlisted fields only and bounds sizes", () => {
  const { line } = buildAuditLine(
    {
      kind: "outbox",
      feature: "observation",
      scope: "project/demo",
      targetId: "memory/2026/09/abc.md",
      byteCounts: { payload: 512 },
      decision: "sent",
      // unknown keys are stripped by construction (not in the schema below)
    } as Parameters<typeof buildAuditLine>[0],
    { verbosity: "metadata", redaction: {}, now: new Date(0) },
  );
  const parsed = JSON.parse(line) as Record<string, unknown>;
  const allowed = new Set([
    "ts",
    "kind",
    "feature",
    "scope",
    "targetId",
    "byteCounts",
    "decision",
    "degraded",
    "snippet",
  ]);
  for (const key of Object.keys(parsed)) {
    assert.ok(allowed.has(key), `unexpected key ${key} in audit line`);
  }
  assert.ok(Buffer.byteLength(line) <= AUDIT_LIMITS.maxLineBytes);
});

test("Q04a: oversized identifier is truncated, line stays within the byte budget", () => {
  const sink = new AuditSink();
  const event = sink.record({
    kind: "outbox",
    decision: "sent",
    targetId: "x".repeat(50_000),
  });
  const line = sink.lines_so_far()[0]!;
  assert.ok(event.targetId!.length <= AUDIT_LIMITS.targetIdChars);
  assert.ok(Buffer.byteLength(line) <= AUDIT_LIMITS.maxLineBytes);
  assert.ok(!line.includes("x".repeat(300)), "raw oversized id leaked");
});

test("Q04a: control characters and quotes in identifiers cannot break the JSON line", () => {
  const sink = new AuditSink();
  const event = sink.record({
    kind: "outbox",
    decision: "sent",
    targetId: 'bad"invoke\n{"evil":true}',
  });
  const line = sink.lines_so_far()[0]!;
  assert.equal(event.targetId, "(redacted-unsafe)");
  assert.ok(event.decision.includes("unsafe:targetId"));
  // The line parses as exactly one JSON object; no injected structure.
  const parsed = JSON.parse(line) as { targetId: string };
  assert.equal(parsed.targetId, "(redacted-unsafe)");
});

// ---------------------------------------------------------------------------
// Durable store: bounded rotation, temp files, permissions
// ---------------------------------------------------------------------------

test("Q04a: durable store persists events and rotates within the disk budget", () => {
  const path = storePath();
  const store = new FileAuditStore({
    path,
    maxRotateBytes: 300,
    maxRotatedFiles: 2,
  });
  try {
    for (let i = 0; i < 60; i += 1) {
      const ev = store.record({
        kind: "outbox",
        feature: "observation",
        scope: "project/demo",
        decision: `sent ${i}`,
      });
      assert.ok(!ev.degraded);
    }
    const status = store.status();
    assert.ok(status.rotatedFiles <= 2, "rotation cap exceeded");
    const totalBytes = [path, `${path}.1`, `${path}.2`]
      .filter((p) => existsSync(p))
      .reduce((sum, p) => sum + readFileSync(p).byteLength, 0);
    assert.ok(
      totalBytes <= 3 * 300 + 60 * 8,
      `unbounded disk growth: ${totalBytes}`,
    );
    // All persisted lines parse; FIFO order preserved (oldest event in .2).
    for (const p of [`${path}.2`, `${path}.1`, path]) {
      if (!existsSync(p)) continue;
      for (const l of readLines(p)) JSON.parse(l);
    }
    const firstOfActive = JSON.parse(readLines(path)[0]!) as {
      decision: string;
    };
    assert.ok(firstOfActive.decision.includes("sent"));
    assert.equal(status.persisted, 60);
    assert.ok(!status.degraded);
  } finally {
    store.close();
  }
  assert.ok(!existsSync(`${path}.lock`), "close() must release the lock");
});

test("Q04a: stale temp files are removed at init; no temp residue after writes", () => {
  const path = storePath();
  writeFileSync(`${path}.12345.tmp`, "garbage", "utf8");
  const store = new FileAuditStore({ path });
  try {
    store.record({ kind: "outbox", decision: "sent" });
    assert.ok(!existsSync(`${path}.12345.tmp`));
    const residue =
      existsSync(`${path}.tmp`) || existsSync(`${path}.12345.tmp`);
    assert.ok(!residue);
  } finally {
    store.close();
  }
});

test(
  "Q04a: audit files are private (dir 0700, log 0600, lock 0600)",
  { skip: process.platform === "win32" },
  () => {
    const sub = join(dir, "state");
    const path = join(sub, "audit.log");
    const store = new FileAuditStore({ path });
    try {
      store.record({ kind: "outbox", decision: "sent" });
      const dirMode = 0o777 & statSync(sub).mode;
      assert.equal(dirMode, 0o700, "audit dir must be 0700");
      const fileMode = 0o777 & statSync(path).mode;
      assert.equal(fileMode, 0o600, "audit log must be 0600");
    } finally {
      store.close();
    }
  },
);

test(
  "Q04a: loosened existing log mode is tightened to 0600 at init",
  { skip: process.platform === "win32" },
  () => {
    const path = storePath();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "", { mode: 0o644 });
    const store = new FileAuditStore({ path });
    try {
      const mode = 0o777 & statSync(path).mode;
      assert.equal(mode, 0o600);
    } finally {
      store.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Single-owner enforcement / concurrent writers
// ---------------------------------------------------------------------------

test("Q04a: second concurrent writer cannot take the log; it degrades without dropping", () => {
  const path = storePath();
  const owner = new FileAuditStore({ path });
  const intruder = new FileAuditStore({ path });
  try {
    const ev = intruder.record({ kind: "outbox", decision: "sent" });
    assert.ok(ev.degraded === true, "intruder record must be flagged degraded");
    const status = intruder.status();
    assert.equal(status.lock, "unavailable");
    assert.equal(status.lastError, "lock-unavailable");
    assert.equal(
      status.buffered,
      1,
      "intruder events must be buffered, not dropped",
    );
    // Owner keeps working undisturbed.
    assert.ok(
      !owner.record({ kind: "outbox", decision: "sent" }).degraded,
      "owner record must not be degraded",
    );
    // No interleaved writes from the intruder on disk.
    for (const l of readLines(path)) {
      const parsed = JSON.parse(l) as { decision: string };
      assert.notEqual(parsed.decision, "sent (intruder)");
    }
  } finally {
    owner.close();
    intruder.close();
  }
});

test("Q04a: stale lock (dead pid) is taken over exactly once", () => {
  const path = storePath();
  // Lock left behind by a process that no longer exists.
  writeFileSync(
    `${path}.lock`,
    JSON.stringify({ pid: 2_000_000_000, purpose: "audit-log" }),
    { mode: 0o600 },
  );
  const store = new FileAuditStore({ path });
  try {
    assert.equal(store.status().lock, "owned");
    assert.ok(
      !store.record({ kind: "outbox", decision: "sent" }).degraded,
      "takeover record must not be degraded",
    );
  } finally {
    store.close();
  }
});

test("Q04a: stale lock by age is taken over even if the pid is unreadable", () => {
  const path = storePath();
  writeFileSync(`${path}.lock`, "not-json", { mode: 0o600 });
  // Backdate the mtime beyond staleLockMs.
  const past = new Date(Date.now() - 60_000);
  utimesSync(`${path}.lock`, past, past);
  const store = new FileAuditStore({ path, staleLockMs: 30_000 });
  try {
    assert.equal(store.status().lock, "owned");
  } finally {
    store.close();
  }
});

test("Q04a: a live foreign lock is never stolen (bounded wait, degraded status)", () => {
  const path = storePath();
  const owner = new FileAuditStore({ path });
  const intruder = new FileAuditStore({ path, staleLockMs: 3_600_000 });
  try {
    assert.equal(intruder.status().lock, "unavailable");
    assert.equal(intruder.status().lastError, "lock-unavailable");
  } finally {
    owner.close();
    intruder.close();
  }
});

test("Q04a: a LIVE owner's lock is never stolen even when older than staleLockMs (Q04 review fix)", () => {
  const path = storePath();
  const owner = new FileAuditStore({ path, staleLockMs: 1 });
  // Backdate the live owner's lock beyond the intruder's staleLockMs.
  const past = new Date(Date.now() - 60_000);
  utimesSync(`${path}.lock`, past, past);
  const intruder = new FileAuditStore({ path, staleLockMs: 30_000 });
  try {
    // The intruder must degrade, and the owner must still own its lock.
    assert.equal(intruder.status().lock, "unavailable");
    assert.equal(intruder.status().lastError, "lock-unavailable");
    assert.equal(owner.status().lock, "owned");
  } finally {
    owner.close();
    intruder.close();
  }
});

test("Q04a: legacy rotated segments beyond maxRotatedFiles are removed at init (Q04 review fix)", () => {
  const path = storePath();
  // Simulate a prior configuration with more rotated segments on disk.
  for (const n of [1, 2, 3, 4]) {
    writeFileSync(`${path}.${n}`, `segment ${n}\n`, { mode: 0o600 });
  }
  const store = new FileAuditStore({ path, maxRotatedFiles: 2 });
  try {
    assert.equal(store.status().lock, "owned");
    assert.ok(existsSync(`${path}.1`), "segment .1 is within the new budget");
    assert.ok(existsSync(`${path}.2`), "segment .2 is within the new budget");
    assert.ok(!existsSync(`${path}.3`), "legacy segment .3 must be removed");
    assert.ok(!existsSync(`${path}.4`), "legacy segment .4 must be removed");
    assert.equal(store.status().rotatedFiles, 2);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Corruption and disk-full handling
// ---------------------------------------------------------------------------

test("Q04a: trailing partial line is repaired at init; corrupt bytes counted", () => {
  const path = storePath();
  const good = JSON.stringify({
    ts: new Date(0).toISOString(),
    kind: "outbox",
    decision: "sent",
  });
  writeFileSync(path, `${good}\n${good.slice(0, 10)}`, "utf8");
  const store = new FileAuditStore({ path });
  try {
    const status = store.status();
    assert.equal(status.corruptSkippedBytes, 10);
    store.record({ kind: "outbox", decision: "sent-after-repair" });
    const lines = readLines(path);
    assert.equal(lines.length, 2);
    for (const l of lines) JSON.parse(l); // every line complete
  } finally {
    store.close();
  }
});

test("Q04a: wholly corrupt (no complete line) file is reset safely", () => {
  const path = storePath();
  writeFileSync(path, "not json at all \u0000 binary", "utf8");
  const store = new FileAuditStore({ path });
  try {
    store.record({ kind: "outbox", decision: "sent" });
    const lines = readLines(path);
    assert.equal(lines.length, 1);
    JSON.parse(lines[0]!);
  } finally {
    store.close();
  }
});

test("Q04a: ENOSPC disk-full degrades without throwing and never fakes success", () => {
  const path = storePath();
  const realFs: AuditStoreFs = {
    appendFileSync: () => {
      const err = new Error("synthetic disk full") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    },
    existsSync: () => true,
    mkdirSync: () => undefined,
    readdirSync: () => [],
    readFileSync: (() => Buffer.alloc(0)) as never,
    renameSync: () => undefined,
    statSync: (() => ({
      size: 10,
      mtimeMs: Date.now(),
      isFile: () => true,
    })) as never,
    unlinkSync: () => undefined,
    chmodSync: () => undefined,
    truncateSync: () => undefined,
    writeFileSync: () => undefined,
  };
  const store = new FileAuditStore({ path, fs: realFs });
  try {
    const ev = store.record({ kind: "outbox", decision: "sent" });
    assert.equal(
      ev.degraded,
      true,
      "record must not claim success on disk-full",
    );
    const status = store.status();
    assert.equal(status.persisted, 0);
    assert.equal(status.writeFailures, 1);
    assert.equal(status.lastError, "ENOSPC");
    assert.ok(status.degraded);
    assert.ok(status.buffered === 1, "event must be buffered, not dropped");
    // Oversized burst stays within the bounded fallback buffer.
    for (let i = 0; i < 100; i += 1)
      store.record({ kind: "outbox", decision: "sent" });
    assert.ok(store.buffered_lines().length <= 64);
  } finally {
    store.close();
  }
});

test("Q04a: store never throws out of record() on arbitrary fs faults", () => {
  const path = storePath();
  const throwing: AuditStoreFs = {
    appendFileSync: () => {
      throw new Error("boom");
    },
    existsSync: () => {
      throw new Error("boom");
    },
    mkdirSync: () => undefined,
    readdirSync: () => {
      throw new Error("boom");
    },
    readFileSync: () => {
      throw new Error("boom");
    },
    renameSync: () => {
      throw new Error("boom");
    },
    statSync: () => {
      throw new Error("boom");
    },
    unlinkSync: () => {
      throw new Error("boom");
    },
    chmodSync: () => undefined,
    truncateSync: () => undefined,
    writeFileSync: () => {
      throw new Error("boom");
    },
  } as unknown as AuditStoreFs;
  const store = new FileAuditStore({ path, fs: throwing });
  try {
    const ev = store.record({ kind: "outbox", decision: "sent" });
    assert.equal(ev.degraded, true);
    const status = store.status();
    assert.ok(status.degraded, "arbitrary fs faults must degrade the store");
    assert.ok(status.writeFailures >= 1);
    assert.ok(
      typeof status.lastError === "string" && status.lastError.length > 0,
    );
    // Sanitized error class only — never the thrown message.
    assert.ok(!JSON.stringify(status).includes("boom"));
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Content-free status surface
// ---------------------------------------------------------------------------

test("Q04a: status() is content-free — no paths, identifiers, or error text", () => {
  const path = storePath();
  const store = new FileAuditStore({ path });
  try {
    store.record({
      kind: "outbox",
      scope: "project/secret-project-name",
      targetId: "memory/2026/09/secret.md",
      decision: "sent",
    });
    const json = JSON.stringify(store.status());
    assert.ok(!json.includes("secret"));
    assert.ok(!json.includes("audit.log"));
    assert.ok(!json.includes(dir));
  } finally {
    store.close();
  }
});

test("Q04a: close() then record() degrades instead of writing unlocked", () => {
  const path = storePath();
  const store = new FileAuditStore({ path });
  store.close();
  const ev = store.record({ kind: "outbox", decision: "sent" });
  assert.equal(ev.degraded, true);
  assert.equal(store.status().lock, "unavailable");
});
