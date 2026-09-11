/**
 * T15: backup verification and non-destructive export (architecture.md §7).
 *
 * Verification re-derives everything from the delivered bytes:
 * - chunk checksums are recomputed (content-addressed integrity, §7 — the
 *   checksum is never treated as branch identity);
 * - manifest completeness: covered entry count/range vs the actual chunk
 *   contents, duplicate coverage, missing chunks (declared but absent),
 *   unexpected chunks (delivered beyond the manifest — duplicated/extra);
 * - branch links: every entry's `parentId` resolves to a null root or an
 *   earlier entry in delivery order (tree integrity, lineage = Pi entry IDs).
 *
 * Fidelity is always reported as "complete with the recorded redactions and
 * omissions" — never byte-identical (decisions.md #2; the manifest is built
 * with `redacted: true` unconditionally).
 *
 * Foreign/newer schema versions fail closed: an unsupported manifest or
 * chunk schemaVersion aborts verification (and any export) instead of
 * guessing — a newer format must never silently corrupt local content.
 *
 * Export is NON-DESTRUCTIVE: it writes only into an explicit destination
 * directory that does not already exist; it never touches Pi sessions and
 * never overwrites anything implicitly. Restoring into Pi sessions is
 * explicitly deferred (architecture.md §13 row 20) and is not attempted here.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  rmdirSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { BACKUP_SCHEMA_VERSION, type BackupView } from "./exporter.ts";
import { chunkChecksum } from "./chunker.ts";
import type { BackupManifest } from "./manifest.ts";

/** Verification issue codes (stable identifiers — safe for status output). */
export type VerifyIssueCode =
  | "manifest-invalid"
  | "schema-unsupported"
  | "missing-chunk"
  | "unexpected-chunk"
  | "checksum-mismatch"
  | "seq-mismatch"
  | "session-mismatch"
  | "byte-length-mismatch"
  | "duplicate-coverage"
  | "entry-count-mismatch"
  | "range-mismatch"
  | "identity-mismatch"
  | "unlinked-parent";

export interface VerifyIssue {
  code: VerifyIssueCode;
  /** Human-readable detail — IDs, seqs and counts only, never content. */
  detail: string;
}

export interface ParsedChunkFile {
  schemaVersion: number;
  sessionId: string;
  seq: number;
  entries: BackupView[];
}

export type ParseOutcome<T> =
  { ok: true; value: T } | { ok: false; code: VerifyIssueCode; detail: string };

/** Parses a serialized chunk file defensively (shape + schema gate). */
export function parseBackupChunkText(
  text: string,
  sessionId: string,
): ParseOutcome<ParsedChunkFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: "checksum-mismatch",
      detail: "chunk is not valid JSON",
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj === null || obj["kind"] !== "kiwifs-backup-chunk") {
    return {
      ok: false,
      code: "schema-unsupported",
      detail: "chunk kind is not kiwifs-backup-chunk",
    };
  }
  const schemaVersion = obj["schemaVersion"];
  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    return {
      ok: false,
      code: "schema-unsupported",
      detail: `chunk schemaVersion invalid: ${String(schemaVersion)}`,
    };
  }
  if (schemaVersion > BACKUP_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "schema-unsupported",
      detail: `chunk schemaVersion ${schemaVersion} is newer than supported (${BACKUP_SCHEMA_VERSION}) — refusing to interpret`,
    };
  }
  if (typeof obj["sessionId"] !== "string" || obj["sessionId"] !== sessionId) {
    return {
      ok: false,
      code: "session-mismatch",
      detail: `chunk sessionId ${String(obj["sessionId"])} does not match the manifest session`,
    };
  }
  if (!Number.isInteger(obj["seq"]) || (obj["seq"] as number) < 0) {
    return {
      ok: false,
      code: "seq-mismatch",
      detail: `chunk seq invalid: ${String(obj["seq"])}`,
    };
  }
  if (!Array.isArray(obj["entries"])) {
    return {
      ok: false,
      code: "manifest-invalid",
      detail: "chunk entries is not an array",
    };
  }
  const entries: BackupView[] = [];
  for (const raw of obj["entries"] as unknown[]) {
    if (typeof raw !== "object" || raw === null) {
      return {
        ok: false,
        code: "manifest-invalid",
        detail: "chunk entry is not an object",
      };
    }
    const e = raw as Record<string, unknown>;
    if (typeof e["id"] !== "string" || e["id"] === "") {
      return {
        ok: false,
        code: "manifest-invalid",
        detail: "chunk entry is missing its id",
      };
    }
    entries.push(e as unknown as BackupView);
  }
  return {
    ok: true,
    value: {
      schemaVersion: schemaVersion as number,
      sessionId: sessionId,
      seq: obj["seq"] as number,
      entries,
    },
  };
}

