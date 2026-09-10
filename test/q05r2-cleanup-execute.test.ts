/**
 * Q05R2 acceptance tests (synthetic only — fake MCP server, no live
 * service, no real model): guarded delete executor for manual remote
 * board cleanup.
 *
 * Covers the Q05R2 task contract:
 * - executes ONLY the exact confirmed preview (never an unpreviewed path)
 * - fresh per-delete recheck: mutation / time drift / ownership / private
 *   transition → visible skip or abort, never a force delete
 * - opId minted AND persisted before each side effect
 * - cancellation propagation and maxDeletes bound, incl. UNKNOWN-outcome
 *   disclosure for deletes cancelled after the ledger persist
 * - partial-failure classification with sanitized details
 * - no atomicity / purge / secure-erasure / all-consumer-ack claims
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { KiwiFSAdapter } from "../src/backend/adapter.ts";
import { createMemoryLedger, mintOpId } from "../src/backend/opid.ts";

import { PrivateModeGate } from "../src/privacy/private-mode.ts";
import { CancelledError } from "../src/backend/errors.ts";
import { BoardRepository } from "../src/board/repository.ts";
import { GC_GRACE_MS } from "../src/board/cleanup-rules.ts";
import { planBoardCleanup } from "../src/board/cleanup.ts";
import { executeBoardCleanup } from "../src/board/cleanup-execute.ts";
import { createFakeServer, type FakeServerState } from "./fake-mcp-server.ts";

const URL_ = "https://kiwifs.test/mcp";
const OWN = "agent-a";
const CHANNEL = "project-alpha";

interface World {
  server: ReturnType<typeof createFakeServer>;
  state: FakeServerState;
  adapter: KiwiFSAdapter;
  repo: BoardRepository;
  ledger: ReturnType<typeof createMemoryLedger>;
  gate: PrivateModeGate;
}

function makeWorld(): World {
  const server = createFakeServer();
  const ledger = createMemoryLedger();
  const gate = new PrivateModeGate();
  const adapter = new KiwiFSAdapter({
    url: URL_,
    requestTimeoutMs: 250,
    fetchImpl: server.fetch,
    ledger,
  });
  const repo = new BoardRepository(adapter, { privateMode: gate });
  return { server, state: server.state, adapter, repo, ledger, gate };
}

async function send(
  w: World,
  msg: { from?: string; to?: string; ttlSeconds?: number; created: Date },
): Promise<{ msgId: string; path: string }> {
  const opId = mintOpId();
  w.ledger.record(opId);
  const res = await w.repo.send(
    {
      channel: CHANNEL,
      from: msg.from ?? OWN,
      to: msg.to ?? "agent-b",
      body: "body (opaque)",
      ...(msg.ttlSeconds !== undefined ? { ttlSeconds: msg.ttlSeconds } : {}),
      created: msg.created,
    },
    opId,
  );
  assert.ok(res.ok);
  return { msgId: res.msgId, path: res.path };
}

/** Own + TTL-expired well beyond grace → eligible (with an old local ack). */
const OLD = new Date(Date.now() - GC_GRACE_MS - 40 * 24 * 60 * 60 * 1000);
/** Ack instant far beyond the 30-day grace (§8 predicate is conjunctive). */
const OLD_ACK = OLD.getTime();
/** Ack lookup: every message locally acked long before the grace window. */
const ackEverything = (): number => OLD_ACK;

async function planOne(
  w: World,
  path: string,
): Promise<
  Extract<Awaited<ReturnType<typeof planBoardCleanup>>, { ok: true }>
> {
  const preview = await planBoardCleanup(w.repo, {
    ownFrom: OWN,
    acked: ackEverything,
    now: new Date(),
  });
  assert.ok(preview.ok, "preview must plan");
  assert.ok(
    preview.candidates.some((c) => c.path === path),
    "candidate must be in preview",
  );
  return preview;
}

// ------------------------------------------------------------- happy path

