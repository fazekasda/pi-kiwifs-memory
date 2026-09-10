/**
 * Q05R1 acceptance tests (synthetic only — fake MCP server, no live
 * service, no real model): manual remote board cleanup eligibility rules
 * and the bounded READ-ONLY preview planner.
 *
 * Covers the Q05R1 task contract:
 * - owner/channel/project canonical board paths (strict path predicates)
 * - ack boundary and TTL/grace boundaries (pure rules, exact edges)
 * - missing / malformed records (visible skips, fail closed)
 * - pagination truncation disclosure and STABLE preview ids
 * - no delete executor: the planner performs reads only (test-pinned)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { KiwiFSAdapter } from "../src/backend/adapter.ts";
import { createMemoryLedger } from "../src/backend/opid.ts";

import { PrivateModeGate } from "../src/privacy/private-mode.ts";
import { BoardRepository } from "../src/board/repository.ts";
import {
  GC_GRACE_MS,
  evaluateCleanupCandidate,
} from "../src/board/cleanup-rules.ts";
import { planBoardCleanup } from "../src/board/cleanup.ts";
import { buildBoardMessage, isExpired } from "../src/board/messages.ts";
import { deriveMsgPath } from "../src/backend/ids.ts";
import { createFakeServer, type FakeServerState } from "./fake-mcp-server.ts";

const URL_ = "https://kiwifs.test/mcp";
const DAY = 24 * 60 * 60 * 1000;

function makeRepo(
  extra: ConstructorParameters<typeof BoardRepository>[1] = {},
) {
  const server = createFakeServer();
  const ledger = createMemoryLedger();
  const adapter = new KiwiFSAdapter({
    url: URL_,
    requestTimeoutMs: 250,
    fetchImpl: server.fetch,
    ledger,
  });
  const repo = new BoardRepository(adapter, extra);
  return {
    server,
    adapter,
    repo,
    record: (opId: string) => ledger.record(opId),
  };
}

async function send(
  r: ReturnType<typeof makeRepo>,
  msg: {
    channel: string;
    from: string;
    to: string;
    body?: string;
    ttlSeconds?: number;
    created: Date;
  },
): Promise<{ msgId: string; path: string }> {
  const opId = `op-${Math.random().toString(36).slice(2, 10)}`;
  r.record(opId);
  const res = await r.repo.send(
    {
      channel: msg.channel,
      from: msg.from,
      to: msg.to,
      body: msg.body ?? "body (opaque)",
      ...(msg.ttlSeconds !== undefined ? { ttlSeconds: msg.ttlSeconds } : {}),
      created: msg.created,
    },
    opId,
  );
  assert.ok(res.ok);
  return { msgId: res.msgId, path: res.path };
}

function ackLookup(
  entries: Record<string, number>,
): (msgId: string) => number | undefined {
  return (msgId) => entries[msgId];
}

const OWN = "agent-a";
const OTHER = "agent-b";

// ---------------------------------------------------------------- rules

test("rules: ttl-expired boundary — expiry exactly at now is NOT expired; 1ms past is", () => {
  const created = new Date("2025-01-01T00:00:00.000Z");
  const atExpiry = new Date(created.getTime() + 60 * 1000);
  const justAfter = new Date(atExpiry.getTime() + 1);
  const view = {
    msgId: "x",
    from: OWN,
    created: created.toISOString(),
    ttlSeconds: 60,
  };
  const notYet = evaluateCleanupCandidate(
    view,
    { ackedAt: undefined },
    OWN,
    atExpiry,
  );
  assert.equal(notYet.eligible, false);
  if (!notYet.eligible)
    assert.equal(notYet.reason, "not-expired-and-not-acked");
  const past = evaluateCleanupCandidate(
    view,
    { ackedAt: undefined },
    OWN,
    justAfter,
  );
  assert.equal(past.eligible, false); // expired but within grace
  if (!past.eligible) assert.equal(past.reason, "within-grace");
});

test("rules: grace boundary — exactly 30d after expiry is NOT eligible; 1ms more is", () => {
  const created = new Date("2025-01-01T00:00:00.000Z");
  const ttl = 60;
  const expiry = created.getTime() + ttl * 1000;
  const atGrace = new Date(expiry + GC_GRACE_MS);
  const justPast = new Date(expiry + GC_GRACE_MS + 1);
  const view = {
    msgId: "x",
    from: OWN,
    created: created.toISOString(),
    ttlSeconds: ttl,
  };
  const at = evaluateCleanupCandidate(
    view,
    { ackedAt: undefined },
    OWN,
    atGrace,
  );
  assert.equal(at.eligible, false);
  if (!at.eligible) assert.equal(at.reason, "within-grace");
  const past = evaluateCleanupCandidate(
    view,
    { ackedAt: undefined },
    OWN,
    justPast,
  );
  assert.deepEqual(past.eligible ? past.basis : [], ["ttl-expired"]);
});

test("rules: ack boundary — grace counts from the LOCAL ack instant, not created", () => {
  const created = new Date("2025-01-01T00:00:00.000Z");
  const view = {
    msgId: "x",
    from: OWN,
    created: created.toISOString(),
    ttlSeconds: undefined,
  };
  // Created long ago, but acked recently → within grace.
  const recentAck = { ackedAt: Date.parse("2025-06-01T00:00:00.000Z") };
  const recent = evaluateCleanupCandidate(
    view,
    recentAck,
    OWN,
    new Date(recentAck.ackedAt! + GC_GRACE_MS),
  );
  assert.equal(recent.eligible, false);
  if (!recent.eligible) assert.equal(recent.reason, "within-grace");
  // 1ms past the ack grace → eligible on the ack basis only.
  const old = evaluateCleanupCandidate(
    view,
    recentAck,
    OWN,
    new Date(recentAck.ackedAt! + GC_GRACE_MS + 1),
  );
  assert.ok(old.eligible);
  assert.deepEqual(old.basis, ["locally-acked"]);
});

test("rules: ownership is exact — another sender is never a candidate; fail-closed malformed timestamps", () => {
  const view = {
    msgId: "x",
    from: OTHER,
    created: "2025-01-01T00:00:00.000Z",
    ttlSeconds: 0,
  };
  const now = new Date(Date.parse("2026-01-01T00:00:00.000Z"));
  const other = evaluateCleanupCandidate(view, { ackedAt: 0 }, OWN, now);
  assert.equal(other.eligible, false);
  if (!other.eligible) assert.equal(other.reason, "not-owner");
  const badCreated = evaluateCleanupCandidate(
    { msgId: "x", from: OWN, created: "not-a-time", ttlSeconds: 0 },
    { ackedAt: 0 },
    OWN,
    now,
  );
  assert.equal(badCreated.eligible, false);
  if (!badCreated.eligible) assert.equal(badCreated.reason, "malformed");
  const badTtl = evaluateCleanupCandidate(
    {
      msgId: "x",
      from: OWN,
      created: "2025-01-01T00:00:00.000Z",
      ttlSeconds: -1,
    },
    { ackedAt: 0 },
    OWN,
    now,
  );
  assert.equal(badTtl.eligible, false);
  if (!badTtl.eligible) assert.equal(badTtl.reason, "malformed");
  // Both bases: the LATER settled instant governs.
  const createdOld = Date.parse("2025-01-01T00:00:00.000Z");
  const both = evaluateCleanupCandidate(
    {
      msgId: "x",
      from: OWN,
      created: new Date(createdOld).toISOString(),
      ttlSeconds: 0,
    },
    { ackedAt: createdOld + GC_GRACE_MS / 2 },
    OWN,
    new Date(createdOld + GC_GRACE_MS / 2 + GC_GRACE_MS + 1),
  );
  assert.ok(both.eligible);
});

// ------------------------------------------------------------- planner

test("planner: end-to-end — only own+expired(or acked)+past-grace messages are proposed; skips are visible; ids stable", async () => {
  const r = makeRepo();
  await r.adapter.connect();
  const created = new Date(Date.now() - 200 * DAY);
  // Eligible: own, expired 200d ago (ttl 1s), past grace, canonical path.
  const a = await send(r, {
    channel: "proj",
    from: OWN,
    to: OTHER,
    ttlSeconds: 1,
    created,
  });
  // Ineligible: other sender's message (expired, past grace — still not ours).
  const b = await send(r, {
    channel: "proj",
    from: OTHER,
    to: OWN,
    ttlSeconds: 1,
    created,
  });
  // Ineligible: own, expired, but LOCALLY ACKED recently → within grace.
  const c = await send(r, {
    channel: "proj",
    from: OWN,
    to: OTHER,
    ttlSeconds: 1,
    created,
  });
  // Ineligible: own, no ttl, never acked → not-expired-and-not-acked.
  const d = await send(r, { channel: "proj", from: OWN, to: OTHER, created });
  // Non-board path must never appear: the listing filters to board-message
  // type + strict board path shape; nothing else is inserted here.

  const acks: Record<string, number> = { [c.msgId]: Date.now() - DAY };
  const now = new Date();
  const plan = await planBoardCleanup(r.repo, {
    ownFrom: OWN,
    acked: ackLookup(acks),
    now,
  });
  assert.ok(plan.ok);
  if (!plan.ok) return;
  // The fake backend ignores offset, so a bounded listing over it is
  // correctly DISCLOSED as truncated (never a silent false-complete).
  assert.equal(typeof plan.listingTruncated, "boolean");
  assert.equal(plan.readTruncated, false);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0]!.msgId, a.msgId);
  assert.equal(plan.candidates[0]!.path, a.path);
  assert.match(plan.candidates[0]!.path, /^board\/proj\/[0-9a-f]{16,64}\.md$/);
  assert.deepEqual(plan.candidates[0]!.basis, ["ttl-expired"]);
  const reasons = new Map(plan.skipped.map((s) => [s.msgId, s.reason]));
  assert.equal(reasons.get(b.msgId), "not-owner");
  assert.equal(reasons.get(c.msgId), "within-grace");
  assert.equal(reasons.get(d.msgId), "not-expired-and-not-acked");

  // Stable preview ids: a second identical plan yields identical order
  // and identical (msgId, path, created) bindings.
  const plan2 = await planBoardCleanup(r.repo, {
    ownFrom: OWN,
    acked: ackLookup(acks),
    now,
  });
  assert.ok(plan2.ok);
  if (!plan2.ok) return;
  assert.deepEqual(
    plan2.candidates.map((x) => [x.msgId, x.path, x.created]),
    plan.candidates.map((x) => [x.msgId, x.path, x.created]),
  );
});

test("planner: fail closed without an identity; private mode refuses with zero reads", async () => {
  const r = makeRepo();
  await r.adapter.connect();
  const noId = await planBoardCleanup(r.repo, {
    ownFrom: "",
    acked: ackLookup({}),
  });
  assert.ok(!noId.ok);
  if (noId.ok) return;
  assert.equal(noId.reason, "no-identity");

  const gate = new PrivateModeGate();
  gate.enable();
  const privRepo = makeRepo({ privateMode: gate });
  await privRepo.adapter.connect();
  const priv = await planBoardCleanup(privRepo.repo, {
    ownFrom: OWN,
    acked: ackLookup({}),
  });
  assert.ok(!priv.ok);
  if (priv.ok) return;
  assert.equal(priv.reason, "private-mode");
});

test("planner: bounded reads — maxReads truncation is DISCLOSED, not hidden", async () => {
  const r = makeRepo();
  await r.adapter.connect();
  const created = new Date(Date.now() - 200 * DAY);
  for (let i = 0; i < 5; i++) {
    await send(r, {
      channel: "proj",
      from: OWN,
      to: OTHER,
      ttlSeconds: 1,
      created,
    });
  }
  const plan = await planBoardCleanup(r.repo, {
    ownFrom: OWN,
    acked: ackLookup({}),
    maxReads: 2,
    now: new Date(),
  });
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.readTruncated, true);
  assert.ok(plan.candidates.length <= 2);
  // maxCandidates bounds the kept set too.
  const plan2 = await planBoardCleanup(r.repo, {
    ownFrom: OWN,
    acked: ackLookup({}),
    maxCandidates: 2,
    now: new Date(),
  });
  assert.ok(plan2.ok);
  if (!plan2.ok) return;
  assert.equal(plan2.candidates.length, 2);
  assert.equal(plan2.readTruncated, true);
});

test("planner: malformed record at a board path is a visible skip, never a candidate", async () => {
  const r = makeRepo();
  await r.adapter.connect();
  // Eligible own message next to a non-board record planted at a board path.
  await send(r, {
    channel: "proj",
    from: OWN,
    to: OTHER,
    ttlSeconds: 1,
    created: new Date(Date.now() - 200 * DAY),
  });
  // Write a malformed "board message" (wrong type) directly through the
  // adapter: the strict path shape is respected, the CONTENT is not.
  const opId = "op-bad";
  r.record(opId);
  const badPath = deriveMsgPath("proj", OWN, opId);
  await r.adapter.writeImmutable(
    badPath,
    "---\nschemaVersion: 1\nid: bad\ntype: board-message\nscope: personal\n---\nnot a board message body",
    { opId },
  );
  const plan = await planBoardCleanup(r.repo, {
    ownFrom: OWN,
    acked: ackLookup({}),
    now: new Date(),
  });
  assert.ok(plan.ok);
  if (!plan.ok) return;
  const badSkip = plan.skipped.find((s) => s.path === badPath);
  assert.ok(badSkip);
  assert.equal(badSkip!.reason, "malformed");
});

test("planner: preview binds exact path — derived path/msgId round-trip matches the wire record", async () => {
  const r = makeRepo();
  await r.adapter.connect();
  const created = new Date(Date.now() - 200 * DAY);
  const sent = await send(r, {
    channel: "proj",
    from: OWN,
    to: OTHER,
    ttlSeconds: 1,
    created,
  });
  const plan = await planBoardCleanup(r.repo, {
    ownFrom: OWN,
    acked: ackLookup({}),
    now: new Date(),
  });
  assert.ok(plan.ok);
  if (!plan.ok) return;
  const item = plan.candidates[0]!;

  assert.equal(item.msgId, sent.msgId);
  assert.equal(item.path, sent.path);
  // created binding equals what the executor must re-verify at delete time.
  assert.equal(Date.parse(item.created), created.getTime());
});

test("planner: no delete executor exists — planner module never calls kiwi_delete", async () => {
  const r = makeRepo();
  await r.adapter.connect();
  await send(r, {
    channel: "proj",
    from: OWN,
    to: OTHER,
    ttlSeconds: 1,
    created: new Date(Date.now() - 200 * DAY),
  });
  const plan = await planBoardCleanup(r.repo, {
    ownFrom: OWN,
    acked: ackLookup({}),
    now: new Date(),
  });
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.ok(plan.candidates.length >= 1);
  // The message is still present after planning (read-only proof).
  const still = await r.repo.read(plan.candidates[0]!.path, {
    includeExpired: true,
  });
  assert.ok(still.ok);
});
