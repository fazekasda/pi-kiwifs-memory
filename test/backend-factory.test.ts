/**
 * Q06A acceptance tests: shared backend factory (behavior-preserving
 * extraction of the duplicated bearer-adapter construction).
 *
 * Synthetic fixtures only — the fake MCP server (in-process fetchImpl, no
 * sockets), throwaway env vars and temp secret files. No live service, no
 * real network, no real credentials, no credential-bearing config reads.
 *
 * Private-mode transitions and gate disposal are runtime-level guarantees
 * that already route through the factory in production composition
 * (`openConfiguredBackend` → `openBearerAdapter`); they stay covered by the
 * existing unmodified suites (q02a/q02c/q02-inflight/q04b/…), which these
 * tests do not duplicate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBearerAdapter,
  openBearerAdapter,
  resolveBearerSecret,
} from "../src/backend/factory.ts";
import {
  OpIdNotPersistedError,
  ResponseFormatError,
  TimeoutError,
} from "../src/backend/errors.ts";
import { createMemoryLedger, mintOpId } from "../src/backend/opid.ts";
import { createFakeServer } from "./fake-mcp-server.ts";

const URL = "https://kiwifs.test/mcp";
const SET_ENV_VAR = "KIWIFS_FACTORY_TEST_ENV_SECRET_0001";
const UNSET_ENV_VAR = "KIWIFS_FACTORY_TEST_DEFINITELY_UNSET_0000";
const ENV_SECRET = "synthetic-factory-env-secret-0001";
const FILE_SECRET = "synthetic-factory-file-secret-0002";
const DOC = `---\nscope: project/demo-proj\nmemory_status: active\n---\nSynthetic body.`;

/** Set/delete env vars for the test body, restore the prior state after. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Temp secret file (trimmed on read by the resolver), removed afterwards. */
async function withTempSecretFile(
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-factory-test-"));
  const path = join(dir, "kiwifs-secret");
  // Trailing newline pins the resolver's trim behavior at the factory.
  writeFileSync(path, `${FILE_SECRET}\n`, { mode: 0o600 });
  try {
    await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * buildBearerAdapter passes no fetchImpl (pre-extraction parity), so tests
 * drive it offline by swapping globalThis.fetch for the fake server's
 * in-process fetch and restoring it afterwards.
 */
async function withGlobalFetch(
  fetchImpl: typeof fetch,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------- missing auth: fail-closed, retryable hold ----------

test("openBearerAdapter returns undefined when the credential does not resolve", async () => {
  await withEnv({ [UNSET_ENV_VAR]: undefined }, async () => {
    const missingEnv = { kind: "env" as const, ref: UNSET_ENV_VAR };
    const missingFile = {
      kind: "file" as const,
      ref: join(tmpdir(), "kiwifs-factory-test-definitely-absent-0000"),
    };
    assert.equal(
      openBearerAdapter(URL, missingEnv, createMemoryLedger()),
      undefined,
    );
    assert.equal(
      openBearerAdapter(URL, missingFile, createMemoryLedger()),
      undefined,
    );
    // Whitespace-only env values are unresolvable too (resolver trims).
    await withEnv({ [UNSET_ENV_VAR]: "   " }, async () => {
      assert.equal(
        openBearerAdapter(URL, missingEnv, createMemoryLedger()),
        undefined,
      );
    });
  });
});

// ---------- openBearerAdapter: header parity, no I/O before connect ----------

test("openBearerAdapter builds the exact bearer header and performs no I/O before connect", async () => {
  await withEnv({ [SET_ENV_VAR]: ENV_SECRET }, async () => {
    const server = createFakeServer();
    const seen: (string | undefined)[] = [];
    server.behavior.authHeaderSeen = (v) => {
      seen.push(v);
    };
    const adapter = openBearerAdapter(
      URL,
      { kind: "env", ref: SET_ENV_VAR },
      createMemoryLedger(),
      { fetchImpl: server.fetch },
    );
    assert.ok(adapter);
    // Constructor guarantee: connect() is the only I/O point.
    assert.equal(server.state.requests.length, 0);
    const caps = await adapter.connect();
    assert.ok(caps.tools.includes("kiwi_read"));
    assert.ok(seen.length >= 2); // initialize + tools/list
    for (const header of seen) {
      assert.equal(header, `Bearer ${ENV_SECRET}`);
    }
  });
});

test("openBearerAdapter resolves file references with the resolver's trim semantics", async () => {
  const server = createFakeServer();
  const seen: (string | undefined)[] = [];
  server.behavior.authHeaderSeen = (v) => {
    seen.push(v);
  };
  await withTempSecretFile(async (path) => {
    const adapter = openBearerAdapter(
      URL,
      { kind: "file", ref: path },
      createMemoryLedger(),
      { fetchImpl: server.fetch },
    );
    assert.ok(adapter);
    await adapter.connect();
    for (const header of seen) {
      assert.equal(header, `Bearer ${FILE_SECRET}`); // newline trimmed
    }
  });
});

// ---------- buildBearerAdapter: guard parity with the pre-extraction sites ----------

test("buildBearerAdapter sends the same bearer header shape for resolvable credentials", async () => {
  await withEnv({ [SET_ENV_VAR]: ENV_SECRET }, async () => {
    const server = createFakeServer();
    const seen: (string | undefined)[] = [];
    server.behavior.authHeaderSeen = (v) => {
      seen.push(v);
    };
    await withGlobalFetch(server.fetch, async () => {
      const adapter = buildBearerAdapter(
        URL,
        { kind: "env", ref: SET_ENV_VAR },
        createMemoryLedger(),
      );
      assert.ok(adapter);
      assert.equal(server.state.requests.length, 0);
      await adapter.connect();
      for (const header of seen) {
        assert.equal(header, `Bearer ${ENV_SECRET}`);
      }
    });
  });
});

test("buildBearerAdapter preserves the empty-token fallback verbatim when the credential unresolves despite the caller guard", async () => {
  await withEnv({ [UNSET_ENV_VAR]: undefined }, async () => {
    const server = createFakeServer();
    const seen: (string | undefined)[] = [];
    server.behavior.authHeaderSeen = (v) => {
      seen.push(v);
    };
    await withGlobalFetch(server.fetch, async () => {
      // Pre-extraction behavior: the outer hold check fired earlier, but the
      // construction itself never threw and never substituted a default
      // credential — the `?? ""` fallback sent an empty token. Preserved.
      const adapter = buildBearerAdapter(
        URL,
        { kind: "env", ref: UNSET_ENV_VAR },
        createMemoryLedger(),
      );
      assert.ok(adapter);
      await adapter.connect();
      for (const header of seen) {
        // The Headers API strips the trailing space, so the recorded value is
        // "Bearer" — the wire token is empty either way, exactly as before.
        assert.equal(header, "Bearer");
      }
    });
  });
});

// ---------- ledger: the mutation-safety dependency threads unchanged ----------

test("openBearerAdapter threads the caller's ledger: mutations fail closed without a persisted opId", async () => {
  await withEnv({ [SET_ENV_VAR]: ENV_SECRET }, async () => {
    const server = createFakeServer();
    const ledger = createMemoryLedger();
    const adapter = openBearerAdapter(
      URL,
      { kind: "env", ref: SET_ENV_VAR },
      ledger,
      { fetchImpl: server.fetch },
    );
    assert.ok(adapter);
    await adapter.connect();
    const path = "project/demo-proj/memory/observations/q06a.md";
    const opId = mintOpId();
    await assert.rejects(
      adapter.write(path, DOC, { opId }),
      OpIdNotPersistedError,
    );
    assert.ok(!server.state.store.has(path)); // no side effect happened
    ledger.record(opId);
    await adapter.write(path, DOC, { opId });
    assert.ok(server.state.store.get(path)?.includes("Synthetic body."));
  });
});

test("buildBearerAdapter threads the caller's ledger with the same fail-closed contract", async () => {
  await withEnv({ [SET_ENV_VAR]: ENV_SECRET }, async () => {
    const server = createFakeServer();
    const ledger = createMemoryLedger();
    const path = "project/demo-proj/memory/observations/q06a-b.md";
    await withGlobalFetch(server.fetch, async () => {
      const adapter = buildBearerAdapter(
        URL,
        { kind: "env", ref: SET_ENV_VAR },
        ledger,
      );
      await adapter.connect();
      const opId = mintOpId();
      await assert.rejects(
        adapter.write(path, DOC, { opId }),
        OpIdNotPersistedError,
      );
      assert.ok(!server.state.store.has(path));
      ledger.record(opId);
      await adapter.write(path, DOC, { opId });
      assert.ok(server.state.store.get(path)?.includes("Synthetic body."));
    });
  });
});

// ---------- transport defaults: no implicit limit drift ----------

test("omitting extra keeps the transport defaults; provided limits thread through", async () => {
  await withEnv({ [SET_ENV_VAR]: ENV_SECRET }, async () => {
    // Default path (no extra): connect + recorded-opId write round-trip
    // through the fake server — transport defaults (10 s / 48 MiB) apply.
    {
      const server = createFakeServer();
      const ledger = createMemoryLedger();
      const adapter = openBearerAdapter(
        URL,
        { kind: "env", ref: SET_ENV_VAR },
        ledger,
        { fetchImpl: server.fetch },
      );
      assert.ok(adapter);
      await adapter.connect();
      const opId = mintOpId();
      ledger.record(opId);
      const path = "project/demo-proj/memory/observations/q06a-defaults.md";
      await adapter.write(path, DOC, { opId });
      assert.ok(server.state.store.get(path)?.includes("Synthetic body."));
    }
    // maxResponseBytes threads through `extra` (typed fail-closed bound).
    {
      const server = createFakeServer({ oversizedBodyBytes: 2 * 1024 * 1024 });
      const adapter = openBearerAdapter(
        URL,
        { kind: "env", ref: SET_ENV_VAR },
        createMemoryLedger(),
        { maxResponseBytes: 64 * 1024, fetchImpl: server.fetch },
      );
      assert.ok(adapter);
      await assert.rejects(
        adapter.connect(),
        (err: unknown) =>
          err instanceof ResponseFormatError && /bound/.test(err.message),
      );
    }
    // requestTimeoutMs threads through `extra` (per-request deadline).
    {
      const server = createFakeServer({ hang: true });
      const adapter = openBearerAdapter(
        URL,
        { kind: "env", ref: SET_ENV_VAR },
        createMemoryLedger(),
        { requestTimeoutMs: 60, fetchImpl: server.fetch },
      );
      assert.ok(adapter);
      const start = Date.now();
      await assert.rejects(adapter.connect(), TimeoutError);
      assert.ok(Date.now() - start < 2000);
    }
  });
});

// ---------- resolveBearerSecret: pure named re-export ----------

test("resolveBearerSecret matches the resolver contract for env and file references", async () => {
  await withEnv(
    { [SET_ENV_VAR]: ENV_SECRET, [UNSET_ENV_VAR]: undefined },
    async () => {
      assert.equal(
        resolveBearerSecret({ kind: "env", ref: SET_ENV_VAR }),
        ENV_SECRET,
      );
      assert.equal(
        resolveBearerSecret({ kind: "env", ref: UNSET_ENV_VAR }),
        undefined,
      );
      await withTempSecretFile(async (path) => {
        assert.equal(
          resolveBearerSecret({ kind: "file", ref: path }),
          FILE_SECRET,
        );
      });
      assert.equal(
        resolveBearerSecret({
          kind: "file",
          ref: join(tmpdir(), "kiwifs-factory-test-definitely-absent-0000"),
        }),
        undefined,
      );
    },
  );
});
