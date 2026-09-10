/**
 * Q09A acceptance tests: bounded tick coalescing under a blocked send.
 *
 * Reproduces the Q08 leftover: while a send blocks (unresponsive backend),
 * every overlapping tick() caller used to queue a full runTick execution on
 * the worker chain — unbounded growth. After the fix:
 * - a high volume of concurrent tick() callers coalesces into at most one
 *   queued execution plus one no-lost-wakeup follow-up;
 * - every caller still settles (explicit await semantics preserved);
 * - work enqueued during the blocked send is delivered exactly once;
 * - private-mode holds and quiesce-style awaiting keep their guarantees;
 * - a throwing tick still settles (rejects) its coalesced callers.
 *
 * Synthetic fixtures only — no live backend, no sockets.
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrivateModeGate } from "../src/privacy/private-mode.ts";
import { DurableOutbox } from "../src/outbox/store.ts";
import { OutboxWorker, type TickSummary } from "../src/outbox/worker.ts";
import { idempotencyKey } from "../src/domain/idempotency.ts";

function newDir(name: string): string {
  return join(
    tmpdir(),
    `kiwifs-q09a-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
}

function makeKey(scope: string, entryIds: string[]): string {
  return idempotencyKey({
    kind: "observation",
    scope,
    sources: [{ sessionId: "s1", entryIds }],
  });
}

function enqueue(store: DurableOutbox, scope: string, id: string): string {
  return store.enqueue({
    kind: "observation",
    scope,
    idempotencyKey: makeKey(scope, [id]),
    payload: { text: id },
  }).opId;
}

test("high-volume concurrent ticks during a blocked send coalesce into bounded executions", async () => {
  const store = DurableOutbox.open(newDir("high-volume"));
  const opId = enqueue(store, "personal", "e1");
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const sendCalls: string[] = [];
  const w = new OutboxWorker({
    store,
    send: async (job) => {
      sendCalls.push(job.opId);
      if (sendCalls.length === 1) await blocked; // first send hangs
    },
    now: () => Date.now(),
    random: () => 0,
  });

  // First tick enters the blocked send.
  const first = w.tick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sendCalls.length, 1, "first send in flight");

  // High-volume trigger: many overlapping callers (timer/gate/command paths).
  const CALLERS = 500;
  const callers: Promise<TickSummary>[] = [];
  for (let i = 0; i < CALLERS; i++) callers.push(w.tick());
  // Bounded: only the one execution is queued/running; no per-caller ticks.
  assert.equal(
    w.tickExecutionsStarted,
    1,
    "overlapping callers must coalesce, not queue executions",
  );

  // Unblock; the covering tick finishes, and the wakeup follow-up drains.
  release();
  const [firstSummary, ...rest] = await Promise.all([first, ...callers]);
  assert.deepEqual(firstSummary.sent, [opId], "job delivered exactly once");
  assert.equal(sendCalls.length, 1, "never double-sent by coalesced ticks");
  assert.equal(store.pending().length, 0, "quiesce: nothing left pending");
  for (const s of rest) {
    assert.deepEqual(
      Object.keys(s).sort(),
      ["held", "pendingAck", "quarantined", "retried", "sent"],
      "every caller settles with a real summary",
    );
  }
  assert.ok(
    w.tickExecutionsStarted <= 2,
    "bounded executions even after release",
  );
  store.close();
});

test("no lost wakeup: work enqueued while a send blocks is delivered after release", async () => {
  const store = DurableOutbox.open(newDir("lost-wakeup"));
  const op1 = enqueue(store, "personal", "e1");
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const sendCalls: string[] = [];
  const w = new OutboxWorker({
    store,
    send: async (job) => {
      sendCalls.push(job.opId);
      if (sendCalls.length === 1) await blocked;
    },
    now: () => Date.now(),
    random: () => 0,
  });

  const t1 = w.tick(); // enters blocked send with job1's head snapshot
  await new Promise((r) => setTimeout(r, 0));
  // Arrives AFTER the running tick read pending(): must not be lost.
  const op2 = enqueue(store, "personal", "e2");
  const late = w.tick(); // coalesces, arms the wakeup
  assert.equal(w.tickExecutionsStarted, 1);

  release();
  const [s1, s2] = await Promise.all([t1, late]);
  assert.deepEqual(s1.sent, [op1]);
  assert.equal(
    w.tickExecutionsStarted,
    2,
    "exactly one follow-up tick covers the late enqueue",
  );
  assert.deepEqual(s2.sent, [op2], "late job delivered by the follow-up");
  assert.equal(store.pending().length, 0);
  assert.equal(new Set(sendCalls).size, 2, "each job sent exactly once");
  store.close();
});

test("private-mode hold is preserved across coalescing; resume delivers (no lost job)", async () => {
  const gate = new PrivateModeGate();
  const store = DurableOutbox.open(newDir("private-hold"));
  const opId = enqueue(store, "personal", "e1");
  const sent: string[] = [];
  const w = new OutboxWorker({
    store,
    send: async (job) => {
      sent.push(job.opId);
    },
    gate,
    now: () => Date.now(),
    random: () => 0,
  });

  gate.enable();
  const t1 = w.tick();
  const coalesced = [w.tick(), w.tick(), w.tick()];
  const [s1, ...rest] = await Promise.all([t1, ...coalesced]);
  assert.deepEqual(s1.held, [opId], "held, never sent, never dropped");
  for (const s of rest) assert.ok(s.held.length <= 1);
  assert.equal(sent.length, 0, "never sent while private");
  assert.equal(store.pending().length, 1, "pending work preserved");

  // Release listener fires a tick internally; coalescing must not lose it.
  gate.resume();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, [opId], "delivered after resume");
  assert.equal(store.pending().length, 0);
  store.close();
});

test("quiesce semantics: awaiting the tick drains pending work; sequential awaits unchanged", async () => {
  const store = DurableOutbox.open(newDir("quiesce"));
  const op1 = enqueue(store, "personal", "e1");
  const op2 = enqueue(store, "personal", "e2");
  const sent: string[] = [];
  const w = new OutboxWorker({
    store,
    send: async (job) => {
      sent.push(job.opId);
    },
    now: () => Date.now(),
    random: () => 0,
  });
  const s1 = await w.tick();
  const s2 = await w.tick();
  // Per-scope ordering: one job per tick, each explicit await gets its own
  // real summary (coalescing only applies to overlapping callers).
  assert.deepEqual(s1.sent, [op1]);
  assert.deepEqual(s2.sent, [op2]);
  assert.equal(w.tickExecutionsStarted, 2);
  assert.equal(store.pending().length, 0);
  store.close();
});

test("a throwing tick still settles (rejects) its coalesced callers", async () => {
  const store = DurableOutbox.open(newDir("throwing"));
  // Force runTick itself to throw ONCE: a transiently faulting clock.
  let fault = true;
  const w = new OutboxWorker({
    store,
    send: async () => undefined,
    now: () => {
      if (fault) {
        fault = false;
        throw new Error("clock fault");
      }
      return Date.now();
    },
    random: () => 0,
  });
  const t1 = w.tick();
  const c1 = w.tick();
  const c2 = w.tick();
  await assert.rejects(t1);
  await assert.rejects(c1, "coalesced caller settled");
  await assert.rejects(c2, "coalesced caller settled");
  // The chain survives; the worker remains usable.
  const opId = enqueue(store, "personal", "e1");
  const s = await w.tick();
  assert.deepEqual(s.sent, [opId]);
  store.close();
});
