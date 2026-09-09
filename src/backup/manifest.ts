/**
 * T14: backup manifest builder (architecture.md §7).
 *
 * The manifest is the per-session index of the backup: schema version,
 * covered source range, chunk list with content checksums, a redaction
 * summary (counts by type — never secret values), and the omission list.
 *
 * Unlike chunk files (immutable, deterministic paths), the manifest is the
 * single MUTABLE path of a backup tree: it is rewritten as capture
 * progresses. This is safe because every chunk is redacted before it is
 * serialized — the manifest itself contains only checksums, counts, entry
 * IDs and paths, never transcript content (fail-closed redaction happens at
 * the chunk edge, so an unredactable entry can never reach the manifest via
 * a chunk either).
 *
 * Completeness semantics: the manifest always describes "complete with the
 * recorded redactions and omissions" — never byte-identical fidelity
 * (decisions.md #2).
 */

import { BACKUP_SCHEMA_VERSION } from "./exporter.ts";

export interface ManifestChunk {
  seq: number;
  path: string;
  checksum: string;
  byteLength: number;
  entryIds: string[];
  /** Single entry exceeded the chunk cap (disclosed, never truncated). */
  oversized?: boolean;
}

export interface ManifestOmission {
  entryId: string;
  reason: string;
}

export interface BackupManifest {
  schemaVersion: number;
  kind: "kiwifs-backup-manifest";
  sessionId: string;
  projectId: string;
  scope: string;
  coveredRange: {
    firstEntryId: string | null;
    lastEntryId: string | null;
    /** Entries represented in this backup (chunked + omitted). */
    entryCount: number;
  };
  chunks: ManifestChunk[];
  /** Redaction counts by type — never secret values. */
  redactionSummary: Record<string, number>;
  omissions: ManifestOmission[];
  /** Always true: a redacted backup is never claimed byte-identical. */
  redacted: true;
  updatedAt: string;
}

/** Deterministic manifest serialization (written to the backend as-is). */
export function serializeBackupManifest(manifest: BackupManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Builds the manifest from the capture engine's durable chunk records.
 * `entryIds` in `coveredRange` order (chunked entries first, in capture
 * order; omitted entries are represented in `omissions`).
 */
export function buildBackupManifest(input: {
  sessionId: string;
  projectId: string;
  scope: string;
  chunks: ManifestChunk[];
  redactionSummary: Record<string, number>;
  omissions: ManifestOmission[];
  /** Ordered entry ids the backup covers (chunked ones in capture order). */
  coveredEntryIds: readonly string[];
  updatedAtMs: number;
}): BackupManifest {
  if (!Number.isFinite(input.updatedAtMs) || input.updatedAtMs < 0) {
    throw new Error("manifest updatedAt must be a finite epoch-ms value");
  }
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    kind: "kiwifs-backup-manifest",
    sessionId: input.sessionId,
    projectId: input.projectId,
    scope: input.scope,
    coveredRange: {
      firstEntryId: input.coveredEntryIds[0] ?? null,
      lastEntryId:
        input.coveredEntryIds[input.coveredEntryIds.length - 1] ?? null,
      entryCount: input.coveredEntryIds.length,
    },
    chunks: input.chunks,
    redactionSummary: input.redactionSummary,
    omissions: input.omissions,
    redacted: true,
    updatedAt: new Date(input.updatedAtMs).toISOString(),
  };
}
