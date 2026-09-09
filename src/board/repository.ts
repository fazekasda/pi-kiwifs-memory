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
  ConflictError,
  OpIdNotPersistedError,
  PrivacyGateError,
} from "../backend/errors.ts";
import type { KiwiFSAdapter } from "../backend/adapter.ts";
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
        | "bad-request";
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
   */
  async list(
    channel: string,
    opts: {
      /** Recipient routing filter (a label, not access control). */
      to?: string;
      limit?: number;
      offset?: number;
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
    const res = await this.adapter.queryMeta(filters, {
      ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      limit,
      signal: opts.signal,
    });
    const paths: string[] = [];
    for (const line of res.text.split("\n")) {
      const m = /^path:\s*(\S+)/.exec(line);
      if (!m) continue;
      const p = m[1] as string;
      if (pathWithinBoardChannel(p, channel)) paths.push(p);
    }
    return { ok: true, paths };
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
    } catch {
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

/** Kept local: path previews must never carry body content into errors. */
function safePathPreview(path: string): string {
  return JSON.stringify(path.length > 80 ? `${path.slice(0, 80)}…` : path);
}
