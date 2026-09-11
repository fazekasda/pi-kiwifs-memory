/**
 * T15: remote backup recovery helper — reads a delivered backup tree
 * (manifest + chunk bytes) through the KiwiFS adapter's `kiwi_read` for
 * verification and export. Read-only: this module never writes.
 *
 * Detection of duplicated/extra deliveries probes one seq beyond the
 * manifest's maximum declared seq; any content found there is included in
 * the chunk map and flagged, so `verifyBackup` reports it as an
 * "unexpected-chunk" issue (never silently ignored). The probe is strictly
 * bounded: a single read at `maxSeq + 1`, gated by the same 999999 seq
 * ceiling the path helper enforces — no unbounded enumeration.
 *
 * All issue details are sanitized by construction: IDs, seqs, counts and
 * paths only — never chunk or transcript content (privacy.md §redaction).
 * The manifest's projectId/scope are verified against the requested
 * identity (T15-hardening) before verification/export trusts them.
 */

import type { KiwiFSAdapter } from "../backend/adapter.ts";
import { backupChunkPath, backupManifestPath } from "../domain/paths.ts";
import type { BackupManifest } from "./manifest.ts";
import {
  parseBackupManifestText,
  type BackupVerification,
  type VerifyIssue,
  verifyBackup,
} from "./verify.ts";

export type FetchBackupOutcome =
  | { state: "missing"; detail: string }
  | { state: "invalid"; issue: VerifyIssue }
  | {
      state: "fetched";
      manifestText: string;
      manifest: BackupManifest;
      /** Delivered chunk contents by seq (extras included, flagged). */
      chunks: Map<number, string>;
      /** Seqs found beyond the manifest's declared range (extras). */
      extraSeqs: number[];
    };

/** Largest chunk seq the path helper accepts (defensive read bound). */
const MAX_CHUNK_SEQ = 999999;

/**
 * Reads the manifest and all declared chunks (+1 probe beyond the declared
 * range) from the backend. Missing chunks are absent from the map — typed
 * detection, never guessed.
 */
export async function fetchRemoteBackup(
  adapter: KiwiFSAdapter,
  projectId: string,
  sessionId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<FetchBackupOutcome> {
  const manifestPath = backupManifestPath(projectId, sessionId);
  const manifestRes = await adapter.read(manifestPath, { signal: opts.signal });
  if (manifestRes.state === "missing") {
    return {
      state: "missing",
      detail: `no manifest at ${manifestPath} (nothing delivered for this session yet)`,
    };
  }
  if (manifestRes.state !== "ok") {
    return {
      state: "invalid",
      issue: {
        code: "manifest-invalid",
        detail: `manifest read returned state ${manifestRes.state} (unreadable)`,
      },
    };
  }
  const manifestText = manifestRes.body;
  const parsed = parseBackupManifestText(manifestText);
  if (!parsed.ok) return { state: "invalid", issue: parsed };
  const manifest = parsed.value;

  const chunks = new Map<number, string>();
  const seqs = manifest.chunks.map((c) => c.seq);
  const maxSeq = seqs.length > 0 ? Math.max(...seqs) : -1;
  for (const seq of seqs) {
    const res = await adapter.read(backupChunkPath(projectId, sessionId, seq), {
      signal: opts.signal,
    });
    if (res.state === "ok") chunks.set(seq, res.body);
  }
  const extraSeqs: number[] = [];
  const probeSeq = maxSeq + 1;
  if (maxSeq >= 0 && probeSeq <= MAX_CHUNK_SEQ) {
    const res = await adapter.read(
      backupChunkPath(projectId, sessionId, probeSeq),
      { signal: opts.signal },
    );
    if (res.state === "ok") {
      extraSeqs.push(probeSeq);
      chunks.set(probeSeq, res.body);
    }
  }
  return { state: "fetched", manifestText, manifest, chunks, extraSeqs };
}

/** Convenience: fetch + verify in one call (read-only). */
export async function verifyRemoteBackup(
  adapter: KiwiFSAdapter,
  projectId: string,
  sessionId: string,
  opts: { signal?: AbortSignal; expectedScope?: string } = {},
): Promise<
  | { state: "missing"; detail: string }
  | { state: "invalid"; issue: VerifyIssue }
  | {
      state: "verified";
      verification: BackupVerification;
      chunks: Map<number, string>;
      manifestText: string;
    }
> {
  const fetched = await fetchRemoteBackup(adapter, projectId, sessionId, opts);
  if (fetched.state !== "fetched") return fetched;
  const verification = verifyBackup({
    manifest: fetched.manifest,
    chunks: fetched.chunks,
    sessionId,
    projectId,
    ...(opts.expectedScope !== undefined ? { scope: opts.expectedScope } : {}),
  });
  return {
    state: "verified",
    verification,
    chunks: fetched.chunks,
    manifestText: fetched.manifestText,
  };
}
