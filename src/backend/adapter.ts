/**
 * T04: the single typed KiwiFS backend boundary (PRD T04, architecture.md §4).
 *
 * - MCP-only (decisions.md #1); no REST fallback exists or is substituted.
 * - Capability discovery at connect time via `tools/list` (authoritative —
 *   the live endpoint advertises 71 tools vs 61 source-enumerated patterns;
 *   no count is hard-coded, only the required-tool set is gated).
 * - Limits enforced client-side before the wire: search limit clamp 50,
 *   32 MiB content, 500-char path (mcp-contracts.md §3, §9 fixture 8).
 * - B2 idempotency: deterministic paths + read-before-write; identical
 *   content replays as no-op, differing content fails closed (no CAS, no
 *   exactly-once, no optimistic concurrency).
 * - Hybrid degradation is detected from per-result rank attribution
 *   (`keyword only`), never from status codes.
 * - No constructor/factory performs network I/O; connect() does.
 */

import {
  AuthError,
  ConflictError,
  isRetryable,
  ValidationError,
} from "./errors.ts";
import type { OpIdLedger } from "./opid.ts";
import {
  hybridIsDegraded,
  parseBriefPack,
  parseChanges,
  parseDeletedPath,
  parseFrontmatter,
  parseHybridHits,
  parseMutationEtag,
  parseScoredHits,
  type HybridHit,
  type ScoredHit,
} from "./parse.ts";
import { McpHttpTransport } from "./transport.ts";

/** Tools the extension requires; capability-driven, never a count. */
export const REQUIRED_TOOLS = [
  "kiwi_read",
  "kiwi_write",
  "kiwi_append",
  "kiwi_delete",
  "kiwi_search",
  "kiwi_search_semantic",
  "kiwi_search_hybrid",
  "kiwi_brief",
  "kiwi_changes",
  "kiwi_query_meta",
  "kiwi_forget",
] as const;

export const SEARCH_LIMIT_MAX = 50;
export const CONTENT_MAX_BYTES = 32 * 1024 * 1024;
export const PATH_MAX_CHARS = 500;

export interface AdapterOptions {
  url: string;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  /** Op-id ledger; mutations refuse to run without a persisted opId. */
  ledger: OpIdLedger;
  fetchImpl?: typeof fetch;
}

export interface Capabilities {
  tools: string[];
  serverName?: string;
}

export interface ReadResult {
  state: "ok" | "not_modified" | "missing";
  content?: string;
  etag?: string;
  frontmatter: Record<string, string>;
  body: string;
}

export interface WriteResult {
  etag?: string;
  /** True when the deterministic-path write replayed as a no-op. */
  replayed: boolean;
}

export interface SearchOptions {
  scope?: string;
  pathPrefix?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal | undefined;
}

export interface ChangesResult {
  changes: ReturnType<typeof parseChanges>["changes"];
  lastSeq?: string;
}

export class KiwiFSAdapter {
  private readonly transport: McpHttpTransport;
  private readonly ledger: OpIdLedger;
  private capabilities?: Capabilities;

  constructor(opts: AdapterOptions) {
    // No network I/O here — connect() is the only I/O entry point.
    this.transport = new McpHttpTransport(opts);
    this.ledger = opts.ledger;
  }

  get connectedCapabilities(): Capabilities | undefined {
    return this.capabilities;
  }

  get transportForReconnect(): McpHttpTransport {
    return this.transport;
  }

  /** Initialize + capability discovery; aborts when a required tool is absent. */
  async connect(signal?: AbortSignal): Promise<Capabilities> {
    await this.transport.initialize(signal);
    const tools = await this.transport.listTools(signal);
    const names = tools.map((t) => t.name);
    const missing = REQUIRED_TOOLS.filter((r) => !names.includes(r));
    if (missing.length > 0) {
      throw new ValidationError(
        `backend is missing required tools: ${missing.join(", ")}`,
      );
    }
    this.capabilities = { tools: names };
    return this.capabilities;
  }

