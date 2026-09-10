/**
 * Q05R3: formatting helpers for the explicit manual remote board cleanup
 * command (`kiwifs-board-cleanup`; architecture.md §8 F8, §13 row 13;
 * decisions.md #14). Pure string/summary logic only — all I/O, all
 * confirmation and all orchestration live in the command handler
 * (src/index.ts), which is the ONLY caller.
 *
 * Separation from the LOCAL prune: `/kiwifs-board-gc` keeps its existing
 * local-only delivery-state prune semantics and its own `--yes` flag. This
 * command is a DISTINCT name with a DISTINCT confirmation binding: headless
 * mode never deletes on `--yes` — it requires an explicit
 * `--confirm <token>` whose token binds the EXACT candidate set of a
 * previously printed preview (content hash over the candidate tuples), so
 * an old local-prune flag can never trigger a remote delete.
 *
 * Disclosures surfaced in every summary (contract from decisions.md #14 /
 * Q05R2 executor):
 * - MCP has no compare-and-swap → an unavoidable read-delete race; no
 *   atomicity claim.
 * - Deletion is MCP-level only: no history/index/backup purge, no secure
 *   erasure, no all-consumer-ack claim (B6).
 * - Routing labels are not confidentiality (shared apikey backend).
 * - Local ack entries are pruned after 14 d; ack evidence may vanish.
 * - Bounded: preview reads (200 candidates / 500 reads), deletes (100).
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DELIVERY_SCHEMA_VERSION } from "../board/delivery.ts";
import type { CleanupPreview, CleanupPreviewItem } from "../board/cleanup.ts";
import type {
  CleanupExecution,
  CleanupExecutionRefused,
} from "../board/cleanup-execute.ts";
import { NO_CAS_DISCLOSURE } from "../board/cleanup-execute.ts";

export { NO_CAS_DISCLOSURE };

/**
 * Durable record of ONE headless preview run, written at
 * `<state>/board-cleanup-preview.json` (0600). ui.notify delivery is
 * guaranteed in TUI and RPC modes (extension_ui_request on stdout), but in
 * JSON output mode its delivery is not guaranteed — so the preview and the
 * confirmation token are ALSO persisted durably and the notice names the
 * file, making the two-step headless flow recoverable in EVERY mode.
 * Content-free: candidate ids/paths/created instants (+ backend etag when
 * the backend supplies one) and counters only — never message bodies.
 */
export interface BoardCleanupPreviewRecord {
  schemaVersion: number;
  kind: "board-cleanup-preview";
  token: string;
  ownFrom: string;
  plannedAt: string;
  /** Whether local ack evidence was readable when this preview was planned. */
  ackStateActive: boolean;
  candidates: Array<{
    msgId: string;
    path: string;
    created: string;
    etag?: string | undefined;
  }>;
  skippedCount: number;
  listingTruncated: boolean;
  readTruncated: boolean;
  disclosure: string;
}

/**
 * Persists the preview record BEFORE anything can be confirmed and returns
 * the record path (surfaced in the preview notice). Write failure is
 * non-fatal — it returns undefined so the caller can disclose the
 * degraded delivery; the notify path still carries the token in TUI,
 * RPC and print modes.
 */
export function writePreviewRecord(
  stateDir: string,
  token: string,
  preview: CleanupPreview,
  ackStateActive: boolean,
  plannedAt: Date,
): string | undefined {
  const record: BoardCleanupPreviewRecord = {
    schemaVersion: 1,
    kind: "board-cleanup-preview",
    token,
    ownFrom: preview.ownFrom,
    plannedAt: plannedAt.toISOString(),
    ackStateActive,
    candidates: preview.candidates.map((c) => ({
      msgId: c.msgId,
      path: c.path,
      created: c.created,
      ...(c.etag !== undefined ? { etag: c.etag } : {}),
    })),
    skippedCount: preview.skipped.length,
    listingTruncated: preview.listingTruncated,
    readTruncated: preview.readTruncated,
    disclosure: NO_CAS_DISCLOSURE,
  };
  try {
    const file = join(stateDir, "board-cleanup-preview.json");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    return file;
  } catch {
    return undefined;
  }
}

