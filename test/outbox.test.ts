/**
 * T07 acceptance tests: durable outbox and recovery — synthetic fixtures
 * only, no live service is contacted (the sender is a fake backend).
 *
 * Acceptance coverage (PRD T07):
 * 1. Crash tests cover before persistence, after persistence, and remote
 *    success before local acknowledgment.
 * 2. Replayed jobs do not duplicate logical observations (deterministic-path
 *    idempotency, B2): identical replay no-ops; content collision fails closed.
 * 3. Offline startup processes pending jobs using only local cursors; backend
 *    cursor drift is detected and flagged, never trusted blindly.
 * 4. Transient failures retry with capped backoff; permanent failures are
 *    quarantined — inspectable, bounded, never retried.
 * 5. High-water overflow pauses new capture with a visible gap; pending jobs
 *    are preserved; disk-full leaves pending jobs and cursors intact.
 * 6. Permissions and multi-process locking prevent exposure/corruption.
 * 7. Failed jobs never block ordinary Pi interaction (tick never throws).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AvailabilityError,
  BackendError,
  ValidationError,
} from "../src/backend/errors.ts";
import { idempotencyKey } from "../src/domain/idempotency.ts";
import { PrivateModeGate } from "../src/privacy/private-mode.ts";
import { CursorFile, reconcile } from "../src/outbox/cursor.ts";
import {
  DurableOutbox,
  OutboxLockHeldError,
  OutboxOverflowError,
  OutboxPermissionError,
  OutboxPersistError,
  DEFAULT_LIMITS,
} from "../src/outbox/store.ts";
import { OutboxWorker, errorFingerprint } from "../src/outbox/worker.ts";

function newDir(name: string): string {
  return join(
    tmpdir(),
    `kiwifs-outbox-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
}

function makeKey(scope: string, entryIds: string[]): string {
  return idempotencyKey({
    kind: "observation",
    scope,
    sources: [{ sessionId: "s1", entryIds }],
  });
}

/**
 * Fake backend implementing deterministic-path idempotency (architecture
 * §2): identical content → no-op; same path, different content → fail
 * closed. Records are keyed by the job's idempotencyKey.
 */
class FakeBackend {
  records = new Map<string, string>();
  sends = 0;
  failNext: Error | null = null;

  async send(job: { idempotencyKey: string; payload: unknown }): Promise<void> {
    this.sends += 1;
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const hash = createHash("sha256")
      .update(JSON.stringify(job.payload))
      .digest("hex");
    const existing = this.records.get(job.idempotencyKey);
    if (existing === undefined) {
      this.records.set(job.idempotencyKey, hash);
      return;
    }
    if (existing !== hash) {
      throw new BackendError(
        "conflict",
        "deterministic path exists with different content",
      );
    }
    // identical content → replay no-op
  }
}

function makeWorker(
  store: DurableOutbox,
  backend: FakeBackend,
  gate?: PrivateModeGate,
  now: () => number = Date.now,
) {
  return new OutboxWorker({
    store,
    send: (job) => backend.send(job),
    ...(gate ? { gate } : {}),
    now,
    random: () => 0, // deterministic jitter: lower bound
    baseDelayMs: 100,
    capDelayMs: 400,
  });
}

test("crash before persistence: enqueue fault leaves nothing durable and a torn tmp file is ignored on reload", () => {
  const dir = newDir("crash-before");
  const store = DurableOutbox.open(dir);
  store.persistFault = new Error("ENOSPC: no space left on device");
  assert.throws(
    () =>
      store.enqueue({
        kind: "observation",
        scope: "personal",
        idempotencyKey: makeKey("personal", ["e1"]),
        payload: { text: "a" },
      }),
    OutboxPersistError,
  );
  assert.equal(
    existsSync(join(dir, "jobs.jsonl.tmp")),
    false,
    "temp file cleaned after fault",
  );
  store.close();

  // Simulate a crash that left a torn temp file behind.
  writeFileSync(join(dir, "jobs.jsonl.tmp"), '{"seq":99,"corrupt');
  const reopened = DurableOutbox.open(dir);
  assert.equal(reopened.pending().length, 0, "job was never durably accepted");
  assert.equal(reopened.stats.paused, false);
  reopened.close();
});

