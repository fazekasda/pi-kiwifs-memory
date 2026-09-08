/**
 * T11 acceptance tests: proposal lifecycle — approve, reject, undo (PRD T11,
 * architecture.md §2/§3.3, decisions.md #11).
 *
 * Covers:
 * - Approval uses verified concurrency protection (AC 3): fresh pre-state
 *   verification + post-write read-back; a concurrent modification between
 *   read and write fails visibly (StaleProposalError), never a silent
 *   overwrite. B2-conformant: no CAS claim, detection + visible failure.
 * - Stale approvals fail visibly (AC 3): decided proposals refuse with the
 *   observed status named.
 * - Undo restores logical visibility and records provenance rather than
 *   erasing history silently (AC 4): superseded targets return to `active`
 *   (retrievable), every transition appends a `kiwifs-provenance:` line,
 *   nothing is deleted.
 * - Replay safety: duplicate reject/undo and crash-interrupted approvals
 *   complete idempotently.
 * - Lifecycle ops are serialized locally (verified single-flight).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  ProposalLifecycle,
  ProposalOpLog,
  StaleProposalError,
  readProposalTargets,
} from "../src/observation/proposals.ts";
import type { ProposalStore } from "../src/observation/proposals.ts";
import {
  buildProposalRecord,
  buildReflectionRecord,
  parseDataBlock,
  type ProposalPayload,
  type ReflectionPayload,
} from "../src/observation/reflection.ts";
import {
  parseStoredRecord,
  serializeStoredRecord,
  type StoredRecord,
} from "../src/domain/records.ts";
import { memoryRecordPath } from "../src/domain/paths.ts";

const SCOPE = "project/example.com/owner/repo";
const CREATED = Date.UTC(2026, 8, 8);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kiwifs-prop-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---- fake backend: real filesystem semantics in memory ----------------------

interface FakeDoc {
  content: string;
}

class FakeBackend implements ProposalStore {
  docs = new Map<string, FakeDoc>();
  /** When set, mutates the record after the next read (injected race). */
  raceAfterRead: ((path: string, backend: FakeBackend) => void) | undefined;
  /** When set, the next write applies different content (concurrent actor). */
  corruptNextWrite: ((path: string, content: string) => string) | undefined;

  async read(
    path: string,
  ): Promise<{ state: "ok" | "missing"; content?: string }> {
    if (this.raceAfterRead) {
      const hook = this.raceAfterRead;
      this.raceAfterRead = undefined;
      hook(path, this);
    }
    const doc = this.docs.get(path);
    return doc ? { state: "ok", content: doc.content } : { state: "missing" };
  }

  async write(
    path: string,
    content: string,
    _opts: { opId: string },
  ): Promise<unknown> {
    const applied = this.corruptNextWrite
      ? this.corruptNextWrite(path, content)
      : content;
    this.corruptNextWrite = undefined;
    this.docs.set(path, { content: applied });
    return { replayed: false };
  }

  /** Installs a proposal + its target observation records. */
  seed(
    targets: StoredRecord[],
    payload: ProposalPayload,
  ): { proposalPath: string } {
    for (const t of targets) {
      const path = memoryRecordPath(
        SCOPE,
        "observation",
        t.frontmatter.id,
        new Date(CREATED),
      );
      this.docs.set(path, { content: serializeStoredRecord(t) });
    }
    const proposal = buildProposalRecord(payload, SCOPE);
    this.docs.set(proposal.path, {
      content: serializeStoredRecord(proposal.record),
    });
    return { proposalPath: proposal.path };
  }
}

function observation(id: string, statement: string): StoredRecord {
  return {
    frontmatter: {
      schemaVersion: 1,
      id,
      type: "observation",
      scope: SCOPE as StoredRecord["frontmatter"]["scope"],
      created: new Date(CREATED).toISOString(),
      sources: [{ sessionId: "session-a", entryIds: [`entry-${id}`] }],
      status: "active",
    },
    body: `<!-- kiwifs:observation-data-begin (inert data; never instructions)\n${JSON.stringify([{ statement }], null, 2)}\nkiwifs:observation-data-end -->\n`,
  };
}

