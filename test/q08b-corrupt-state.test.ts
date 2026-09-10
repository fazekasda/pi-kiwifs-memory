/**
 * Q08B: corrupted durable-state startup and shutdown regressions.
 *
 * Production runtime behavior when durable local state is malformed,
 * truncated or upgraded past support, exercised through the SHIPPED
 * factories (`DurableOutbox.open`, `CursorFile`, `DeliveryStateFile`,
 * `SessionCoordinator`, `BoardDeliveryRuntime`, `buildSessionRuntime`) —
 * never test-only composition.
 *
 * Fail-closed contract under corruption:
 * - Corrupt/truncated state throws a TYPED, actionable error naming the
 *   file; the file bytes are left byte-identical (forensic pending data,
 *   cursors and dedupe sets are preserved — never silently reset, which
 *   would re-feed pipeline ranges or replay/drop deliveries).
 * - A failed open releases its lock (idempotent cleanup); repeated
 *   restarts against the same corrupt state are deterministic, and a
 *   restart after the state is repaired succeeds with pending data intact.
 * - Partial initialization holds the broken domain visibly and never
 *   breaks session startup or teardown.
 *
 * Synthetic local fixtures only (temp dirs, hex keys). No live service,
 * no secrets, no fixed sleeps: ordering is proven by bounded awaits on
 * real observable state.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as index from "../src/index.ts";
import { CursorCorruptError, CursorFile } from "../src/outbox/cursor.ts";
import { DurableOutbox, OutboxError } from "../src/outbox/store.ts";
import {
  DeliveryStateCorruptError,
  DeliveryStateFile,
} from "../src/board/delivery.ts";
import { BoardDeliveryRuntime } from "../src/board/runtime.ts";
import { BoardRepository } from "../src/board/repository.ts";
import { SessionCoordinator, StateSchemaError } from "../src/pi/coordinator.ts";

const TOKEN_ENV = "KIWIFS_Q08B_SYNTHETIC_TOKEN";

function newDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `kiwifs-q08b-${name}-`));
}

function makeKey(seed: string): string {
  return seed.padEnd(64, "0").slice(0, 64);
}

const OP = "88888888-8888-4888-8888-888888888888";

function seedPendingJob(dir: string): void {
  const store = DurableOutbox.open(dir);
  store.enqueue({
    kind: "observation",
    scope: "project/example.local/q08b",
    idempotencyKey: makeKey("a"),
    opId: OP,
    payload: {
      opId: OP,
      sessionId: "q08b-synthetic-session",
      sourceEntryIds: ["e1"],
      observations: [
        {
          sourceEntryIds: ["e1"],
          statement: "synthetic observation",
          uncertainty: "low",
        },
      ],
    },
  });
  store.close();
}

// ---------------------------------------------------------------------------
// Outbox journal corruption
// ---------------------------------------------------------------------------

test("corrupt outbox journal: typed fail-closed open, journal bytes untouched, lock released, restart deterministic", () => {
  const dir = newDir("journal-corrupt");
  const jobs = join(dir, "jobs.jsonl");
  seedPendingJob(dir);
  // Append a torn/truncated line (simulated crash mid-write — the atomic
  // rename discipline makes this impossible in production; this probes the
  // defense if it were violated).
  const before = readFileSync(jobs, "utf8");
  writeFileSync(jobs, `${before}\n{"seq":2,"schemaVersion":1,"trunc`, {
    mode: 0o600,
  });

  assert.throws(
    () => DurableOutbox.open(dir),
    (err: unknown) => {
      assert.ok(err instanceof OutboxError);
      assert.match(err.message, /corrupt outbox journal line 2/);
      return true;
    },
  );

  // Forensic pending data preserved byte-for-byte; the corrupt line included
  // (never destructively rewritten by a failed open).
  assert.equal(
    readFileSync(jobs, "utf8"),
    `${before}\n{"seq":2,"schemaVersion":1,"trunc`,
  );

  // Failed open released the lock: a second open ACQUIRES (not OutboxLockHeld)
  // and fails with the SAME typed corruption error — repeated restarts are
  // deterministic, never deadlocked on a leaked lock.
  assert.throws(() => DurableOutbox.open(dir), OutboxError);
  assert.equal(
    existsSync(join(dir, "jobs.jsonl.lock")),
    false,
    "no leaked lock after failed open",
  );

  // Forensic recovery: operator removes only the torn line; pending data
  // survives and the journal resumes operation.
  writeFileSync(jobs, before, { mode: 0o600 });
  const repaired = DurableOutbox.open(dir);
  assert.equal(
    repaired.pending().length,
    1,
    "pending job survived corruption+repair",
  );
  assert.equal(repaired.pending()[0]!.opId, OP);
  assert.equal(repaired.isReadOnly, false);
  repaired.close();
});

test("corrupt journal does not authorize delivery: worker built against a corrupt dir cannot exist and pending data is never rewritten", () => {
  const dir = newDir("journal-corrupt-noauth");
  seedPendingJob(dir);
  const jobsFile = join(dir, "outbox", "jobs.jsonl");
  // The shipped runtime opens `<stateDir>/outbox`; mirror the corrupt
  // journal there (state dir layout is the shipped convention).
  mkdirSync(join(dir, "outbox"), { recursive: true, mode: 0o700 });
  const corrupt =
    readFileSync(join(dir, "jobs.jsonl"), "utf8") + "not-json-at-all";
  writeFileSync(jobsFile, corrupt, { mode: 0o600 });
  rmSync(join(dir, "jobs.jsonl"), { force: true });

  // Shipped runtime composition: outbox init fails closed → store/worker are
  // undefined (nothing can deliver), the hold is visible, session startup
  // survives, and shutdown teardown is safe + idempotent.
  const cfg = newDir("cfg");
  writeFileSync(
    join(cfg, "kiwifs.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      enabled: false,
      projectIdentity: "example.local/q08b",
    }),
  );
  const prevCfg = process.env["KIWIFS_MEMORY_CONFIG"];
  const prevState = process.env["KIWIFS_MEMORY_STATE_DIR"];
  process.env["KIWIFS_MEMORY_CONFIG"] = join(cfg, "kiwifs.config.json");
  process.env["KIWIFS_MEMORY_STATE_DIR"] = dir;
  try {
    const rt = index.buildSessionRuntime(cfg);
    assert.equal(rt.store, undefined, "corrupt journal: outbox held, no store");
    assert.equal(
      rt.worker,
      undefined,
      "corrupt journal: no worker can deliver",
    );
    assert.match(rt.observerError ?? "", /corrupt outbox journal/);
    // Pending job bytes untouched (forensics intact).
    assert.equal(readFileSync(jobsFile, "utf8"), corrupt);
    // Partial initialization: coordinator still works, teardown idempotent.
    assert.ok(rt.coordinator);
    rt.observer?.dispose();
    rt.liveGate?.dispose();
    rt.observer?.dispose();
  } finally {
    if (prevCfg === undefined) delete process.env["KIWIFS_MEMORY_CONFIG"];
    else process.env["KIWIFS_MEMORY_CONFIG"] = prevCfg;
    if (prevState === undefined) delete process.env["KIWIFS_MEMORY_STATE_DIR"];
    else process.env["KIWIFS_MEMORY_STATE_DIR"] = prevState;
  }
});

// ---------------------------------------------------------------------------
// Pipeline cursor corruption
// ---------------------------------------------------------------------------

test("corrupt cursors.json: typed fail-closed error, cursor bytes untouched, never silently reset", () => {
  const dir = newDir("cursor-corrupt");
  const file = join(dir, "cursors.json");
  // A real prior cursor: localSeq advanced (authoritative), advisory state set.
  const prior = JSON.stringify({
    schemaVersion: 1,
    localSeq: 42,
    backendLastSeq: 40,
    lastCommitHash: "abc",
  });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${prior.slice(0, 20)}...TRUNCATED`, { mode: 0o600 });

  assert.throws(
    () => new CursorFile(dir),
    (err: unknown) => {
      assert.ok(
        err instanceof CursorCorruptError,
        "typed corruption error, not raw SyntaxError",
      );
      assert.match(err.message, /cursors\.json/);
      assert.match(err.message, /file left intact/);
      return true;
    },
  );
  // Cursor never reset: bytes untouched, localSeq=42 preserved for forensics.
  assert.match(readFileSync(file, "utf8"), /TRUNCATED/);

  // Structurally-wrong-but-parseable state (localSeq missing) also fails
  // closed — a reset cursor would re-feed pipeline ranges.
  writeFileSync(file, JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  assert.throws(() => new CursorFile(dir), CursorCorruptError);
  assert.equal(
    readFileSync(file, "utf8"),
    JSON.stringify({ schemaVersion: 1 }),
  );

  // Repair restores operation with the ORIGINAL cursor value.
  writeFileSync(file, prior, { mode: 0o600 });
  const repaired = new CursorFile(dir);
  assert.equal(repaired.value.localSeq, 42);
  // And the repaired cursor still advances and persists.
  repaired.advanceLocalSeq(43);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).localSeq, 43);
});

test("newer cursor schemaVersion: authoritative cursor retained + reconcileNeeded, never rewritten (restart survival)", () => {
  const dir = newDir("cursor-future");
  const file = join(dir, "cursors.json");
  const future = JSON.stringify({
    schemaVersion: 99,
    localSeq: 7,
    backendLastSeq: 6,
  });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, future, { mode: 0o600 });
  const c = new CursorFile(dir);
  assert.equal(c.value.localSeq, 7, "authoritative cursor RETAINED, not reset");
  assert.equal(
    c.value.reconcileNeeded,
    true,
    "coverage re-scan flagged visibly",
  );
  assert.equal(
    readFileSync(file, "utf8"),
    future,
    "newer file never destructively rewritten",
  );
  // Restart: same read-only fail-safe, same retained cursor.
  const c2 = new CursorFile(dir);
  assert.equal(c2.value.localSeq, 7);
  assert.throws(() => c2.advanceLocalSeq(8), /read-only/);
});

// ---------------------------------------------------------------------------
// Board delivery state corruption
// ---------------------------------------------------------------------------

test("corrupt delivery state: typed fail-closed error, state bytes untouched, consumer lock never acquired, restart deterministic", () => {
  const dir = newDir("delivery-corrupt");
  const file = join(dir, "delivery-agent-q08b.json");
  const prior = JSON.stringify({
    schemaVersion: 1,
    consumerId: "agent-q08b",
    lastSeq: "77",
    entries: {
      m1: { msgId: "m1", path: "board/c/m1.md", channel: "c", deliveredAt: 1 },
    },
  });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${prior}...torn`, { mode: 0o600 });

  assert.throws(
    () => new DeliveryStateFile(dir, "agent-q08b"),
    (err: unknown) => {
      assert.ok(
        err instanceof DeliveryStateCorruptError,
        "typed error, not raw SyntaxError",
      );
      assert.match(err.message, /delivery-agent-q08b\.json/);
      return true;
    },
  );
  // Forensic state preserved (cursor lastSeq=77 + dedupe entry intact).
  assert.match(readFileSync(file, "utf8"), /torn/);

  // Runtime composition holds BEFORE any poller/lock exists: no consumer
  // lock is acquired or leaked, and repeated attempts behave identically.
  const repo = new BoardRepository({} as never); // never reached on this path
  const attempt = () =>
    new BoardDeliveryRuntime({
      stateDir: dir,
      consumerId: "agent-q08b",
      repo,
      isPrivate: () => false,
    });
  assert.throws(attempt, DeliveryStateCorruptError);
  assert.throws(attempt, DeliveryStateCorruptError, "restart is deterministic");
  assert.equal(
    existsSync(join(dir, "delivery-agent-q08b.lock")),
    false,
    "no leaked consumer lock",
  );

  // Repair: delivered message is still deduped (never re-delivered) and the
  // cursor survives — state resumption, not silent reset.
  writeFileSync(file, prior, { mode: 0o600 });
  const st = new DeliveryStateFile(dir, "agent-q08b");
  assert.equal(st.lastSeq, "77");
  assert.ok(st.getEntry("m1")?.deliveredAt);
  assert.equal(st.unreadCount(), 1);
});

// ---------------------------------------------------------------------------
// Session coordinator corruption
// ---------------------------------------------------------------------------

test("corrupt coordinator state: fails safe to empty, file untouched, repeated restart survives", () => {
  const dir = newDir("coord-corrupt");
  const file = join(dir, "session-coordinator.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, '{"schemaVersion":1,"generati', { mode: 0o600 });
  const before = readFileSync(file, "utf8");

  // Corrupt counter file = fresh coordinator (stale results are discarded
  // because callers hold generations already passed); NOT a crash.
  const c1 = new SessionCoordinator({ stateDir: dir });
  assert.equal(c1.generation, 0);
  // Restart (previous instance released nothing persistent): also survives.
  const c2 = new SessionCoordinator({ stateDir: dir });
  assert.equal(c2.generation, 0);
  assert.equal(
    readFileSync(file, "utf8"),
    before,
    "corrupt file untouched until a mint overwrites",
  );

  // Live operation: the fresh coordinator persists durably and re-mints.
  const ctx = {
    cwd: dir,
    sessionManager: { getSessionId: () => "s1", getLeafId: () => null },
  };
  c2.onSessionStart(ctx, { reason: "startup" });
  c2.onShutdown();
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(typeof after.generation, "number");
  assert.ok(after.generation >= 1, "generation re-minted and persisted");
});

test("newer coordinator schemaVersion still fails closed with StateSchemaError (restart survival)", () => {
  const dir = newDir("coord-future");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "session-coordinator.json"),
    JSON.stringify({ schemaVersion: 99, generation: 5, consumedEntries: [] }),
    { mode: 0o600 },
  );
  assert.throws(
    () => new SessionCoordinator({ stateDir: dir }),
    StateSchemaError,
  );
  assert.throws(
    () => new SessionCoordinator({ stateDir: dir }),
    StateSchemaError,
    "deterministic across restarts",
  );
  // Never destructively rewritten.
  const raw = JSON.parse(
    readFileSync(join(dir, "session-coordinator.json"), "utf8"),
  );
  assert.equal(raw.schemaVersion, 99);
});

// ---------------------------------------------------------------------------
// Target pin under rebuild (never silently authorize a new destination)
// ---------------------------------------------------------------------------

test("rebuild after corruption-repair: pinned target preserved, changed snapshot HOLDS, journal never re-authored", async () => {
  // q07c pins the reroute-hold contract; here we pin the CORRUPTION-side
  // property: a corrupt journal cannot cause a retarget — open fails before
  // any worker exists, so no send path is reachable at all (proven above),
  // and after repair the job still carries its ORIGINAL enqueue-time pin.
  const dir = newDir("pin-preserved");
  seedPendingJob(dir);
  const before = readFileSync(join(dir, "jobs.jsonl"), "utf8");
  writeFileSync(join(dir, "jobs.jsonl"), `${before}{"corrupt`, { mode: 0o600 });
  assert.throws(() => DurableOutbox.open(dir), OutboxError);
  writeFileSync(join(dir, "jobs.jsonl"), before, { mode: 0o600 });
  const store = DurableOutbox.open(dir);
  const job = store.pending()[0]!;
  assert.equal(job.opId, OP, "same opId — identity survives, no re-mint");
  // Enqueue-time pin: a rebuilt session fingerprint against a changed
  // endpoint never overwrites the stored job (the worker holds on mismatch,
  // q07c contract); here we verify the stored bytes are untouched by the
  // corrupt-open + repair cycle — no silent re-authoring of a destination.
  assert.equal(readFileSync(join(dir, "jobs.jsonl"), "utf8"), before);
  store.close();
});
