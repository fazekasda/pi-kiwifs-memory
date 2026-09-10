/**
 * T16: board repository — send/read/list over verified MCP primitives only
 * (PRD T16, architecture.md §8, mcp-contracts.md §5).
 *
 * - Send: `kiwi_write` of one immutable file per message via the adapter's
 *   B2 read-before-write `writeImmutable`. Same job replay → same
 *   op-derived path → no-op; differing content at the same path fails
 *   CLOSED and is reported as quarantined (never overwritten; no CAS, no
 *   exactly-once claims).
 * - List: `kiwi_query_meta` (`channel`/`to` filters), then client-side
 *   post-filtering by strict channel containment — query results are never
 *   trusted as a scope boundary on a shared-key backend.
 * - Read: fresh `kiwi_read`, path containment check, parse + client-side
 *   TTL. Message bodies are returned as opaque data, never executed.
 *
 * Authorization disclosure (must stay visible): the backend has ONE shared
 * apikey and no per-path authorization. Channel/recipient checks here are
 * the enforceable CLIENT policy only; routing labels are not tenant
 * security. No constructor performs network I/O; every call takes an
 * AbortSignal for cancellation.
 */

import {
  CancelledError,
  ConflictError,
  OpIdNotPersistedError,
  PrivacyGateError,
} from "../backend/errors.ts";
import { isRetryable } from "../backend/errors.ts";
import type { ChangesResult, KiwiFSAdapter } from "../backend/adapter.ts";
import {
  pathWithinBoardChannel,
  validateId,
  PathEscapeError,
} from "../domain/paths.ts";
import { parseStoredRecord } from "../domain/records.ts";
import { PrivateModeActiveError } from "../privacy/private-mode.ts";
import {
  buildBoardMessage,
  isExpired,
  parseBoardMessage,
  validateBoardIdentities,
  type BoardMessageInput,
} from "./messages.ts";

/** Maximum number of paths a single list call will return (client cap). */
export const BOARD_LIST_MAX = 200;

export type SendResult =
  | {
      ok: true;
      msgId: string;
      path: string;
      /** True when read-before-write found identical content (B2 replay). */
      replayed: boolean;
    }
  | {
      ok: false;
      /** Job must be quarantined upstream; the original message is intact. */
      quarantined: true;
      reason: "content-collision";
      path: string;
    };

export type ListResult =
  | {
      ok: true;
      /** Message paths inside the requested channel, client-side filtered. */
      paths: string[];
    }
  | { ok: false; reason: "bad-request"; detail: string };

export type ReadResult =
  | {
      ok: true;
      msgId: string;
      to: string;
      from: string;
      channel: string;
      created: string;
      ttlSeconds: undefined | number;
      expired: boolean;
      /**
       * Backend content identity (`kiwi.etag` from read `_meta`) when the
       * backend supplies one — a content drift signal, NOT a CAS (never
       * used for optimistic writes).
       */
      etag?: string | undefined;
      /** Opaque message body — data only, never executed or parsed. */
      body: string;
    }
  | {
      ok: false;
      reason:
        | "missing"
        | "expired"
        | "malformed"
        | "future-version"
        | "unsupported-version"
        | "out-of-channel"
        | "bad-request"
        | "unavailable";
      detail: string;
    };

export interface BoardRepositoryOptions {
  /**
   * Privacy redactor applied to the message body BEFORE serialization and
   * any wire use (decisions.md #10: board messages are an outbound edge).
   * Returns {ok:false, reason} to fail closed.
   */
  redact?:
    | ((body: string) =>
        | { ok: true; content: string }
        | {
            ok: false;
            reason: string;
          })
    | undefined;
  /** Private-mode gate: when active, all board reads AND writes are refused. */
  privateMode?: { isPrivate: boolean } | undefined;
  now?: () => Date;
}

export class BoardRepository {
  private readonly adapter: KiwiFSAdapter;
  private readonly opts: Required<Pick<BoardRepositoryOptions, "now">> &
    BoardRepositoryOptions;

  constructor(adapter: KiwiFSAdapter, opts: BoardRepositoryOptions = {}) {
    this.adapter = adapter;
    this.opts = { now: opts.now ?? (() => new Date()), ...opts };
  }