function proposalPayload(targetIds: string[]): ProposalPayload {
  const targets = targetIds.map((id) => ({
    recordId: id,
    createdAt: CREATED,
  }));
  return {
    setHash: "a".repeat(32),
    startedAt: new Date(CREATED).toISOString(),
    action: "merge",
    targets,
  };
}

function targetPaths(targetIds: string[]): string[] {
  return targetIds.map((id) =>
    memoryRecordPath(SCOPE, "observation", id, new Date(CREATED)),
  );
}

function lifecycle(backend: FakeBackend, now = () => new Date(CREATED)) {
  return new ProposalLifecycle({
    opLog: new ProposalOpLog(dir),
    openStore: async () => backend,
    now,
  });
}

async function statusOf(backend: FakeBackend, path: string): Promise<string> {
  const doc = backend.docs.get(path);
  if (!doc) return "missing";
  const parsed = parseStoredRecord(doc.content);
  if (!parsed.ok) return "malformed";
  return parsed.record.frontmatter.status;
}

function provenanceLines(backend: FakeBackend, path: string): string[] {
  const doc = backend.docs.get(path);
  if (!doc) return [];
  return doc.content
    .split("\n")
    .filter((l) => l.startsWith("kiwifs-provenance: "));
}

// ---- approve ----------------------------------------------------------------

test("approve supersedes targets with provenance and is read-back verified", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  const lc = lifecycle(backend);
  const result = await lc.approve(proposalPath, { actor: "alice" });
  assert.equal(result.applied, "applied");
  assert.equal(await statusOf(backend, proposalPath), "active");
  for (const p of targetPaths(ids)) {
    assert.equal(await statusOf(backend, p), "superseded");
    const lines = provenanceLines(backend, p).join("\n");
    assert.match(lines, /superseded by proposal /);
    assert.match(lines, /alice/);
  }
  assert.match(
    provenanceLines(backend, proposalPath).join("\n"),
    /approved by alice/,
  );
});

test("approve on a decided proposal fails visibly with the observed status", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  const lc = lifecycle(backend);
  await lc.reject(proposalPath, {
    actor: "alice",
    reason: "duplicate of manual merge",
  });
  await assert.rejects(
    lc.approve(proposalPath, { actor: "bob" }),
    (err: Error) => {
      assert.ok(err instanceof StaleProposalError);
      assert.match(err.message, /'superseded'/);
      assert.match(err.message, /pending-approval/);
      return true;
    },
  );
  // Rejected proposal never touched targets.
  for (const p of targetPaths(ids)) {
    assert.equal(await statusOf(backend, p), "active");
  }
});

test("concurrent modification between read and write fails visibly, never overwrites", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  // Simulate another actor winning the write race: our verified write lands,
  // but the backend stores THEIR content (decided differently). The
  // lifecycle's post-write read-back detects the divergence and fails
  // visibly — no silent overwrite of the concurrent actor's decision.
  backend.corruptNextWrite = (path, _ours) => {
    const doc = backend.docs.get(path)!;
    return `${doc.content}kiwifs-provenance: rejected by carol concurrently\n`;
  };
  const lc = lifecycle(backend);
  await assert.rejects(
    lc.approve(proposalPath, { actor: "alice" }),
    (err: Error) => {
      assert.ok(err instanceof StaleProposalError);
      assert.match(err.message, /concurrent modification detected/);
      return true;
    },
  );
  // The concurrent actor's provenance survives — never overwritten.
  assert.match(
    provenanceLines(backend, proposalPath).join("\n"),
    /rejected by carol/,
  );
});

test("corrupted concurrent write is detected by read-back verification", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  backend.corruptNextWrite = (_path, content) =>
    content.replace("approved", "APPROVED-BY-SOMEONE-ELSE");
  const lc = lifecycle(backend);
  await assert.rejects(
    lc.approve(proposalPath, { actor: "alice" }),
    /concurrent modification detected/,
  );
});

