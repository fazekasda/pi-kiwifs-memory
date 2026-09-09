/**
 * T19 chunk 1: integrated offline fault/privacy matrix (PRD T19 AC 1/3/4/7,
 * architecture.md fault-test table). Synthetic only — the REAL shared
 * pipeline (KiwiFSAdapter + OutboxWorker + observation/backup/board senders
 * + retrieval coordinator) runs against the in-process fake MCP server
 * (test/fake-mcp-server.ts); no live service, no network, no model calls.
 *
 * What this file adds over the granular per-feature suites (T07/T13/T14/
 * T16): observation, backup and board ride the SAME real backend adapter
 * and the SAME outbox worker (not the FakeBackend stubs of
 * test/outbox.test.ts), so outage/retry/recovery, crash-reload, replay,
 * conflicting writes, private-mode transitions and malformed payloads are
 * exercised through the actual wire boundary — and a leak scanner proves
 * every refusal/error/degradation string carries no synthetic secret or
 * user-content canaries.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KiwiFSAdapter } from "../src/backend/adapter.ts";
import { createMemoryLedger, type OpIdLedger } from "../src/backend/opid.ts";
import { identityRedactor } from "../src/backend/guard.ts";
import { idempotencyKey } from "../src/domain/idempotency.ts";
import {
  buildObservationRecord,
  createObservationSender,
  type ObservationPayload,
} from "../src/observation/sender.ts";
import { serializeChunk, chunkChecksum } from "../src/backup/chunker.ts";
import { DurableOutbox, type OutboxJob } from "../src/outbox/store.ts";
import { OutboxWorker } from "../src/outbox/worker.ts";
import { PrivateModeGate } from "../src/privacy/private-mode.ts";
import {
  RetrievalCoordinator,
  type EvidencePack,
} from "../src/retrieval/coordinator.ts";
import {
  createFakeServer,
  type FakeServerBehavior,
} from "./fake-mcp-server.ts";
import { BoardRepository } from "../src/board/repository.ts";
import { BoardDelivery, DeliveryStateFile } from "../src/board/delivery.ts";

const URL_ = "https://kiwifs.test/mcp";
const SCOPE = "project/demo-proj";

/** Leak canaries (synthetic; never real credentials or user data). */
const SECRET_CANARY = "SYNTHETIC-SECRET-CANARY-9f2a7c";
const CONTENT_CANARY = "SYNTHETIC-CONTENT-CANARY-4b81ce";

/** Mutable clock so worker backoff windows advance deterministically. */
let fakeNow = 1_000;
const now = () => fakeNow;

/** Deterministic UUID-shaped opIds (payload.opId must equal job.opId). */
const OP_IDS = {
  outage: "00000000-0000-4000-8000-0000000000a1",
  crashObs: "00000000-0000-4000-8000-0000000000b1",
  conflict: "00000000-0000-4000-8000-0000000000c1",
  board: "00000000-0000-4000-8000-0000000000d2",
  privateObs: "00000000-0000-4000-8000-0000000000d1",
  malformed: "00000000-0000-4000-8000-0000000000e1",
  leak: "00000000-0000-4000-8000-0000000000f1",
  bounded: "00000000-0000-4000-8000-0000000000f2",
};

function newDir(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `kiwifs-t19-${name}-`)), "state");
}

async function setup(
  behavior: FakeServerBehavior = {},
  ledger: OpIdLedger = createMemoryLedger(),
) {
  const server = createFakeServer(behavior);
  const adapter = new KiwiFSAdapter({
    url: URL_,
    fetchImpl: server.fetch,
    ledger,
    requestTimeoutMs: 1_000,
  });
  await adapter.connect();
  return { server, adapter, ledger };
}

function makeWorker(
  store: DurableOutbox,
  adapter: KiwiFSAdapter,
  gate?: PrivateModeGate,
  send?: (job: OutboxJob) => Promise<void>,
): OutboxWorker {
  return new OutboxWorker({
    store,
    send:
      send ??
      createObservationSender({
        scope: SCOPE,
        openBackend: async () => adapter,
      }),
    ...(gate ? { gate } : {}),
    now,
    random: () => 0, // deterministic jitter lower bound
    baseDelayMs: 100,
    capDelayMs: 400,
  });
}

function observationPayload(opId: string): ObservationPayload {
  return {
    opId,
    trigger: "threshold",
    sessionId: "s1",
    sourceEntryIds: ["e1", "e2"],
    inputBudgetTokens: 6_000,
    outputBudgetTokens: 3_000,
    observations: [
      {
        sourceEntryIds: ["e1"],
        statement: "The team uses Postgres as the storage engine.",
        uncertainty: "low",
      },
    ],
  };
}

function enqueueObservation(store: DurableOutbox, opId: string): OutboxJob {
  return store.enqueue({
    kind: "observation",
    scope: SCOPE,
    opId,
    idempotencyKey: idempotencyKey({
      kind: "observation",
      scope: SCOPE,
      sources: [{ sessionId: "s1", entryIds: ["e1"] }],
    }),
    payload: observationPayload(opId),
  });
}