/** Parses a serialized manifest defensively (shape + schema gate). */
export function parseBackupManifestText(
  text: string,
): ParseOutcome<BackupManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: "manifest-invalid",
      detail: "manifest is not valid JSON",
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj === null || obj["kind"] !== "kiwifs-backup-manifest") {
    return {
      ok: false,
      code: "schema-unsupported",
      detail: "manifest kind is not kiwifs-backup-manifest",
    };
  }
  const schemaVersion = obj["schemaVersion"];
  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    return {
      ok: false,
      code: "schema-unsupported",
      detail: `manifest schemaVersion invalid: ${String(schemaVersion)}`,
    };
  }
  if (schemaVersion > BACKUP_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "schema-unsupported",
      detail: `manifest schemaVersion ${schemaVersion} is newer than supported (${BACKUP_SCHEMA_VERSION}) — refusing to interpret (foreign/newer format)`,
    };
  }
  for (const key of ["sessionId", "projectId", "scope"]) {
    if (typeof obj[key] !== "string" || (obj[key] as string) === "") {
      return {
        ok: false,
        code: "manifest-invalid",
        detail: `manifest field ${key} is missing or empty`,
      };
    }
  }
  if (obj["redacted"] !== true) {
    return {
      ok: false,
      code: "manifest-invalid",
      detail:
        "manifest does not declare redacted: true — a redaction-honest manifest is required",
    };
  }
  const chunks = obj["chunks"];
  if (!Array.isArray(chunks)) {
    return {
      ok: false,
      code: "manifest-invalid",
      detail: "manifest chunks is not an array",
    };
  }
  for (const c of chunks as unknown[]) {
    const m = c as Record<string, unknown>;
    if (
      !Number.isInteger(m?.["seq"]) ||
      typeof m?.["path"] !== "string" ||
      typeof m?.["checksum"] !== "string" ||
      !Number.isInteger(m?.["byteLength"]) ||
      !Array.isArray(m?.["entryIds"]) ||
      (m?.["entryIds"] as unknown[]).some((id) => typeof id !== "string")
    ) {
      return {
        ok: false,
        code: "manifest-invalid",
        detail: "manifest chunk record is malformed",
      };
    }
  }
  const covered = obj["coveredRange"] as Record<string, unknown> | undefined;
  if (
    covered === null ||
    typeof covered !== "object" ||
    !Number.isInteger(covered?.["entryCount"])
  ) {
    return {
      ok: false,
      code: "manifest-invalid",
      detail: "manifest coveredRange is malformed",
    };
  }
  if (obj["omissions"] !== undefined && !Array.isArray(obj["omissions"])) {
    return {
      ok: false,
      code: "manifest-invalid",
      detail: "manifest omissions is not an array",
    };
  }
  return { ok: true, value: parsed as unknown as BackupManifest };
}

export interface BackupVerification {
  ok: boolean;
  issues: VerifyIssue[];
  manifest: BackupManifest;
  /** Ordered entry ids actually covered by the delivered chunks. */
  coveredEntryIds: string[];
  /** Fidelity statement — always redaction-honest, never byte-identical. */
  fidelity:
    | "complete with recorded redactions and omissions (not byte-identical)"
    | "incomplete or corrupted";
}

export interface VerifyInput {
  /** Parsed manifest (the single mutable backup path). */
  manifest: BackupManifest;
  /** Delivered chunk contents by seq (only what the backend actually returned). */
  chunks: Map<number, string>;
  /** Session id the manifest must describe. */
  sessionId: string;
  /** Project id the manifest must claim — never trusted blindly (T15-hardening). */
  projectId: string;
  /** When provided, the manifest scope must match it exactly. */
  scope?: string;
}

/**
 * Verifies checksums, manifest completeness and branch links against the
 * delivered chunk bytes. Pure: no network, no filesystem.
 */