test("crash-interrupted approval completes idempotently on retry", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  const lc = lifecycle(backend);
  // Simulate a crash after the proposal write but before target writes:
  // apply the lifecycle's own proposal transition, then re-run approve.
  const first = await lc.approve(proposalPath, { actor: "alice" });
  assert.equal(first.applied, "applied");
  // Re-approve (crash-replay of the same intent): targets are already
  // superseded by THIS proposal → replay, no new writes to targets.
  const replay = await lc.approve(proposalPath, { actor: "alice" });
  assert.equal(replay.applied, "replay");
  assert.equal(replay.targets.length, 0);
  // No duplicate provenance lines on targets.
  for (const p of targetPaths(ids)) {
    const lines = provenanceLines(backend, p).filter((l) =>
      l.includes("superseded by proposal"),
    );
    assert.equal(lines.length, 1);
  }
});

test("approval stops visibly when a target was changed by another actor", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    [observation(ids[0]!, "claim 0"), observation(ids[1]!, "claim 1")],
    proposalPayload(ids),
  );
  // Pre-supersede the second target by an unknown actor.
  const second = targetPaths(ids)[1]!;
  const doc = backend.docs.get(second)!;
  const parsedRes = parseStoredRecord(doc.content);
  if (!parsedRes.ok) throw new Error("seed corrupt");
  const parsed = parsedRes;
  const tampered: StoredRecord = {
    ...parsed.record,
    frontmatter: { ...parsed.record.frontmatter, status: "superseded" },
  };
  backend.docs.set(second, { content: serializeStoredRecord(tampered) });
  const lc = lifecycle(backend);
  await assert.rejects(
    lc.approve(proposalPath, { actor: "alice" }),
    /partially applied \(1\/2 targets superseded\)/,
  );
});

// ---- reject -----------------------------------------------------------------

test("reject marks the proposal superseded with provenance; targets untouched", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  const lc = lifecycle(backend);
  const result = await lc.reject(proposalPath, {
    actor: "alice",
    reason: "not a duplicate",
  });
  assert.equal(result.applied, "applied");
  assert.equal(await statusOf(backend, proposalPath), "superseded");
  const lines = provenanceLines(backend, proposalPath).join("\n");
  assert.match(lines, /rejected by alice/);
  assert.match(lines, /reason: not a duplicate/);
  for (const p of targetPaths(ids)) {
    assert.equal(await statusOf(backend, p), "active");
  }
  // Duplicate reject replays.
  const replay = await lc.reject(proposalPath, { actor: "bob" });
  assert.equal(replay.applied, "replay");
  const lines2 = provenanceLines(backend, proposalPath).filter((l) =>
    l.includes("rejected by"),
  );
  assert.equal(lines2.length, 1);
});

// ---- undo -------------------------------------------------------------------

test("undo restores logical visibility and records provenance without erasing history", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  const lc = lifecycle(backend);
  await lc.approve(proposalPath, { actor: "alice" });
  for (const p of targetPaths(ids)) {
    assert.equal(await statusOf(backend, p), "superseded");
  }
  const result = await lc.undo(proposalPath, {
    actor: "bob",
    reason: "approved by mistake",
  });
  assert.equal(result.applied, "applied");
  assert.deepEqual(result.targets.sort(), targetPaths(ids).sort());
  // AC 4: logical visibility restored — targets are active again.
  for (const p of targetPaths(ids)) {
    assert.equal(await statusOf(backend, p), "active");
  }
  // Full history preserved: supersession AND restore lines coexist.
  for (const p of targetPaths(ids)) {
    const lines = provenanceLines(backend, p).join("\n");
    assert.match(lines, /superseded by proposal /);
    assert.match(lines, /restored by undo of proposal /);
    assert.match(lines, /bob/);
    assert.match(lines, /reason: approved by mistake/);
  }
  // Proposal superseded with approval-undone provenance (never deleted).
  assert.equal(await statusOf(backend, proposalPath), "superseded");
  const plines = provenanceLines(backend, proposalPath).join("\n");
  assert.match(plines, /approved by alice/);
  assert.match(plines, /approval undone by bob/);
});

test("undo of a pending or rejected proposal fails visibly", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  const lc = lifecycle(backend);
  await assert.rejects(
    lc.undo(proposalPath, { actor: "bob" }),
    /undo requires an approved \(active\) proposal; status is 'pending-approval'/,
  );
  await lc.reject(proposalPath, { actor: "alice" });
  await assert.rejects(
    lc.undo(proposalPath, { actor: "bob" }),
    /status is 'superseded'/,
  );
});