  async read(
    path: string,
    opts: {
      ifNotEtag?: string | undefined;
      signal?: AbortSignal | undefined;
    } = {},
  ): Promise<ReadResult> {
    assertValidPath(path);
    const args: Record<string, unknown> = { path };
    if (opts.ifNotEtag !== undefined) args["if_not_etag"] = opts.ifNotEtag;
    let res: { isError: boolean; text: string; meta: Record<string, unknown> };
    try {
      res = await this.call("kiwi_read", args, opts.signal);
    } catch (err) {
      // A missing path is a typed READ outcome (read-back is control flow for
      // B2 idempotency and guard step 1); other domain errors still throw.
      if (err instanceof ValidationError && /not found/i.test(err.message)) {
        return { state: "missing", frontmatter: {}, body: "" };
      }
      throw err;
    }
    const metaEtag =
      typeof res.meta["kiwi.etag"] === "string"
        ? (res.meta["kiwi.etag"] as string)
        : undefined;
    if (res.meta["kiwi.not_modified"] === true) {
      // Live evidence (T04 probe): _meta is empty on reads; the not-modified
      // text carries the ETag. Parse it as the fallback carrier.
      const etag =
        metaEtag !== undefined ? metaEtag : parseMutationEtag(res.text);
      return {
        state: "not_modified",
        ...(etag !== undefined ? { etag } : {}),
        frontmatter: {},
        body: "",
      };
    }
    const { frontmatter, body } = parseFrontmatter(res.text);
    return {
      state: "ok",
      content: res.text,
      ...(metaEtag !== undefined ? { etag: metaEtag } : {}),
      frontmatter,
      body,
    };
  }

  /**
   * Plain write (mutable paths such as test artifacts or updates). Enforces
   * op-id persistence and limits; replay idempotency for immutable records
   * goes through writeImmutable.
   */
  async write(
    path: string,
    content: string,
    opts: {
      actor?: string;
      provenance?: string;
      opId: string;
      signal?: AbortSignal | undefined;
    },
  ): Promise<WriteResult> {
    assertValidPath(path);
    assertContentSize(content);
    this.ledger.assertPersisted(opts.opId);
    const args: Record<string, unknown> = { path, content, opId: opts.opId };
    if (opts.actor !== undefined) args["actor"] = opts.actor;
    if (opts.provenance !== undefined) args["provenance"] = opts.provenance;
    const res = await this.call("kiwi_write", args, opts.signal);
    const etag =
      typeof res.meta["kiwi.etag"] === "string"
        ? (res.meta["kiwi.etag"] as string)
        : parseMutationEtag(res.text);
    return { ...(etag !== undefined ? { etag } : {}), replayed: false };
  }

  /**
   * Immutable-record write with B2 read-before-write idempotency:
   * absent → write; identical content → no-op replay; different content →
   * fail closed (job must be quarantined upstream, never overwrite).
   */
  async writeImmutable(
    path: string,
    content: string,
    opts: {
      actor?: string;
      provenance?: string;
      opId: string;
      signal?: AbortSignal | undefined;
    },
  ): Promise<WriteResult> {
    assertValidPath(path);
    assertContentSize(content);
    this.ledger.assertPersisted(opts.opId);
    const existing = await this.read(path, { signal: opts.signal });
    if (existing.state === "ok" && existing.content !== undefined) {
      if (existing.content === content) {
        return {
          ...(existing.etag !== undefined ? { etag: existing.etag } : {}),
          replayed: true,
        };
      }
      throw new ConflictError(
        `deterministic path already exists with different content; refusing to overwrite (fail closed)`,
        "kiwi_write",
      );
    }
    if (existing.state === "not_modified") {
      // if_not_etag was never set here; treat as present-unknown-content.
      throw new ConflictError(
        `deterministic path exists with unreadable state; refusing to overwrite (fail closed)`,
        "kiwi_write",
      );
    }
    return this.write(path, content, opts);
  }