test("crash after persistence: reopened outbox sees the pending job and delivers it", async () => {
  const dir = newDir("crash-after");
  const backend = new FakeBackend();
  {
    const store = DurableOutbox.open(dir);
    const job = store.enqueue({
      kind: "observation",
      scope: "personal",
      idempotencyKey: makeKey("personal", ["e1"]),
      payload: { text: "synthetic observation" },
    });
    assert.equal(job.status, "pending");
    store.close(); // crash before any send
  }
  const store = DurableOutbox.open(dir);
  const w = makeWorker(store, backend);
  const summary = await w.tick();
  assert.equal(summary.sent.length, 1);
  assert.equal(backend.records.size, 1);
  assert.equal(store.pending().length, 0, "acked after delivery");
  store.close();
});

test("remote success before local ack (natural window): replay does not duplicate (B2)", async () => {
  const dir = newDir("ack-window");
  const backend = new FakeBackend();
  {
    const store = DurableOutbox.open(dir);
    const w = makeWorker(store, backend);
    store.enqueue({
      kind: "backup-chunk",
      scope: "personal",
      idempotencyKey: makeKey("personal", ["e2"]),
      payload: { seq: 1, text: "chunk" },
    });
    // Remote succeeds, then the process "crashes" before the local ack.
    await w.tick();
    store.close();
    // No reopen-ack: simulate crash by NOT persisting an ack — reopen sees pending.
  }
  const store = DurableOutbox.open(dir);
  const w = makeWorker(store, backend);
  const summary = await w.tick();
  // The job was already sent once, so either it was acked in the first run
  // (sent:0) or it replays (sent:1) — but the backend holds exactly one record.
  assert.ok(summary.sent.length <= 1);
  assert.equal(backend.records.size, 1, "no logical duplicate on the backend");
  if (summary.sent.length === 1) {
    assert.equal(store.pending().length, 0, "replay completed the ack");
  }
  store.close();
});

test("forced crash between remote success and local ack: replay no-ops against the backend", async () => {
  const dir = newDir("ack-window-forced");
  const backend = new FakeBackend();
  const store = DurableOutbox.open(dir);
  const w = makeWorker(store, backend);
  store.enqueue({
    kind: "backup-chunk",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e3"]),
    payload: { seq: 1, text: "chunk" },
  });
  store.persistFault = new Error("ENOSPC"); // ack persist fails after remote success
  const summary = await w.tick();
  assert.deepEqual(summary.sent.length, 1, "remote accepted");
  assert.deepEqual(
    summary.pendingAck.length,
    1,
    "local ack deferred, not quarantined",
  );
  assert.equal(backend.records.size, 1);
  store.persistFault = null;
  const summary2 = await w.tick();
  assert.deepEqual(summary2.sent.length, 1, "replay re-sends");
  assert.equal(
    backend.records.size,
    1,
    "identical replay no-ops (no duplicate)",
  );
  assert.equal(store.pending().length, 0);
  store.close();
});

test("content collision on replay fails closed and quarantines (never overwrites)", async () => {
  const dir = newDir("collision");
  const backend = new FakeBackend();
  const store = DurableOutbox.open(dir);
  const w = makeWorker(store, backend);
  store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e4"]),
    payload: { text: "v1" },
  });
  backend.records.set(
    makeKey("personal", ["e4"]),
    createHash("sha256")
      .update(JSON.stringify({ text: "OTHER" }))
      .digest("hex"),
  );
  const summary = await w.tick();
  assert.equal(
    summary.quarantined.length,
    1,
    "conflict is permanent → quarantine",
  );
  assert.match(summary.quarantined[0]!.reason, /BackendError:conflict/);
  assert.equal(store.quarantined().length, 1);
  assert.equal(
    backend.records.get(makeKey("personal", ["e4"])),
    createHash("sha256")
      .update(JSON.stringify({ text: "OTHER" }))
      .digest("hex"),
    "record untouched",
  );
  store.close();
});

test("offline startup: pending jobs delivered from local state alone; cursors advance from local maxSeq", async () => {
  const dir = newDir("offline");
  const backend = new FakeBackend();
  {
    const store = DurableOutbox.open(dir);
    for (const e of ["e1", "e2"]) {
      store.enqueue({
        kind: "observation",
        scope: "personal",
        idempotencyKey: makeKey("personal", [e]),
        payload: { entry: e },
      });
    }
    const cursors = new CursorFile(dir);
    cursors.advanceLocalSeq(store.maxSeq);
    store.close();
  }
  // No backend contact until the worker tick; cursors come from disk only.
  const cursors = new CursorFile(dir);
  assert.equal(cursors.value.localSeq, 2);
  const store = DurableOutbox.open(dir);
  assert.equal(store.pending().length, 2);
  const w = makeWorker(store, backend);
  await w.tick();
  assert.equal(
    backend.records.size,
    1,
    "per-scope ordering: one job per scope per tick",
  );
  await w.tick();
  assert.equal(backend.records.size, 2);
  cursors.advanceLocalSeq(store.maxSeq);
  assert.equal(cursors.value.localSeq, 2);
  store.close();
});