function backupChunkJob(
  store: DurableOutbox,
  sessionId = "s1",
  scope = SCOPE,
): OutboxJob {
  const entries = [
    {
      id: "e1",
      parentId: null,
      type: "message",
      timestamp: "2026-09-08T00:00:00Z",
      role: "user",
      text: "backup view one",
      omissions: [],
    },
  ];
  const content = serializeChunk({ sessionId, seq: 1, entries });
  return store.enqueue({
    kind: "backup-chunk",
    scope,
    idempotencyKey: createHash("sha256")
      .update(`backup:${sessionId}:1`)
      .digest("hex")
      .slice(0, 32),
    payload: {
      type: "chunk",
      sessionId,
      seq: 1,
      entryIds: ["e1"],
      content,
      checksum: chunkChecksum(content),
    },
  });
}

function boardJob(
  store: DurableOutbox,
  opId: string,
  scope = SCOPE,
): OutboxJob {
  return store.enqueue({
    kind: "board-message",
    scope,
    opId,
    idempotencyKey: createHash("sha256")
      .update(`board:demo:${opId}`)
      .digest("hex")
      .slice(0, 32),
    payload: {
      opId,
      channel: "demo-channel",
      from: "agent-a1",
      to: "agent-b2",
      body: "synthetic board body (redacted)",
      created: new Date(0).toISOString(),
    },
  });
}

/** Count backend write-tool calls (any backend mutation). */
function writeCalls(server: {
  state: { requests: { body: string }[] };
}): number {
  return server.state.requests.filter((r) => r.body.includes('"kiwi_write"'))
    .length;
}