export function verifyBackup(input: VerifyInput): BackupVerification {
  const issues: VerifyIssue[] = [];
  const manifest = input.manifest;
  if (
    typeof manifest.schemaVersion !== "number" ||
    manifest.schemaVersion > BACKUP_SCHEMA_VERSION
  ) {
    issues.push({
      code: "schema-unsupported",
      detail: `manifest schemaVersion ${String(manifest.schemaVersion)} is newer than supported (${BACKUP_SCHEMA_VERSION}) — refusing to interpret (foreign/newer format)`,
    });
  }
  if (manifest.sessionId !== input.sessionId) {
    issues.push({
      code: "session-mismatch",
      detail: `manifest sessionId ${manifest.sessionId} does not match requested ${input.sessionId}`,
    });
  }
  // Identity gate: a manifest is only trusted for the project/scope it was
  // requested for — a manifest from another project (or claiming a different
  // scope) must never verify or export (T15-hardening).
  if (manifest.projectId !== input.projectId) {
    issues.push({
      code: "identity-mismatch",
      detail: `manifest projectId ${manifest.projectId} does not match requested ${input.projectId}`,
    });
  }
  if (input.scope !== undefined && manifest.scope !== input.scope) {
    issues.push({
      code: "identity-mismatch",
      detail: `manifest scope ${manifest.scope} does not match requested ${input.scope}`,
    });
  }

  const manifestSeqs = new Set(manifest.chunks.map((c) => c.seq));
  const bySeq = new Map(manifest.chunks.map((c) => [c.seq, c]));

  // Delivered chunks the manifest does not declare: duplicated/extra.
  for (const seq of [...input.chunks.keys()].sort((a, b) => a - b)) {
    if (!manifestSeqs.has(seq)) {
      issues.push({
        code: "unexpected-chunk",
        detail: `delivered chunk seq ${seq} is not declared in the manifest (duplicated or extra)`,
      });
    }
  }

  const coveredEntryIds: string[] = [];
  const seenEntries = new Set<string>();
  let orderedOk = true;

  for (const record of manifest.chunks) {
    const content = input.chunks.get(record.seq);
    if (content === undefined) {
      issues.push({
        code: "missing-chunk",
        detail: `chunk seq ${record.seq} (${record.path}) declared in the manifest but not delivered`,
      });
      continue;
    }
    const actual = chunkChecksum(content);
    if (actual !== record.checksum) {
      issues.push({
        code: "checksum-mismatch",
        detail: `chunk seq ${record.seq} checksum mismatch (manifest ${record.checksum.slice(0, 12)}…, actual ${actual.slice(0, 12)}… — corrupted or tampered)`,
      });
    }
    const parsed = parseBackupChunkText(content, manifest.sessionId);
    if (!parsed.ok) {
      issues.push({
        code: parsed.code,
        detail: `seq ${record.seq}: ${parsed.detail}`,
      });
      continue;
    }
    if (parsed.value.seq !== record.seq) {
      issues.push({
        code: "seq-mismatch",
        detail: `chunk at seq ${record.seq} self-describes as seq ${parsed.value.seq} (reordered or misfiled)`,
      });
      orderedOk = false;
    }
    if (Buffer.byteLength(content, "utf8") !== record.byteLength) {
      issues.push({
        code: "byte-length-mismatch",
        detail: `chunk seq ${record.seq} byte length differs from the manifest`,
      });
    }
    const contentIds = parsed.value.entries.map((e) => e.id);
    if (
      contentIds.length !== record.entryIds.length ||
      contentIds.some((id, i) => id !== record.entryIds[i])
    ) {
      issues.push({
        code: "manifest-invalid",
        detail: `chunk seq ${record.seq} entry ids diverge from the manifest`,
      });
    }
    for (const id of contentIds) {
      if (seenEntries.has(id)) {
        issues.push({
          code: "duplicate-coverage",
          detail: `entry ${id} appears in more than one chunk (seq ${record.seq})`,
        });
      }
      seenEntries.add(id);
      coveredEntryIds.push(id);
    }
  }

  // Manifest completeness: covered range vs actual coverage.
  const count = manifest.coveredRange.entryCount;
  if (count !== coveredEntryIds.length && orderedOk) {
    issues.push({
      code: "entry-count-mismatch",
      detail: `manifest declares ${count} covered entries, chunks deliver ${coveredEntryIds.length}`,
    });
  }
  // Null endpoints must mean an EMPTY backup. A nonempty backup (manifest
  // entryCount > 0 OR delivered coverage) can never bypass range validation
  // by claiming null endpoints (T15-hardening regression fix).
  if (manifest.coveredRange.entryCount > 0) {
    if (manifest.coveredRange.firstEntryId === null) {
      issues.push({
        code: "range-mismatch",
        detail: `manifest declares ${manifest.coveredRange.entryCount} covered entries but a null firstEntryId — range endpoints are mandatory for a nonempty backup`,
      });
    }
    if (manifest.coveredRange.lastEntryId === null) {
      issues.push({
        code: "range-mismatch",
        detail: `manifest declares ${manifest.coveredRange.entryCount} covered entries but a null lastEntryId — range endpoints are mandatory for a nonempty backup`,
      });
    }
  }
  if (
    manifest.coveredRange.firstEntryId !== null &&
    coveredEntryIds.length > 0 &&
    manifest.coveredRange.firstEntryId !== coveredEntryIds[0]
  ) {
    issues.push({
      code: "range-mismatch",
      detail: `manifest firstEntryId ${manifest.coveredRange.firstEntryId} does not match delivered ${coveredEntryIds[0]}`,
    });
  }
  if (
    manifest.coveredRange.lastEntryId !== null &&
    coveredEntryIds.length > 0 &&
    manifest.coveredRange.lastEntryId !==
      coveredEntryIds[coveredEntryIds.length - 1]
  ) {
    issues.push({
      code: "range-mismatch",
      detail: `manifest lastEntryId ${manifest.coveredRange.lastEntryId} does not match delivered ${coveredEntryIds[coveredEntryIds.length - 1]}`,
    });
  }

  // Branch links: every parentId resolves to null or an earlier entry in
  // delivery order (tree integrity).
  {
    const seen = new Set<string>();
    for (const record of manifest.chunks) {
      const parsed = input.chunks.has(record.seq)
        ? parseBackupChunkText(
            input.chunks.get(record.seq) as string,
            manifest.sessionId,
          )
        : undefined;
      if (!parsed || !parsed.ok) continue;
      for (const entry of parsed.value.entries) {
        const parent = entry.parentId;
        if (parent !== null && parent !== undefined && !seen.has(parent)) {
          issues.push({
            code: "unlinked-parent",
            detail: `entry ${entry.id} references parent ${String(parent)} that is not covered earlier in the tree`,
          });
        }
        seen.add(entry.id);
      }
    }
  }

  const ok = issues.length === 0;
  return {
    ok,
    issues,
    manifest,
    coveredEntryIds,
    fidelity: ok
      ? "complete with recorded redactions and omissions (not byte-identical)"
      : "incomplete or corrupted",
  };
}