  /**
   * Raw `kiwi_changes` feed for cursor consumers (T17 delivery). A typed
   * narrow seam instead of reaching into the private adapter field. Contains
   * NO channel containment (that is the read path's job) — the delivery
   * layer filters board paths itself and never executes change payloads.
   */
  changes(
    since: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChangesResult> {
    // Q02 chunk 3: the raw kiwi_changes feed was the ONE repository op that
    // bypassed the per-operation private gate (send/list/read all assert).
    // A transition mid-delivery-cycle could therefore keep paging the feed
    // until the next boundary check. Failing closed here aborts the active
    // cycle at the very next feed call (best-effort abort; the cursor stays
    // untouched, so the segment replays on resume — no drops, no duplicates).
    this.assertNotPrivate();
    return this.adapter.changes(since, opts);
  }

  /**
   * Sends one immutable message. The caller must already have persisted
   * `opId` durably (outbox enqueue); the adapter enforces this and fails
   * closed otherwise. Never deletes anything and never retries a send
   * beyond the adapter's idempotency policy.
   */
  async send(
    input: BoardMessageInput,
    opId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SendResult> {
    this.assertNotPrivate();
    validateBoardIdentities(input.channel, input.from, input.to);
    let body = input.body;
    if (this.opts.redact) {
      const r = this.opts.redact(body);
      if (!r.ok) {
        // Fail closed before anything leaves the process.
        throw new PrivacyGateError(
          `board message body refused by privacy gate: ${r.reason}`,
        );
      }
      body = r.content;
    }
    const built = buildBoardMessage({ ...input, body }, opId, this.opts.now());
    try {
      const res = await this.adapter.writeImmutable(built.path, built.content, {
        opId,
        signal: opts.signal,
      });
      return {
        ok: true,
        msgId: built.msgId,
        path: built.path,
        replayed: res.replayed,
      };
    } catch (err) {
      if (err instanceof ConflictError) {
        // Differing content at the deterministic path: fail closed, leave the
        // original message intact; the outbox quarantines the job (visible).
        return {
          ok: false,
          quarantined: true,
          reason: "content-collision",
          path: built.path,
        };
      }
      if (err instanceof OpIdNotPersistedError) throw err;
      throw err;
    }
  }

  /**
   * Lists message paths in a channel via `kiwi_query_meta`, post-filtered by
   * strict `board/{channel}/` containment (query results are advisory on a
   * shared-key backend, so the client re-checks every path).
   *
   * Because the containment post-filter may drop paths the server returned,
   * a single page can UNDERFILL the requested limit while more matching
   * paths exist. This method therefore keeps fetching subsequent pages
   * (bounded by `maxPages`) until the limit is filled or a page yields no
   * new matching paths. It never assumes more than the observed evidence.
   *
   * Ordering: the server-side `sort` parameter is NOT relied upon (its
   * behavior has not been verified against the live backend); callers must
   * not depend on the order of the returned paths.
   */
  async list(
    channel: string,
    opts: {
      /** Recipient routing filter (a label, not access control). */
      to?: string;
      limit?: number;
      offset?: number;
      /** Page-fetch bound for containment-underfill recovery. */
      maxPages?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ListResult> {
    this.assertNotPrivate();
    try {
      validateId("channel", channel);
      if (opts.to !== undefined) validateId("to", opts.to);
    } catch (err) {
      return {
        ok: false,
        reason: "bad-request",
        detail: (err as PathEscapeError).message,
      };
    }
    const filters: Record<string, string> = { channel };
    if (opts.to !== undefined) filters["to"] = opts.to;
    const limit =
      opts.limit !== undefined
        ? Math.min(Math.max(1, opts.limit), BOARD_LIST_MAX)
        : BOARD_LIST_MAX;
    const maxPages = opts.maxPages ?? 10;
    const seen = new Set<string>();
    let offset = opts.offset ?? 0;
    let exhausted = false;
    for (let page = 0; page < maxPages && !exhausted; page++) {
      const res = await this.adapter.queryMeta(filters, {
        ...(offset !== 0 ? { offset } : {}),
        limit,
        signal: opts.signal,
      });
      let rawCount = 0;
      let newKept = 0;
      for (const line of res.text.split("\n")) {
        const m = /^path:\s*(\S+)/.exec(line);
        if (!m) continue;
        rawCount++;
        const p = m[1] as string;
        if (!pathWithinBoardChannel(p, channel)) continue;
        if (seen.has(p)) continue;
        seen.add(p);
        newKept++;
      }
      // Fill the limit by paging past containment-filter drops. A page with
      // no newly kept paths means the listing is exhausted (also guards
      // against backends that ignore `offset` — the loop is bounded anyway).
      if (seen.size >= limit || rawCount === 0 || newKept === 0) {
        exhausted = true;
      } else {
        offset += limit;
      }
    }
    return { ok: true, paths: [...seen].slice(0, limit) };
  }

  /**
   * Cross-channel board-message discovery via `kiwi_query_meta` (T19).
   *
   * Fallback discovery primitive for the changes-feed failure mode observed
   * live (persistent server-side IsError HTTP 500 whenever the feed has
   * entries — tasks/evidence/t19-live-report.json): the board's ONLY inbound
   * discovery was the feed, so a broken feed silently killed delivery.
   *
   * Contract basis (mcp-contracts.md §3/§5, MCP-only — no REST fallback):
   * `kiwi_query_meta` takes exact frontmatter filters `$.field=value` with
   * limit/offset pagination. Every message THIS extension delivers must
   * parse as a `type: board-message` record (the read path rejects anything
   * else as malformed), so filtering on `type` selects exactly the
   * deliverable message set. Paths are still re-checked against the strict
   * board-path shape — query results are never trusted as a boundary.
   *
   * Bounded: pages of ≤BOARD_LIST_MAX paths, at most `maxPages` pages, at
   * most `maxPaths` kept; a page with no newly kept paths ends paging (also
   * guards against offset-ignoring backends). `truncated: true` discloses a
   * bound stop — callers surface it, never hide it. Adapter errors propagate
   * (availability vs domain classification stays at the caller); private
   * mode refuses before any network read.
   */
  async listAllBoardMessagePaths(
    opts: {
      maxPaths?: number;
      maxPages?: number;
      /** Paths already handled upstream (delivery dedupe) — never counted
       * against the bound, so a bounded cycle cannot starve the backlog on a
       * stable listing order. */
      exclude?: ReadonlySet<string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ ok: true; paths: string[]; truncated: boolean }> {
    this.assertNotPrivate();
    const limit = BOARD_LIST_MAX;
    const maxPages = opts.maxPages ?? 20;
    const maxPaths = Math.max(1, opts.maxPaths ?? 1000);
    const exclude = opts.exclude;
    const seen = new Set<string>();
    let offset = 0;
    let truncated = false;
    let lastPageRawCount = 0;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.adapter.queryMeta(
        { type: "board-message" },
        { ...(offset !== 0 ? { offset } : {}), limit, signal: opts.signal },
      );
      let rawCount = 0;
      for (const line of res.text.split("\n")) {
        const m = /^path:\s*(\S+)/.exec(line);
        if (!m) continue;
        rawCount++;
        const p = m[1] as string;
        // Strict board-path shape (same predicate the delivery read applies).
        if (boardChannelOfPath(p) === undefined) continue;
        if (boardMsgIdOfPath(p) === undefined) continue;
        if (exclude?.has(p)) continue; // handled upstream — never re-listed
        if (seen.has(p)) continue;
        if (seen.size >= maxPaths) {
          truncated = true;
          break;
        }
        seen.add(p);
      }
      // Empty page = exhausted listing. A page of only already-handled rows
      // does NOT stop paging (that would starve the backlog behind a stable
      // listing order); the page bound and the offset-ignoring case are
      // covered by maxPages and the truncated disclosure instead.
      if (rawCount === 0 || truncated) {
        lastPageRawCount = rawCount;
        break;
      }
      lastPageRawCount = rawCount;
      offset += limit;
    }
    // A stop at the page bound with rows still arriving on the last page can
    // mean an exhausted listing OR an offset-ignoring backend — not knowable
    // from the observed evidence, so disclose truncation (never a silent
    // false-complete).
    if (truncated || lastPageRawCount > 0) truncated = true;
    return { ok: true, paths: [...seen], truncated };
  }

  /**
   * Reads one message fresh from the backend (no trust in cached listings):
   * containment check → parse → client-side TTL. Expired messages are a
   * visible typed result, never silently dropped by the backend (B5: no
   * server-side TTL exists).
   */
  async read(
    path: string,
    opts: { signal?: AbortSignal; includeExpired?: boolean } = {},
  ): Promise<ReadResult> {
    this.assertNotPrivate();
    const channel = boardChannelOfPath(path);
    if (channel === undefined) {
      return {
        ok: false,
        reason: "bad-request",
        detail: `path is not inside board/{channel}/: ${safePathPreview(path)}`,
      };
    }
    let raw;
    try {
      raw = await this.adapter.read(path, { signal: opts.signal });
    } catch (err) {
      // Distinguish transient availability from a genuinely absent message:
      // mapping a backend outage to "missing" would mask that the message
      // may still exist and must be retried later (T16 follow-up).
      if (isRetryable(err)) {
        return {
          ok: false,
          reason: "unavailable",
          detail: "backend availability fault; message state unknown",
        };
      }
      if (err instanceof CancelledError) throw err;
      return { ok: false, reason: "missing", detail: "backend read failed" };
    }
    if (raw.state === "missing") {
      return { ok: false, reason: "missing", detail: "message not found" };
    }
    if (raw.state !== "ok" || raw.content === undefined) {
      return {
        ok: false,
        reason: "missing",
        detail: "unreadable backend state",
      };
    }
    const parsed = parseBoardMessage(raw.content, this.opts.now());
    if (!parsed.ok) {
      return {
        ok: false,
        reason: parsed.reason,
        detail: parsed.detail,
      };
    }
    const fm = parsed.message.frontmatter;
    const ttlSeconds =
      fm.ttl !== undefined && fm.ttl !== "" ? Number(fm.ttl) : undefined;
    const expired = isExpired(fm.created, ttlSeconds, this.opts.now());
    if (expired && !opts.includeExpired) {
      return {
        ok: false,
        reason: "expired",
        detail: `message expired client-side (created ${fm.created}, ttl ${fm.ttl}s)`,
      };
    }
    return {
      ok: true,
      msgId: fm.id,
      to: fm.to ?? "",
      from: fm.from ?? "",
      channel: fm.channel ?? "",
      created: fm.created,
      ttlSeconds:
        ttlSeconds !== undefined && Number.isFinite(ttlSeconds)
          ? ttlSeconds
          : undefined,
      expired,
      ...(raw.etag !== undefined ? { etag: raw.etag } : {}),
      // Opaque data. Never executed, never parsed as commands (decisions.md
      // #4): the only thing downstream code may do with `body` is show it.
      body: parsed.message.body,
    };
  }

  private assertNotPrivate(): void {
    if (this.opts.privateMode?.isPrivate) {
      throw new PrivateModeActiveError("board");
    }
  }
}

/** Extracts the channel from a board path, or undefined when not contained. */
export function boardChannelOfPath(path: string): string | undefined {
  const m = /^board\/([a-z0-9][a-z0-9-]{0,63})\//.exec(path);
  if (!m) return undefined;
  try {
    const channel = m[1] as string;
    return pathWithinBoardChannel(path, channel) ? channel : undefined;
  } catch {
    return undefined;
  }
}

/**
 * msg_id is the hex file name stem of a board path (board/{channel}/{id}.md).
 * Exported so the delivery layer and the fallback discovery share ONE strict
 * path predicate (never a looser local re-implementation).
 */
export function boardMsgIdOfPath(path: string): string | undefined {
  const m = /^board\/[a-z0-9][a-z0-9-]{0,63}\/([0-9a-f]{16,64})\.md$/.exec(
    path,
  );
  return m?.[1];
}

/** Kept local: path previews must never carry body content into errors. */
function safePathPreview(path: string): string {
  return JSON.stringify(path.length > 80 ? `${path.slice(0, 80)}…` : path);
}
