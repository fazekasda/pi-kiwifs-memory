/**
 * T04: MCP Streamable HTTP transport (mcp-contracts.md §2, architecture.md §4).
 *
 * - Stateless sessions: initialize per logical connection; session ids are
 *   echoed if the server returns one but never required (WithStateLess).
 * - Redirects are rejected before being followed — credentials must never
 *   reach a redirected origin (fetch `redirect: "error"` plus a defensive
 *   3xx status check).
 * - Responses are bounded: bodies larger than the configured cap produce a
 *   typed safe failure and are never parsed into memory beyond the bound.
 * - Cancellation: the caller's AbortSignal plus a per-request timeout are
 *   combined into one abort signal that propagates to the server request.
 * - Only transport-level faults are retryable; authorization failures are a
 *   hard setup error and are never retried (PRD T04).
 */

import {
  AuthError,
  AvailabilityError,
  CancelledError,
  ResponseFormatError,
  TimeoutError,
} from "./errors.ts";

export interface TransportOptions {
  url: string;
  /** Headers for every request (e.g. Authorization). Never logged or echoed. */
  headers?: Record<string, string>;
  /** Per-request timeout in ms (runner default 10_000). */
  requestTimeoutMs?: number;
  /** Maximum accepted response body size in bytes (default 48 MiB). */
  maxResponseBytes?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
let nextRequestId = 1;

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolCallResult {
  isError: boolean;
  text: string;
  meta: Record<string, unknown>;
}

export class McpHttpTransport {
  private readonly opts: Required<
    Pick<TransportOptions, "requestTimeoutMs" | "maxResponseBytes">
  > &
    TransportOptions;
  private initialized = false;
  private sessionId?: string;
  /** Injectable clock for tests. */
  now: () => number = () => Date.now();

  constructor(opts: TransportOptions) {
    this.opts = {
      requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      ...opts,
    };
  }

  /** True once initialize has succeeded for the current logical connection. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Performs the stateless initialize handshake. Safe to call again to
   * re-initialize a new logical connection (the server keeps no session).
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    const result = (await this.request(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "pi-kiwifs-memory", version: "0.1.0" },
      },
      signal,
    )) as Record<string, unknown> | undefined;
    const info = result?.["serverInfo"] as
      { name?: string; version?: string } | undefined;
    this.initialized = true;
    void info;
  }

  async listTools(
    signal?: AbortSignal,
  ): Promise<{ name: string; inputSchema?: unknown }[]> {
    if (!this.initialized) await this.initialize(signal);
    const result = (await this.request("tools/list", {}, signal)) as {
      tools?: { name: string; inputSchema?: unknown }[];
    };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /**
   * Calls a tool. Domain failures (`isError: true` inside a JSON-RPC success)
   * are returned as `isError` results, NOT thrown — the adapter maps them to
   * typed errors per operation. Only transport/protocol faults throw.
   */
  async callTool(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolCallResult> {
    if (!this.initialized) await this.initialize(signal);
    const result = (await this.request(
      "tools/call",
      {
        name: tool,
        arguments: args,
      },
      signal,
    )) as Record<string, unknown> | undefined;
    const isError = result?.["isError"] === true;
    const content = result?.["content"];
    const text = Array.isArray(content)
      ? content
          .filter(
            (c): c is { type: string; text: string } =>
              typeof c === "object" &&
              c !== null &&
              (c as { type?: unknown }).type === "text",
          )
          .map((c) => c.text)
          .join("\n")
      : "";
    const metaRaw = result?.["_meta"];
    const meta: Record<string, unknown> =
      typeof metaRaw === "object" && metaRaw !== null
        ? (metaRaw as Record<string, unknown>)
        : {};
    return { isError, text, meta };
  }

  /** One JSON-RPC request/response cycle over Streamable HTTP POST. */
  private async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const tool = method === "tools/call" ? String(params["name"]) : method;
    const id = nextRequestId++;
    const controller = new AbortController();
    const timeout = this.opts.requestTimeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new CancelledError("caller aborted request", tool);
      }
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    // The per-request deadline arms the ENTIRE request lifecycle — headers
    // AND streamed body read — so a server that stalls mid-body cannot hang
    // the call beyond the configured bound. The timer is only disarmed in
    // the outer finally below.
    try {
      let res: Response;
      try {
        res = await (this.opts.fetchImpl ?? fetch)(this.opts.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(this.sessionId !== undefined
              ? { "mcp-session-id": this.sessionId }
              : {}),
            ...this.opts.headers,
          },
          body,
          // Credentials must never reach a redirected origin.
          redirect: "error",
          signal: controller.signal,
        });
      } catch (err) {
        if (signal?.aborted && !timedOut) {
          throw new CancelledError("caller aborted request", tool);
        }
        if (timedOut || controller.signal.aborted) {
          throw new TimeoutError(`request exceeded ${timeout}ms`, tool);
        }
        // fetch with redirect:"error" rejects on redirect attempts.
        throw new AvailabilityError(
          `transport fault: ${(err as Error).message}`,
          tool,
        );
      }

      if (res.status === 401 || res.status === 403) {
        // Hard setup error — never retried as transient.
        throw new AuthError(
          `backend rejected credentials (HTTP ${res.status}); check mcp.auth configuration`,
          tool,
        );
      }
      if (res.status >= 300 && res.status < 400) {
        throw new AvailabilityError(
          "backend attempted a redirect; refusing to follow (credential safety)",
          tool,
        );
      }
      if (!res.ok) {
        throw new AvailabilityError(
          `backend unavailable (HTTP ${res.status})`,
          tool,
        );
      }

      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;

      const declared = res.headers.get("content-length");
      if (declared !== null && Number(declared) > this.opts.maxResponseBytes) {
        throw new ResponseFormatError(
          `response exceeds bound (${declared} bytes)`,
          tool,
        );
      }
      let text: string;
      try {
        text = await readBounded(res, this.opts.maxResponseBytes, tool);
      } catch (err) {
        // An abort during the body read surfaces as a reader rejection; map
        // it to the same typed timeout/cancellation errors as the fetch leg.
        if (signal?.aborted && !timedOut) {
          throw new CancelledError("caller aborted request", tool);
        }
        if (timedOut || controller.signal.aborted) {
          throw new TimeoutError(`request exceeded ${timeout}ms`, tool);
        }
        throw err;
      }
      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(text) as JsonRpcResponse;
      } catch {
        throw new ResponseFormatError("response is not valid JSON-RPC", tool);
      }
      if (parsed.error !== undefined) {
        // JSON-RPC protocol errors are permanent (e.g. method-not-found):
        // retrying them as availability faults would always fail again.
        throw new ResponseFormatError(
          "backend returned a JSON-RPC protocol error",
          tool,
        );
      }
      if (parsed.id !== id) {
        throw new ResponseFormatError("response id mismatch", tool);
      }
      return parsed.result;
    } finally {
      if (signal) signal.removeEventListener("abort", onCallerAbort);
      clearTimeout(timer);
    }
  }
}

/**
 * Reads the body with a hard byte bound. Oversized bodies produce a typed
 * safe failure; nothing beyond the bound is buffered.
 */
async function readBounded(
  res: Response,
  max: number,
  tool: string,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let received = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > max) {
        try {
          await reader.cancel();
        } catch {
          /* body already gone */
        }
        throw new ResponseFormatError(
          `response exceeds bound (>${max} bytes)`,
          tool,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const parts: string[] = [];
  for (const c of chunks) parts.push(decoder.decode(c, { stream: true }));
  parts.push(decoder.decode());
  return parts.join("");
}