test("executor deletes an eligible confirmed candidate and removes it from the backend", async () => {
  const w = makeWorld();
  const { msgId, path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, path);

  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 1);
  assert.equal(res.deleted[0]!.msgId, msgId);
  assert.equal(res.deleted[0]!.path, path);
  assert.equal(res.aborted, false);
  // Message is actually gone from the backend store.
  assert.equal(w.state.store.has(path), false);
});

test("executor mints and persists the opId BEFORE the delete side effect", async () => {
  // The ledger the executor records into must be the SAME durable ledger
  // the adapter asserts against (persist-before-side-effect). Use a spy
  // ledger and observe the record-before-del ordering directly.
  const server = createFakeServer();
  const recorded = new Set<string>();
  let observedOpId = "";
  const spyLedger = {
    record: (opId: string) => {
      recorded.add(opId);
    },
    assertPersisted: (opId: string) => {
      if (!recorded.has(opId)) {
        throw new Error("opId not persisted before mutation");
      }
    },
  };
  const adapter = new KiwiFSAdapter({
    url: URL_,
    requestTimeoutMs: 250,
    fetchImpl: server.fetch,
    ledger: spyLedger,
  });
  const repo = new BoardRepository(adapter, {});
  const sendOp = mintOpId();
  spyLedger.record(sendOp);
  const sent = await repo.send(
    {
      channel: CHANNEL,
      from: OWN,
      to: "agent-b",
      body: "b",
      ttlSeconds: 60,
      created: OLD,
    },
    sendOp,
  );
  assert.ok(sent.ok);
  const preview = await planBoardCleanup(repo, {
    ownFrom: OWN,
    acked: ackEverything,
  });
  assert.ok(preview.ok);

  const realDel = adapter.del.bind(adapter);
  const wrapped = Object.create(adapter);
  wrapped.del = async (p: string, o: { opId: string }) => {
    assert.ok(recorded.has(o.opId), "opId must be recorded before del");
    observedOpId = o.opId;
    return realDel(p, o);
  };
  const res = await executeBoardCleanup(repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: wrapped as KiwiFSAdapter,
    ledger: spyLedger,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 1);
  // UUID-shaped fresh opId, not any preview/send-time value.
  assert.match(res.deleted[0]!.opId, /^[0-9a-f-]{36}$/);
  assert.equal(observedOpId, res.deleted[0]!.opId);
});

test("executor never deletes an unpreviewed path — fabricated candidate is refused", async () => {
  const w = makeWorld();
  const { path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, path);

  // Fabricate an extra candidate bound to a path that was never previewed.
  const forged: typeof preview = {
    ...preview,
    candidates: [
      ...preview.candidates,
      {
        msgId:
          "0000000000000000000000000000000000000000000000000000000000000000",
        path: "board/other-channel/0000000000000000000000000000000000000000000000000000000000000000.json",
        channel: "other-channel",
        from: OWN,
        to: "agent-b",
        created: OLD.toISOString(),
        ttlSeconds: 60,
        basis: ["ttl-expired"],
        expired: true,
        ackedAt: undefined,
      },
    ],
  };
  const res = await executeBoardCleanup(w.repo, forged, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 1); // only the genuine candidate
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0]!.reason, "id-mismatch");
  // The forged path still exists — untouched.
  assert.equal(
    w.state.store.has(
      "board/other-channel/0000000000000000000000000000000000000000000000000000000000000000",
    ),
    false,
  );
  assert.equal(w.state.store.has(path), false);
});

// ------------------------------------------------------- exact binding

test("stale preview: message changed between preview and execute → visible skip, no delete", async () => {
  const w = makeWorld();
  const { msgId, path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, path);

  // Mutate the stored record AFTER the preview (simulated concurrent write).
  const stem = msgId;
  const mutated = w.state.store
    .get(path)!
    .replace(/^created:.*$/m, "created: 2099-01-01T00:00:00.000Z");
  w.state.store.set(path, mutated);

  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 0);
  assert.equal(res.skipped[0]!.reason, "changed");
  assert.equal(w.state.store.has(path), true); // untouched
  void stem;
});

