/**
 * T15 acceptance tests: backup verification and non-destructive export —
 * synthetic fixtures only, no live service is contacted.
 *
 * Acceptance coverage (PRD T15):
 * 1. Missing, duplicated, reordered and corrupted chunks are detected.
 * 2. Round-trip fixture recovers all promised fields, with redaction and
 *    omissions explicitly represented.
 * 3. Recovery writes only to an explicit new destination after validation
 *    (existing destination refused).
 * 4. Foreign/newer schema versions cannot silently corrupt (fail closed).
 * 5. Completeness never claims byte-for-byte fidelity when redaction
 *    occurred (fidelity statement is redaction-honest).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toBackupViews } from "../src/backup/exporter.ts";
import { chunkEntries, serializeChunk } from "../src/backup/chunker.ts";
import { buildBackupManifest } from "../src/backup/manifest.ts";
import {
  exportBackup,
  ExportRefusedError,
  parseBackupChunkText,
  parseBackupManifestText,
  verifyBackup,
  type VerifyIssueCode,
} from "../src/backup/verify.ts";
import type { BackupView } from "../src/backup/exporter.ts";

const SCOPE = "project/demo-proj";
const SESSION = "s-t15";

function fixtureEntries(): Record<string, unknown>[] {
  return [
    {
      type: "message",
      id: "m-root",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "start of session" },
    },
    {
      type: "message",
      id: "m-a",
      parentId: "m-root",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "assistant",
        content: "answer with AWS AKIAIOSFODNN7EXAMPLE inside",
      },
    },
    {
      type: "message",
      id: "m-b",
      parentId: "m-a",
      timestamp: "2026-01-01T00:00:02Z",
      message: { role: "user", content: "follow-up" },
    },
    {
      // Binary content: omitted, recorded — never serialized.
      type: "message",
      id: "m-bin",
      parentId: "m-b",
      timestamp: "2026-01-01T00:00:03Z",
      message: {
        role: "toolResult",
        content: [{ type: "image", data: "AAAA" }],
      },
    },
  ];
}

interface Fixture {
  views: BackupView[];
  manifest: ReturnType<typeof buildBackupManifest>;
  chunks: Map<number, string>;
}

function buildFixture(): Fixture {
  const views = toBackupViews(fixtureEntries());
  assert.equal(views.length, 4);
  // Small cap → multiple chunks, so per-chunk detection paths are exercised.
  const drafts = chunkEntries(SESSION, views, {
    seqStart: 0,
    maxChunkBytes: 256,
  });
  const manifest = buildBackupManifest({
    sessionId: SESSION,
    projectId: "demo-proj",
    scope: SCOPE,
    chunks: drafts.map((d) => ({
      seq: d.seq,
      path: `backup/demo-proj/${SESSION}/${String(d.seq).padStart(6, "0")}.md`,
      checksum: d.checksum,
      byteLength: d.byteLength,
      entryIds: d.entryIds,
      ...(d.oversized ? { oversized: true } : {}),
    })),
    redactionSummary: { "aws-access-key": 1 },
    omissions: [{ entryId: "m-bin", reason: "binary-omitted" }],
    coveredEntryIds: views.map((v) => v.id),
    updatedAtMs: 1735689600000,
  });
  const chunks = new Map(drafts.map((d) => [d.seq, d.content]));
  return { views, manifest, chunks };
}

function issueCodes(v: { issues: { code: VerifyIssueCode }[] }): Set<string> {
  return new Set(v.issues.map((i) => i.code));
}

test("T15 AC2/AC5: healthy backup verifies; fidelity is redaction-honest", () => {
  const f = buildFixture();
  const v = verifyBackup({
    manifest: f.manifest,
    chunks: f.chunks,
    sessionId: SESSION,
  });
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  assert.equal(v.coveredEntryIds.join(","), f.views.map((x) => x.id).join(","));
  assert.match(v.fidelity, /not byte-identical/);
  assert.equal(v.manifest.redactionSummary["aws-access-key"], 1);
  assert.deepEqual(v.manifest.omissions, [
    { entryId: "m-bin", reason: "binary-omitted" },
  ]);
});

test("T15 AC1: missing chunk is detected", () => {
  const f = buildFixture();
  const reduced = new Map(f.chunks);
  reduced.delete(0);
  const v = verifyBackup({
    manifest: f.manifest,
    chunks: reduced,
    sessionId: SESSION,
  });
  assert.equal(v.ok, false);
  assert.ok(issueCodes(v).has("missing-chunk"));
  assert.match(v.fidelity, /incomplete or corrupted/);
});

test("T15 AC1: duplicated/extra delivered chunk is detected", () => {
  const f = buildFixture();
  const extra = new Map(f.chunks);
  const maxSeq = Math.max(...extra.keys());
  extra.set(maxSeq + 1, f.chunks.get(0) as string);
  const v = verifyBackup({
    manifest: f.manifest,
    chunks: extra,
    sessionId: SESSION,
  });
  assert.equal(v.ok, false);
  assert.ok(issueCodes(v).has("unexpected-chunk"));
});

test("T15 AC1: reordered chunks are detected (content seq ≠ manifest seq)", () => {
  const f = buildFixture();
  const a = f.chunks.get(0) as string;
  const b = f.chunks.get(1) as string;
  const swapped = new Map(f.chunks);
  swapped.set(0, b);
  swapped.set(1, a);
  const v = verifyBackup({
    manifest: f.manifest,
    chunks: swapped,
    sessionId: SESSION,
  });
  assert.equal(v.ok, false);
  assert.ok(issueCodes(v).has("seq-mismatch"));
});

test("T15 AC1: corrupted chunk bytes fail the checksum", () => {
  const f = buildFixture();
  const corrupted = new Map(f.chunks);
  corrupted.set(
    0,
    (f.chunks.get(0) as string).replace("start of session", "tampered!!!"),
  );
  const v = verifyBackup({
    manifest: f.manifest,
    chunks: corrupted,
    sessionId: SESSION,
  });
  assert.equal(v.ok, false);
  assert.ok(issueCodes(v).has("checksum-mismatch"));
});

test("T15 AC1: manifest completeness — count/range/duplicate-coverage gaps detected", () => {
  const f = buildFixture();
  // entryCount undercount.
  const badCount = {
    ...f.manifest,
    coveredRange: { ...f.manifest.coveredRange, entryCount: 3 },
  };
  const vCount = verifyBackup({
    manifest: badCount,
    chunks: f.chunks,
    sessionId: SESSION,
  });
  assert.ok(issueCodes(vCount).has("entry-count-mismatch"));
  // first entry id mismatch.
  const badRange = {
    ...f.manifest,
    coveredRange: { ...f.manifest.coveredRange, firstEntryId: "m-wrong" },
  };
  const vRange = verifyBackup({
    manifest: badRange,
    chunks: f.chunks,
    sessionId: SESSION,
  });
  assert.ok(issueCodes(vRange).has("range-mismatch"));
  // duplicate coverage: the same entries delivered in two chunks (content).
  const dupViews = toBackupViews(fixtureEntries().slice(0, 2));
  const dupChunks = new Map<number, string>([
    [0, serializeChunk({ sessionId: SESSION, seq: 0, entries: dupViews })],
    [1, serializeChunk({ sessionId: SESSION, seq: 1, entries: dupViews })],
  ]);
  const dupManifest = {
    ...f.manifest,
    coveredRange: { ...f.manifest.coveredRange, entryCount: 2 },
    chunks: [
      {
        seq: 0,
        path: "backup/demo-proj/s-t15/000000.md",
        checksum: "x",
        byteLength: 0,
        entryIds: dupViews.map((v) => v.id),
      },
      {
        seq: 1,
        path: "backup/demo-proj/s-t15/000001.md",
        checksum: "y",
        byteLength: 0,
        entryIds: dupViews.map((v) => v.id),
      },
    ],
  } as unknown as typeof f.manifest;
  const vDup = verifyBackup({
    manifest: dupManifest,
    chunks: dupChunks,
    sessionId: SESSION,
  });
  assert.ok(issueCodes(vDup).has("duplicate-coverage"));
});

test("T15 AC1: unlinked parent (branch link into uncovered/later entry) is detected", () => {
  // Child first, parent later: delivery order breaks the tree link.
  const entries = [
    {
      type: "message",
      id: "child",
      parentId: "parent",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "child first" },
    },
    {
      type: "message",
      id: "parent",
      parentId: null,
      timestamp: "2026-01-01T00:00:01Z",
      message: { role: "user", content: "parent later" },
    },
  ];
  const views = toBackupViews(entries);
  const manifest = buildBackupManifest({
    sessionId: SESSION,
    projectId: "demo-proj",
    scope: SCOPE,
    chunks: [
      {
        seq: 0,
        path: `backup/demo-proj/${SESSION}/000000.md`,
        checksum: "x",
        byteLength: 0,
        entryIds: ["child"],
      },
      {
        seq: 1,
        path: `backup/demo-proj/${SESSION}/000001.md`,
        checksum: "x",
        byteLength: 0,
        entryIds: ["parent"],
      },
    ],
    redactionSummary: {},
    omissions: [],
    coveredEntryIds: ["child", "parent"],
    updatedAtMs: 0,
  });
  const parentView = views[0]!;
  const childView = views[1]!;
  const chunks = new Map<number, string>([
    [0, serializeChunk({ sessionId: SESSION, seq: 0, entries: [parentView] })],
    [1, serializeChunk({ sessionId: SESSION, seq: 1, entries: [childView] })],
  ]);
  const v = verifyBackup({ manifest, chunks, sessionId: SESSION });
  assert.equal(v.ok, false);
  assert.ok(issueCodes(v).has("unlinked-parent"));
});

test("T15 AC4: foreign/newer schema versions fail closed (manifest and chunk)", () => {
  const f = buildFixture();
  const newer = { ...f.manifest, schemaVersion: 99 };
  const p = parseBackupManifestText(JSON.stringify(newer));
  assert.equal(p.ok, false);
  assert.equal(p.ok ? "" : p.code, "schema-unsupported");
  assert.match(p.ok ? "" : p.detail, /newer than supported/);

  const newerChunk = serializeChunk({
    sessionId: SESSION,
    seq: 0,
    entries: f.views,
  }).replace('"schemaVersion": 1', '"schemaVersion": 99');
  const pc = parseBackupChunkText(newerChunk, SESSION);
  assert.equal(pc.ok, false);
  assert.equal(pc.ok ? "" : pc.code, "schema-unsupported");
  // Verification surfaces the schema refusal as an issue, not a guess.
  const v = verifyBackup({
    manifest: newer as typeof f.manifest,
    chunks: f.chunks,
    sessionId: SESSION,
  });
  assert.equal(v.ok, false);
  assert.ok(issueCodes(v).has("schema-unsupported"));
});

test("T15 AC4: malformed manifest fails closed (kind, redacted flag, chunk shape)", () => {
  const f = buildFixture();
  assert.equal(parseBackupManifestText("not json").ok, false);
  const badKind = { ...f.manifest, kind: "something-else" };
  assert.equal(parseBackupManifestText(JSON.stringify(badKind)).ok, false);
  const unredacted = { ...f.manifest, redacted: false };
  const p = parseBackupManifestText(JSON.stringify(unredacted));
  assert.equal(p.ok, false);
  assert.match(p.ok ? "" : p.detail, /redacted/);
  const badChunk = { ...f.manifest, chunks: [{ seq: "x" }] };
  assert.equal(parseBackupManifestText(JSON.stringify(badChunk)).ok, false);
});

test("T15 AC2/AC3: round-trip export recovers promised fields with redaction/omissions represented", () => {
  const f = buildFixture();
  const v = verifyBackup({
    manifest: f.manifest,
    chunks: f.chunks,
    sessionId: SESSION,
  });
  assert.equal(v.ok, true);
  const dest = join(mkdtempSync(join(tmpdir(), "kiwifs-t15-")), "export-new");
  const ex = exportBackup({
    verification: v,
    chunks: f.chunks,
    destination: dest,
  });
  assert.ok(ex.files.length >= 3);
  // Round-trip: parse exported chunks back and recover all promised fields.
  const recovered: BackupView[] = [];
  for (const record of v.manifest.chunks) {
    const text = readFileSync(
      join(dest, "chunks", `${String(record.seq).padStart(6, "0")}.md`),
      "utf8",
    );
    const parsed = parseBackupChunkText(text, SESSION);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok ? parsed.value.seq : -1, record.seq);
    recovered.push(...(parsed.ok ? parsed.value.entries : []));
  }
  assert.equal(recovered.length, f.views.length);
  for (const view of f.views) {
    const r = recovered.find((e) => e.id === view.id);
    assert.ok(r, `missing recovered entry ${view.id}`);
    assert.equal(r.parentId, view.parentId);
    assert.equal(r.type, view.type);
    assert.equal(r.timestamp, view.timestamp);
    if (view.text !== undefined) assert.equal(r.text, view.text);
  }
  // Redaction and omissions are explicitly represented in the summary.
  const summary = readFileSync(join(dest, "export-summary.md"), "utf8");
  assert.match(summary, /not byte-identical/);
  assert.match(summary, /aws-access-key: 1/);
  assert.match(summary, /m-bin: binary-omitted/);
  // Manifest copied with checksums intact.
  const manifestOut = readFileSync(join(dest, "manifest.md"), "utf8");
  assert.match(manifestOut, /"kind": "kiwifs-backup-manifest"/);
  rmSync(dest, { recursive: true, force: true });
});

test("T15 AC3: export refuses existing destination, unverified backups and unsafe paths", () => {
  const f = buildFixture();
  const v = verifyBackup({
    manifest: f.manifest,
    chunks: f.chunks,
    sessionId: SESSION,
  });
  const dest = mkdtempSync(join(tmpdir(), "kiwifs-t15-"));
  assert.throws(
    () =>
      exportBackup({ verification: v, chunks: f.chunks, destination: dest }),
    ExportRefusedError,
  );
  assert.ok(
    !existsSync(join(dest, "manifest.md")),
    "nothing written on refusal",
  );
  // Unverified backup is refused outright.
  const broken = new Map(f.chunks);
  broken.delete(0);
  const vBad = verifyBackup({
    manifest: f.manifest,
    chunks: broken,
    sessionId: SESSION,
  });
  assert.throws(
    () =>
      exportBackup({
        verification: vBad,
        chunks: broken,
        destination: join(dest, "nope"),
      }),
    ExportRefusedError,
  );
  assert.ok(!existsSync(join(dest, "nope")));
  // Unsafe destination.
  assert.throws(
    () => exportBackup({ verification: v, chunks: f.chunks, destination: "/" }),
    ExportRefusedError,
  );
  rmSync(dest, { recursive: true, force: true });
});