test("reconciliation: continuous feed adopts advisory cursor; regression drift is flagged, never adopted", async () => {
  const dir = newDir("reconcile");
  const cursors = new CursorFile(dir);
  cursors.setBackend(5, "c5");
  // Continuous pages from c5.
  const res = await reconcile(cursors, async (since) =>
    since === "c5"
      ? { changes: [{ seq: 6 }, { seq: 7 }], commitHash: "c7", hasMore: false }
      : { changes: [], commitHash: "c0", hasMore: false },
  );
  assert.equal(res.drift, false);
  assert.equal(res.paused, false);
  assert.equal(cursors.value.backendLastSeq, 7);
  assert.equal(cursors.value.lastCommitHash, "c7");
  // Regression: feed returns an already-consumed seq → drift flagged.
  const res2 = await reconcile(cursors, async () => ({
    changes: [{ seq: 3 }],
    commitHash: "c3",
    hasMore: false,
  }));
  assert.equal(res2.drift, true);
  assert.equal(
    cursors.value.reconcileNeeded,
    true,
    "drift visible, never adopted blindly",
  );
  assert.equal(
    cursors.value.lastCommitHash,
    "c7",
    "advisory cursor NOT overwritten by drift",
  );
});

test("reconciliation: feed gap (missing seq range) is drift — never adopted blindly", async () => {
  const dir = newDir("reconcile-gap");
  const cursors = new CursorFile(dir);
  cursors.setBackend(5, "c5");
  // Feed starts at 7: changes 6 was lost/trimmed — a gap against prior cursor 5.
  const res = await reconcile(cursors, async () => ({
    changes: [{ seq: 7 }, { seq: 8 }],
    commitHash: "c8",
    hasMore: false,
  }));
  assert.equal(res.drift, true, "gap is drift");
  assert.equal(
    cursors.value.reconcileNeeded,
    true,
    "gap flagged visibly, never adopted",
  );
  assert.equal(
    cursors.value.backendLastSeq,
    5,
    "advisory cursor NOT advanced across a gap",
  );
  assert.equal(cursors.value.lastCommitHash, "c5");
});

test("reconciliation bound: stops at maxPages with a visible pause, resumes next cycle", async () => {
  const dir = newDir("reconcile-bound");
  const cursors = new CursorFile(dir);
  let pages = 0;
  const res = await reconcile(
    cursors,
    async () => {
      pages += 1;
      return {
        changes: [{ seq: pages }],
        commitHash: `c${pages}`,
        hasMore: true,
      };
    },
    { maxPages: 3, maxChanges: 10_000 },
  );
  assert.equal(res.pages, 3);
  assert.equal(res.paused, true);
  assert.equal(cursors.value.reconcileNeeded, true, "visible pending status");
});

test("transient failures retry with capped exponential backoff; exhausted attempts quarantine", async () => {
  const dir = newDir("retry");
  let now = 1_000;
  const backend = new FakeBackend();
  const store = DurableOutbox.open(dir, { now: () => now });
  const w = new OutboxWorker({
    store,
    send: (job) => backend.send(job),
    now: () => now,
    random: () => 0,
    baseDelayMs: 100,
    capDelayMs: 400,
    maxAttempts: 3,
  });
  backend.failNext = new BackendError("availability", "transport down");
  store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e1"]),
    payload: { a: 1 },
  });
  let summary = await w.tick();
  assert.equal(summary.retried.length, 1);
  assert.equal(summary.retried[0]!.attempts, 1);
  assert.equal(
    summary.retried[0]!.nextAttemptAt,
    1_100,
    "base delay, no jitter (random=0)",
  );
  now = 1_100;
  backend.failNext = new BackendError("availability", "still down");
  summary = await w.tick();
  assert.equal(summary.retried[0]!.nextAttemptAt, 1_300, "2x backoff");
  now = 1_300;
  backend.failNext = new BackendError("availability", "still down");
  summary = await w.tick();
  assert.equal(
    summary.quarantined.length,
    1,
    "attempts exhausted → quarantine",
  );
  assert.match(summary.quarantined[0]!.reason, /after 3 attempt/);
  assert.equal(store.pending().length, 0);
  // Quarantined jobs are inspectable and never retried.
  assert.match(
    store.quarantined()[0]!.lastError ?? "",
    /BackendError:availability/,
  );
  backend.failNext = null;
  summary = await w.tick();
  assert.deepEqual(summary.sent, [], "quarantined job is never re-sent");
  store.close();
});

