/**
 * Q03b: forget reason redaction + hardened namespace path safety.
 *
 * Synthetic, loopback-only (no network, no model calls, no real services):
 * - Every forget-reason entry point funnels through `forgetMemoryPath`
 *   (production composition: the /kiwifs-forget command handler passes raw
 *   user text there; it persists in TWO durable places — the local op log
 *   JSONL and the backend `superseded_reason`). These tests use a FAKE store
 *   that records the exact args the adapter would send, plus the real
 *   `ManualOpLog` on a temp dir, so both sinks are observed.
 * - Secret canaries are SYNTHETIC fixtures that only match the detection
 *   patterns; they are not real credentials.
 * - The guard's path-prefix step now uses `pathWithinMemoryNamespace`
 *   (hardened containment), verified against traversal/boundary variants and
 *   valid paths — never against the authorized-scope gate (step 3), which
 *   stays intact.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetMemoryPath } from "../src/commands/manual-ops.ts";
import type { ManualOpsDeps } from "../src/commands/manual-ops.ts";
import { guardCandidate } from "../src/backend/guard.ts";
import { KiwiFSAdapter } from "../src/backend/adapter.ts";
import { mintOpId, createMemoryLedger } from "../src/backend/opid.ts";
import { createFakeServer } from "./fake-mcp-server.ts";
import { pathWithinMemoryNamespace } from "../src/domain/paths.ts";

// Synthetic canaries — fixture patterns only, never real secrets.
const CANARY_API_KEY = "sk-synthetic0123456789abcdefABCDEF";
const CANARY_GITHUB = "ghp_" + "S0123456789abcdefghijklmnopqrstuvwxyz";

function forgetDoc(scope = "project/demo"): string {
  return `---\nscope: ${scope}\nmemory_status: active\ncreated: 2026-01-01T00:00:00Z\n---\n\nSynthetic record body.\n`;
}

function fakeForgetStore(doc: string) {
  const calls: { forgetArgs: Record<string, unknown> }[] = [];
  return {
    calls,
    store: {
      async read() {
        return {
          state: "ok" as const,
          content: doc,
          frontmatter: { scope: "project/demo", memory_status: "active" },
          body: "Synthetic record body.",
        };
      },
      async write() {
        return {};
      },
      async forget(_path: string, opts: { reason?: string; opId: string }) {
        // Mirror what KiwiFSAdapter.forget sends over the wire: the reason
        // becomes the backend `superseded_reason` argument.
        const args: Record<string, unknown> = { path: _path, opId: opts.opId };
        if (opts.reason !== undefined) args["superseded_reason"] = opts.reason;
        calls.push({ forgetArgs: args });
        return {};
      },
    },
  };
}

type Sink = Pick<
  ManualOpsDeps,
  "opLog" | "openStore" | "path" | "reason" | "actor"
>;

function makeDeps(
  dir: string,
  opLog: ManualOpsDeps["opLog"],
  store: unknown,
  reason: string,
): Sink {
  return {
    opLog,
    openStore: async () => store as never,
    path: "project/demo/memory/observations/x.md",
    reason,
    actor: "synthetic-test",
  };
}

// ManualOpLog re-imported lazily to keep the top of the file tidy.
import { ManualOpLog } from "../src/commands/manual-ops.ts";

test("forget reason with secret canaries is redacted in BOTH durable sinks (op log + backend args)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q03b-redact-"));
  try {
    const opLog = new ManualOpLog(dir);
    const fake = fakeForgetStore(forgetDoc());
    const result = await forgetMemoryPath(
      makeDeps(
        dir,
        opLog,
        fake.store,
        `remove because key leaked: ${CANARY_API_KEY} and ${CANARY_GITHUB}`,
      ),
    );
    assert.equal(result.ok, true);

    // Backend sink: the args the adapter would send carry only the
    // structural placeholder, never any canary material.
    assert.equal(fake.calls.length, 1);
    const wire = JSON.stringify(fake.calls[0]!.forgetArgs);
    assert.match(wire, /superseded_reason/);
    assert.match(wire, /\[REDACTED:api-key:\d+\]/);
    assert.match(wire, /\[REDACTED:github-token:\d+\]/);
    assert.ok(!wire.includes(CANARY_API_KEY), "raw api-key canary on the wire");
    assert.ok(!wire.includes(CANARY_GITHUB), "raw github canary on the wire");

    // Local sink: the op log JSONL on disk is sanitized too.
    const raw = readFileSync(join(dir, "manual-oplog.jsonl"), "utf8");
    assert.match(raw, /"action":"forget"/);
    assert.match(raw, /"reason":"/);
    assert.ok(!raw.includes(CANARY_API_KEY), "raw canary in local op log");
    assert.ok(!raw.includes(CANARY_GITHUB), "raw canary in local op log");
    assert.match(raw, /\[REDACTED:api-key:/);

    // Result detail never discloses the reason text.
    assert.ok(!JSON.stringify(result).includes(CANARY_API_KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forget reason that cannot be classified is HELD, not persisted (fail closed on the reason only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q03b-held-"));
  try {
    const opLog = new ManualOpLog(dir);
    const fake = fakeForgetStore(forgetDoc());
    // Control characters make redaction fail closed (redactText held:true).
    const hostile = `clop\u0007 ${CANARY_API_KEY}\u0007`;
    const result = await forgetMemoryPath(
      makeDeps(dir, opLog, fake.store, hostile),
    );
    // The forget itself proceeds (reason is optional metadata); the reason
    // is dropped from both sinks and the hold is disclosed.
    assert.equal(result.ok, true);
    assert.match(result.detail, /reason held/);
    assert.equal(fake.calls.length, 1);
    const wire = JSON.stringify(fake.calls[0]!.forgetArgs);
    assert.ok(!("superseded_reason" in fake.calls[0]!.forgetArgs));
    assert.ok(!wire.includes(CANARY_API_KEY));
    const raw = readFileSync(join(dir, "manual-oplog.jsonl"), "utf8");
    assert.ok(!raw.includes("reason"), "held reason persisted to op log");
    assert.ok(!raw.includes("\u0007"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clean forget reason still flows (redaction must not over-scrub ordinary text)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-q03b-clean-"));
  try {
    const opLog = new ManualOpLog(dir);
    const fake = fakeForgetStore(forgetDoc());
    const result = await forgetMemoryPath(
      makeDeps(dir, opLog, fake.store, "superseded by corrected observation"),
    );
    assert.equal(result.ok, true);
    assert.equal(
      fake.calls[0]!.forgetArgs["superseded_reason"],
      "superseded by corrected observation",
    );
    const raw = readFileSync(join(dir, "manual-oplog.jsonl"), "utf8");
    assert.match(raw, /superseded by corrected observation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- hardened namespace containment (guard step 4) --------------------------

const URL = "https://kiwifs.test/mcp"; // loopback only: never contacted

function adapterWithDoc(path: string, docText: string): KiwiFSAdapter {
  const server = createFakeServer();
  server.state.store.set(path, docText);
  server.state.etags.set(path, "etag-q03b");
  const adapter = new KiwiFSAdapter({
    url: URL,
    fetchImpl: server.fetch,
    ledger: createMemoryLedger(),
  });
  return adapter;
}

test("guard step 4: traversal and prefix-boundary variants are rejected; valid paths still pass", async () => {
  const doc = forgetDoc("project/demo-proj");
  const good = "project/demo-proj/memory/observations/x.md";
  const base = { authorizedScopes: ["project/demo-proj", "personal"] };

  // Valid path inside the namespace passes the full guard.
  const okRes = await guardCandidate(good, {
    ...base,
    adapter: adapterWithDoc(good, doc),
  });
  assert.equal(okRes.ok, true, JSON.stringify(okRes));

  for (const hostile of [
    "project/demo-proj/memory/../memory-evil/x.md",
    "project/demo-proj/memory/observations/../secret.md",
    "project/demo-proj/memory-evil/x.md",
    "project/demo-proj/memoryx/x.md",
  ]) {
    const res = await guardCandidate(hostile, {
      ...base,
      adapter: adapterWithDoc(hostile, doc),
    });
    assert.ok(!res.ok, `expected rejection: ${hostile}`);
    if (!res.ok) assert.equal(res.step, "path-prefix", hostile);
  }

  // `..` inside the record FILENAME position is contained too.
  const dotdot = "project/demo-proj/memory/observations/..%2Fx.md";
  const helper = pathWithinMemoryNamespace(dotdot, "project/demo-proj");
  assert.equal(helper, true); // literal %2f is just a name; no real traversal
  const realTraversal = "project/demo-proj/memory/observations/../../x.md";
  assert.equal(
    pathWithinMemoryNamespace(realTraversal, "project/demo-proj"),
    false,
  );
});

test("guard step 4: scope gate is NOT weakened — unauthorized scope still rejected at step 3", async () => {
  const doc = forgetDoc("cross/other");
  const p = "cross/other/memory/observations/x.md";
  const res = await guardCandidate(p, {
    authorizedScopes: ["project/demo-proj", "personal"],
    adapter: adapterWithDoc(p, doc),
  });
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.step, "scope");
});
