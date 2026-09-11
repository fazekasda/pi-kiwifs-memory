/**
 * T14: backup chunker (architecture.md §7, §13 row 11).
 *
 * - Chunks are ≤64 KiB text (bytes of the serialized chunk) by default; a
 *   single entry larger than the cap forms its own `oversized` chunk rather
 *   than being dropped or truncated.
 * - Chunk boundaries are decided by the capture engine's durable coverage
 *   cursor (the uncovered entry set at capture time), never by which
 *   lifecycle event fired — re-derivation after a crash reproduces the same
 *   boundaries, the same `seq` and byte-identical content (no `opId`, no
 *   wall-clock value inside chunk content), so a replay of an already
 *   delivered chunk is a read-before-write no-op (B2, deterministic paths).
 * - Chunk content is JSON (schemaVersion, sessionId, seq, entries). The
 *   checksum is content-addressed (SHA-256) and verified by T15 tooling; it
 *   is never treated as branch identity.
 */

import { createHash } from "node:crypto";
import { BACKUP_SCHEMA_VERSION, type BackupView } from "./exporter.ts";

export const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024;

/** Serializable backup entry (post-redaction text only — never raw). */
export type BackupEntry = BackupView;

export interface ChunkDraft {
  seq: number;
  /** Exact serialized chunk content (deterministic for a given entry set). */
  content: string;
  byteLength: number;
  checksum: string;
  entryIds: string[];
  /** True when a single entry exceeded the cap (disclosed in the manifest). */
  oversized: boolean;
}

/**
 * Serializes one chunk deterministically. No timestamps, no opId, no
 * wall-clock values: the same entry set under the same seq always yields
 * byte-identical content (crash-replay determinism).
 */
export function serializeChunk(input: {
  sessionId: string;
  seq: number;
  entries: BackupEntry[];
}): string {
  return `${JSON.stringify(
    {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: "kiwifs-backup-chunk",
      sessionId: input.sessionId,
      seq: input.seq,
      entries: input.entries,
    },
    null,
    2,
  )}\n`;
}

/** Content-addressed checksum (SHA-256 hex) of the exact chunk bytes. */
export function chunkChecksum(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Splits the ordered entry list into chunks under `maxChunkBytes`. Entry
 * order is preserved; boundaries derive purely from the input list and the
 * starting seq, so the same uncovered range always chunks identically.
 */
export function chunkEntries(
  sessionId: string,
  entries: readonly BackupEntry[],
  options: { seqStart: number; maxChunkBytes?: number },
): ChunkDraft[] {
  const maxBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 256) {
    throw new Error(`invalid maxChunkBytes: ${maxBytes}`);
  }
  const drafts: ChunkDraft[] = [];
  let pending: BackupEntry[] = [];
  let seq = options.seqStart;

  const flush = (oversized: boolean): void => {
    if (pending.length === 0) return;
    const content = serializeChunk({ sessionId, seq, entries: pending });
    drafts.push({
      seq,
      content,
      byteLength: Buffer.byteLength(content, "utf8"),
      checksum: chunkChecksum(content),
      entryIds: pending.map((e) => e.id),
      oversized,
    });
    seq += 1;
    pending = [];
  };

  for (const entry of entries) {
    pending.push(entry);
    const content = serializeChunk({ sessionId, seq, entries: pending });
    const size = Buffer.byteLength(content, "utf8");
    if (size > maxBytes) {
      if (pending.length === 1) {
        // Single oversized entry: own chunk, flagged — never truncated,
        // never dropped.
        flush(true);
      } else {
        // Pop the overflowing entry and close the current chunk.
        const carried = pending.pop() as BackupEntry;
        flush(false);
        pending.push(carried);
        const single = serializeChunk({ sessionId, seq, entries: pending });
        flush(Buffer.byteLength(single, "utf8") > maxBytes);
      }
    }
  }
  flush(false);
  return drafts;
}
