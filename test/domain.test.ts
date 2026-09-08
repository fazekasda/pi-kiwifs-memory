/**
 * T05: versioned records, provenance, idempotency and namespace isolation.
 * Fixtures live in test/fixtures/domain/ (synthetic data only).
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SCHEMA_VERSION,
  parseStoredRecord,
  parseLocalArtifact,
  serializeStoredRecord,
  type TombstoneEntry,
  type ProcessingCursor,
  type BackupManifest,
} from "../src/domain/records.ts";
import {
  ID_GRAMMAR,
  PathEscapeError,
  backupChunkPath,
  backupManifestPath,
  boardMessagePath,
  memoryRecordPath,
  pathWithinBackupTree,
  pathWithinBoardChannel,
  pathWithinMemoryNamespace,
  validateId,
  validateProjectId,
} from "../src/domain/paths.ts";
import {
  canonicalJson,
  deriveRecordId,
  idempotencyKey,
} from "../src/domain/idempotency.ts";
import { deriveMsgId } from "../src/backend/ids.ts";

const FIX = "test/fixtures/domain";
const recordsFixture = JSON.parse(
  readFileSync(`${FIX}/records.json`, "utf8"),
) as { records: { name: string; markdown: string }[] };
const malformedFixture = JSON.parse(
  readFileSync(`${FIX}/malformed-cases.json`, "utf8"),
) as { cases: { name: string; markdown: string; expect: string }[] };
const localFixture = JSON.parse(
  readFileSync(`${FIX}/local-artifacts.json`, "utf8"),
) as {
  valid: {
    tombstone: TombstoneEntry;
    cursor: ProcessingCursor;
    manifest: BackupManifest;
  };
  futureVersion: Record<string, unknown>;
};

// ---------- round-trip ----------

test("round-trip preserves supported metadata and content", () => {
  for (const rec of recordsFixture.records) {
    const parsed = parseStoredRecord(rec.markdown);
    assert.equal(parsed.ok, true, `${rec.name}: ${JSON.stringify(parsed)}`);
    if (!parsed.ok) continue;
    const reserialized = serializeStoredRecord(parsed.record);
    const reparsed = parseStoredRecord(reserialized);
    assert.equal(reparsed.ok, true);
    if (!reparsed.ok) continue;
    assert.deepEqual(reparsed.record.frontmatter, parsed.record.frontmatter);
    assert.equal(reparsed.record.body, parsed.record.body);
    assert.equal(reparsed.record.frontmatter.schemaVersion, SCHEMA_VERSION);
  }
});

test("sources preserve session, branch and entry id distinctions", () => {
  const parsed = parseStoredRecord(recordsFixture.records[0]!.markdown);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const src = parsed.record.frontmatter.sources[0]!;
  assert.equal(src.sessionId, "s-abc");
  assert.equal(src.branchId, "b-main");
  assert.deepEqual(src.entryIds, ["e1", "e2"]);
  // A source without branchId must not gain a phantom branchId.
  const noBranch = parseStoredRecord(recordsFixture.records[1]!.markdown);
  assert.ok(noBranch.ok);
  if (!noBranch.ok) return;
  assert.equal(noBranch.record.frontmatter.sources[0]!.branchId, undefined);
});

test("board message frontmatter carries routing fields", () => {
  const parsed = parseStoredRecord(recordsFixture.records[1]!.markdown);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const fm = parsed.record.frontmatter;
  assert.equal(fm.type, "board-message");
  assert.equal(fm.to, "reviewer-agent");
  assert.equal(fm.from, "implementer-agent");
  assert.equal(fm.channel, "project-updates");
  assert.equal(fm.ttl, "30d");
});

// ---------- fail-safe reading ----------

for (const c of malformedFixture.cases) {
  test(`malformed/unknown version fails safely: ${c.name}`, () => {
    const parsed = parseStoredRecord(c.markdown);
    assert.equal(parsed.ok, false, `${c.name} should not parse`);
    if (parsed.ok) return;
    assert.equal(parsed.reason, c.expect);
    assert.equal(parsed.readOnly, true, "failures must be marked read-only");
  });
}

test("future-version local artifacts fail read-only, never rewritten", () => {
  const parsed = parseLocalArtifact<ProcessingCursor>(
    "cursor",
    JSON.stringify(localFixture.futureVersion),
  );
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.reason, "future-version");
  assert.equal(parsed.readOnly, true);
});

test("serialization refuses to write a non-current schemaVersion", () => {
  assert.throws(
    () =>
      serializeStoredRecord({
        frontmatter: {
          schemaVersion: 99,
          id: "aaaaaaaaaaaaaaaa",
          type: "observation",
          scope: "personal",
          created: "2026-09-08T10:30:00Z",
          sources: [],
          status: "active",
        },
        body: "x",
      }),
    /only 1 is writable/,
  );
});

// ---------- local artifacts ----------

test("valid local artifacts parse and round-trip through JSON", () => {
  const tomb = parseLocalArtifact<TombstoneEntry>(
    "tombstone",
    JSON.stringify(localFixture.valid.tombstone),
  );
  assert.ok(tomb.ok && tomb.artifact.path.endsWith("abcdef0123456789.md"));
  const cur = parseLocalArtifact<ProcessingCursor>(
    "cursor",
    JSON.stringify(localFixture.valid.cursor),
  );
  assert.ok(cur.ok && cur.artifact.lastConsumedEntryId === "e42");
  const man = parseLocalArtifact<BackupManifest>(
    "manifest",
    JSON.stringify(localFixture.valid.manifest),
  );
  assert.ok(man.ok);
  if (man.ok) {
    assert.equal(man.artifact.omissions[0]!.reason, "binary-omitted");
    assert.equal(man.artifact.redactionSummary.apiKeyLike, 2);
  }
});

test("malformed local artifacts fail safely", () => {
  assert.equal(parseLocalArtifact("cursor", "{not json").ok, false);
  const missingVersion = parseLocalArtifact<ProcessingCursor>(
    "cursor",
    JSON.stringify({
      sessionId: "s",
      lastConsumedEntryId: "e",
      updatedAt: "x",
    }),
  );
  assert.ok(!missingVersion.ok && missingVersion.reason === "malformed");
});

// ---------- idempotency keys ----------

test("repeated events produce the same idempotency key", () => {
  const sources = [{ sessionId: "s-abc", entryIds: ["e1", "e2"] }];
  const a = idempotencyKey({ kind: "observation", scope: "personal", sources });
  const b = idempotencyKey({ kind: "observation", scope: "personal", sources });
  assert.equal(a, b);
  // Key-order independence via canonical form.
  const c = idempotencyKey({
    scope: "personal",
    sources,
    kind: "observation",
  });
  assert.equal(a, c);
});

test("forked sessions with shared history produce distinct keys", () => {
  // Same entries (shared history) but the fork mints a new sessionId.
  const parent = idempotencyKey({
    kind: "observation",
    scope: "personal",
    sources: [{ sessionId: "s-parent", branchId: "b-main", entryIds: ["e1"] }],
  });
  const fork = idempotencyKey({
    kind: "observation",
    scope: "personal",
    sources: [{ sessionId: "s-fork", branchId: "b-main", entryIds: ["e1"] }],
  });
  assert.notEqual(parent, fork);
  // Branch lineage also distinguishes identity within one session.
  const otherBranch = idempotencyKey({
    kind: "observation",
    scope: "personal",
    sources: [{ sessionId: "s-parent", branchId: "b-side", entryIds: ["e1"] }],
  });
  assert.notEqual(parent, otherBranch);
  // Entry order is part of the identity of the work.
  const reordered = idempotencyKey({
    kind: "observation",
    scope: "personal",
    sources: [{ sessionId: "s-parent", entryIds: ["e2", "e1"] }],
  });
  assert.notEqual(parent, reordered);
});

test("identical content in different scopes produces distinct keys", () => {
  const sources = [{ sessionId: "s-abc", entryIds: ["e1"] }];
  assert.notEqual(
    idempotencyKey({ kind: "observation", scope: "personal", sources }),
    idempotencyKey({
      kind: "observation",
      scope: "project/github.com/org/repo",
      sources,
    }),
  );
});

test("canonicalJson is stable and injects no content ambiguity", () => {
  assert.equal(
    canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }),
    '{"a":[2,{"c":4,"d":3}],"b":1}',
  );
  assert.equal(canonicalJson(null), "null");
});

test("record ids derive from opIds and match the msg_id convention", () => {
  const opId = "3f9a2b1c-8d4e-5f60-a1b2-c3d4e5f60718";
  const obsId = deriveRecordId("observation", opId);
  assert.match(obsId, /^[0-9a-f]{16}$/);
  assert.equal(
    obsId,
    deriveRecordId("observation", opId),
    "stable across replays",
  );
  assert.notEqual(obsId, deriveRecordId("reflection", opId), "kind-bound");
  assert.throws(() => deriveRecordId("observation", "not-a-uuid"));
  // Board msg_id convention (architecture.md §2) reuses the T04 derivation:
  // same channel/from/opId → same msg_id/path.
  assert.equal(
    deriveMsgId("chan", "me", opId),
    deriveMsgId("chan", "me", opId),
  );
  assert.notEqual(
    deriveMsgId("chan", "me", opId),
    deriveMsgId("chan", "other", opId),
  );
});

// ---------- namespace isolation ----------

test("id grammar rejects escaping and malformed identifiers", () => {
  const bad = [
    "",
    "../escape",
    "UpperCase",
    "with_underscore",
    "with.dot",
    "with/slash",
    "%2e%2e",
    " leading-space",
    "a".repeat(65), // 65 chars > 64 (first char + 63)
    "-leading-dash",
  ];
  for (const id of bad) {
    assert.throws(
      () => validateId("test", id),
      PathEscapeError,
      `should reject: ${id}`,
    );
  }
  assert.equal(validateId("test", "abc-123"), "abc-123");
  assert.match("abc-123", ID_GRAMMAR);
});

test("memory record paths stay inside their scope namespace", () => {
  const created = new Date(Date.UTC(2026, 8, 8));
  assert.equal(
    memoryRecordPath("personal", "observation", "abcdef0123456789", created),
    "personal/memory/observations/2026/09/abcdef0123456789.md",
  );
  assert.equal(
    memoryRecordPath(
      "project/github.com/org/repo",
      "reflection",
      "abcdef0123456789",
      created,
    ),
    "project/github.com/org/repo/memory/reflections/2026/09/abcdef0123456789.md",
  );
  assert.equal(
    memoryRecordPath("personal", "proposal", "abcdef0123456789"),
    "personal/memory/merge-proposals/abcdef0123456789.md",
  );
  for (const evil of ["../evil", "%2e%2e", "Bad..Id", "a/b"]) {
    assert.throws(
      () => memoryRecordPath("personal", "observation", evil),
      PathEscapeError,
    );
  }
  assert.throws(
    () => memoryRecordPath("cross/other", "observation", "abcdef0123456789"),
    /owner scope/,
  );
  assert.throws(
    () =>
      memoryRecordPath(
        "project/github.com/../x",
        "observation",
        "abcdef0123456789",
      ),
    PathEscapeError,
  );
});

test("memory record paths bucket by UTC regardless of process timezone", async () => {
  // 2026-08-31T15:30Z is still August in UTC but September 1 in UTC+9.
  const ts = "2026-08-31T15:30:00Z";
  const script =
    "const { memoryRecordPath } = await import('./src/domain/paths.ts');" +
    `console.log(memoryRecordPath('personal','observation','abcdef0123456789', new Date('${ts}')))`;
  const runInTz = (tz: string): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        "node",
        ["--experimental-strip-types", "-e", script],
        { env: { ...process.env, TZ: tz } },
        (err: Error | null, stdout: string) =>
          err ? reject(err) : resolve(stdout),
      );
    });
  const [utcPath, tokyoPath] = await Promise.all([
    runInTz("UTC"),
    runInTz("Asia/Tokyo"),
  ]);
  assert.match(utcPath, /observations\/2026\/08\//);
  assert.equal(utcPath, tokyoPath);
});

test("backup and board path builders contain their identifiers", () => {
  assert.equal(
    backupManifestPath("github.com/org/repo", "s-abc"),
    "backup/github.com/org/repo/s-abc/manifest.md",
  );
  assert.equal(
    backupChunkPath("github.com/org/repo", "s-abc", 42),
    "backup/github.com/org/repo/s-abc/000042.md",
  );
  assert.throws(
    () => backupChunkPath("github.com/org/repo", "../x", 0),
    PathEscapeError,
  );
  assert.throws(() => backupChunkPath("a/../b", "s-abc", 0), PathEscapeError);
  assert.throws(() =>
    backupChunkPath("github.com/org/repo", "s-abc", 1_000_000),
  );
  assert.equal(
    boardMessagePath("project-updates", "0123456789abcdef"),
    "board/project-updates/0123456789abcdef.md",
  );
  assert.throws(
    () => boardMessagePath("../chan", "0123456789abcdef"),
    PathEscapeError,
  );
  assert.throws(
    () => boardMessagePath("chan", "0123456789abcdef/../../x"),
    PathEscapeError,
  );
});

test("project identity validation rejects traversal but accepts git identities", () => {
  assert.equal(validateProjectId("github.com/org/repo"), "github.com/org/repo");
  for (const evil of [
    "",
    "A/B",
    " a/b",
    "a%2Fb",
    "a\\b",
    "a/../b",
    "a//b",
    "a/.",
  ]) {
    assert.throws(
      () => validateProjectId(evil),
      PathEscapeError,
      `reject: ${evil}`,
    );
  }
});

test("namespace containment checks bound guard step 4", () => {
  const scope = "project/github.com/org/repo";
  assert.ok(
    pathWithinMemoryNamespace(
      `${scope}/memory/observations/2026/09/abcdef0123456789.md`,
      scope,
    ),
  );
  assert.ok(!pathWithinMemoryNamespace(`${scope}/memory-evil/x.md`, scope));
  assert.ok(!pathWithinMemoryNamespace(`${scope}/memory/../escape.md`, scope));
  assert.ok(!pathWithinMemoryNamespace("personal/memory/x.md", scope));
  assert.ok(
    pathWithinBoardChannel(
      "board/project-updates/0123456789abcdef.md",
      "project-updates",
    ),
  );
  assert.ok(
    !pathWithinBoardChannel("board/other-channel/x.md", "project-updates"),
  );
  assert.ok(
    pathWithinBackupTree(
      "backup/github.com/org/repo/s-abc/000000.md",
      "github.com/org/repo",
    ),
  );
  assert.ok(
    !pathWithinBackupTree(
      "backup/github.com/org/other/s-abc/x.md",
      "github.com/org/repo",
    ),
  );
});