export class ExportRefusedError extends Error {}

function tryLstat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Writes a file with exclusive creation ('wx' — fails if the path exists,
 * including as a symlink) and forces 0600 independent of the umask.
 *
 * `owned` is the cleanup ledger: the path is added ONLY after the exclusive
 * open succeeded, so (a) a mid-write failure (ENOSPC/EIO) still leaves the
 * partially-written file on the ledger for cleanup, while (b) a path planted
 * between claim and write (EEXIST on 'wx') never lands on the ledger and is
 * therefore never deleted — cleanup removes only what this call created.
 */
function writePrivateFile(
  path: string,
  content: string,
  owned: string[],
): void {
  const fd = openSync(path, "wx", 0o600);
  owned.push(path);
  try {
    writeSync(fd, Buffer.from(content, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // mode in openSync is masked by the umask; chmod makes 0600 absolute.
  chmodSync(path, 0o600);
}

/**
 * Non-destructive export of a VERIFIED backup to an explicit new
 * destination directory. Refuses to write when the destination exists,
 * when verification reported issues, or when the schema is unsupported —
 * recovery never implicitly overwrites anything (PRD T15).
 *
 * T15-hardening:
 * - The destination is claimed ATOMICALLY with a non-recursive mkdir +
 *   EEXIST refusal (no existsSync-then-mkdir TOCTOU race, no recursive
 *   parent creation that could follow an attacker-planted symlink).
 * - Dangling or pre-existing symlinks at the destination fail the mkdir or
 *   are rejected via lstat; every file is written with O_EXCL ('wx') so a
 *   path planted between claim and write is refused, never overwritten.
 * - Modes are absolute: 0700 for directories and 0600 for files, enforced
 *   with chmod independent of a permissive umask.
 * - On any failure, ONLY artifacts this call created are removed (recorded
 *   file paths + the claimed directories, non-recursively); preexisting or
 *   non-owned content is never deleted.
 */
export function exportBackup(input: {
  verification: BackupVerification;
  /** Chunk contents by seq (the same delivered bytes that were verified). */
  chunks: Map<number, string>;
  destination: string;
}): { destination: string; files: string[] } {
  const v = input.verification;
  if (!v.ok) {
    throw new ExportRefusedError(
      `refusing to export an unverified backup: ${v.issues.map((i) => i.code).join(", ")}`,
    );
  }
  if (v.manifest.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new ExportRefusedError(
      `refusing to export schemaVersion ${v.manifest.schemaVersion} (newer than supported ${BACKUP_SCHEMA_VERSION})`,
    );
  }
  const dest = resolve(input.destination);
  if (!dest || dest === "/" || dest.length < 2) {
    throw new ExportRefusedError("refusing to export to an unsafe destination");
  }
  // Atomic claim: create the destination with a SINGLE non-recursive mkdir.
  // Any pre-existing entry (including symlinks, dangling or not) yields EEXIST
  // and is refused — there is no stat-then-create race window.
  try {
    mkdirSync(dest, { mode: 0o700 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // lstat is best-effort (the entry can vanish between mkdir and here in
      // a race); a missing entry is still a refusal, never a fallback write.
      const st = tryLstat(dest);
      throw new ExportRefusedError(
        `destination already exists${st?.isSymbolicLink() ? " (a symbolic link)" : ""}: ${dest} — export only writes to a NEW explicit destination`,
      );
    }
    if (code === "ENOENT") {
      throw new ExportRefusedError(
        `destination parent directory does not exist: ${dest} — create it first (no recursive parent creation)`,
      );
    }
    throw err;
  }
  // Defense in depth: if something swapped the path between mkdir and this
  // check, refuse (the fresh directory would have been replaced).
  const claimed = lstatSync(dest);
  if (claimed.isSymbolicLink() || !claimed.isDirectory()) {
    throw new ExportRefusedError(
      `destination was replaced after claim: ${dest} — refusing to export`,
    );
  }
  chmodSync(dest, 0o700);

  /** Artifacts created by THIS call — the only things cleanup may remove. */
  const files: string[] = [];
  const cleanupOwned = (err: unknown): never => {
    for (const p of files) {
      try {
        rmSync(p, { force: false });
      } catch {
        /* best-effort: never mask the original error */
      }
    }
    for (const dir of [join(dest, "chunks"), dest]) {
      try {
        rmdirSync(dir); // non-recursive: fails if anything else remains
      } catch {
        /* never delete content we did not create */
      }
    }
    throw err;
  };

  const manifestPath = join(dest, "manifest.md");
  try {
    writePrivateFile(
      manifestPath,
      JSON.stringify(v.manifest, null, 2) + "\n",
      files,
    );
  } catch (err) {
    cleanupOwned(err);
  }

  const chunksDir = join(dest, "chunks");
  try {
    mkdirSync(chunksDir, { mode: 0o700 });
    chmodSync(chunksDir, 0o700);
  } catch (err) {
    cleanupOwned(err);
  }
  for (const record of v.manifest.chunks) {
    const content = input.chunks.get(record.seq);
    if (content === undefined) continue;
    const p = join(chunksDir, `${String(record.seq).padStart(6, "0")}.md`);
    try {
      writePrivateFile(p, content, files);
    } catch (err) {
      cleanupOwned(err);
    }
  }

  // Human-readable recovery summary: redaction/omissions are represented
  // explicitly, and the fidelity statement never claims byte-identical.
  const lines: string[] = [
    "# KiwiFS backup export",
    "",
    `session: ${v.manifest.sessionId}`,
    `scope: ${v.manifest.scope}`,
    `entries covered: ${v.coveredEntryIds.length} (manifest declares ${v.manifest.coveredRange.entryCount})`,
    `chunks: ${v.manifest.chunks.length}`,
    `verification: OK — checksums, completeness and branch links verified`,
    `fidelity: ${v.fidelity}`,
    "",
    "## Redaction summary (counts by type — no values)",
    "",
    ...(Object.keys(v.manifest.redactionSummary).length === 0
      ? ["(none recorded)"]
      : Object.entries(v.manifest.redactionSummary).map(
          ([type, n]) => `- ${type}: ${n}`,
        )),
    "",
    "## Omissions (content absent from this backup, with reasons)",
    "",
    ...(v.manifest.omissions.length === 0
      ? ["(none recorded)"]
      : v.manifest.omissions.map((o) => `- ${o.entryId}: ${o.reason}`)),
    "",
    "Restoring into Pi sessions is not part of this export (deferred; architecture §13 row 20). This directory is a self-contained verified copy.",
    "",
  ];
  const summaryPath = join(dest, "export-summary.md");
  try {
    writePrivateFile(
      summaryPath,
      lines.filter((l) => l !== "").join("\n"),
      files,
    );
  } catch (err) {
    cleanupOwned(err);
  }

  return { destination: dest, files };
}