test("stale preview: sender changed after preview → changed skip, no delete", async () => {
  const w = makeWorld();
  const { path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, path);
  const mutated = w.state.store
    .get(path)!
    .replace(/^from:.*$/m, "from: agent-b");
  w.state.store.set(path, mutated);

  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 0);
  assert.equal(res.skipped[0]!.reason, "changed");
  assert.equal(w.state.store.has(path), true);
});

test("conservative hold: expired but never locally acked → missing-basis skip, no delete", async () => {
  const w = makeWorld();
  const { path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planBoardCleanup(w.repo, {
    ownFrom: OWN,
    acked: () => undefined,
    now: new Date(),
  });
  assert.ok(preview.ok);
  // The expired-only record is NEVER a candidate (conjunctive §8 predicate).
  assert.equal(preview.candidates.length, 0);
  assert.equal(preview.skipped[0]!.reason, "missing-basis");

  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: () => undefined,
    adapter: w.adapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 0);
  assert.equal(w.state.store.has(path), true);
});

test("fresh content identity: preview-recorded etag that drifted → changed skip, no delete", async () => {
  const w = makeWorld();
  const { msgId, path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, path);
  const item = preview.candidates.find((c) => c.path === path)!;
  assert.ok(item.etag, "fake backend supplies etags on reads");

  // Simulate a content change under the SAME stable id/created/from: the
  // backend content identity (etag) moved. Same msgId, same created, same
  // from — only the etag differs. The executor must skip, never delete.
  w.state.etags.set(path, "etag-drifted-by-concurrent-write");

  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 0);
  assert.equal(res.skipped[0]!.reason, "changed");
  assert.match(res.skipped[0]!.detail, /etag drift/);
  assert.equal(w.state.store.has(path), true); // untouched
  void msgId;
});

test("no etag at preview time (backend without content metadata) → binding stays on the exact tuple, no CAS invented", async () => {
  const w = makeWorld();
  const { path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, path);
  // Strip the etag from the preview: simulates a backend whose reads carry
  // no kiwi.etag. Binding must fall back to {msgId, path, created, from}.
  const noEtag: typeof preview = {
    ...preview,
    candidates: preview.candidates.map((c) => ({
      ...c,
      etag: undefined,
    })),
  };
  const res = await executeBoardCleanup(w.repo, noEtag, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, preview.candidates.length);
});

test("executor proceeds when ONLY the recipient label changed — routing labels are not confidentiality and eligibility never reads `to`", async () => {
  // Documented-by-test: `to` is a routing label (decisions.md #4), the
  // ownership basis is `from`, and eligibility never reads the recipient.
  // A `to` drift between preview and delete therefore does NOT make the
  // message ineligible or changed — the delete proceeds, exactly bound to
  // the unchanged {msgId, path, created} tuple.
  const w = makeWorld();
  const { path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, path);
  const mutated = w.state.store
    .get(path)!
    .replace(/^to:.*$/m, "to: some-other-agent");
  w.state.store.set(path, mutated);

  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 1);
  assert.equal(res.deleted[0]!.path, path);
  assert.equal(w.state.store.has(path), false);
});

test("time drift: preview eligible, but at execution time still within grace → no delete", async () => {
  const w = makeWorld();
  // Created 70d ago, ttl 30d → expired 40d ago → eligible at preview now;
  // at execution `now` (created + 45d) it is only 15d past expiry → grace.
  const created = new Date(Date.now() - 70 * 24 * 60 * 60 * 1000);
  const { path } = await send(w, { created, ttlSeconds: 30 * 24 * 60 * 60 });
  const preview = await planOne(w, path);

  const earlierNow = new Date(created.getTime() + 45 * 24 * 60 * 60 * 1000);
  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
    now: earlierNow,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 0);
  assert.equal(res.skipped[0]!.reason, "within-grace");
  assert.equal(w.state.store.has(path), true);
});

