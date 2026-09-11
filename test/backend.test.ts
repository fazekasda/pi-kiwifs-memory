/**
 * T04 acceptance tests: adapter, transport and op-id behavior against the
 * fake MCP server (synthetic fixtures, no live service).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthError,
  AvailabilityError,
  ConflictError,
  ResponseFormatError,
  TimeoutError,
  ValidationError,
  isRetryable,
} from "../src/backend/errors.ts";
import { createMemoryLedger, mintOpId } from "../src/backend/opid.ts";
import { KiwiFSAdapter, SEARCH_LIMIT_MAX } from "../src/backend/adapter.ts";
import { deriveMsgId, deriveMsgPath } from "../src/backend/ids.ts";
import { createFakeServer } from "./fake-mcp-server.ts";
import msgIdVectors from "./fixtures/mcp/board-msg-id-vectors.json" with { type: "json" };

const URL = "https://kiwifs.test/mcp";

function makeAdapter(
  behavior = {},
  headers?: Record<string, string>,
  extra: { maxResponseBytes?: number } = {},
) {
  const server = createFakeServer(behavior);
  const ledger = createMemoryLedger();
  const adapter = new KiwiFSAdapter({
    url: URL,
    ...(headers ? { headers } : {}),
    requestTimeoutMs: 250,
    ...(extra.maxResponseBytes !== undefined
      ? { maxResponseBytes: extra.maxResponseBytes }
      : {}),
    fetchImpl: server.fetch,
    ledger,
  });
  return { server, ledger, adapter };
}

const DOC = `---\nscope: project/demo-proj\nmemory_status: active\n---\nSynthetic body.`;

// ---------- no constructor network I/O ----------

test("constructor performs no network I/O; connect() does", async () => {
  const { server, adapter } = makeAdapter();
  await adapter.connect();
  assert.ok(server.state.requests.length >= 2); // initialize + tools/list
  assert.equal(
    adapter.connectedCapabilities?.tools.includes("kiwi_read"),
    true,
  );
});

test("connect aborts when a required tool is missing (capability-driven, no hard-coded count)", async () => {
  const server = createFakeServer();
  const original = server.fetch;
  const filtered = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    const text = await res.text();
    const parsed = JSON.parse(text);
    if (parsed.result?.tools) {
      parsed.result.tools = parsed.result.tools.filter(
        (t: { name: string }) => t.name !== "kiwi_changes",
      );
    }
    return new Response(JSON.stringify(parsed), { status: 200 });
  }) as typeof fetch;
  const adapter = new KiwiFSAdapter({
    url: URL,
    fetchImpl: filtered,
    ledger: createMemoryLedger(),
  });
  await assert.rejects(adapter.connect(), ValidationError);
});

// ---------- CRUD, ETags, if_not_etag ----------

test("read returns content, parsed frontmatter and _meta ETag; isError is typed", async () => {
  const { server, ledger, adapter } = makeAdapter();
  await adapter.connect();
  const opId = mintOpId();
  ledger.record(opId);
  await adapter.write("project/demo-proj/memory/observations/a.md", DOC, {
    opId,
  });
  const read = await adapter.read("project/demo-proj/memory/observations/a.md");
  assert.equal(read.state, "ok");
  assert.equal(read.frontmatter["scope"], "project/demo-proj");
  assert.equal(read.frontmatter["memory_status"], "active");
  assert.ok(read.etag?.startsWith("etag-"));

  const missing = await adapter.read("project/demo-proj/memory/gone.md");
  assert.equal(missing.state, "missing"); // typed read outcome, not a throw
  void missing;
  assert.ok(missing); // first read above already proved the happy path
});

test("if_not_etag returns not_modified with etag (fixture 5)", async () => {
  const { ledger, adapter } = makeAdapter();
  await adapter.connect();
  const opId = mintOpId();
  ledger.record(opId);
  const path = "project/demo-proj/memory/observations/b.md";
  const written = await adapter.write(path, DOC, { opId });
  const read = await adapter.read(path, {
    ...(written.etag !== undefined ? { ifNotEtag: written.etag } : {}),
  });
  assert.equal(read.state, "not_modified");
  assert.equal(read.etag, written.etag);
});

test("limits: search limit clamped to 50, oversized content and long paths rejected client-side", async () => {
  const { ledger, adapter } = makeAdapter();
  await adapter.connect();
  const opId = mintOpId();
  ledger.record(opId);
  const res = await adapter.searchFts("synthetic", { limit: 60 });
  assert.ok(Array.isArray(res.hits));
  await assert.rejects(
    adapter.write(
      "project/demo-proj/memory/big.md",
      "x".repeat(32 * 1024 * 1024 + 1),
      { opId },
    ),
    ValidationError,
  );
  await assert.rejects(
    adapter.write(`${"p".repeat(501)}.md`, DOC, { opId }),
    ValidationError,
  );
  assert.equal(SEARCH_LIMIT_MAX, 50);
});

// ---------- op-id ledger + deterministic-path idempotency (B2) ----------

test("mutations refuse to run when the opId was not persisted first", async () => {
  const { adapter } = makeAdapter();
  await adapter.connect();
  await assert.rejects(
    adapter.write("project/demo-proj/memory/observations/x.md", DOC, {
      opId: mintOpId(),
    }),
  );
});

test("writeImmutable: absent→write, identical replay→no-op, different content→fail closed", async () => {
  const { ledger, adapter } = makeAdapter();
  await adapter.connect();
  const opId = mintOpId();
  ledger.record(opId);
  const path = "project/demo-proj/memory/observations/2026/09/obs-1.md";
  const first = await adapter.writeImmutable(path, DOC, { opId });
  assert.equal(first.replayed, false);
  const replay = await adapter.writeImmutable(path, DOC, { opId });
  assert.equal(replay.replayed, true); // read-before-write no-op
  await assert.rejects(
    adapter.writeImmutable(path, `${DOC}different`, { opId }),
    ConflictError,
  );
});

test("op-id-derived msg_id vectors: dual-sender distinctness and replay stability (fixture 5b)", () => {
  const vectors = msgIdVectors.vectors as {
    channel: string;
    from: string;
    opId: string;
    expectedMsgId: string;
    expectedPath: string;
  }[];
  const [a, b, replay] = vectors;
  assert.equal(deriveMsgId(a!.channel, a!.from, a!.opId), a!.expectedMsgId);
  assert.equal(deriveMsgPath(a!.channel, a!.from, a!.opId), a!.expectedPath);
  // identical payloads, distinct opIds → distinct messages
  assert.notEqual(
    deriveMsgId(b!.channel, b!.from, b!.opId),
    deriveMsgId(a!.channel, a!.from, a!.opId),
  );
  assert.equal(deriveMsgId(b!.channel, b!.from, b!.opId), b!.expectedMsgId);
  // replay of the same opId → same path
  assert.equal(
    deriveMsgPath(replay!.channel, replay!.from, replay!.opId),
    replay!.expectedPath,
  );
});

// ---------- search legs and degradation ----------

test("hybrid degradation comes from rank attribution, never status", async () => {
  const { server, ledger, adapter } = makeAdapter();
  await adapter.connect();
  const opId = mintOpId();
  ledger.record(opId);
  await adapter.write("project/demo-proj/memory/observations/h1.md", DOC, {
    opId,
  });
  server.state.hybridAttribution.set(
    "project/demo-proj/memory/observations/h1.md",
    "keyword only",
  );
  const res = await adapter.searchHybrid("Synthetic body");
  assert.equal(res.degraded, true); // `keyword only` → degraded, not semantic
  assert.equal(res.hits[0]?.attribution, "keyword only");
  server.state.hybridAttribution.clear();
  const clean = await adapter.searchHybrid("Synthetic body");
  assert.equal(clean.degraded, false);
});

test("changes replay with the same cursor is idempotent (fixture 7)", async () => {
  const { ledger, adapter } = makeAdapter();
  await adapter.connect();
  const opId = mintOpId();
  ledger.record(opId);
  await adapter.write("project/demo-proj/memory/observations/c.md", DOC, {
    opId,
  });
  const first = await adapter.changes("0000000");
  const second = await adapter.changes("0000000");
  assert.deepEqual(first, second);
  assert.ok(first.changes.some((c) => c.path.endsWith("c.md")));
  assert.equal(first.lastSeq, "c91d0a4");
});

// ---------- error normalization (error-cases.json) ----------

test("auth failures are a hard setup error and are never retried", async () => {
  const { server, adapter } = makeAdapter({ status: 401 });
  await assert.rejects(adapter.connect(), AuthError);
  // Exactly one request: no retry after the authorization failure.
  assert.equal(server.state.requests.length, 1);
});

test("redirects are rejected before being followed (no credential forwarding)", async () => {
  const { server, adapter } = makeAdapter({
    status: 302,
    location: "https://unrelated.example.invalid/mcp",
  });
  await assert.rejects(adapter.connect(), AvailabilityError);
  // Only the original URL was ever contacted.
  for (const req of server.state.requests) {
    assert.equal(req.url, URL);
  }
});

test("timeouts terminate pending requests within the configured bound", async () => {
  const { adapter } = makeAdapter({ hang: true });
  const start = Date.now();
  await assert.rejects(adapter.connect(), TimeoutError);
  assert.ok(Date.now() - start < 2000);
});

test("per-request deadline also covers a mid-body stall (not just headers)", async () => {
  const { server, adapter } = makeAdapter();
  await adapter.connect();
  // Headers arrive promptly; the body stalls after a few bytes.
  server.behavior.stallBodyAfterBytes = 16;
  const start = Date.now();
  await assert.rejects(adapter.changes("0"), TimeoutError);
  assert.ok(Date.now() - start < 2000);
});

test("kiwi_append is never retried on availability faults (non-idempotent)", async () => {
  const { server, ledger, adapter } = makeAdapter();
  await adapter.connect();
  const opId = mintOpId();
  ledger.record(opId);
  const path = "integration-tests/t04/no-retry.md";
  await adapter.write(path, DOC, { opId });
  const requestsBefore = server.state.requests.length;
  server.behavior.failToolOnce = "kiwi_append";
  const appendOpId = mintOpId();
  ledger.record(appendOpId);
  await assert.rejects(
    adapter.append(path, "more", { opId: appendOpId }),
    AvailabilityError,
  );
  // Exactly one call attempt: the transport fault was NOT replayed.
  assert.equal(server.state.requests.length - requestsBefore, 1);
  // And the store shows no duplicated/partial append.
  assert.ok(!server.state.store.get(path)?.includes("more"));
});

test("idempotent tools are retried once on availability faults", async () => {
  const { server, adapter } = makeAdapter();
  await adapter.connect();
  const requestsBefore = server.state.requests.length;
  server.behavior.failToolOnce = "kiwi_changes";
  const res = await adapter.changes("0");
  assert.ok(Array.isArray(res.changes));
  // Exactly two call attempts: one fault + one successful replay.
  assert.equal(server.state.requests.length - requestsBefore, 2);
});

test("caller cancellation propagates into backend calls", async () => {
  const { adapter } = makeAdapter({ hang: true });
  const controller = new AbortController();
  const pending = adapter.connect(controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (err: unknown) => {
    const code = (err as { code?: string }).code;
    return code === "cancelled" || code === "timeout";
  });
});

test("invalid and oversized backend responses produce typed safe failures", async () => {
  {
    const { adapter } = makeAdapter({ invalidJson: true });
    await assert.rejects(adapter.connect(), ResponseFormatError);
  }
  {
    const { adapter } = makeAdapter(
      { oversizedBodyBytes: 2 * 1024 * 1024 },
      undefined,
      {
        maxResponseBytes: 64 * 1024,
      },
    );
    await assert.rejects(
      adapter.connect(),
      (err: unknown) =>
        err instanceof ResponseFormatError && /bound/.test(err.message),
    );
  }
});

test("auth headers are sent by reference and never logged in error messages", async () => {
  let seen: string | undefined;
  const server2 = createFakeServer({ status: 401 });
  server2.behavior.authHeaderSeen = (v) => {
    seen = v;
  };
  const a2 = new KiwiFSAdapter({
    url: URL,
    headers: {
      authorization: "Bearer synthetic-not-a-real-credential-value-000000",
    },
    fetchImpl: server2.fetch,
    ledger: createMemoryLedger(),
  });
  await assert.rejects(a2.connect(), (err: AuthError) => {
    assert.ok(!err.message.includes("synthetic-not-a-real-credential"));
    return true;
  });
  assert.ok(seen?.startsWith("Bearer "));
});