  async append(
    path: string,
    content: string,
    opts: {
      separator?: string;
      actor?: string;
      opId: string;
      signal?: AbortSignal;
    },
  ): Promise<WriteResult> {
    assertValidPath(path);
    assertContentSize(content);
    this.ledger.assertPersisted(opts.opId);
    const args: Record<string, unknown> = { path, content, opId: opts.opId };
    if (opts.separator !== undefined) args["separator"] = opts.separator;
    if (opts.actor !== undefined) args["actor"] = opts.actor;
    const res = await this.call("kiwi_append", args, opts.signal);
    const etag =
      typeof res.meta["kiwi.etag"] === "string"
        ? (res.meta["kiwi.etag"] as string)
        : parseMutationEtag(res.text);
    return { ...(etag !== undefined ? { etag } : {}), replayed: false };
  }

  async del(
    path: string,
    opts: { actor?: string; opId: string; signal?: AbortSignal },
  ): Promise<{ path: string }> {
    assertValidPath(path);
    this.ledger.assertPersisted(opts.opId);
    const args: Record<string, unknown> = { path, opId: opts.opId };
    if (opts.actor !== undefined) args["actor"] = opts.actor;
    const res = await this.call("kiwi_delete", args, opts.signal);
    return { path: parseDeletedPath(res.text) ?? path };
  }

  /** FTS search (SQL-side scope filter server-side; limit clamped to 50). */
  async searchFts(
    query: string,
    opts: SearchOptions = {},
  ): Promise<{ hits: ScoredHit[]; text: string }> {
    const args = searchArgs(query, opts);
    const res = await this.call("kiwi_search", args, opts.signal);
    return { hits: parseScoredHits(res.text), text: res.text };
  }

  /** Semantic search (server-side scope param; post-candidate — B4). */
  async searchSemantic(
    query: string,
    opts: SearchOptions & { threshold?: number } = {},
  ): Promise<{ hits: ScoredHit[]; text: string }> {
    const args = searchArgs(query, opts);
    if (opts.threshold !== undefined) args["threshold"] = opts.threshold;
    const res = await this.call("kiwi_search_semantic", args, opts.signal);
    return { hits: parseScoredHits(res.text), text: res.text };
  }

  /**
   * Hybrid search. No scope parameter exists — the caller MUST post-filter
   * via the guard pipeline. Degradation comes from rank attribution only.
   */
  async searchHybrid(
    query: string,
    opts: SearchOptions = {},
  ): Promise<{ hits: HybridHit[]; degraded: boolean; text: string }> {
    const args = searchArgs(query, opts);
    const res = await this.call("kiwi_search_hybrid", args, opts.signal);
    const hits = parseHybridHits(res.text);
    return { hits, degraded: hybridIsDegraded(hits), text: res.text };
  }

  /**
   * Brief pack. `budget_tokens` is advisory; brief has NO scope parameter so
   * every returned page must pass the guard pipeline before use.
   */
  async brief(
    query: string,
    opts: {
      budgetTokens?: number;
      maxPages?: number;
      pathPrefix?: string;
      signal?: AbortSignal | undefined;
    } = {},
  ): Promise<{
    sections: { path: string; body: string }[];
    dropped: { path: string }[];
    text: string;
  }> {
    const args: Record<string, unknown> = { query };
    if (opts.budgetTokens !== undefined)
      args["budget_tokens"] = opts.budgetTokens;
    if (opts.maxPages !== undefined) args["max_pages"] = opts.maxPages;
    if (opts.pathPrefix !== undefined) args["path_prefix"] = opts.pathPrefix;
    const res = await this.call("kiwi_brief", args, opts.signal);
    const parsed = parseBriefPack(res.text);
    return { ...parsed, text: res.text };
  }

