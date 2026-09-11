/**
 * T13 — explicit recall tools (`kiwifs_memory_search` / `kiwifs_memory_read`)
 * dedicated tests (test/recall-tools.test.ts).
 *
 * Chunk scope: search/read private-mode ZERO backend reads; held-runtime
 * refusals; fresh-read guard gates (scope / status / path-prefix / schema
 * read-back / redaction); the advisory tombstone cache can never authorize
 * a hit; the shared search deadline (timeout) degrades visibly and is
 * bounded; search output framing/truncation.
 *
 * Synthetic fixtures only — no credentials, no live services.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { KiwiFSAdapter } from "../src/backend/adapter.ts";
import type { ScoredHit } from "../src/backend/parse.ts";
import { identityRedactor } from "../src/backend/guard.ts";
import type { TombstoneCache } from "../src/backend/guard.ts";
import {
  RetrievalCoordinator,
  type EvidenceItem,
} from "../src/retrieval/coordinator.ts";
import {
  buildMemoryReadTool,
  buildMemorySearchTool,
} from "../src/inject/tools.ts";

// ---- fakes ---------------------------------------------------------------

interface FakeRecord {
  frontmatter: Record<string, string>;
  body: string;
}

function doc(fm: Record<string, string>, body: string): string {
  return `---\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n${body}`;
}

interface FakeAdapterOptions {
  records?: Record<string, FakeRecord>;
  fts?: (query: string, scope?: string) => ScoredHit[];
  redactor?: (
    content: string,
  ) => { ok: true; content: string } | { ok: false; reason: string };
  /** searchFts hangs until its abort signal fires (deadline testing). */
  hangingSearch?: boolean;
}

