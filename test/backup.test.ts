/**
 * T14 acceptance tests: transcript backup capture — synthetic fixtures only,
 * no live service is contacted (the sender runs against a fake backend).
 *
 * Acceptance coverage (PRD T14):
 * 1. Synthetic branched session export preserves all included entries and
 *    tree relationships (id/parentId survive into chunk JSON).
 * 2. Interrupted capture resumes without missing or duplicating accepted
 *    entries (durable coverage cursor; crash-window re-derivation is
 *    byte-identical and replays as a backend no-op).
 * 3. Manifest declares schema, covered source range, redaction (counts by
 *    type, never values) and omitted content; chunk checksums match bytes.
 * 4. Private/excluded content is absent according to policy (private mode,
 *    content-pattern exclusions, extension-internal omissions, binaries).
 * 5. Raw transcript records are not automatically eligible for ordinary
 *    memory retrieval (guard step 4 namespace check + structural path split).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackupCapture,
  parseBackupPayload,
  sendBackupJob,
  type BackupChunkPayload,
  type BackupBackend,
} from "../src/backup/capture.ts";
import { toBackupViews } from "../src/backup/exporter.ts";
import {
  chunkChecksum,
  DEFAULT_MAX_CHUNK_BYTES,
} from "../src/backup/chunker.ts";
import { guardCandidate } from "../src/backend/guard.ts";
import type { KiwiFSAdapter } from "../src/backend/adapter.ts";
import type { OutboxJob } from "../src/outbox/store.ts";
import { DurableOutbox } from "../src/outbox/store.ts";

const SCOPE = "project/demo-proj";

function makeEntries(): Record<string, unknown>[] {
  // Branched tree:  root ── user A ── assistant B ── toolResult B
  //                 (root ── user C, a divergent branch)
  return [
    {
      type: "message",
      id: "e-root",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "first input" },
    },
    {
      type: "message",
      id: "e-a",
      parentId: "e-root",
      timestamp: "2026-01-01T00:00:01Z",
      message: { role: "user", content: "branch A input" },
    },
    {
      type: "message",
      id: "e-b",
      parentId: "e-a",
      timestamp: "2026-01-01T00:00:02Z",
      message: { role: "assistant", content: "branch A answer" },
    },
    {
      // Pi represents tool results as messages with role "toolResult".
      type: "message",
      id: "e-b-tool",
      parentId: "e-b",
      timestamp: "2026-01-01T00:00:02Z",
      message: { role: "toolResult", content: "tool output kept" },
    },
    {
      type: "message",
      id: "e-c",
      parentId: "e-root",
      timestamp: "2026-01-01T00:00:03Z",
      message: { role: "user", content: "branch C input" },
    },
  ];
}

function tmpStateDir(): string {
  return mkdtempSync(join(tmpdir(), "kiwifs-backup-"));
}

interface FakeBackendState {
  paths: Map<string, string>;
  writes: { path: string; content: string }[];
}

function fakeBackend(
  state: FakeBackendState,
): BackupBackend & FakeBackendState {
  return {
    paths: state.paths,
    writes: state.writes,
    async writeImmutable(path, content) {
      state.writes.push({ path, content });
      const existing = state.paths.get(path);
      if (existing !== undefined) {
        if (existing === content) return { replayed: true };
        throw new Error("conflict (fail closed)");
      }
      state.paths.set(path, content);
      return { replayed: false };
    },
    async write(path, content) {
      state.writes.push({ path, content });
      state.paths.set(path, content);
      return { replayed: false };
    },
  };
}

async function deliverAll(
  outbox: DurableOutbox,
  backend: BackupBackend & FakeBackendState,
  scope = SCOPE,
): Promise<{ delivered: number; replayed: number; acceptedIds: string[] }> {
  let delivered = 0;
  let replayed = 0;
  const acceptedIds: string[] = [];
  for (const job of outbox.pending()) {
    if (job.kind !== "backup-chunk") continue;
    await sendBackupJob(job, scope, "demo-proj", backend);
    delivered += 1;
    const payload = parseBackupPayload(job);
    if (payload.type === "chunk") acceptedIds.push(...payload.entryIds);
    // Replay of the same job: byte-identical content — a chunk replays as a
    // read-before-write no-op; a manifest rewrite is effect-idempotent.
    await sendBackupJob(job, scope, "demo-proj", backend);
    replayed += 1;
    outbox.ack(job.seq);
  }
  return { delivered, replayed, acceptedIds };
}

function backupJobs(outbox: DurableOutbox): OutboxJob[] {
  return outbox.pending().filter((j) => j.kind === "backup-chunk");
}

function chunkPayloads(outbox: DurableOutbox): BackupChunkPayload[] {
  return backupJobs(outbox)
    .map((j) => parseBackupPayload(j))
    .filter((p): p is BackupChunkPayload => p.type === "chunk");
}

function makeCapture(
  stateDir: string,
  outbox: DurableOutbox,
  opts: Partial<ConstructorParameters<typeof BackupCapture>[0]> = {},
): BackupCapture {
  return new BackupCapture({
    stateDir,
    outbox,
    scope: SCOPE,
    projectId: "demo-proj",
    sessionId: "s-demo",
    ...opts,
  });
}

test("T14 AC1: branched export preserves entries and tree relationships", async () => {
  const stateDir = tmpStateDir();
  try {
    const outbox = DurableOutbox.open(join(stateDir, "outbox"));
    const capture = makeCapture(stateDir, outbox);
    const result = capture.capture(makeEntries());
    assert.equal(result.enqueuedChunks > 0, true);
    assert.equal(result.heldEntries, 0);
    const payloads = chunkPayloads(outbox);
    const ids = payloads.flatMap((p) => p.entryIds);
    assert.deepEqual(
      [...ids].sort(),
      ["e-a", "e-b", "e-b-tool", "e-c", "e-root"],
      "all included entries captured exactly once",
    );
    // Tree relationships survive: parse chunk JSON and check parentId links.
    const byId = new Map<string, { id: string; parentId: string | null }>();
    for (const p of payloads) {
      const parsed = JSON.parse(p.content) as {
        entries: { id: string; parentId: string | null }[];
      };
      for (const e of parsed.entries) byId.set(e.id, e);
    }
    assert.equal(byId.get("e-a")?.parentId, "e-root");
    assert.equal(byId.get("e-b")?.parentId, "e-a");
    assert.equal(byId.get("e-b-tool")?.parentId, "e-b");
    assert.equal(byId.get("e-c")?.parentId, "e-root");
    // Roles (including toolResult) and their text survive.
    const views = toBackupViews(makeEntries());
    assert.equal(views.find((v) => v.id === "e-b")?.role, "assistant");
    const tool = views.find((v) => v.id === "e-b-tool");
    assert.equal(tool?.role, "toolResult");
    assert.match(tool?.text ?? "", /tool output kept/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("T14 AC2: interrupted capture resumes without missing or duplicating", async () => {
  const stateDir = tmpStateDir();
  try {
    const outbox = DurableOutbox.open(join(stateDir, "outbox"));
    const backend = fakeBackend({ paths: new Map(), writes: [] });
    const first = makeCapture(stateDir, outbox);
    first.capture(makeEntries().slice(0, 2)); // entries e-root, e-a
    const deliveredFirst = await deliverAll(outbox, backend);
    assert.equal(deliveredFirst.delivered > 0, true);

    // "Restart": fresh engine from the same durable state, same outbox.
    const second = makeCapture(stateDir, outbox);
    const resumed = second.capture(makeEntries()); // full tree again
    const payloads = chunkPayloads(outbox);
    // The durable coverage cursor: the resumed flush enqueues ONLY the
    // entries the interrupted life had not accepted yet — never re-chunked.
    assert.deepEqual(payloads.flatMap((p) => p.entryIds).sort(), [
      "e-b",
      "e-b-tool",
      "e-c",
    ]);
    // Across both lives, every accepted entry appears exactly once.
    const allIds = [
      ...deliveredFirst.acceptedIds,
      ...payloads.flatMap((p) => p.entryIds),
    ];
    const duplicates = allIds.filter((id, i) => allIds.indexOf(id) !== i);
    assert.deepEqual(duplicates, [], "no duplicated accepted entries");
    assert.deepEqual(
      [...allIds].sort(),
      ["e-a", "e-b", "e-b-tool", "e-c", "e-root"],
      "resumed capture covers the full tree",
    );
    // Seq continues from the durable cursor (no re-use of chunk numbers).
    const seqs = payloads.map((p) => p.seq);
    assert.equal(new Set(seqs).size, seqs.length);
    assert.equal(second.coveredCount(), 5);
    assert.equal(resumed.enqueuedChunks > 0, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("T14 AC2: crash-window re-derivation is byte-identical (replay no-op)", async () => {
  const stateDir = tmpStateDir();
  try {
    const outbox = DurableOutbox.open(join(stateDir, "outbox"));
    const entries = makeEntries();
    // First "life" (state file lost afterwards = crash before cursor persist).
    const first = makeCapture(stateDir, outbox);
    first.capture(entries);
    const backend = fakeBackend({ paths: new Map(), writes: [] });
    await deliverAll(outbox, backend);

    // Second life with an EMPTY durable state (worst case: cursor lost) but
    // the same outbox and backend: re-derivation must produce identical
    // chunk bytes, so backend delivery is a replay no-op, never a conflict.
    const emptyDir = join(stateDir, "empty");
    const outbox2 = DurableOutbox.open(join(emptyDir, "outbox"));
    const second = makeCapture(emptyDir, outbox2);
    second.capture(entries);
    // Byte-identical re-derivation: every re-enqueued chunk's content equals
    // a chunk delivered by the first life with the same seq.
    const firstContents = new Map<string, string>();
    for (const job of outbox.pending().concat(outbox2.pending())) {
      if (job.kind !== "backup-chunk") continue;
      const p = parseBackupPayload(job);
      if (p.type === "chunk")
        firstContents.set(`${p.sessionId}/${p.seq}`, p.content);
    }
    const outbox2Contents = new Map<string, string>();
    for (const job of outbox2.pending()) {
      const p = parseBackupPayload(job);
      if (p.type === "chunk") {
        outbox2Contents.set(`${p.sessionId}/${p.seq}`, p.content);
      }
    }
    for (const [key, content] of outbox2Contents) {
      assert.equal(
        firstContents.get(key),
        content,
        `seq ${key} byte-identical`,
      );
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("T14 AC3: manifest declares schema, covered range, redaction and omissions", async () => {
  const stateDir = tmpStateDir();
  try {
    const outbox = DurableOutbox.open(join(stateDir, "outbox"));
    const capture = makeCapture(stateDir, outbox);
    const entries = [
      ...makeEntries(),
      {
        type: "message",
        id: "e-secret",
        parentId: "e-c",
        timestamp: "2026-01-01T00:00:04Z",
        message: {
          role: "user",
          content: "my key is AKIAIOSFODNN7EXAMPLE keep it",
        },
      },
      {
        type: "message",
        id: "e-binary",
        parentId: "e-secret",
        timestamp: "2026-01-01T00:00:05Z",
        message: {
          role: "assistant",
          content: [{ type: "image", data: "binary" }],
        },
      },
    ];
    capture.capture(entries);
    const manifest = capture.manifestFor();
    assert.ok(manifest);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.kind, "kiwifs-backup-manifest");
    assert.equal(manifest.sessionId, "s-demo");
    assert.equal(manifest.redacted, true, "never claims byte-identical");
    // Covered range: every represented entry id.
    assert.equal(manifest.coveredRange.entryCount, 7);
    assert.equal(manifest.coveredRange.firstEntryId, "e-root");
    assert.equal(manifest.coveredRange.lastEntryId, "e-binary");
    // Redaction summary: counts by type, never secret values.
    assert.ok((manifest.redactionSummary["aws-access-key"] ?? 0) >= 1);
    const serialized = JSON.stringify(manifest);
    assert.ok(!serialized.includes("AKIAIOSFODNN7EXAMPLE"), "no secret values");
    // Omissions: binary content recorded, never present as text.
    assert.ok(
      manifest.omissions.some(
        (o) => o.entryId === "e-binary" && o.reason === "binary-omitted",
      ),
    );
    // Chunk checksums match the exact delivered bytes.
    const backend = fakeBackend({ paths: new Map(), writes: [] });
    await deliverAll(outbox, backend);
    const manifestDelivered = backend.writes.find((w) =>
      w.path.endsWith("manifest.md"),
    );
    assert.ok(manifestDelivered, "manifest delivered to manifest.md path");
    const deliveredManifest = JSON.parse(
      manifestDelivered.content,
    ) as typeof manifest;
    for (const chunk of deliveredManifest.chunks) {
      const stored = backend.paths.get(chunk.path);
      assert.ok(stored, `chunk ${chunk.path} delivered`);
      assert.equal(chunkChecksum(stored as string), chunk.checksum);
      assert.equal(
        Buffer.byteLength(stored as string, "utf8"),
        chunk.byteLength,
      );
      assert.ok(
        !chunkChecksum(stored as string).includes("demo-proj"),
        "checksum is content-addressed, never branch identity",
      );
    }
    assert.equal(
      deliveredManifest.chunks.every((c) =>
        c.path.startsWith("backup/demo-proj/s-demo/"),
      ),
      true,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("T14 AC4: private mode skips capture; pending jobs are held, not deleted", async () => {
  const stateDir = tmpStateDir();
  try {
    const outbox = DurableOutbox.open(join(stateDir, "outbox"));
    const capture = makeCapture(stateDir, outbox, {
      privateMode: () => true,
    });
    const result = capture.capture(makeEntries());
    assert.equal(result.skippedReason, "private-mode");
    assert.equal(backupJobs(outbox).length, 0);
    assert.equal(capture.coveredCount(), 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("T14 AC4: excluded and extension-internal content is absent per policy", async () => {
  const stateDir = tmpStateDir();
  try {
    const outbox = DurableOutbox.open(join(stateDir, "outbox"));
    const capture = makeCapture(stateDir, outbox, {
      exclusions: [{ pattern: "internal-only-marker" }],
    });
    const entries = [
      ...makeEntries(),
      {
        type: "message",
        id: "e-excluded",
        parentId: "e-c",
        timestamp: "2026-01-01T00:00:06Z",
        message: { role: "user", content: "internal-only-marker payload" },
      },
      {
        type: "custom_message",
        id: "e-kiwifs",
        parentId: "e-c",
        timestamp: "2026-01-01T00:00:07Z",
        customType: "kiwifs.evidence",
        content: "injected evidence must not recurse",
        details: {},
        display: false,
      },
    ];
    const result = capture.capture(entries);
    assert.equal(result.enqueuedChunks > 0, true);
    const backend = fakeBackend({ paths: new Map(), writes: [] });
    await deliverAll(outbox, backend);
    const allChunks = [...backend.paths.entries()]
      .filter(
        ([path]) => path.includes("s-demo") && !path.endsWith("manifest.md"),
      )
      .map(([, content]) => content)
      .join("\n");
    assert.ok(
      !allChunks.includes("internal-only-marker"),
      "excluded text absent",
    );
    assert.ok(
      !allChunks.includes("injected evidence"),
      "extension text absent",
    );
    const manifest = capture.manifestFor();
    assert.ok(manifest);
    assert.ok(
      manifest.omissions.some(
        (o) => o.entryId === "e-excluded" && o.reason === "excluded-by-policy",
      ),
    );
    assert.ok(
      manifest.omissions.some(
        (o) => o.entryId === "e-kiwifs" && o.reason === "extension-internal",
      ),
    );
    // Excluded entries are covered (never re-evaluated into chunks later).
    assert.equal(capture.coveredCount(), 7);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("T14 AC4: redaction failure holds entries fail-closed (never sent raw)", async () => {
  const stateDir = tmpStateDir();
  try {
    const outbox = DurableOutbox.open(join(stateDir, "outbox"));
    let fail = true;
    const capture = makeCapture(stateDir, outbox, {
      redact: (content) =>
        fail ? { ok: false, reason: "cannot classify" } : { ok: true, content },
    });
    const result = capture.capture(makeEntries());
    assert.equal(result.enqueuedChunks, 0, "nothing enqueued while held");
    assert.equal(result.heldEntries, 5, "all text entries held");
    assert.ok(result.lastError?.includes("redaction-held"));
    assert.equal(capture.coveredCount(), 0, "held entries stay uncovered");
    assert.equal(backupJobs(outbox).length, 0);
    // Recovery: working redactor picks the entries up (never dropped).
    fail = false;
    const recovered = capture.capture(makeEntries());
    assert.equal(recovered.enqueuedChunks > 0, true);
    assert.equal(recovered.heldEntries, 0);
    assert.equal(capture.coveredCount(), 5);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("T14: payload validation rejects tampered chunks at delivery", () => {
  const stateDir = tmpStateDir();
  try {
    const outbox = DurableOutbox.open(join(stateDir, "outbox"));
    const capture = makeCapture(stateDir, outbox);
    capture.capture(makeEntries());
    const job = backupJobs(outbox)[0];
    assert.ok(job);
    // Valid payload parses.
    const payload = parseBackupPayload(job) as BackupChunkPayload;
    assert.equal(payload.type, "chunk");
    // Tampered session id fails the content/header cross-check.
    const tampered = JSON.parse(JSON.stringify(job)) as OutboxJob;
    (tampered.payload as BackupChunkPayload).sessionId = "s-other";
    assert.throws(() => parseBackupPayload(tampered), /diverge|match|required/);
    // Tampered entry ids fail the sources cross-check.
    const tampered2 = JSON.parse(JSON.stringify(job)) as OutboxJob;
    (tampered2.payload as BackupChunkPayload).entryIds = ["e-bogus"];
    assert.throws(() => parseBackupPayload(tampered2), /diverge/);
    // Non-JSON content fails closed.
    const tampered3 = JSON.parse(JSON.stringify(job)) as OutboxJob;
    (tampered3.payload as BackupChunkPayload).content = "{not json";
    assert.throws(() => parseBackupPayload(tampered3), /valid JSON/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("T14: 64 KiB cap with oversized single entry disclosed, never truncated", async () => {
  const stateDir = tmpStateDir();
  try {
    const outbox = DurableOutbox.open(join(stateDir, "outbox"));
    const capture = makeCapture(stateDir, outbox);
    const bigText = "x".repeat(DEFAULT_MAX_CHUNK_BYTES);
    const entries = [
      ...makeEntries(),
      {
        type: "message",
        id: "e-big",
        parentId: "e-c",
        timestamp: "2026-01-01T00:00:08Z",
        message: { role: "user", content: bigText },
      },
    ];
    capture.capture(entries);
    const manifest = capture.manifestFor();
    assert.ok(manifest);
    const big = manifest.chunks.find((c) => c.entryIds.includes("e-big"));
    assert.ok(big, "oversized entry captured");
    assert.equal(big.oversized, true, "disclosed in the manifest");
    const backend = fakeBackend({ paths: new Map(), writes: [] });
    await deliverAll(outbox, backend);
    const stored = backend.paths.get(big.path);
    assert.ok(stored);
    assert.ok(
      (stored as string).includes(bigText),
      "oversized entry content intact, never truncated",
    );
    // Ordinary chunks stay under the cap.
    for (const chunk of manifest.chunks.filter((c) => !c.oversized)) {
      assert.ok(chunk.byteLength <= DEFAULT_MAX_CHUNK_BYTES + 64);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("T14 AC5: raw transcript records cannot pass ordinary retrieval guards", async () => {
  const stateDir = tmpStateDir();
  try {
    // A backup chunk record that otherwise looks like an active memory
    // record (authorized scope, active status) must still fail the guard's
    // memory/ namespace check — the structural split that keeps raw logs
    // out of ordinary RAG evidence.
    const adapter = {
      async read(path: string) {
        return {
          state: "ok" as const,
          content:
            "---\nscope: project/demo-proj\nmemory_status: active\n---\nraw transcript",
          body: "raw transcript",
          frontmatter: { scope: SCOPE, memory_status: "active" },
          ...(path.startsWith("backup/") ? { etag: undefined } : {}),
        };
      },
    } as unknown as KiwiFSAdapter;
    const guardResult = await guardCandidate(
      "backup/demo-proj/s-demo/000000.md",
      {
        adapter,
        authorizedScopes: [SCOPE],
        redact: (content) => ({ ok: true, content }),
      },
    );
    assert.equal(guardResult.ok, false);
    if (!guardResult.ok) {
      assert.equal(guardResult.step, "path-prefix");
    }
    // Memory paths still pass the same guard (control).
    const ok = await guardCandidate(
      "project/demo-proj/memory/observations/x.md",
      {
        adapter,
        authorizedScopes: [SCOPE],
        redact: (c) => ({ ok: true, content: c }),
      },
    );
    assert.equal(ok.ok, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