/**
 * READ-ONLY source of ack evidence for cleanup runs: the SAME consumer's
 * DURABLE delivery state file
 * (`<state>/board/delivery-<consumerId>.json`) is read directly, fresh per
 * call. Acks are per-consumer local state; this never invents acks from
 * anywhere else and NEVER writes or locks the file.
 * - File absent → undefined (no delivery state yet — NO ack evidence;
 *   conservative hold, disclosed as "delivery state unavailable").
 * - File corrupt/newer-schema → undefined (fail closed: NO ack evidence,
 *   so with the conjunctive §8 predicate NOTHING is eligible — a
 *   conservative hold, never a broadened delete set).
 */
export function readDurableAckState(
  boardStateDir: string,
  consumerId: string | undefined,
): Map<string, number> | undefined {
  if (consumerId === undefined) return undefined;
  const file = join(boardStateDir, `delivery-${consumerId}.json`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No durable delivery state yet: no ack evidence exists AT ALL.
      return undefined;
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const rec = parsed as {
    schemaVersion?: unknown;
    entries?: unknown;
  } | null;
  if (
    typeof rec !== "object" ||
    rec === null ||
    typeof rec.schemaVersion !== "number" ||
    rec.schemaVersion > DELIVERY_SCHEMA_VERSION ||
    typeof rec.entries !== "object" ||
    rec.entries === null
  ) {
    return undefined;
  }
  const acks = new Map<string, number>();
  for (const [msgId, entry] of Object.entries(
    rec.entries as Record<string, unknown>,
  )) {
    const ackedAt = (entry as { ackedAt?: unknown } | null)?.ackedAt;
    if (typeof ackedAt === "number" && Number.isFinite(ackedAt)) {
      acks.set(msgId, ackedAt);
    }
  }
  return acks;
}

/**
 * Q05R3 durable opId ledger for board-cleanup deletes. The executor mints
 * an interactive opId and this log persists it (append + fsync, 0o600)
 * BEFORE the `kiwi_delete` side effect — the same durable-opId-before-
 * side-effect rule as ManualOpLog (forget) and ProposalOpLog (lifecycle).
 * A corrupt log fails closed (deletes disabled), never resets history.
 */
export class BoardCleanupOpLog {
  private readonly file: string;
  private readonly known = new Set<string>();

  constructor(stateDir: string) {
    this.file = join(stateDir, "board-cleanup-oplog.jsonl");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const raw = readFileSync(this.file, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(
          "board cleanup op log is corrupt (failing closed; remote deletes disabled)",
        );
      }
      const rec = parsed as { opId?: unknown };
      if (
        typeof rec !== "object" ||
        rec === null ||
        typeof rec.opId !== "string" ||
        rec.opId === ""
      ) {
        throw new Error(
          "board cleanup op log contains a malformed entry (failing closed)",
        );
      }
      this.known.add(rec.opId);
    }
  }

  /** Durably records the opId (append + fsync) before any side effect. */
  record(opId: string): void {
    if (!/^[0-9a-f-]{16,64}$/.test(opId)) {
      throw new Error("board cleanup op log refused a malformed opId");
    }
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify({ schemaVersion: 1, opId })}\n`;
    appendFileSync(this.file, line, { mode: 0o600 });
    const fd = openSync(this.file, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.known.add(opId);
  }

  has(opId: string): boolean {
    return this.known.has(opId);
  }

  /** The OpIdLedger view handed to the delete executor/adapter. */
  ledger(): {
    record: (opId: string) => void;
    assertPersisted: (opId: string) => void;
  } {
    return {
      record: (opId: string) => {
        if (!this.has(opId)) this.record(opId);
      },
      assertPersisted: (opId: string) => {
        if (!this.has(opId)) {
          throw new Error(
            "refusing board delete: opId was not durably persisted before the side effect",
          );
        }
      },
    };
  }
}

/**
 * Deterministic confirmation token binding the EXACT candidate set: a
 * SHA-256 over the sorted `msgId|path|created[|etag]` tuples, 16 hex chars.
 * The token changes when ANY candidate changes (id, path, observed created
 * instant, or — when the backend supplies one — its content identity etag),
 * so a headless confirmation can never silently apply to a different set
 * than the one the user saw. Content-free: no bodies, no recipient labels
 * beyond what the deterministic ids already encode.
 */
export function cleanupPreviewToken(
  candidates: readonly CleanupPreviewItem[],
): string {
  const lines = candidates
    .map((c) =>
      c.etag !== undefined
        ? `${c.msgId}|${c.path}|${c.created}|${c.etag}`
        : `${c.msgId}|${c.path}|${c.created}`,
    )
    .sort();
  const h = createHash("sha256");
  for (const line of lines) h.update(`${line}\n`);
  return `bc-${h.digest("hex").slice(0, 16)}`;
}

/**
 * Bounded, body-free preview summary. msg ids are deterministic hashes
 * (SHA-256 of channel/from/opId — src/backend/ids.ts); message bodies are
 * NEVER shown and paths are shown only as a count, never itemized.
 */
export function formatCleanupPreview(
  preview: CleanupPreview,
  notes: { ackStateInactive?: boolean } = {},
): string {
  const basisTtl = preview.candidates.length;
  const basisAck = preview.candidates.length;
  const channels = new Map<string, number>();
  for (const c of preview.candidates) {
    channels.set(c.channel, (channels.get(c.channel) ?? 0) + 1);
  }
  const channelLine =
    channels.size === 0
      ? ""
      : `\nchannels: ${[...channels.entries()]
          .sort()
          .map(([ch, n]) => `${ch}=${n}`)
          .join(", ")}`;
  const trunc: string[] = [];
  if (preview.listingTruncated)
    trunc.push("board listing hit its bound — more messages may exist");
  if (preview.readTruncated)
    trunc.push("read bound hit — some listed messages were not inspected");
  const truncText = trunc.length > 0 ? `\nTRUNCATED: ${trunc.join("; ")}` : "";
  const ackNote = notes.ackStateInactive
    ? "\nNOTE: board delivery state unavailable — no local ack evidence could be read. " +
      "Eligibility requires BOTH client-TTL-expiry AND a local ack by this agent, so " +
      "NOTHING is eligible now (conservative hold; re-run once board delivery state is available)"
    : "";
  return (
    `board cleanup preview for sender "${preview.ownFrom}": ` +
    `${preview.candidates.length} candidate(s) eligible ` +
    `(${basisTtl} via TTL-expiry, ${basisAck} via local ack), ` +
    `${preview.skipped.length} skipped (visible in result detail)` +
    channelLine +
    truncText +
    ackNote +
    `\nlimits: delete is bounded (max 100/run); eligibility requires client-TTL-expiry AND a local ack by this agent; ` +
    `30-day grace after the LATER of expiry and the local ack; ` +
    `local ack entries are pruned after 14d; ineligible/changed messages are skipped, never force-deleted` +
    `\n${NO_CAS_DISCLOSURE}`
  );
}

/** Bounded, body-free execution report (no raw paths, no message content). */
export function formatCleanupExecution(
  result: CleanupExecution | CleanupExecutionRefused,
): string {
  if (!result.ok) {
    const partial =
      result.deleted.length > 0
        ? ` ${result.deleted.length} delete(s) had already completed — partial state disclosed, nothing hidden`
        : " zero deletes were performed";
    return `board cleanup REFUSED (${result.reason}): ${result.detail}${partial}`;
  }
  const skipCounts = new Map<string, number>();
  for (const s of result.skipped) {
    skipCounts.set(s.reason, (skipCounts.get(s.reason) ?? 0) + 1);
  }
  const skipText =
    result.skipped.length === 0
      ? ""
      : `\nskipped: ${[...skipCounts.entries()]
          .sort()
          .map(([r, n]) => `${r}=${n}`)
          .join(", ")}`;
  const boundText = result.deletedBoundHit
    ? "\nDELETE BOUND HIT — remaining candidates were NOT attempted (rerun to continue)"
    : "";
  const abortText = result.aborted
    ? "\nABORTED — remaining candidates were not examined (cancellation or private-mode transition)"
    : "";
  const unknownText =
    result.unknownDeleteOpIds.length > 0
      ? `\nUNKNOWN OUTCOME: ${result.unknownDeleteOpIds.length} delete(s) were issued but their remote result is unknown (opIds: ${result.unknownDeleteOpIds.join(",")}); rerun replays them safely`
      : "";
  return (
    `board cleanup: deleted ${result.deleted.length}` +
    `${result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : ""}` +
    skipText +
    boundText +
    abortText +
    unknownText +
    `\nlocal ack state was NOT modified; deleted opIds: ${result.deleted.map((d) => d.opId).join(",") || "none"}` +
    `\n${result.disclosure}`
  );
}