function noCanaries(label: string, ...samples: (string | undefined)[]): void {
  for (const sample of samples) {
    if (sample === undefined) continue;
    assert.ok(
      !sample.includes(SECRET_CANARY),
      `${label}: secret canary leaked: ${sample}`,
    );
    assert.ok(
      !sample.includes(CONTENT_CANARY),
      `${label}: content canary leaked: ${sample}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Matrix scenarios
// ---------------------------------------------------------------------------

test("fault matrix: outage (HTTP 500) → retry with backoff → recovery delivers the observation record", async () => {
  // Real wiring (src/index.ts): the adapter's op-id ledger IS the outbox
  // store's durable journal — assertPersisted fails closed otherwise.
  const store = DurableOutbox.open(newDir("outage"), { now });
  const { server, adapter } = await setup(undefined, store.ledger());
  const w = makeWorker(store, adapter);
  const job = enqueueObservation(store, OP_IDS.outage);
  // Outage window: every request 500s → transport maps to AvailabilityError.
  server.behavior.status = 500;
  const tick1 = await w.tick();
  assert.equal(tick1.sent.length, 0, "nothing delivered during the outage");
  assert.equal(tick1.retried.length, 1, "failure recorded as a retry");
  noCanaries("retry path", JSON.stringify(tick1.retried));
  // Recovery: clear the outage, advance past backoff, tick again.
  delete server.behavior.status;
  fakeNow += 5_000;
  const tick2 = await w.tick();
  assert.equal(tick2.sent.length, 1, "recovered delivery after outage");
  assert.equal(tick2.sent[0], job.opId);
  const storePaths = [...server.state.store.keys()];
  assert.equal(storePaths.length, 1);
  assert.match(storePaths[0]!, /memory\/observations\//);
  assert.match(
    server.state.store.get(storePaths[0]!)!,
    /Postgres as the storage engine/,
  );
  assert.equal(store.pending().length, 0);
  store.close();
});

test("fault matrix: crash after enqueue → reopen processes pending from local state only; replay tick duplicates nothing", async () => {
  const dir = newDir("crash-reload");
  {
    const store = DurableOutbox.open(dir, { now });
    enqueueObservation(store, OP_IDS.crashObs);
    backupChunkJob(store);
    assert.equal(store.pending().length, 2);
    store.close(); // crash before any send
  }
  // Reopen over the SAME durable state (fresh worker = restart analogue);
  // the restarted adapter re-wires the reopened store's ledger.
  const reopened = DurableOutbox.open(dir, { now });
  const { server, adapter } = await setup(undefined, reopened.ledger());
  const w = makeWorker(reopened, adapter);
  // One tick processes at most one due job per scope (strict per-scope
  // ordering) — bounded loop until the durable pending set drains.
  const sentOpIds: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const s = await w.tick();
    sentOpIds.push(...s.sent);
    if (reopened.pending().length === 0) break;
    fakeNow += 1_000; // advance past the previous job's backoff window
  }
  assert.equal(sentOpIds.length, 2, "both pending jobs delivered on restart");
  const writesAfterFirst = writeCalls(server);
  assert.ok(writesAfterFirst >= 2);
  const paths = [...server.state.store.keys()];
  assert.ok(paths.some((p) => p.includes("memory/observations/")));
  assert.ok(paths.some((p) => p.includes("backup/")));
  // Replay: identical local state → backend writeImmutable replay no-op.
  const replay = await w.tick();
  assert.equal(replay.sent.length, 0);
  assert.equal(writeCalls(server), writesAfterFirst, "replay did not re-write");
  reopened.close();
});

test("fault matrix: conflicting write (deterministic path, differing content) fails closed and quarantines with a content-free reason; original content intact", async () => {
  const store = DurableOutbox.open(newDir("conflict"), { now });
  const { server, adapter } = await setup(undefined, store.ledger());
  const w = makeWorker(store, adapter);
  const job = enqueueObservation(store, OP_IDS.conflict);
  // Seed the backend with DIFFERENT content at the exact deterministic path
  // the sender will derive (same payload.opId, same persisted createdAt).
  const seeded = buildObservationRecord(
    observationPayload(job.opId),
    SCOPE,
    job.createdAt,
  );
  server.state.store.set(
    seeded.path,
    `---\nscope: ${SCOPE}\nmemory_status: active\n---\nseeded-different-content\n`,
  );
  const summary = await w.tick();
  assert.equal(summary.sent.length, 0, "conflict is never delivered");
  assert.equal(summary.quarantined.length, 1, "conflict quarantined");
  const q = store.quarantined()[0]!;
  assert.equal(q.opId, job.opId);
  // Quarantine reason is the error fingerprint only — no payload content.
  assert.match(q.lastError ?? "", /quarantined/);
  assert.doesNotMatch(q.lastError ?? "", /Postgres/);
  noCanaries("conflict quarantine", q.lastError, JSON.stringify(summary));
  // Original backend content was never overwritten (no CAS/overwrite).
  assert.match(
    server.state.store.get(seeded.path)!,
    /seeded-different-content/,
    "original backend content intact",
  );
  store.close();
});

test("fault matrix: private-mode transition holds sends across all three features and releases them on resume (zero backend mutation while private)", async () => {
  const store = DurableOutbox.open(newDir("private"), { now });
  const { server, adapter } = await setup(undefined, store.ledger());
  const gate = new PrivateModeGate(false, () => new Date(0));
  const w = makeWorker(store, adapter, gate);
  enqueueObservation(store, OP_IDS.privateObs);
  // Three DISTINCT scopes: the worker delivers one job per scope-head per
  // tick, so each feature job must be its own scope head to be examined and
  // HELD within a bounded tick loop (previously all three shared one scope
  // and the "held 3" assertion counted duplicate refs of the SAME head job —
  // exposed by the T19 hold-dedupe fix).
  backupChunkJob(store, "s1", "project/demo-proj-backup");
  boardJob(store, OP_IDS.board, "project/demo-proj-board");
  assert.equal(store.pending().length, 3);
  const writesAtConnect = writeCalls(server);
  gate.enable();
  // One tick per scope-head: bounded loop until all three jobs are HELD.
  const heldOpIds: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const s = await w.tick();
    heldOpIds.push(...s.held);
    if (gate.heldJobs().length === 3) break;
  }
  assert.equal(gate.heldJobs().length, 3, "all three feature jobs held");
  assert.equal(heldOpIds.length, 3);
  assert.equal(
    writeCalls(server),
    writesAtConnect,
    "zero backend mutation while private",
  );
  assert.equal(gate.heldJobs().length, 3);
  // Resume: release listener triggers a worker tick (one job per scope per
  // tick) — bounded loop until the durable pending set drains.
  gate.resume();
  await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 5 && store.pending().length > 0; i += 1) {
    fakeNow += 1_000;
    await w.tick();
  }
  const after = store.stats;
  assert.equal(after.quarantined, 0, "private-mode hold never quarantines");
  assert.equal(after.pending, 0, "held jobs released and delivered");
  const paths = [...server.state.store.keys()];
  assert.ok(
    paths.some((p) => p.includes("board/")),
    "board message delivered",
  );
  assert.ok(
    paths.some((p) => p.includes("backup/")),
    "backup chunk delivered",
  );
  assert.ok(
    paths.some((p) => p.includes("memory/observations/")),
    "observation delivered",
  );
  noCanaries("private-mode path", JSON.stringify(gate.eventLog()));
  store.close();
});

test("fault matrix: malformed job payload → typed permanent failure, quarantine before any backend write", async () => {
  const store = DurableOutbox.open(newDir("malformed"), { now });
  const { server, adapter } = await setup(undefined, store.ledger());
  const w = makeWorker(store, adapter);
  const writesAtConnect = writeCalls(server);
  store.enqueue({
    kind: "observation",
    scope: SCOPE,
    idempotencyKey: idempotencyKey({
      kind: "observation",
      scope: SCOPE,
      sources: [{ sessionId: "s1", entryIds: ["e1"] }],
    }),
    payload: { trigger: "threshold", observations: "not-an-array" },
  });
  const summary = await w.tick();
  assert.equal(summary.sent.length, 0);
  assert.equal(summary.quarantined.length, 1);
  assert.equal(writeCalls(server), writesAtConnect, "no backend write");
  const q = store.quarantined()[0]!;
  assert.match(q.lastError ?? "", /quarantined/);
  noCanaries("malformed quarantine", q.lastError);
  store.close();
});

test("fault matrix: refusal/error strings carry no secret or user-content canaries (worker quarantine, enqueue gate, private-mode refusal, settle drop)", async () => {
  const store = DurableOutbox.open(newDir("leaks"), { now });
  const { adapter } = await setup(undefined, store.ledger());
  const gate = new PrivateModeGate(false, () => new Date(0));
  const w = makeWorker(store, adapter, gate, async () => {
    // Worst case: a failing sender whose error embeds BOTH canaries.
    throw new Error(
      `delivery failed for ${SECRET_CANARY}: user said "${CONTENT_CANARY}"`,
    );
  });
  const job = store.enqueue({
    kind: "observation",
    scope: SCOPE,
    opId: OP_IDS.leak,
    idempotencyKey: idempotencyKey({
      kind: "observation",
      scope: SCOPE,
      sources: [{ sessionId: "s1", entryIds: ["e1"] }],
    }),
    payload: observationPayload(OP_IDS.leak),
  });
  const summary = await w.tick();
  assert.equal(summary.sent.length, 0);
  const q = store.quarantined()[0]!;
  assert.equal(q.opId, job.opId);
  // The durable failure reason is the fingerprint (name:code), not the message.
  assert.equal(q.status, "quarantined");
  assert.doesNotMatch(q.lastError ?? "", /SYNTHETIC-(SECRET|CONTENT)-CANARY/);

  // Secret-bearing enqueue refusal: the gate refuses BEFORE persisting.
  assert.throws(
    () =>
      store.enqueue({
        kind: "observation",
        scope: SCOPE,
        idempotencyKey: idempotencyKey({
          kind: "observation",
          scope: SCOPE,
          sources: [{ sessionId: "s1", entryIds: ["e2"] }],
        }),
        payload: { note: "token sk-synthetic0123456789abcdefghijklmnopqrstu" },
      }),
    /refused/,
  );
  // Private-mode refusal message names the feature, never content.
  gate.enable();
  let refusal = "";
  try {
    gate.assertNetworkAllowed("observation");
  } catch (err) {
    refusal = (err as Error).message;
  }
  assert.match(refusal, /blocked by private mode: observation/);
  noCanaries("leak check", refusal, q.lastError, JSON.stringify(store.stats));
  gate.resume(); // release (nothing pending here: the failing job quarantined)

  // Registry drop (fail closed at settle) is content-free as well.
  const coord = new RetrievalCoordinator({
    adapter,
    authorizedScopes: [SCOPE],
    deadlineMs: 500,
    tokenCap: 3_000,
    generation: 1,
    redact: identityRedactor,
    tokenizer: { id: "test", countTokens: (t) => t.split(/\s+/).length },
  });
  await coord.retrieve(
    `${SECRET_CANARY} ${CONTENT_CANARY}`,
    undefined,
    "interactive",
  );
  const dropped = coord.registry.dropUnmatched();
  assert.ok(dropped.length >= 1, "pack dropped fail-closed at settle");
  noCanaries("settle drop", coord.lastDegradedNote, JSON.stringify(dropped));
  store.close();
});

test("fault matrix: adversarial retrieval — superseded in-scope, out-of-scope active and keyword-only hybrid leak zero canaries into the pack", async () => {
  const server = createFakeServer();
  server.state.store.set(
    "project/demo-proj/memory/observations/2026/01/active-in-scope.md",
    [
      "---",
      `scope: ${SCOPE}`,
      "memory_status: active",
      "---",
      "Postgres storage decision",
    ].join("\n"),
  );
  server.state.store.set(
    "project/demo-proj/memory/observations/2026/01/forgotten-leak-attempt.md",
    [
      "---",
      `scope: ${SCOPE}`,
      "memory_status: superseded",
      "---",
      `Postgres storage decision ${CONTENT_CANARY}`,
    ].join("\n"),
  );
  server.state.store.set(
    "other-proj/memory/observations/2026/01/out-of-scope.md",
    [
      "---",
      "scope: project/other-proj",
      "memory_status: active",
      "---",
      `Postgres storage decision ${SECRET_CANARY}`,
    ].join("\n"),
  );
  server.state.hybridAttribution.set(
    "project/demo-proj/memory/observations/2026/01/active-in-scope.md",
    "keyword only",
  );
  const adapter = new KiwiFSAdapter({
    url: URL_,
    fetchImpl: server.fetch,
    ledger: createMemoryLedger(),
  });
  await adapter.connect();
  const coord = new RetrievalCoordinator({
    adapter,
    authorizedScopes: [SCOPE],
    deadlineMs: 2_000,
    tokenCap: 3_000,
    generation: 1,
    redact: identityRedactor,
    tokenizer: { id: "test", countTokens: (t) => t.split(/\s+/).length },
  });
  const outcome = await coord.retrieve(
    "Postgres storage decision",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack", "in-scope active record still recalled");
  const pack = (outcome as { pack: EvidencePack }).pack;
  const rendered = framePack(pack);
  noCanaries(
    "adversarial pack",
    rendered,
    JSON.stringify(pack.degraded),
    coord.lastDegradedNote,
  );
  // B3: the forgotten (superseded) record never enters the pack — the
  // read-back predicate rejects it even though hybrid/FTS surfaced it.
  assert.equal(
    pack.items.filter((i) => i.path.includes("forgotten-leak-attempt")).length,
    0,
    "superseded record excluded by read-back predicate",
  );
  // B4: the out-of-scope record never enters the pack (client-side gate is
  // the only scope gate on the scope-less hybrid leg).
  assert.equal(
    pack.items.filter((i) => i.path.includes("out-of-scope")).length,
    0,
    "out-of-scope record excluded",
  );
  for (const item of pack.items) {
    assert.ok(
      item.scope === SCOPE,
      `pack item scope ${item.scope} outside authorized set`,
    );
  }
  // Keyword-only attribution is honored at pack level (upsert keeps the
  // higher-scoring scoped leg for overlapping records, so the attribution
  // contract is the pack-wide degraded flag — never counting keyword-only
  // hits as semantic evidence).
  assert.ok(
    pack.degraded.some((d) =>
      /hybrid search degraded: results lack full semantic attribution/.test(d),
    ),
    `keyword-only hybrid degradation reported: ${pack.degraded.join(" | ")}`,
  );
  // No item may pose as semantic evidence via the degraded hybrid leg: every
  // item's leg is the guarded leg that accepted it, and the pack-wide flag
  // marks the hybrid results as keyword-only.
  assert.ok(
    pack.items.every(
      (i) => i.leg !== "hybrid" || i.attribution === "keyword only",
    ),
  );
});

test("fault matrix: bounded local state after shutdown — outbox state file stays bounded and the closed store refuses further work", async () => {
  const dir = newDir("bounded");
  const store = DurableOutbox.open(dir, { now });
  store.enqueue({
    kind: "observation",
    scope: SCOPE,
    opId: OP_IDS.bounded,
    idempotencyKey: idempotencyKey({
      kind: "observation",
      scope: SCOPE,
      sources: [{ sessionId: "s1", entryIds: ["e1"] }],
    }),
    payload: observationPayload(OP_IDS.bounded),
  });
  store.close();
  assert.throws(
    () =>
      store.enqueue({
        kind: "observation",
        scope: SCOPE,
        idempotencyKey: idempotencyKey({
          kind: "observation",
          scope: SCOPE,
          sources: [{ sessionId: "s1", entryIds: ["e2"] }],
        }),
        payload: { note: "after close" },
      }),
    /closed/,
    "closed store refuses new work",
  );
  const bytes = statSync(join(dir, "jobs.jsonl")).size;
  assert.ok(bytes > 0 && bytes < 64 * 1024, `state file bounded (${bytes} B)`);
});

function framePack(pack: EvidencePack): string {
  return pack.items.map((i) => `${i.path} ${i.body}`).join("\n");
}

// ---------------------------------------------------------------------------
// T19 chunk-1 additions (PRD AC1 remaining gaps): brief-leg cross-scope
// leakage as a DEDICATED case, malformed SEARCH output, dropped vector jobs,
// backend upgrade compatibility. Same real pipeline, same fake server.
// ---------------------------------------------------------------------------

test("fault matrix: brief-leg scope leakage is a dedicated fail-closed case — out-of-scope, superseded and fabricated brief sections never reach the pack", async () => {
  const server = createFakeServer();
  const inScope = "project/demo-proj/memory/observations/2026/01/brief-keep.md";
  // Long benign body: the kept brief section must clear the 25%
  // minimum-evidence threshold (§13 row 4) so the pack survives WITHOUT the
  // rebuild path — proving the brief leg itself delivers the record.
  const filler = "reliable context line for the team.\n".repeat(220);
  server.state.store.set(
    inScope,
    [
      "---",
      `scope: ${SCOPE}`,
      "memory_status: active",
      "---",
      `Postgres storage decision (real record body)\n${filler}`,
    ].join("\n"),
  );
  server.state.store.set(
    "other-proj/memory/observations/2026/01/brief-leak.md",
    [
      "---",
      "scope: project/other-proj",
      "memory_status: active",
      "---",
      `Postgres storage decision ${SECRET_CANARY}`,
    ].join("\n"),
  );
  server.state.store.set(
    "project/demo-proj/memory/observations/2026/01/brief-stale.md",
    [
      "---",
      `scope: ${SCOPE}`,
      "memory_status: superseded",
      "---",
      `Postgres storage decision ${CONTENT_CANARY}`,
    ].join("\n"),
  );
  // Fabricated brief pack (server-side brief text is untrusted): the
  // in-scope section's body claims canary content that the STORE does not
  // contain. The guard must re-read and use ONLY the read-back body.
  server.behavior.textOverrides = {
    // Search legs yield nothing (server-side fault analogue): the ONLY
    // candidate source this cycle is the brief pack.
    kiwi_search: "malformed: no results",
    kiwi_search_semantic: "malformed: no results",
    kiwi_search_hybrid: "malformed: no results",
    kiwi_brief: [
      "Brief pack (estimated 512 tokens, budget 4000):",
      "",
      `=== ${inScope} ===`,
      `FABRICATED BRIEF TEXT ${SECRET_CANARY}`,
      "",
      "=== other-proj/memory/observations/2026/01/brief-leak.md ===",
      `Postgres storage decision ${SECRET_CANARY}`,
      "",
      "=== project/demo-proj/memory/observations/2026/01/brief-stale.md ===",
      "Postgres storage decision",
    ].join("\n"),
  };
  const adapter = new KiwiFSAdapter({
    url: URL_,
    fetchImpl: server.fetch,
    ledger: createMemoryLedger(),
  });
  await adapter.connect();
  const coord = new RetrievalCoordinator({
    adapter,
    authorizedScopes: [SCOPE],
    deadlineMs: 2_000,
    tokenCap: 3_000,
    generation: 1,
    redact: identityRedactor,
    tokenizer: { id: "test", countTokens: (t) => t.split(/\s+/).length },
  });
  const outcome = await coord.retrieve(
    "Postgres storage decision",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack", "the in-scope brief section survives");
  const pack = (outcome as { pack: EvidencePack }).pack;
  // Exactly one item: the in-scope record, sourced from the brief leg, with
  // the REAL read-back body — the fabricated brief text never wins.
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0]!.path, inScope);
  assert.equal(pack.items[0]!.leg, "brief");
  assert.match(pack.items[0]!.body, /real record body/);
  assert.doesNotMatch(pack.items[0]!.body, /FABRICATED|SYNTHETIC-SECRET/);
  // Out-of-scope (scope step) and superseded (status step) sections dropped
  // with visible, content-free degradation notes.
  assert.ok(
    pack.degraded.some((d) =>
      /brief section dropped: guard step 'scope'/.test(d),
    ),
    `scope drop disclosed: ${pack.degraded.join(" | ")}`,
  );
  assert.ok(
    pack.degraded.some((d) =>
      /brief section dropped: guard step 'status'/.test(d),
    ),
    `status drop disclosed: ${pack.degraded.join(" | ")}`,
  );
  noCanaries(
    "brief-leak pack",
    framePack(pack),
    JSON.stringify(pack.degraded),
    coord.lastDegradedNote,
  );
});

test("fault matrix: malformed SEARCH output fabricates nothing — unparseable lines are skipped, phantom hits are guard-rejected, canaries never leak", async () => {
  const server = createFakeServer();
  const real = "project/demo-proj/memory/observations/2026/01/search-hit.md";
  server.state.store.set(
    real,
    [
      "---",
      `scope: ${SCOPE}`,
      "memory_status: active",
      "---",
      "Postgres storage decision",
    ].join("\n"),
  );
  server.behavior.textOverrides = {
    // Mixed garbage: negative score, score-less entry, prose noise — none of
    // it may fabricate a hit; canaries inside malformed lines never parse.
    kiwi_search: [
      `noise line with ${SECRET_CANARY}`,
      "1. path-without-score (N/A)",
      "-2. negative/score.md (-1.00)",
      `3. ${real} (3.00)`,
      "4. trailing garbage (",
      `5. ${CONTENT_CANARY}/x.md (high-score)`,
    ].join("\n"),
    // A well-formed hit for a path that does not exist: the guard's fresh
    // read-back must reject it (fabricated candidates never injected).
    kiwi_search_semantic: [
      `9. project/demo-proj/memory/observations/2026/01/phantom.md (0.500)`,
      `phantom score text ${SECRET_CANARY}`,
    ].join("\n"),
    // Unknown hybrid attribution strings must not fabricate hits.
    kiwi_search_hybrid: [
      `1. ${real} (vector-ish, #1)`,
      `2. ${real} (both #1)`,
    ].join("\n"),
  };
  const adapter = new KiwiFSAdapter({
    url: URL_,
    fetchImpl: server.fetch,
    ledger: createMemoryLedger(),
  });
  await adapter.connect();
  // Adapter level: parsers return only the well-formed hits — no throw, no
  // fabrication (parse never throws; callers see empty/partial hits).
  const fts = await adapter.searchFts("Postgres storage decision");
  assert.deepEqual(
    fts.hits.map((h) => h.path),
    [real],
  );
  const hyb = await adapter.searchHybrid("Postgres storage decision");
  assert.equal(hyb.hits.length, 0, "unknown attribution fabricates no hit");
  const sem = await adapter.searchSemantic("Postgres storage decision");
  assert.deepEqual(
    sem.hits.map((h) => h.path),
    ["project/demo-proj/memory/observations/2026/01/phantom.md"],
  );

  const coord = new RetrievalCoordinator({
    adapter,
    authorizedScopes: [SCOPE],
    deadlineMs: 2_000,
    tokenCap: 3_000,
    generation: 1,
    redact: identityRedactor,
    tokenizer: { id: "test", countTokens: (t) => t.split(/\s+/).length },
  });
  const outcome = await coord.retrieve(
    "Postgres storage decision",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  // Only the real record entered the pack; the phantom was guard-rejected.
  assert.deepEqual(
    pack.items.map((i) => i.path),
    [real],
  );
  assert.ok(
    pack.degraded.some((d) =>
      /candidate rejected: guard step 'read-back'/.test(d),
    ),
    `phantom rejection disclosed: ${pack.degraded.join(" | ")}`,
  );
  noCanaries(
    "malformed-search pack",
    framePack(pack),
    JSON.stringify(pack.degraded),
    coord.lastDegradedNote,
  );
});

test("fault matrix: dropped vector jobs — a dropped INDEX job keeps the record recallable via FTS with B4 under-recall disclosed; a dropped DELETE job's ghost is read-back-rejected", async () => {
  const server = createFakeServer();
  const droppedIndex =
    "project/demo-proj/memory/observations/2026/01/dropped-index.md";
  const droppedIndex2 =
    "project/demo-proj/memory/observations/2026/01/dropped-index-two.md";
  const droppedDelete =
    "project/demo-proj/memory/observations/2026/01/dropped-delete.md";
  const body = (extra: string) =>
    [
      "---",
      `scope: ${SCOPE}`,
      "memory_status: active",
      "---",
      `Postgres storage decision ${extra}`,
    ].join("\n");
  server.state.store.set(droppedIndex, body("vector index job dropped"));
  // A second record whose vector index job was dropped as well: the B4
  // under-recall measurement then observes 1 semantic hit vs 2 FTS hits.
  server.state.store.set(droppedIndex2, body("vector index job also dropped"));
  // Dropped DELETE job: the record was deleted, but the vector index still
  // carries it (delete job dropped when the queue was full — the concrete
  // mcp-contracts.md §4 stale-vector fixture).
  server.state.store.set(droppedDelete, body(`${CONTENT_CANARY} ghost`));
  server.state.store.delete(droppedDelete);
  server.state.semanticDropPaths.add(droppedIndex);
  server.state.semanticDropPaths.add(droppedIndex2);
  server.state.staleSemanticPaths.add(droppedDelete);
  server.state.hybridAttribution.set(droppedIndex, "keyword only");
  server.state.hybridAttribution.set(droppedIndex2, "keyword only");
  server.state.hybridAttribution.set(droppedDelete, "semantic only");
  const adapter = new KiwiFSAdapter({
    url: URL_,
    fetchImpl: server.fetch,
    ledger: createMemoryLedger(),
  });
  await adapter.connect();
  const coord = new RetrievalCoordinator({
    adapter,
    authorizedScopes: [SCOPE],
    deadlineMs: 2_000,
    tokenCap: 3_000,
    generation: 1,
    redact: identityRedactor,
    tokenizer: { id: "test", countTokens: (t) => t.split(/\s+/).length },
  });
  const outcome = await coord.retrieve(
    "Postgres storage decision",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const pack = (outcome as { pack: EvidencePack }).pack;
  const paths = pack.items.map((i) => i.path);
  // Dropped INDEX job: the record is still recallable (FTS leg), never
  // claimed as a semantic hit, and the under-recall is MEASURED (B4 note).
  assert.ok(
    paths.includes(droppedIndex),
    "dropped-index record still recalled",
  );
  const idxItem = pack.items.find((i) => i.path === droppedIndex)!;
  assert.notEqual(idxItem.leg, "semantic");
  // B4 measurement: the dropped index job made the semantic leg return one
  // hit fewer than FTS for this scope — the shortfall is REPORTED.
  assert.ok(
    pack.degraded.some((d) =>
      /semantic scope leg under-recall \(B4 post-candidate filter\): 1 semantic hit\(s\) vs 2 FTS hit\(s\)/.test(
        d,
      ),
    ),
    `B4 under-recall measured: ${pack.degraded.join(" | ")}`,
  );
  assert.ok(
    pack.degraded.some((d) =>
      /hybrid search degraded: results lack full semantic attribution/.test(d),
    ),
    "keyword-only hybrid degradation disclosed",
  );
  // Dropped DELETE job: the ghost is surfaced by the vector leg but the
  // read-back predicate rejects it — never injected.
  assert.ok(
    !paths.includes(droppedDelete),
    "dropped-delete ghost excluded by read-back",
  );
  assert.ok(
    pack.degraded.some((d) =>
      /candidate rejected: guard step 'read-back'/.test(d),
    ),
    `ghost rejection disclosed: ${pack.degraded.join(" | ")}`,
  );
  noCanaries(
    "dropped-vector pack",
    framePack(pack),
    JSON.stringify(pack.degraded),
    coord.lastDegradedNote,
  );
});

test("fault matrix: backend upgrade — additive tools/version are tolerated (capability-driven, no count); a regressive upgrade fails closed BEFORE any mutation; additive output-shape evolution parses unchanged", async () => {
  // (a) Additive upgrade: more tools, newer server version — connect
  // succeeds, capabilities are recorded, the real delivery pipeline works.
  {
    const store = DurableOutbox.open(newDir("upgrade-additive"), { now });
    const server = createFakeServer({
      extraTools: ["kiwi_graph_walk", "kiwi_future_thing"],
      serverVersion: "9.9.9",
    });
    const adapter = new KiwiFSAdapter({
      url: URL_,
      fetchImpl: server.fetch,
      ledger: store.ledger(),
      requestTimeoutMs: 1_000,
    });
    const caps = await adapter.connect();
    assert.ok(
      caps.tools.includes("kiwi_future_thing"),
      "new tools are recorded, never a count gate",
    );
    const w = makeWorker(store, adapter);
    const job = enqueueObservation(store, OP_IDS.outage);
    const tick = await w.tick();
    assert.deepEqual(
      tick.sent,
      [job.opId],
      "delivery works on an upgraded backend",
    );
    assert.ok(
      [...server.state.store.keys()].some((p) =>
        p.includes("memory/observations/"),
      ),
    );
    store.close();
  }
  // (b) Regressive upgrade: a required tool disappeared. connect() fails
  // closed BEFORE any mutation — the request log proves no write attempt.
  {
    const server = createFakeServer({ removeTools: ["kiwi_brief"] });
    const adapter = new KiwiFSAdapter({
      url: URL_,
      fetchImpl: server.fetch,
      ledger: createMemoryLedger(),
    });
    await assert.rejects(
      adapter.connect(),
      /missing required tools: kiwi_brief/,
    );
    const mutations = server.state.requests.filter(
      (r) =>
        r.body.includes('"kiwi_write"') || r.body.includes('"kiwi_delete"'),
    );
    assert.equal(mutations.length, 0, "no mutation before capability gate");
  }
  // (c) Additive output-shape evolution: unknown extra lines in changes and
  // search results are tolerated — parsing neither fabricates nor breaks,
  // and a board delivery cycle still completes over the evolved shape.
  {
    const server = createFakeServer({
      textOverrides: {
        kiwi_changes: [
          "- A board/dev/0123456789abcdef0123456789abcdef.md (actor: alice, 2026-09-08T00:00:00Z)",
          "",
          "last_seq: c91d0a4",
          "extra_field: future-server-metadata",
          "trailing evolution line without a key",
        ].join("\n"),
      },
    });
    const adapter = new KiwiFSAdapter({
      url: URL_,
      fetchImpl: server.fetch,
      ledger: createMemoryLedger(),
    });
    await adapter.connect();
    const changes = await adapter.changes("");
    assert.equal(changes.changes.length, 1);
    assert.equal(changes.lastSeq, "c91d0a4");
    // The delivery cycle consumes the evolved feed shape unchanged.
    const repo = new BoardRepository(adapter, {
      now: () => new Date("2026-09-08T00:00:00Z"),
    });
    const state = new DeliveryStateFile(newDir("upgrade-shape"), "consumer-a");
    const delivered: string[] = [];
    const delivery = new BoardDelivery({
      repo,
      state,
      deliver: (m) => void delivered.push(m.msgId),
      schedule: false,
      activePollMs: 1000,
      recipient: "them",
    });
    server.state.store.set(
      "board/dev/0123456789abcdef0123456789abcdef.md",
      [
        "---",
        "schemaVersion: 1",
        "id: 0123456789abcdef0123456789abcdef",
        "type: board-message",
        "scope: personal",
        "created: 2026-09-07T00:00:00Z",
        "sources: []",
        "status: active",
        "to: them",
        "from: alice",
        "channel: dev",
        "ttl: ",
        "---",
        "evolved-shape body",
      ].join("\n"),
    );
    const cycle = await delivery.runCycle();
    assert.deepEqual(cycle.delivered, ["0123456789abcdef0123456789abcdef"]);
    assert.equal(delivered.length, 1);
    assert.equal(cycle.discoveryFallback, undefined, "feed mode unaffected");
  }
});