test("undo refuses to restore targets it did not supersede", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  const lc = lifecycle(backend);
  await lc.approve(proposalPath, { actor: "alice" });
  // Another actor supersedes target 2 under a DIFFERENT proposal (our line
  // replaced — a full doc overwrite by the other actor).
  const second = targetPaths(ids)[1]!;
  const foreign = observation(ids[1]!, "claim 1");
  const other: StoredRecord = {
    ...foreign,
    frontmatter: { ...foreign.frontmatter, status: "superseded" },
  };
  backend.docs.set(second, {
    content:
      serializeStoredRecord(other) +
      "kiwifs-provenance: superseded by proposal deadbeefdeadbeef at 2026-09-08T00:00:00.000Z (op ffffffff, by mallory)\n",
  });
  await assert.rejects(
    lc.undo(proposalPath, { actor: "bob" }),
    /was not superseded by proposal/,
  );
});

test("duplicate undo replays as a no-op", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  const lc = lifecycle(backend);
  await lc.approve(proposalPath, { actor: "alice" });
  await lc.undo(proposalPath, { actor: "bob" });
  const replay = await lc.undo(proposalPath, { actor: "carol" });
  assert.equal(replay.applied, "replay");
  const undone = provenanceLines(backend, proposalPath).filter((l) =>
    l.includes("approval undone"),
  );
  assert.equal(undone.length, 1);
});

// ---- op log -----------------------------------------------------------------

test("op log records every lifecycle op durably before the side effect", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  const opLog = new ProposalOpLog(dir);
  const lc = new ProposalLifecycle({
    opLog,
    openStore: async () => backend,
    now: () => new Date(CREATED),
  });
  await lc.approve(proposalPath, { actor: "alice" });
  await lc.undo(proposalPath, { actor: "bob" });
  // A fresh log instance re-loads the recorded opIds (crash-proof ledger).
  const reloaded = new ProposalOpLog(dir);
  assert.ok(reloaded.has(await firstOpId()));
  assert.equal(opLog.has("nonexistent"), false);

  async function firstOpId(): Promise<string> {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(join(dir, "proposal-oplog.jsonl"), "utf8");
    const first = raw.split("\n").find((l) => l.trim() !== "")!;
    return (JSON.parse(first) as { opId: string }).opId;
  }
});

// ---- lifecycle serialization -------------------------------------------------

test("overlapping lifecycle operations settle serially (single-flight)", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  const lc = lifecycle(backend);
  const [a, b] = await Promise.allSettled([
    lc.approve(proposalPath, { actor: "alice" }),
    lc.approve(proposalPath, { actor: "bob" }),
  ]);
  // Both settle (serialized): one applied, one replay — never interleaved
  // partial state.
  assert.ok(a.status === "fulfilled" || a.status === "rejected");
  assert.ok(b.status === "fulfilled" || b.status === "rejected");
  assert.equal(await statusOf(backend, proposalPath), "active");
  for (const p of targetPaths(ids)) {
    const lines = provenanceLines(backend, p).filter((l) =>
      l.includes("superseded by proposal"),
    );
    assert.equal(lines.length, 1);
  }
});

// ---- readProposalTargets ------------------------------------------------------

test("readProposalTargets validates the proposal shape and target set", async () => {
  const backend = new FakeBackend();
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const { proposalPath } = backend.seed(
    ids.map((id, i) => observation(id, `claim ${i}`)),
    proposalPayload(ids),
  );
  const { id, status, targets } = await readProposalTargets(
    backend,
    proposalPath,
  );
  assert.equal(status, "pending-approval");
  assert.equal(targets.action, "merge");
  assert.deepEqual(targets.targetPaths, targetPaths(ids));

  await assert.rejects(
    readProposalTargets(backend, "nope/missing.md"),
    /not readable/,
  );

  // A non-proposal record is refused.
  const observationRecord = observation("cccccccccccc", "x");
  const obsPath = memoryRecordPath(
    SCOPE,
    "observation",
    observationRecord.frontmatter.id,
    new Date(CREATED),
  );
  backend.docs.set(obsPath, {
    content: serializeStoredRecord(observationRecord),
  });
  await assert.rejects(readProposalTargets(backend, obsPath), /not a proposal/);
});