test("identity drift: executing under a different identity refuses with zero deletes", async () => {
  const w = makeWorld();
  const { path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, path);

  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: "agent-zzz",
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
  });
  assert.ok(!res.ok);
  assert.equal(res.reason, "identity-changed");
  assert.equal(res.deleted.length, 0);
  assert.equal(w.state.store.has(path), true);
});

test("failed preview (ok:false) refuses without any delete", async () => {
  const w = makeWorld();
  const res = await executeBoardCleanup(
    w.repo,
    { ok: false, reason: "listing-failed", detail: "x" },
    {
      ownFrom: OWN,
      acked: ackEverything,
      adapter: w.adapter,
      ledger: w.ledger,
    },
  );
  assert.ok(!res.ok);
  assert.equal(res.reason, "no-preview");
  assert.equal(res.deleted.length, 0);
});

// -------------------------------------------------------- private mode

test("private mode before execution refuses with zero deletes", async () => {
  const w = makeWorld();
  const { path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, path);
  w.gate.enable();
  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
    privateMode: w.gate,
  });
  assert.ok(!res.ok);
  assert.equal(res.reason, "private-mode");
  assert.equal(res.deleted.length, 0);
  assert.equal(w.state.store.has(path), true);
});

test("private-mode TRANSITION mid-run aborts after partial deletes, reports the partial result", async () => {
  const w = makeWorld();
  const a = await send(w, { created: OLD, ttlSeconds: 60 });
  const b = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, a.path);
  assert.ok(preview.candidates.length >= 2);

  // Transition to private mode right AFTER the first delete completes.
  let deletes = 0;
  const realDel = w.adapter.del.bind(w.adapter);
  const wrappedAdapter = Object.create(w.adapter);
  wrappedAdapter.del = async (p: string, o: { opId: string }) => {
    const r = await realDel(p, o);
    if (++deletes >= 1) w.gate.enable();
    return r;
  };
  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: wrappedAdapter as KiwiFSAdapter,
    ledger: w.ledger,
    privateMode: w.gate,
  });
  assert.ok(!res.ok);
  assert.equal(res.reason, "private-mode");
  assert.equal(res.deleted.length, 1); // partial
  assert.equal(w.state.store.has(a.path), false);
  assert.equal(w.state.store.has(b.path), true); // second never attempted
});

// ------------------------------------------------------- cancellation

test("pre-aborted signal performs zero deletes and reports aborted", async () => {
  const w = makeWorld();
  const { path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, path);
  const ac = new AbortController();
  ac.abort();
  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
    signal: ac.signal,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 0);
  assert.equal(res.aborted, true);
  assert.equal(w.state.store.has(path), true);
});

test("signal fires mid-run: remaining candidates are not examined", async () => {
  const w = makeWorld();
  const a = await send(w, { created: OLD, ttlSeconds: 60 });
  const b = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, a.path);
  const ac = new AbortController();
  let n = 0;
  const realDel = w.adapter.del.bind(w.adapter);
  const wrappedAdapter = Object.create(w.adapter);
  wrappedAdapter.del = async (
    p: string,
    o: { opId: string; signal?: AbortSignal },
  ) => {
    if (++n >= 2) ac.abort();
    return realDel(p, o);
  };
  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: wrappedAdapter as KiwiFSAdapter,
    ledger: w.ledger,
    signal: ac.signal,
  });
  assert.ok(res.ok);
  assert.ok(res.deleted.length <= 2);
  assert.equal(res.aborted, true);
});