function makeAdapter(
  opts: FakeAdapterOptions = {},
): KiwiFSAdapter & { readCalls: string[]; searchQueries: string[] } {
  const readCalls: string[] = [];
  const searchQueries: string[] = [];
  const redact = opts.redactor ?? identityRedactor;
  const adapter = {
    readCalls,
    searchQueries,
    async read(path: string, o: { signal?: AbortSignal } = {}) {
      if (o.signal?.aborted)
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      readCalls.push(path);
      const r = opts.records?.[path];
      if (!r) return { state: "missing", frontmatter: {}, body: "" };
      return {
        state: "ok",
        content: doc(r.frontmatter, r.body),
        frontmatter: r.frontmatter,
        body: r.body,
      };
    },
    async searchFts(
      query: string,
      o: { scope?: string; signal?: AbortSignal } = {},
    ) {
      (searchQueries as unknown as { query: string; scope?: string }[]).push({
        query,
        ...(o.scope !== undefined ? { scope: o.scope } : {}),
      });
      if (opts.hangingSearch) {
        await new Promise<never>((_, reject) => {
          o.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      }
      return { hits: opts.fts?.(query, o.scope) ?? [], text: "" };
    },
    async searchSemantic() {
      return { hits: [], text: "" };
    },
    async searchHybrid() {
      return { hits: [], degraded: false, text: "" };
    },
    async brief() {
      return { sections: [], dropped: [], text: "" };
    },
  } as unknown as KiwiFSAdapter & {
    readCalls: string[];
    searchQueries: string[];
  };
  return adapter;
}

const SCOPE_A = "project/alpha";
const SCOPES = [SCOPE_A, "personal"];
const OBS_PATH = `${SCOPE_A}/memory/observations/2026/09/a1.md`;
const GOOD_RECORD: FakeRecord = {
  frontmatter: { scope: SCOPE_A, memory_status: "active" },
  body: "Alpha decided to use SQLite for the index.",
};

function makeCoordinator(
  adapter: KiwiFSAdapter,
  overrides: Partial<
    ConstructorParameters<typeof RetrievalCoordinator>[0]
  > = {},
): RetrievalCoordinator {
  return new RetrievalCoordinator({
    adapter,
    authorizedScopes: SCOPES,
    deadlineMs: 2000,
    tokenCap: 3000,
    generation: 1,
    redact: identityRedactor,
    tokenizer: {
      id: "test-words",
      countTokens: (t) => t.trim().split(/\s+/).length,
    },
    ...overrides,
  });
}

type ToolDef = {
  execute: (
    toolCallId: string,
    params: never,
    signal?: AbortSignal,
    ...rest: never[]
  ) => Promise<{ content: { type: string; text?: string }[] }>;
};

async function runTool(tool: ToolDef, params: Record<string, string>) {
  const result = await tool.execute("id", params as never);
  const first = result.content[0]!;
  assert.equal(first.type, "text");
  return first.text!;
}

const OK_DEPS = (
  coordinator: RetrievalCoordinator,
  adapter: KiwiFSAdapter,
) => ({
  getRuntime: () => ({ coordinator, adapter }),
  getHeldReason: () => undefined,
  privateMode: () => false,
  deadlineMs: 2000,
});

// ---- private mode: zero backend reads -------------------------------------

test("private mode: both tools refuse with ZERO backend reads of any kind", async () => {
  const adapter = makeAdapter({
    records: { [OBS_PATH]: GOOD_RECORD },
    fts: () => [{ path: OBS_PATH, score: 0.9 }],
  });
  const coordinator = makeCoordinator(adapter);
  const deps = { ...OK_DEPS(coordinator, adapter), privateMode: () => true };
  const search = buildMemorySearchTool(() => deps);
  const read = buildMemoryReadTool(() => deps);
  assert.match(await runTool(search, { query: "SQLite" }), /private mode/);
  assert.match(await runTool(read, { path: OBS_PATH }), /private mode/);
  assert.equal(adapter.searchQueries.length, 0, "no search fanout");
  assert.equal(adapter.readCalls.length, 0, "no fresh reads");
});

test("held runtime: both tools refuse with the sanitized hold reason, no reads", async () => {
  const adapter = makeAdapter();
  const coordinator = makeCoordinator(adapter);
  const deps = {
    getRuntime: () => undefined,
    getHeldReason: () => "credential unresolved",
    privateMode: () => false,
    deadlineMs: 2000,
  };
  assert.match(
    await runTool(
      buildMemorySearchTool(() => deps),
      { query: "x" },
    ),
    /retrieval is held.*credential unresolved/s,
  );
  assert.match(
    await runTool(
      buildMemoryReadTool(() => deps),
      { path: OBS_PATH },
    ),
    /retrieval is held.*credential unresolved/s,
  );
  assert.equal(adapter.searchQueries.length, 0);
  assert.equal(adapter.readCalls.length, 0);
});

// ---- fresh-read guard gates ------------------------------------------------

test("read gate: missing record fails closed at read-back", async () => {
  const adapter = makeAdapter({ records: {} });
  const read = buildMemoryReadTool(() =>
    OK_DEPS(makeCoordinator(adapter), adapter),
  );
  const text = await runTool(read, { path: OBS_PATH });
  assert.match(text, /'read-back'/);
  assert.equal(adapter.readCalls.length, 1, "exactly one fresh read attempted");
});

test("read gate: non-active memory_status is rejected", async () => {
  const adapter = makeAdapter({
    records: {
      [OBS_PATH]: {
        frontmatter: { scope: SCOPE_A, memory_status: "superseded" },
        body: "old",
      },
    },
  });
  const read = buildMemoryReadTool(() =>
    OK_DEPS(makeCoordinator(adapter), adapter),
  );
  assert.match(await runTool(read, { path: OBS_PATH }), /'status'/);
});

test("read gate: record scope outside the authorized set is rejected", async () => {
  const other = "project/other";
  const path = `${other}/memory/observations/o.md`;
  const adapter = makeAdapter({
    records: {
      [path]: {
        frontmatter: { scope: other, memory_status: "active" },
        body: "secret from another project",
      },
    },
  });
  const read = buildMemoryReadTool(() =>
    OK_DEPS(makeCoordinator(adapter), adapter),
  );
  const text = await runTool(read, { path });
  assert.match(text, /'scope'/);
  assert.ok(!text.includes("secret from another project"));
});

test("read gate: path outside the scope memory/ namespace is rejected", async () => {
  const path = `${SCOPE_A}/other/namespace/o.md`;
  const adapter = makeAdapter({
    records: {
      [path]: {
        frontmatter: { scope: SCOPE_A, memory_status: "active" },
        body: "misplaced",
      },
    },
  });
  const read = buildMemoryReadTool(() =>
    OK_DEPS(makeCoordinator(adapter), adapter),
  );
  assert.match(await runTool(read, { path }), /'path-prefix'/);
});

test("read gate: redaction failure fails closed with no body", async () => {
  const adapter = makeAdapter({
    records: { [OBS_PATH]: GOOD_RECORD },
  });
  const coordinator = makeCoordinator(adapter, {
    redact: () => ({ ok: false, reason: "unclassifiable content" }),
  });
  const read = buildMemoryReadTool(() => OK_DEPS(coordinator, adapter));
  const text = await runTool(read, { path: OBS_PATH });
  assert.match(text, /'redaction'/);
  assert.ok(!text.includes(GOOD_RECORD.body));
});

test("read success: guarded body is framed as untrusted data with source ids", async () => {
  const adapter = makeAdapter({ records: { [OBS_PATH]: GOOD_RECORD } });
  const read = buildMemoryReadTool(() =>
    OK_DEPS(makeCoordinator(adapter), adapter),
  );
  const text = await runTool(read, { path: OBS_PATH });
  assert.match(text, /UNTRUSTED DATA/);
  assert.match(text, new RegExp(`source=${OBS_PATH.replace(/\//g, "\\/")}`));
  assert.match(text, /SQLite for the index/);
});

test("search: guarded results carry source ids; unauthorized hits are dropped silently", async () => {
  const otherPath = "project/other/memory/o.md";
  const adapter = makeAdapter({
    records: {
      [OBS_PATH]: GOOD_RECORD,
      [otherPath]: {
        frontmatter: { scope: "project/other", memory_status: "active" },
        body: "foreign project secret",
      },
    },
    fts: () => [
      { path: OBS_PATH, score: 0.5 },
      { path: otherPath, score: 0.9 },
    ],
  });
  const search = buildMemorySearchTool(() =>
    OK_DEPS(makeCoordinator(adapter), adapter),
  );
  const text = await runTool(search, { query: "index" });
  assert.match(text, /UNTRUSTED DATA/);
  assert.match(text, /source=/);
  assert.ok(!text.includes("foreign project secret"));
});

test("search: query failing privacy classification refuses with no backend call", async () => {
  const adapter = makeAdapter({ fts: () => [{ path: OBS_PATH, score: 1 }] });
  const coordinator = makeCoordinator(adapter, {
    redact: () => ({ ok: false, reason: "unclassifiable" }),
  });
  const search = buildMemorySearchTool(() => OK_DEPS(coordinator, adapter));
  const text = await runTool(search, { query: "whatever" });
  assert.match(text, /privacy/);
  assert.equal(adapter.searchQueries.length, 0);
});

test("search: fanout is bounded to the coordinator's authorized scope set", async () => {
  const adapter = makeAdapter();
  const coordinator = makeCoordinator(adapter);
  const search = buildMemorySearchTool(() => OK_DEPS(coordinator, adapter));
  await runTool(search, { query: "q" });
  const searched = adapter.searchQueries as unknown as {
    query: string;
    scope?: string;
  }[];
  assert.equal(searched.length, SCOPES.length);
  assert.deepEqual(
    searched.map((s) => s.scope).sort(),
    [...SCOPES].sort(),
    "one query per authorized scope, nothing beyond",
  );
});

// ---- advisory tombstone cache cannot authorize ------------------------------

test("advisory tombstone cache: a cache HIT refuses before any read", async () => {
  const adapter = makeAdapter({ records: { [OBS_PATH]: GOOD_RECORD } });
  const cache: TombstoneCache = { isAdvisoryTombstoned: () => true };
  const read = buildMemoryReadTool(() => ({
    ...OK_DEPS(makeCoordinator(adapter), adapter),
    tombstoneCache: cache,
  }));
  const text = await runTool(read, { path: OBS_PATH });
  assert.match(text, /tombstoned/);
  assert.equal(adapter.readCalls.length, 0);
});

test("advisory tombstone cache: a STALE/EMPTY cache never authorizes a forgotten record", async () => {
  // Cache says nothing is tombstoned (stale), backend read-back reveals
  // memory_status: superseded → the guard pipeline still rejects.
  const adapter = makeAdapter({
    records: {
      [OBS_PATH]: {
        frontmatter: { scope: SCOPE_A, memory_status: "superseded" },
        body: "forgotten content",
      },
    },
  });
  const cache: TombstoneCache = { isAdvisoryTombstoned: () => false };
  const read = buildMemoryReadTool(() => ({
    ...OK_DEPS(makeCoordinator(adapter), adapter),
    tombstoneCache: cache,
  }));
  const text = await runTool(read, { path: OBS_PATH });
  assert.match(text, /'status'/);
  assert.ok(!text.includes("forgotten content"));
  // The read also cannot be smuggled through search.
  const search = buildMemorySearchTool(() => ({
    ...OK_DEPS(makeCoordinator(adapter), adapter),
    tombstoneCache: cache,
  }));
  const s = await runTool(search, { query: "q" });
  assert.ok(!s.includes("forgotten content"));
});

// ---- deadline / timeout ------------------------------------------------------

test("search deadline: a hanging fanout degrades visibly and never fabricates results", async () => {
  const adapter = makeAdapter({ hangingSearch: true });
  const search = buildMemorySearchTool(() => ({
    ...OK_DEPS(makeCoordinator(adapter), adapter),
    deadlineMs: 50,
  }));
  const text = await runTool(search, { query: "q" });
  assert.match(text, /deadline exceeded/);
  assert.ok(!text.includes("SQLite"), "no evidence reported past the deadline");
});

test("read deadline: an already-aborted signal fails closed at read-back", async () => {
  const adapter = makeAdapter({ records: { [OBS_PATH]: GOOD_RECORD } });
  const controller = new AbortController();
  controller.abort();
  const read = buildMemoryReadTool(() =>
    OK_DEPS(makeCoordinator(adapter), adapter),
  );
  const result = await (read as unknown as ToolDef).execute(
    "id",
    { path: OBS_PATH } as never,
    controller.signal,
  );
  const text = result.content[0]!.text!;
  assert.match(text, /degraded.*deadline exceeded/s);
  assert.ok(!text.includes("SQLite"));
});

// ---- output bounds ------------------------------------------------------------

test("search output is deterministically bounded by maxResults and maxBodyChars", async () => {
  const records: Record<string, FakeRecord> = {};
  const hits: ScoredHit[] = [];
  for (let i = 0; i < 8; i++) {
    const p = `${SCOPE_A}/memory/observations/o${i}.md`;
    records[p] = {
      frontmatter: { scope: SCOPE_A },
      body: `body-${i} `.repeat(300),
    };
    hits.push({ path: p, score: i / 10 });
  }
  const adapter = makeAdapter({ records, fts: () => hits });
  const search = buildMemorySearchTool(() => ({
    ...OK_DEPS(makeCoordinator(adapter), adapter),
    maxResults: 3,
    maxBodyChars: 20,
  }));
  const text = await runTool(search, { query: "q" });
  assert.equal((text.match(/\[Memory:S\d+/g) ?? []).length, 3);
  assert.match(text, /\[truncated\]/);
});
