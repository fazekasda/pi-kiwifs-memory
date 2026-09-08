/**
 * T04: in-memory fake KiwiFS MCP server for contract tests (synthetic only —
 * no network, no credentials, no real data). Speaks enough JSON-RPC over
 * HTTP POST for McpHttpTransport/KiwiFSAdapter: initialize, tools/list,
 * tools/call with the required kiwi_* tools, plus fault injection for auth,
 * redirects, hangs, invalid and oversized responses.
 */

import { createHash } from "node:crypto";

export interface FakeServerState {
  store: Map<string, string>;
  etags: Map<string, string>;
  /** path → hybrid attribution override for kiwi_search_hybrid results. */
  hybridAttribution: Map<string, "both" | "keyword only" | "semantic only">;
  /** Paths whose FTS index still contains them despite deletion (stale vector analogue). */
  staleFtsPaths: Set<string>;
  changesLog: { action: string; path: string; actor: string; ts: string }[];
  requests: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }[];
}

export function createState(): FakeServerState {
  return {
    store: new Map(),
    etags: new Map(),
    hybridAttribution: new Map(),
    staleFtsPaths: new Set(),
    changesLog: [],
    requests: [],
  };
}

export interface FakeServerBehavior {
  status?: number;
  /** Location header for a redirect response (never followed by the adapter). */
  location?: string;
  /** Never resolve; rejects when the request signal aborts (timeout tests). */
  hang?: boolean;
  /** Respond with a non-JSON body. */
  invalidJson?: boolean;
  /** Respond with a body larger than the configured transport bound. */
  oversizedBodyBytes?: number;
  /** Send this many body bytes, then stall forever (mid-body hang). */
  stallBodyAfterBytes?: number;
  /** Throw a transport fault the next time this tool is called (once). */
  failToolOnce?: string;
  /** Drop the Authorization header check (simulate no-auth endpoint). */
  authHeaderSeen?: (value: string | undefined) => void;
}

export interface FakeServer {
  fetch: typeof fetch;
  state: FakeServerState;
  behavior: FakeServerBehavior;
}

const TOOL_NAMES = [
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
  "kiwi_remember",
  "kiwi_forget",
];