  /**
   * Changes feed replay: `since` is an exclusive commit-hash cursor. Asking
   * again with the same cursor is idempotent server-side (fixture 7).
   */
  async changes(
    since: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChangesResult> {
    const args: Record<string, unknown> = { since };
    if (opts.limit !== undefined) {
      args["limit"] = Math.min(Math.max(1, opts.limit), 500);
    }
    const res = await this.call("kiwi_changes", args, opts.signal);
    return parseChanges(res.text);
  }

  /** Frontmatter meta query (board listing primitive). */
  async queryMeta(
    filters: Record<string, string>,
    opts: {
      sort?: string;
      limit?: number;
      offset?: number;
      signal?: AbortSignal | undefined;
    } = {},
  ): Promise<{ text: string }> {
    const args: Record<string, unknown> = { filters };
    if (opts.sort !== undefined) args["sort"] = opts.sort;
    if (opts.limit !== undefined) args["limit"] = opts.limit;
    if (opts.offset !== undefined) args["offset"] = opts.offset;
    const res = await this.call("kiwi_query_meta", args, opts.signal);
    return { text: res.text };
  }

  /** Reversible logical forget (frontmatter rewrite; body preserved). */
  async forget(
    path: string,
    opts: { reason?: string; opId: string; signal?: AbortSignal },
  ): Promise<{ path: string }> {
    assertValidPath(path);
    this.ledger.assertPersisted(opts.opId);
    const args: Record<string, unknown> = { path, opId: opts.opId };
    if (opts.reason !== undefined) args["superseded_reason"] = opts.reason;
    await this.call("kiwi_forget", args, opts.signal);
    return { path };
  }

  /**
   * Tools that may be retried once on a transient availability fault.
   * `kiwi_append` is deliberately EXCLUDED: it is non-idempotent
   * (mcp-contracts.md — "idempotencyHint false — replays duplicate by
   * design"), so a transport fault after the server committed the append
   * must surface as an error, never be silently replayed.
   */
  private static readonly IDEMPOTENT_TOOLS = new Set([
    "kiwi_read",
    "kiwi_write",
    "kiwi_delete",
    "kiwi_search",
    "kiwi_search_semantic",
    "kiwi_search_hybrid",
    "kiwi_brief",
    "kiwi_changes",
    "kiwi_query_meta",
    "kiwi_forget",
  ]);

  /**
   * Tool invocation with the shared error policy: domain `isError` results
   * become typed ValidationError (never retried as transient); only
   * availability faults on IDEMPOTENT tools are retried, at most once.
   * Authorization failures propagate immediately (AuthError is not
   * retryable). Non-idempotent calls (kiwi_append) are never retried.
   */
  private async call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    isError: boolean;
    text: string;
    meta: Record<string, unknown>;
  }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.transport.callTool(tool, args, signal);
        if (res.isError) {
          throw new ValidationError(
            `backend rejected ${tool}: ${sanitizeMessage(res.text)}`,
            tool,
          );
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (
          !isRetryable(err) ||
          !KiwiFSAdapter.IDEMPOTENT_TOOLS.has(tool) ||
          signal?.aborted
        ) {
          throw err;
        }
      }
    }
    throw lastErr;
  }
}

function searchArgs(
  query: string,
  opts: SearchOptions,
): Record<string, unknown> {
  const args: Record<string, unknown> = { query };
  if (opts.scope !== undefined) args["scope"] = opts.scope;
  if (opts.pathPrefix !== undefined) args["path_prefix"] = opts.pathPrefix;
  if (opts.limit !== undefined) {
    // Server clamps to 50 (mcpserver.go:136-149); clamp client-side too.
    args["limit"] = Math.min(Math.max(1, opts.limit), SEARCH_LIMIT_MAX);
  }
  if (opts.offset !== undefined) args["offset"] = Math.max(0, opts.offset);
  return args;
}

function assertValidPath(path: string): void {
  if (path.length > PATH_MAX_CHARS) {
    throw new ValidationError(
      `path exceeds ${PATH_MAX_CHARS} characters (server limit)`,
    );
  }
}

function assertContentSize(content: string): void {
  if (Buffer.byteLength(content, "utf8") > CONTENT_MAX_BYTES) {
    throw new ValidationError(
      `content exceeds ${CONTENT_MAX_BYTES} bytes (32 MiB server limit)`,
    );
  }
}

/** Strip anything credential-shaped from messages destined for logs/status. */
function sanitizeMessage(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9._~+/=-]{32,}/g, "[redacted]");
}

// Re-export so feature code can catch the hard setup error without reaching
// into the errors module shape.
export { AuthError };
