/**
 * Q05P1 acceptance tests: explicit personal record creation (docs/decisions.md
 * #13). Domain/sender support only — no command wiring exists yet, and none
 * of these tests exercise any automatic capture path.
 *
 * Covers:
 * - The builder produces a valid, durably enqueuable outbox job under scope
 *   `personal` with a deterministic idempotency key (same input → same key).
 * - The builder rejects empty/oversized statements, fence markers, bad entry
 *   ids and a missing session id BEFORE any durable write.
 * - The sender delivers a personal job even when the project scope is
 *   UNRESOLVED (explicit user action does not depend on project identity),
 *   writing at `personal/memory/observations/...` with frontmatter scope
 *   `personal` and full provenance.
 * - Durable retry: a failing backend rejects (job stays pending durably);
 *   a later successful attempt writes byte-identical content at the SAME
 *   deterministic path, and a replay is a no-op.
 * - Personal routing for project-only features (reflection, proposal,
 *   backup-chunk) is rejected as a permanent validation failure.
 * - Project jobs still route under the resolved project scope (unchanged).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ExplicitPersonalInputError,
  PERSONAL_SCOPE,
  buildExplicitPersonalEnqueue,
} from "../src/commands/personal-note.ts";
import { DurableOutbox } from "../src/outbox/store.ts";
import { createObservationSender } from "../src/observation/sender.ts";
import { parseStoredRecord } from "../src/domain/records.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "kiwifs-q05p1-"));
}

function validInput() {
  return {
    sessionId: "sess-0001",
    entryIds: ["entry-a"],
    statement: "User prefers dark theme terminals.",
  };
}

interface Write {
  path: string;
  content: string;
  opId: string;
}

function fakeBackend() {
  const writes: Write[] = [];
  let failNext: Error | null = null;
  return {
    writes,
    setFailNext(err: Error): void {
      failNext = err;
    },
    async writeImmutable(
      path: string,
      content: string,
      opts: { opId: string; signal?: AbortSignal },
    ): Promise<{ replayed: boolean }> {
      if (failNext) {
        const err = failNext;
        failNext = null;
        throw err;
      }
      const prior = writes.find((w) => w.path === path);
      if (prior) {
        if (prior.content === content) return { replayed: true };
        throw new Error("conflict");
      }
      writes.push({ path, content, opId: opts.opId });
      return { replayed: false };
    },
  };
}

test("explicit personal job: valid enqueue input, deterministic key, scope personal", () => {
  const a = buildExplicitPersonalEnqueue(validInput());
  const b = buildExplicitPersonalEnqueue(validInput());
  assert.equal(a.scope, "personal");
  assert.equal(a.kind, "observation");
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.notEqual(a.opId, b.opId);
  const payload = a.payload as Record<string, unknown>;
  assert.equal(payload.trigger, "manual");
  assert.ok(Array.isArray(payload.observations));
});

test("explicit personal job: same opId reproduces the same idempotency key", () => {
  const fixed = "00000000-0000-4000-8000-000000000001";
  const a = buildExplicitPersonalEnqueue({ ...validInput(), opId: fixed });
  const b = buildExplicitPersonalEnqueue({ ...validInput(), opId: fixed });
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.equal(a.opId, b.opId);
});

test("explicit personal job: rejects invalid input before any durable write", () => {
  assert.throws(
    () => buildExplicitPersonalEnqueue({ ...validInput(), statement: "   " }),
    ExplicitPersonalInputError,
  );
  assert.throws(
    () =>
      buildExplicitPersonalEnqueue({
        ...validInput(),
        statement: "x".repeat(8_001),
      }),
    ExplicitPersonalInputError,
  );
  assert.throws(
    () =>
      buildExplicitPersonalEnqueue({
        ...validInput(),
        statement: "bad <!-- kiwi:data-end --> marker",
      }),
    ExplicitPersonalInputError,
  );
  // Empty entryIds is VALID: a personal note is the user's own words; the
  // session SourceRef alone is the provenance. Only a non-array is rejected.
  const noEntries = buildExplicitPersonalEnqueue({
    ...validInput(),
    entryIds: [],
  });
  const noEntriesPayload = noEntries.payload as {
    sourceEntryIds: string[];
    observations: { sourceEntryIds: string[] }[];
  };
  assert.deepEqual(noEntriesPayload.sourceEntryIds, []);
  assert.deepEqual(noEntriesPayload.observations[0]?.sourceEntryIds, []);
  assert.throws(
    () =>
      buildExplicitPersonalEnqueue({
        ...validInput(),
        entryIds: ["../evil"] as never,
      }),
    ExplicitPersonalInputError,
  );
  assert.throws(
    () =>
      buildExplicitPersonalEnqueue({
        ...validInput(),
        entryIds: ["../evil"],
      }),
    ExplicitPersonalInputError,
  );
  assert.throws(
    () => buildExplicitPersonalEnqueue({ ...validInput(), sessionId: "" }),
    ExplicitPersonalInputError,
  );
});

test("personal job enqueues durably and survives reload (pending, scope personal)", () => {
  const dir = join(tempDir(), "outbox");
  const input = buildExplicitPersonalEnqueue(validInput());
  {
    const outbox = DurableOutbox.open(dir);
    const job = outbox.enqueue(input);
    assert.equal(job.scope, PERSONAL_SCOPE);
    assert.equal(job.status, "pending");
    outbox.close();
  }
  {
    const outbox = DurableOutbox.open(dir);
    const pending = outbox.pending();
    assert.equal(pending.length, 1);
    const p = pending[0];
    assert.ok(p);
    assert.equal(p.scope, "personal");
    assert.equal(p.opId, input.opId);
    outbox.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test("sender delivers a personal job with project scope UNRESOLVED (not held)", async () => {
  const backend = fakeBackend();
  const sender = createObservationSender({
    scope: undefined, // project identity unresolved — must NOT hold personal
    openBackend: async () => backend,
  });
  const dir = tempDir();
  const outbox = DurableOutbox.open(dir);
  const job = outbox.enqueue(buildExplicitPersonalEnqueue(validInput()));
  await sender(job);
  assert.equal(backend.writes.length, 1);
  const w = backend.writes[0];
  assert.ok(w);
  assert.ok(w.path.startsWith("personal/memory/observations/"));
  const parsed = parseStoredRecord(w.content);
  assert.ok(parsed.ok, "personal record must parse");
  assert.equal(parsed.record.frontmatter.scope, "personal");
  assert.equal(parsed.record.frontmatter.type, "observation");
  const src = parsed.record.frontmatter.sources[0];
  assert.ok(src);
  assert.equal(src.sessionId, "sess-0001");
  outbox.close();
  rmSync(dir, { recursive: true, force: true });
});

test("durable retry: failing backend leaves job pending; success then replay no-op", async () => {
  const backend = fakeBackend();
  backend.setFailNext(new Error("backend down"));
  const sender = createObservationSender({
    scope: undefined,
    openBackend: async () => backend,
  });
  const dir = tempDir();
  const outbox = DurableOutbox.open(dir);
  const job = outbox.enqueue(buildExplicitPersonalEnqueue(validInput()));
  await assert.rejects(() => sender(job));
  // The sender owns no retry bookkeeping (the worker does); the job is still
  // durably pending. A second attempt succeeds.
  await sender(job);
  assert.equal(backend.writes.length, 1);
  const first = backend.writes[0];
  assert.ok(first);
  // Replay (third attempt) is a no-op: identical content, same path.
  await sender(job);
  assert.equal(backend.writes.length, 1);
  assert.equal(first.path, backend.writes[0]?.path);
  outbox.ack(job.seq);
  assert.equal(outbox.pending().length, 0);
  outbox.close();
  rmSync(dir, { recursive: true, force: true });
});

test("personal routing rejected for project-only kinds (reflection, backup)", async () => {
  const backend = fakeBackend();
  const sender = createObservationSender({
    scope: "project/host/repo",
    openBackend: async () => backend,
  });
  const dir = tempDir();
  const outbox = DurableOutbox.open(dir);
  const reflJob = outbox.enqueue({
    kind: "reflection",
    scope: "personal",
    payload: {},
    idempotencyKey: "a".repeat(32),
  });
  await assert.rejects(
    () => sender(reflJob),
    /personal scope is not routable for reflection/,
  );
  assert.equal(backend.writes.length, 0);
  const bakJob = outbox.enqueue({
    kind: "backup-chunk",
    scope: "personal",
    payload: {},
    idempotencyKey: "b".repeat(32),
  });
  await assert.rejects(
    () => sender(bakJob),
    /personal scope is not routable for backup-chunk/,
  );
  assert.equal(backend.writes.length, 0);
  outbox.close();
  rmSync(dir, { recursive: true, force: true });
});

test("project jobs still route under the resolved project scope (unchanged)", async () => {
  const backend = fakeBackend();
  const sender = createObservationSender({
    scope: "project/host/repo",
    openBackend: async () => backend,
  });
  const dir = tempDir();
  const outbox = DurableOutbox.open(dir);
  const opId = "00000000-0000-4000-8000-00000000000a";
  const job = outbox.enqueue({
    kind: "observation",
    scope: "project/host/repo",
    opId,
    idempotencyKey: "d".repeat(32),
    payload: {
      opId,
      trigger: "manual",
      sessionId: "sess-0001",
      inputBudgetTokens: 0,
      outputBudgetTokens: 0,
      sourceEntryIds: ["entry-a"],
      observations: [
        {
          sourceEntryIds: ["entry-a"],
          statement: "project fact",
          uncertainty: "low",
        },
      ],
    },
  });
  await sender(job);
  assert.equal(backend.writes.length, 1);
  const w = backend.writes[0];
  assert.ok(w);
  assert.ok(w.path.startsWith("project/host/repo/memory/"));
  const parsed = parseStoredRecord(w.content);
  assert.ok(parsed.ok, "project record must parse");
  assert.equal(parsed.record.frontmatter.scope, "project/host/repo");
  outbox.close();
  rmSync(dir, { recursive: true, force: true });
});