export function createFakeServer(
  behavior: FakeServerBehavior = {},
): FakeServer {
  const state = createState();
  let counter = 0;
  const nextEtag = (path: string): string => {
    counter += 1;
    const etag = `etag-${createHash("sha256").update(`${path}:${counter}`).digest("hex").slice(0, 8)}`;
    state.etags.set(path, etag);
    return etag;
  };

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const body = typeof init?.body === "string" ? init.body : "";
    state.requests.push({ url, method: init?.method ?? "GET", headers, body });
    behavior.authHeaderSeen?.(headers["authorization"]);

    if (behavior.hang) {
      await new Promise<never>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    }
    if (behavior.status !== undefined) {
      const respHeaders = new Headers();
      if (behavior.location) respHeaders.set("location", behavior.location);
      return new Response("synthetic", {
        status: behavior.status,
        headers: respHeaders,
      });
    }
    if (behavior.invalidJson) {
      return new Response("not json at all", { status: 200 });
    }
    if (behavior.oversizedBodyBytes !== undefined) {
      return new Response("x".repeat(behavior.oversizedBodyBytes), {
        status: 200,
      });
    }
    if (behavior.stallBodyAfterBytes !== undefined) {
      const bytes = new TextEncoder().encode(
        "y".repeat(behavior.stallBodyAfterBytes),
      );
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new Error("aborted")),
            { once: true },
          );
        },
      });
      return new Response(stream, { status: 200 });
    }

    let req: {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      req = JSON.parse(body);
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        }),
        { status: 200 },
      );
    }
    const id = req.id;
    const faultTool =
      req.method === "tools/call"
        ? String(
            (req.params as Record<string, unknown> | undefined)?.["name"] ?? "",
          )
        : "";
    if (
      behavior.failToolOnce !== undefined &&
      behavior.failToolOnce === faultTool
    ) {
      delete behavior.failToolOnce;
      throw new Error("synthetic transport fault");
    }
    const result = await dispatch(req.method ?? "", req.params ?? {});
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status: 200,
    });
  }) as typeof fetch;

  async function dispatch(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === "initialize") {
      return {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "kiwifs", version: "1.0.0" },
      };
    }
    if (method === "tools/list") {
      return {
        tools: TOOL_NAMES.map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      };
    }
    if (method !== "tools/call") {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown method ${method}` }],
      };
    }
    const tool = String(params["name"]);
    const args = (params["arguments"] ?? {}) as Record<string, unknown>;
    return callTool(tool, args);
  }

  function textResult(text: string, meta?: Record<string, unknown>): unknown {
    return {
      content: [{ type: "text", text }],
      ...(meta ? { _meta: meta } : {}),
    };
  }
  function errorResult(text: string): unknown {
    return { isError: true, content: [{ type: "text", text }] };
  }

  function setFrontmatterValue(
    content: string,
    key: string,
    value: string,
  ): string {
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
    if (!m) return content;
    const lines = (m[1] as string)
      .split("\n")
      .filter((l) => !l.startsWith(`${key}:`));
    lines.push(`${key}: ${value}`);
    return `---\n${lines.join("\n")}\n---\n${m[2] ?? ""}`;
  }

  function callTool(tool: string, args: Record<string, unknown>): unknown {
    const path = typeof args["path"] === "string" ? args["path"] : undefined;
    switch (tool) {
      case "kiwi_read": {
        if (!path) return errorResult("path is required");
        const etag = state.etags.get(path);
        const content = state.store.get(path);
        if (content === undefined) {
          return errorResult(`path not found: ${path}`);
        }
        const ifNotEtag = args["if_not_etag"];
        if (
          typeof ifNotEtag === "string" &&
          etag !== undefined &&
          ifNotEtag === etag
        ) {
          return textResult(
            `Not modified (ETag: ${etag}). Use if_not_etag to skip re-reading unchanged content.`,
            { "kiwi.etag": etag, "kiwi.not_modified": true },
          );
        }
        return textResult(
          content,
          etag !== undefined ? { "kiwi.etag": etag } : undefined,
        );
      }
      case "kiwi_write": {
        if (!path) return errorResult("path is required");
        if (path.length > 500)
          return errorResult("path exceeds 500 characters");
        const content = args["content"];
        if (typeof content !== "string")
          return errorResult("content is required");
        if (Buffer.byteLength(content) > 32 * 1024 * 1024) {
          return errorResult("content exceeds 32 MiB");
        }
        const existed = state.store.has(path);
        state.store.set(path, content);
        const etag = nextEtag(path);
        state.changesLog.push({
          action: existed ? "M" : "A",
          path,
          actor: String(args["actor"] ?? "mcp-agent"),
          ts: "2026-09-08T00:00:00Z",
        });
        return textResult(`Written ${path} (ETag: ${etag})`);
      }
      case "kiwi_append": {
        if (!path) return errorResult("path is required");
        const content = args["content"];
        if (typeof content !== "string")
          return errorResult("content is required");
        const sep =
          typeof args["separator"] === "string" ? args["separator"] : "\n";
        const prev = state.store.get(path) ?? "";
        state.store.set(path, prev === "" ? content : prev + sep + content);
        const etag = nextEtag(path);
        state.changesLog.push({
          action: "M",
          path,
          actor: String(args["actor"] ?? "mcp-agent"),
          ts: "2026-09-08T00:00:00Z",
        });
        return textResult(`Appended to ${path} (ETag: ${etag})`);
      }
      case "kiwi_delete": {
        if (!path) return errorResult("path is required");
        state.store.delete(path);
        state.etags.delete(path);
        state.changesLog.push({
          action: "D",
          path,
          actor: String(args["actor"] ?? "mcp-agent"),
          ts: "2026-09-08T00:00:00Z",
        });
        return textResult(`Deleted ${path} (committed 4b81ce2)`);
      }
      case "kiwi_search": {
        const query = args["query"];
        if (typeof query !== "string" || query === "")
          return errorResult("query is required");
        const limit = Math.min(Number(args["limit"] ?? 20) || 20, 50);
        const scope =
          typeof args["scope"] === "string" ? args["scope"] : undefined;
        const prefix =
          typeof args["path_prefix"] === "string"
            ? args["path_prefix"]
            : undefined;
        const hits: string[] = [];
        for (const [p, c] of state.store) {
          if (!c.includes(query)) continue;
          if (prefix !== undefined && !p.startsWith(prefix)) continue;
          if (scope !== undefined && !c.startsWith(`---\n`)) continue;
          if (scope !== undefined) {
            const m = /^---\n([\s\S]*?)\n---/.exec(c);
            const fm = m?.[1] ?? "";
            if (!fm.includes(`scope: ${scope}`)) continue;
          }
          hits.push(p);
          if (hits.length >= limit) break;
        }
        // Include stale FTS paths (deleted from store but index not updated).
        for (const p of state.staleFtsPaths) {
          if (prefix === undefined || p.startsWith(prefix)) {
            if (!hits.includes(p)) hits.push(p);
            if (hits.length >= limit) break;
          }
        }
        const lines = hits.map(
          (p, i) =>
            `${i + 1}. ${p} (${(3.5 - i * 0.1).toFixed(2)})\n   Synthetic snippet for ${p}.`,
        );
        return textResult(
          [...lines, "", `Use offset=${hits.length} to see more results.`].join(
            "\n",
          ),
        );
      }
      case "kiwi_search_semantic": {
        const query = args["query"];
        if (typeof query !== "string" || query === "")
          return errorResult("query is required");
        const limit = Math.min(Number(args["limit"] ?? 5) || 5, 50);
        const hits: string[] = [];
        for (const [p, c] of state.store) {
          if (!c.includes(query)) continue;
          const scope = args["scope"];
          if (typeof scope === "string") {
            const m = /^---\n([\s\S]*?)\n---/.exec(c);
            if (!m || !(m[1] as string).includes(`scope: ${scope}`)) continue;
          }
          hits.push(p);
          if (hits.length >= limit) break;
        }
        return textResult(
          hits
            .map((p, i) => `${i + 1}. ${p} (${(0.9 - i * 0.05).toFixed(3)})`)
            .join("\n"),
        );
      }
      case "kiwi_search_hybrid": {
        const query = args["query"];
        if (typeof query !== "string" || query === "")
          return errorResult("query is required");
        const hits: string[] = [];
        for (const p of [...state.store.keys(), ...state.staleFtsPaths]) {
          const c = state.store.get(p);
          if (c !== undefined && !c.includes(query)) continue;
          hits.push(p);
        }
        return textResult(
          hits
            .map(
              (p, i) =>
                `${i + 1}. ${p} (${state.hybridAttribution.get(p) ?? "both"}, #${i + 1})`,
            )
            .join("\n"),
        );
      }
      case "kiwi_brief": {
        const query = args["query"];
        if (typeof query !== "string" || query === "")
          return errorResult("query is required");
        // Fake brief: sections for every stored page mentioning the query.
        const parts: string[] = [
          `Brief pack (estimated 512 tokens, budget ${Number(args["budget_tokens"] ?? 4000)}):`,
        ];
        for (const [p, c] of state.store) {
          if (!c.includes(query)) continue;
          parts.push(`=== ${p} ===`);
          parts.push(
            /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(c)?.[1]?.trim() ?? c,
          );
        }
        return textResult(parts.join("\n\n"));
      }
      case "kiwi_changes": {
        const since = args["since"];
        const log =
          typeof since === "string" && since !== ""
            ? state.changesLog.filter((e) => e.ts > since)
            : state.changesLog;
        const limit = Math.min(Number(args["limit"] ?? 50) || 50, 500);
        const lines = log
          .slice(0, limit)
          .map((e) => `- ${e.action} ${e.path} (actor: ${e.actor}, ${e.ts})`);
        return textResult([...lines, "", "last_seq: c91d0a4"].join("\n"));
      }
      case "kiwi_query_meta": {
        const filters = (args["filters"] ?? {}) as Record<string, string>;
        const lines: string[] = [];
        for (const [p, c] of state.store) {
          const m = /^---\n([\s\S]*?)\n---/.exec(c);
          const fm = m?.[1] ?? "";
          const ok = Object.entries(filters).every(([k, v]) =>
            fm.includes(`${k}: ${v}`),
          );
          if (ok) lines.push(`path: ${p}`);
        }
        return textResult(lines.join("\n"));
      }
      case "kiwi_forget": {
        if (!path) return errorResult("path is required");
        const content = state.store.get(path);
        if (content === undefined)
          return errorResult(`path not found: ${path}`);
        state.store.set(
          path,
          setFrontmatterValue(content, "memory_status", "superseded"),
        );
        const etag = nextEtag(path);
        state.changesLog.push({
          action: "M",
          path,
          actor: "mcp-agent",
          ts: "2026-09-08T00:00:00Z",
        });
        return textResult(`Forgotten ${path} (ETag: ${etag})`);
      }
      case "kiwi_remember": {
        return textResult("remembered (fake)");
      }
      default:
        return errorResult(`unknown tool: ${tool}`);
    }
  }

  return { fetch: fetchFn, state, behavior };
}