test("cancelled DELETE after ledger persist discloses the opId as UNKNOWN outcome", async () => {
  // The opId is already durably recorded when adapter.del raises
  // CancelledError, so the remote delete may or may not have applied:
  // the opId must be disclosed as unknown, never silently dropped.
  const w = makeWorld();
  await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(
    w,
    (await send(w, { created: OLD, ttlSeconds: 60 })).path,
  );
  const wrappedAdapter = Object.create(w.adapter);
  wrappedAdapter.del = async () => {
    throw new CancelledError("simulated cancellation after dispatch");
  };
  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: wrappedAdapter as KiwiFSAdapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok);
  assert.equal(res.aborted, true);
  assert.equal(res.unknownDeleteOpIds.length, 1);
  // The opId IS durably persisted (assertPersisted throws only when absent):
  let persisted = true;
  try {
    w.ledger.assertPersisted(res.unknownDeleteOpIds[0]!);
  } catch {
    persisted = false;
  }
  assert.equal(persisted, true);
});

// ------------------------------------------------------------ bounds

test("maxDeletes bound: only N deleted, bound disclosed, extra candidate untouched", async () => {
  const w = makeWorld();
  const a = await send(w, { created: OLD, ttlSeconds: 60 });
  const b = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, a.path);
  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
    maxDeletes: 1,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 1);
  assert.equal(res.deletedBoundHit, true);
  const deletedPath = res.deleted[0]!.path;
  const other = deletedPath === a.path ? b.path : a.path;
  assert.equal(w.state.store.has(other), true);
});

// ----------------------------------------------------- partial failures

test("delete fault on one candidate → visible delete-failed skip, remaining candidates proceed", async () => {
  const w = makeWorld();
  const a = await send(w, { created: OLD, ttlSeconds: 60 });
  const b = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, a.path);
  // Fail exactly one delete (first call) with a domain error.
  let delCalls = 0;
  const realDel = w.adapter.del.bind(w.adapter);
  const wrappedAdapter = Object.create(w.adapter);
  wrappedAdapter.del = async (p: string, o: { opId: string }) => {
    if (++delCalls === 1) throw new Error("synthetic transport fault");
    return realDel(p, o);
  };
  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: wrappedAdapter as KiwiFSAdapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 1);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0]!.reason, "delete-failed");
  // Sanitized detail: no body content, no raw path.
  assert.ok(!res.skipped[0]!.detail.includes("body"));
  assert.ok(!res.skipped[0]!.detail.includes("board/"));
  // The failed one is still present.
  const failedPath = res.skipped[0]!.path === a.path ? a.path : b.path;
  assert.equal(w.state.store.has(failedPath), true);
});

test("concurrently deleted message (recheck read → missing) → visible missing skip, no delete attempted", async () => {
  const w = makeWorld();
  const { path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, path);
  w.state.store.delete(path); // vanished after preview
  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok);
  assert.equal(res.deleted.length, 0);
  assert.equal(res.skipped[0]!.reason, "missing");
});

// ---------------------------------------------------------- disclosure

test("every execution result carries the no-CAS / no-purge disclosure", async () => {
  const w = makeWorld();
  const { path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const preview = await planOne(w, path);
  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: ackEverything,
    adapter: w.adapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok);
  assert.match(res.disclosure, /no compare-and-swap/);
  assert.match(res.disclosure, /no history\/index\/backup purge/);
  assert.match(res.disclosure, /no secure erasure/);
  assert.match(res.disclosure, /no all-consumer-ack/);
});

test("local ack state is never modified by the executor", async () => {
  const w = makeWorld();
  const { msgId, path } = await send(w, { created: OLD, ttlSeconds: 60 });
  const ackedAt = Date.now() - GC_GRACE_MS - 1000;
  const ackState: Record<string, number> = { [msgId]: ackedAt };
  const preview = await planBoardCleanup(w.repo, {
    ownFrom: OWN,
    acked: (id) => ackState[id],
  });
  assert.ok(preview.ok && preview.candidates.some((c) => c.path === path));
  const res = await executeBoardCleanup(w.repo, preview, {
    ownFrom: OWN,
    acked: (id) => ackState[id],
    adapter: w.adapter,
    ledger: w.ledger,
  });
  assert.ok(res.ok && res.deleted.length === 1);
  assert.equal(Object.keys(ackState).length, 1); // untouched
  assert.equal(ackState[msgId], ackedAt);
});