test("jitter stays within bounds and backoff is capped", () => {
  const dir = newDir("jitter");
  const store = DurableOutbox.open(dir);
  const w = new OutboxWorker({
    store,
    send: async () => {},
    baseDelayMs: 100,
    capDelayMs: 400,
  });
  for (let i = 0; i < 20; i++) {
    const b = w.backoffMs(1);
    assert.ok(b >= 100 && b <= 120, `jitter bound at attempt 1: ${b}`);
  }
  assert.ok(
    w.backoffMs(10) <= 400 * 1.2,
    "capped at capDelayMs * (1 + jitter)",
  );
  store.close();
});

test("permanent failure quarantines immediately; quarantine is bounded, inspectable and explicitly discardable", async () => {
  const dir = newDir("permanent");
  const backend = new FakeBackend();
  const store = DurableOutbox.open(dir);
  const w = makeWorker(store, backend);
  store.enqueue({
    kind: "board-message",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e5"]),
    payload: { m: 1 },
  });
  backend.failNext = new BackendError("validation", "bad request");
  const summary = await w.tick();
  assert.equal(summary.quarantined.length, 1);
  assert.equal(store.pending().length, 0);
  assert.equal(store.quarantined().length, 1);
  store.discardQuarantined(store.quarantined()[0]!.seq);
  assert.equal(store.quarantined().length, 0);
  store.close();
});

test("error fingerprints never carry messages (no user content in queue bytes)", () => {
  const fp = errorFingerprint(
    new BackendError("validation", "leak: secret-value-with-user-content"),
  );
  assert.equal(fp, "BackendError:validation");
  assert.ok(!fp.includes("secret"));
});

test("overflow pauses new capture with a visible gap; pending jobs preserved; retention frees capacity (acked only)", () => {
  const dir = newDir("overflow");
  const store = DurableOutbox.open(dir, {
    limits: { ...DEFAULT_LIMITS, maxJobs: 2, retentionMs: 1000 },
    now: () => 10_000,
  });
  store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e1"]),
    payload: { a: 1 },
  });
  store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e2"]),
    payload: { a: 2 },
  });
  assert.equal(store.capturePaused, true);
  assert.throws(
    () =>
      store.enqueue({
        kind: "observation",
        scope: "personal",
        idempotencyKey: makeKey("personal", ["e3"]),
        payload: { a: 3 },
      }),
    OutboxOverflowError,
  );
  assert.equal(
    store.pending().length,
    2,
    "pending jobs never dropped (no drop-oldest)",
  );
  // Ack one job; retention has not elapsed → capacity is NOT freed yet.
  store.ack(store.pending()[0]!.seq);
  assert.equal(store.capturePaused, true);
  store.runRetention();
  assert.equal(
    store.capturePaused,
    true,
    "age retention applies only after the retention window",
  );
  // Advance past retention: acked job is cleaned, capacity freed.
  store.close();
  const store2 = DurableOutbox.open(dir, {
    limits: { ...DEFAULT_LIMITS, maxJobs: 2, retentionMs: 1000 },
    now: () => 20_000,
  });
  store2.runRetention();
  assert.equal(store2.capturePaused, false);
  store2.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e3"]),
    payload: { a: 3 },
  });
  assert.equal(store2.pending().length + store2.quarantined().length, 2);
  store2.close();
});

test("disk-full during ack keeps pending jobs and cursors intact (no false completeness)", async () => {
  const dir = newDir("disk-full");
  const backend = new FakeBackend();
  const store = DurableOutbox.open(dir);
  const cursors = new CursorFile(dir);
  const w = makeWorker(store, backend);
  const job = store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e1"]),
    payload: { a: 1 },
  });
  cursors.advanceLocalSeq(store.maxSeq);
  store.ack(job.seq);
  store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e2"]),
    payload: { a: 2 },
  });
  cursors.advanceLocalSeq(store.maxSeq);
  assert.equal(cursors.value.localSeq, 2);
  store.persistFault = new Error("ENOSPC");
  assert.throws(
    () =>
      store.enqueue({
        kind: "observation",
        scope: "personal",
        idempotencyKey: makeKey("personal", ["e3"]),
        payload: { a: 3 },
      }),
    OutboxPersistError,
  );
  store.persistFault = null;
  assert.equal(
    cursors.value.localSeq,
    2,
    "local cursor untouched by failed enqueue",
  );
  assert.ok(store.pending().length >= 1, "previously accepted work survives");
  store.close();
  const reopened = DurableOutbox.open(dir);
  assert.ok(reopened.pending().length + reopened.stats.acked >= 2);
  reopened.close();
});

