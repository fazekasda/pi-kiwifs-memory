/**
 * T04 acceptance tests: the B3 fail-closed guard pipeline, tombstone
 * advisory cache, and the brief scope gate with fallback rebuild
 * (guard-pipeline-cases.json, mcp-contracts.md §8/§9 fixtures 2/3/5a/5c).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mintOpId, createMemoryLedger } from "../src/backend/opid.ts";
import { KiwiFSAdapter } from "../src/backend/adapter.ts";
import {
  QueryMetaTombstoneCache,
  advisoryPreFilter,
  buildBriefEvidence,
  guardCandidate,
} from "../src/backend/guard.ts";
import { createFakeServer } from "./fake-mcp-server.ts";

const URL = "https://kiwifs.test/mcp";
const SCOPES = ["project/demo-proj", "personal"];

function doc(
  scope: string,
  status?: string,
  body = "Synthetic body text.",
): string {
  const lines = ["---", `scope: ${scope}`];
  if (status !== undefined) lines.push(`memory_status: ${status}`);
  lines.push("---", body);
  return lines.join("\n");
}

async function setup(
  seed: (state: import("./fake-mcp-server.ts").FakeServerState) => void,
) {
  const server = createFakeServer();
  seed(server.state);
  const adapter = new KiwiFSAdapter({
    url: URL,
    fetchImpl: server.fetch,
    ledger: createMemoryLedger(),
  });
  await adapter.connect();
  return { adapter, server };
}

const SECRET_RE = /SYNTHETIC-SECRET-[0-9A-F-]+/g;
const redact = (content: string) =>
  SECRET_RE.test(content)
    ? {
        ok: true as const,
        content: content.replace(SECRET_RE, "[REDACTED:secret:n]"),
      }
    : { ok: true as const, content };

test("guard step 1: read-back failure (missing path) rejects", async () => {
  const { adapter } = await setup(() => {});
  const res = await guardCandidate(
    "project/demo-proj/memory/observations/2026/02/gone.md",
    { adapter, authorizedScopes: SCOPES },
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.step, "read-back");
});

test("guard step 2: superseded and unknown statuses reject even though content exists", async () => {
  const { adapter } = await setup((state) => {
    state.store.set(
      "project/demo-proj/memory/observations/2026/02/obs-0003.md",
      doc("project/demo-proj", "superseded", "forgotten but still readable"),
    );
    state.store.set(
      "project/demo-proj/memory/observations/2026/02/obs-0004.md",
      doc("project/demo-proj", "quarantined"),
    );
  });
  for (const p of [
    "project/demo-proj/memory/observations/2026/02/obs-0003.md",
    "project/demo-proj/memory/observations/2026/02/obs-0004.md",
  ]) {
    const res = await guardCandidate(p, { adapter, authorizedScopes: SCOPES });
    assert.equal(res.ok, false, p);
    if (!res.ok) assert.equal(res.step, "status");
  }
});

test("guard step 3: out-of-scope read-back rejects (the only gate on hybrid/brief legs)", async () => {
  const { adapter } = await setup((state) => {
    state.store.set(
      "project/other-proj/memory/observations/2026/02/obs-0042.md",
      doc("project/other-proj", "active"),
    );
  });
  const res = await guardCandidate(
    "project/other-proj/memory/observations/2026/02/obs-0042.md",
    { adapter, authorizedScopes: SCOPES },
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.step, "scope");
});

test("guard step 4: path outside the scope memory/ namespace rejects (raw backup chunk)", async () => {
  const { adapter } = await setup((state) => {
    state.store.set(
      "project/demo-proj/backup/session-1/000001.md",
      doc("project/demo-proj", "active"),
    );
  });
  const res = await guardCandidate(
    "project/demo-proj/backup/session-1/000001.md",
    { adapter, authorizedScopes: SCOPES },
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.step, "path-prefix");
});

test("guard step 5: privacy redaction transforms or rejects before injection", async () => {
  const { adapter } = await setup((state) => {
    state.store.set(
      "project/demo-proj/memory/observations/2026/02/obs-0005.md",
      doc(
        "project/demo-proj",
        "active",
        "Deploy key is SYNTHETIC-SECRET-0000-DEADBEEF for the fixture environment.",
      ),
    );
  });
  const res = await guardCandidate(
    "project/demo-proj/memory/observations/2026/02/obs-0005.md",
    { adapter, authorizedScopes: SCOPES, redact },
  );
  assert.equal(res.ok, true);
  if (res.ok) assert.ok(!res.body.includes("SYNTHETIC-SECRET"));
});

test("fail-closed redaction: unclassifiable content is rejected, never passed through", async () => {
  const { adapter } = await setup((state) => {
    state.store.set(
      "project/demo-proj/memory/observations/2026/02/obs-0006.md",
      doc("project/demo-proj", "active"),
    );
  });
  const res = await guardCandidate(
    "project/demo-proj/memory/observations/2026/02/obs-0006.md",
    {
      adapter,
      authorizedScopes: SCOPES,
      redact: () => ({ ok: false, reason: "cannot classify" }),
    },
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.step, "redaction");
});

test("tombstone cache is advisory: an empty/stale cache never permits a superseded record (fixture 5c)", async () => {
  const { adapter } = await setup((state) => {
    state.store.set(
      "project/demo-proj/memory/observations/2026/02/obs-0003.md",
      doc("project/demo-proj", "superseded"),
    );
  });
  // Fresh (and therefore "stale" wrt the record) empty advisory cache.
  const emptyCache = new QueryMetaTombstoneCache(adapter, SCOPES, 0, () => 0);
  assert.equal(
    advisoryPreFilter(
      "project/demo-proj/memory/observations/2026/02/obs-0003.md",
      emptyCache,
    ),
    false,
  );
  const res = await guardCandidate(
    "project/demo-proj/memory/observations/2026/02/obs-0003.md",
    { adapter, authorizedScopes: SCOPES, tombstoneCache: emptyCache },
  );
  assert.equal(res.ok, false); // the read-back status check is the gate
});

test("tombstone cache refresh picks up superseded paths and still defers to read-back", async () => {
  const { adapter } = await setup((state) => {
    const opId = mintOpId();
    state.store.set(
      "project/demo-proj/memory/observations/2026/02/obs-0003.md",
      doc("project/demo-proj", "active"),
    );
    void opId;
    state.store.set(
      "project/demo-proj/memory/observations/2026/02/obs-old.md",
      doc("project/demo-proj", "superseded"),
    );
  });
  const cache = new QueryMetaTombstoneCache(adapter, SCOPES);
  await cache.refresh();
  assert.equal(
    advisoryPreFilter(
      "project/demo-proj/memory/observations/2026/02/obs-old.md",
      cache,
    ),
    true,
  );
  // Advisory hit on an ACTIVE record must not reject it (read-back decides).
  // First mark the cache wrongly, then prove the pipeline still passes the page.
  const wrongCache: { isAdvisoryTombstoned(p: string): boolean } = {
    isAdvisoryTombstoned: () => true,
  };
  const res = await guardCandidate(
    "project/demo-proj/memory/observations/2026/02/obs-0003.md",
    { adapter, authorizedScopes: SCOPES, tombstoneCache: wrongCache },
  );
  assert.equal(
    res.ok,
    true,
    "advisory tombstone must never reject an active record",
  );
});

test("brief scope gate (fixture 5a): out-of-scope brief page is dropped; pack rebuilds from scoped search", async () => {
  const { adapter } = await setup((state) => {
    state.store.set(
      "project/demo-proj/memory/observations/2026/02/obs-0001.md",
      doc(
        "project/demo-proj",
        "active",
        "Synthetic in-scope observation body.",
      ),
    );
    state.store.set(
      "project/other-proj/memory/observations/2026/02/obs-0042.md",
      doc("project/other-proj", "active", "Synthetic OUT-OF-SCOPE body."),
    );
  });
  const brief = await adapter.brief("Synthetic");
  assert.equal(brief.sections.length, 2); // brief returned BOTH (no scope param)
  const search = await adapter.searchFts("Synthetic", {
    scope: "project/demo-proj",
  });
  const result = await buildBriefEvidence(
    brief.sections,
    search.hits,
    { adapter, authorizedScopes: SCOPES },
    { maxPackChars: 100 }, // kept pack must clear 25% of this cap
  );
  assert.deepEqual(
    result.kept.map((k) => k.path),
    ["project/demo-proj/memory/observations/2026/02/obs-0001.md"],
  );
  assert.ok(
    result.dropped.some(
      (d) => d.path.includes("other-proj") && d.step === "scope",
    ),
  );
  assert.equal(result.rebuilt, false); // kept pack exceeded the minimum threshold
});

test("brief fallback rebuild triggers when the filtered pack falls below the minimum threshold", async () => {
  const { adapter } = await setup((state) => {
    state.store.set(
      "project/demo-proj/memory/observations/2026/02/obs-0001.md",
      doc("project/demo-proj", "active", "x".repeat(500)),
    );
    // The ONLY brief result is out-of-scope → kept pack is empty.
    state.store.set(
      "project/other-proj/memory/observations/2026/02/obs-0042.md",
      doc("project/other-proj", "active", "out of scope only brief content"),
    );
  });
  const brief = await adapter.brief("out of scope only brief content");
  const search = await adapter.searchFts("x", { scope: "project/demo-proj" });
  const result = await buildBriefEvidence(
    brief.sections,
    search.hits,
    { adapter, authorizedScopes: SCOPES },
    { maxPackChars: 10_000 },
  );
  assert.equal(result.rebuilt, true);
  assert.equal(
    result.kept
      .map((k) => k.path)
      .includes("project/demo-proj/memory/observations/2026/02/obs-0001.md"),
    true,
  );
  assert.ok(result.kept.every((k) => !k.path.includes("other-proj")));
});