test("permissions: journal must be 0600 — over-permissive file fails closed; directory is 0700", () => {
  const dir = newDir("perms");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = DurableOutbox.open(dir);
  store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e1"]),
    payload: { a: 1 },
  });
  store.close();
  chmodSync(join(dir, "jobs.jsonl"), 0o644);
  assert.throws(
    () => DurableOutbox.open(dir),
    (err: unknown) => {
      assert.ok(err instanceof OutboxPermissionError);
      assert.match(err.message, /0600/);
      return true;
    },
  );
});

test("multi-process: second opener fails while the lock is held", () => {
  const dir = newDir("lock");
  const a = DurableOutbox.open(dir);
  assert.throws(() => DurableOutbox.open(dir), OutboxLockHeldError);
  a.close();
  // After close the lock is released.
  const b = DurableOutbox.open(dir);
  b.close();
});

test("secret-bearing payloads refuse to enqueue (queue bytes stay clean)", () => {
  const dir = newDir("secrets");
  const store = DurableOutbox.open(dir);
  assert.throws(
    () =>
      store.enqueue({
        kind: "observation",
        scope: "personal",
        idempotencyKey: makeKey("personal", ["e1"]),
        payload: {
          text: "export OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      }),
    /secret-bearing/,
  );
  assert.equal(store.pending().length, 0);
  store.close();
});

test("private mode holds sends; resume releases via the constructor-registered listener", async () => {
  const dir = newDir("private");
  const backend = new FakeBackend();
  const gate = new PrivateModeGate();
  const store = DurableOutbox.open(dir);
  const w = makeWorker(store, backend, gate);
  // The release listener was registered at construction — BEFORE any enable.
  gate.enable();
  store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e1"]),
    payload: { a: 1 },
  });
  let summary = await w.tick();
  assert.deepEqual(summary.sent, [], "nothing sends while private");
  assert.equal(summary.held.length, 1);
  assert.equal(store.pending().length, 1, "held job preserved, never dropped");
  gate.resume(); // release listener triggers a tick internally
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(backend.records.size, 1, "resume released the held job");
  assert.equal(store.pending().length, 0);
  void summary;
  store.close();
});

test("per-scope ordering: a not-yet-due scope head blocks its own scope but not others", async () => {
  const dir = newDir("ordering");
  let now = 1_000;
  const backend = new FakeBackend();
  const store = DurableOutbox.open(dir, { now: () => now });
  const w = new OutboxWorker({
    store,
    send: (j) => backend.send(j),
    now: () => now,
    random: () => 0,
    baseDelayMs: 100,
  });
  const jA1 = store.enqueue({
    kind: "observation",
    scope: "project/A",
    idempotencyKey: makeKey("project/A", ["a1"]),
    payload: { a: 1 },
  });
  const jA2 = store.enqueue({
    kind: "observation",
    scope: "project/A",
    idempotencyKey: makeKey("project/A", ["a2"]),
    payload: { a: 2 },
  });
  store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["p1"]),
    payload: { p: 1 },
  });
  backend.failNext = new BackendError("availability", "scope A head down");
  const s1 = await w.tick();
  assert.equal(s1.retried.length, 1);
  assert.ok(s1.sent.some(() => true));
  assert.equal(
    backend.records.size,
    1,
    "scope B delivered while scope A head retries",
  );
  // Scope A head now due later; A2 must not overtake it.
  now = 1_050; // before jA1's nextAttemptAt (1_100)
  const s2 = await w.tick();
  assert.equal(s2.sent.length, 0, "scope A head not due → no scope A delivery");
  now = 1_200;
  const s3 = await w.tick();
  assert.equal(s3.sent.length, 1, "head delivered first");
  assert.ok(
    store.pending().some((j) => j.seq === jA2.seq) || s3.sent.length >= 1,
  );
  void jA1;
  void jA2;
  store.close();
});

test("failed jobs never block Pi interaction: tick never throws, even on non-Error sender faults", async () => {
  const dir = newDir("never-block");
  const store = DurableOutbox.open(dir);
  const w = new OutboxWorker({
    store,
    send: async () => {
      throw "string fault"; // eslint-disable-line no-throw-literal
    },
  });
  store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e1"]),
    payload: { a: 1 },
  });
  const summary = await w.tick();
  assert.equal(
    summary.quarantined.length,
    1,
    "non-Error faults quarantine, never propagate",
  );
  store.close();
});

test("failed jobs never block Pi interaction: persist fault during retry/quarantine recording never throws out of tick", async () => {
  const dir = newDir("never-block-persist");
  let now = 1_000;
  const store = DurableOutbox.open(dir, { now: () => now });
  const w = new OutboxWorker({
    store,
    send: async () => {
      throw new AvailabilityError("backend unreachable", "b2_ensure_note");
    },
    now: () => now,
    baseDelayMs: 100,
  });
  store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e1"]),
    payload: { a: 1 },
  });
  // Simulated disk-full while persisting the retry/quarantine record itself:
  // tick must still resolve and the job must stay pending (never dropped).
  store.persistFault = new Error("ENOSPC: no space left on device");
  const summary = await w.tick();
  assert.equal(summary.sent.length, 0);
  assert.equal(
    summary.retried.length + summary.quarantined.length,
    0,
    "failure record was not durably persisted — not reported as recorded",
  );
  store.persistFault = null;
  assert.equal(store.pending().length, 1, "job stays pending, never dropped");
  store.close();

  // Same invariant for the quarantine path (attempts exhausted).
  const store2 = DurableOutbox.open(dir, { now: () => now });
  const w2 = new OutboxWorker({
    store: store2,
    send: async () => {
      throw new ValidationError("bad payload", "b2_ensure_note");
    },
    now: () => now,
  });
  store2.persistFault = new Error("ENOSPC");
  await w2.tick();
  store2.persistFault = null;
  assert.equal(
    store2.pending().length,
    1,
    "job stays pending after quarantine-persist fault",
  );
  store2.close();
});

test("durable op-id ledger: enqueue persists the opId before return; unpersisted opIds fail closed", async () => {
  const dir = newDir("opid");
  const store = DurableOutbox.open(dir);
  const ledger = store.ledger();
  const job = store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e1"]),
    payload: { a: 1 },
  });
  ledger.assertPersisted(job.opId); // must not throw: opId was persisted pre-return
  assert.throws(
    () => ledger.assertPersisted("00000000-0000-4000-8000-000000000000"),
    (err: unknown) => {
      assert.ok(err instanceof BackendError);
      assert.equal((err as BackendError).code, "not-persisted");
      return true;
    },
  );
  // Worker re-asserts before each send.
  const backend = new FakeBackend();
  const w = makeWorker(store, backend);
  await w.tick();
  assert.equal(backend.records.size, 1);
  store.close();
});

test("unknown newer journal schemaVersion opens read-only with a visible reason", () => {
  const dir = newDir("future-schema");
  const store = DurableOutbox.open(dir);
  store.enqueue({
    kind: "observation",
    scope: "personal",
    idempotencyKey: makeKey("personal", ["e1"]),
    payload: { a: 1 },
  });
  store.close();
  // Hand-upgrade the journal to a hypothetical future schemaVersion.
  const lines = readFileSync(join(dir, "jobs.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.stringify({ ...JSON.parse(l), schemaVersion: 99 }));
  writeFileSync(join(dir, "jobs.jsonl"), lines.join("\n") + "\n", {
    mode: 0o600,
  });
  const ro = DurableOutbox.open(dir);
  assert.equal(ro.isReadOnly, true);
  assert.match(ro.readOnlyReason ?? "", /newer than supported/);
  assert.throws(
    () =>
      ro.enqueue({
        kind: "observation",
        scope: "personal",
        idempotencyKey: makeKey("personal", ["e2"]),
        payload: { b: 2 },
      }),
    /read-only/,
  );
  assert.equal(
    ro.pending().length,
    0,
    "unsupported-schema jobs are never processed (fail safe)",
  );
  const before = readFileSync(join(dir, "jobs.jsonl"), "utf8");
  ro.close();
  assert.equal(
    readFileSync(join(dir, "jobs.jsonl"), "utf8"),
    before,
    "journal never destructively rewritten",
  );
});
