import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepMerge, loadConfig } from "../src/config/loader.ts";
import {
  DEFAULT_CONFIG,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_MODEL_ROUTE,
  effectiveFeatures,
  validateConfig,
} from "../src/config/schema.ts";
import {
  resolvedStatusLines,
  statusIsSecretFree,
} from "../src/config/status.ts";

function base(over: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: 1, enabled: false, ...over };
}

// ---------- validation: URLs ----------

test("rejects invalid mcp URLs", () => {
  for (const url of [
    "not-a-url",
    "ftp://host/mcp",
    "host:3333/mcp",
    "https://",
  ]) {
    const result = validateConfig(base({ mcp: { url } }));
    assert.equal(result.ok, false, url);
    if (!result.ok) {
      assert.ok(
        result.issues.some((i) => i.path === "mcp.url"),
        url,
      );
    }
  }
});

test("accepts valid http(s) URL and normalizes it", () => {
  const result = validateConfig(
    base({ mcp: { url: "https://host:3333/mcp" } }),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.config.mcp.url, "https://host:3333/mcp");
});

test("rejects credentials embedded in the URL (must use auth by reference)", () => {
  const result = validateConfig(
    base({ mcp: { url: "https://user:secret@host/mcp" } }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.issues.some(
        (i) => i.path === "mcp.url" && /credentials/.test(i.message),
      ),
    );
  }
});

// ---------- validation: credentials ----------

test("rejects inline header credentials (headers key not allowed)", () => {
  const result = validateConfig(
    base({
      enabled: true,
      mcp: { url: "https://host/mcp", headers: { Authorization: "Bearer x" } },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.ok(result.issues.some((i) => i.path.startsWith("mcp.headers")));
});

test("enabled config without a credential reference fails", () => {
  const result = validateConfig(
    base({ enabled: true, mcp: { url: "https://host/mcp" } }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some((i) => i.path === "mcp.auth"));
});

test("env and file credential references are accepted; bare values are not", () => {
  const env = validateConfig(
    base({
      enabled: true,
      mcp: {
        url: "https://host/mcp",
        auth: { kind: "env", ref: "KIWIFS_API_KEY" },
      },
    }),
  );
  assert.equal(env.ok, true);
  const file = validateConfig(
    base({
      enabled: true,
      mcp: {
        url: "https://host/mcp",
        auth: { kind: "file", ref: "/run/secrets/kiwifs-key" },
      },
    }),
  );
  assert.equal(file.ok, true);
  const badEnv = validateConfig(
    base({ mcp: { auth: { kind: "env", ref: "not a var!" } } }),
  );
  assert.equal(badEnv.ok, false);
  const relFile = validateConfig(
    base({ mcp: { auth: { kind: "file", ref: "secrets/key" } } }),
  );
  assert.equal(relFile.ok, false);
});

// ---------- validation: model credential reference (T10) ----------

test("model.auth by reference is accepted; unknown model keys are rejected", () => {
  const ok = validateConfig(
    base({
      model: {
        route: "openrouter/z-ai/glm-5.3-flash",
        auth: { kind: "env", ref: "KIWIFS_MODEL_KEY" },
      },
    }),
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.config.model.auth, {
      kind: "env",
      ref: "KIWIFS_MODEL_KEY",
    });
  }
  const badVar = validateConfig(
    base({ model: { auth: { kind: "env", ref: "not a var!" } } }),
  );
  assert.equal(badVar.ok, false);
  const unknownKey = validateConfig(
    base({ model: { headers: { Authorization: "Bearer x" } } }),
  );
  assert.equal(unknownKey.ok, false);
  if (!unknownKey.ok)
    assert.ok(unknownKey.issues.some((i) => i.path.startsWith("model.")));
});

test("status renders model credential by reference and fail-closed note without it", () => {
  const withAuth = validateConfig(
    base({
      model: {
        route: "openrouter/z-ai/glm-5.3-flash",
        auth: { kind: "file", ref: "/run/secrets/kiwifs-model-key" },
      },
    }),
  );
  assert.equal(withAuth.ok, true);
  if (withAuth.ok) {
    const text = resolvedStatusLines(withAuth.config).join("\n");
    assert.match(
      text,
      /model credentials: file:\/run\/secrets\/kiwifs-model-key/,
    );
    assert.ok(statusIsSecretFree(resolvedStatusLines(withAuth.config)));
  }
  const withoutAuth = validateConfig(base({}));
  assert.equal(withoutAuth.ok, true);
  if (withoutAuth.ok) {
    const text = resolvedStatusLines(withoutAuth.config).join("\n");
    assert.match(
      text,
      /model credentials: not configured — extraction fails closed/,
    );
  }
});

test("disabled config may omit url and auth entirely (defaults)", () => {
  const result = validateConfig(base({}));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.mcp.url, "");
    assert.equal(result.config.mcp.auth, undefined);
    assert.equal(result.config.enabled, false);
  }
});

// ---------- validation: conflicts and unknown keys ----------

test("unknown top-level keys are a validation conflict", () => {
  const result = validateConfig(
    base({ mcpUrl: "https://host/mcp", extra: true }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((i) => i.path === "mcpUrl"));
    assert.ok(result.issues.some((i) => i.path === "extra"));
  }
});

test("unknown newer schemaVersion fails safely with a visible refusal", () => {
  const result = validateConfig(base({ schemaVersion: 2 }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.issues.some(
        (i) => /newer/.test(i.message) && /refusing/.test(i.message),
      ),
    );
  }
});

test("older schemaVersion is rejected (explicit upgrade required)", () => {
  const result = validateConfig(base({ schemaVersion: 0 }));
  assert.equal(result.ok, false);
});

test("non-object and wrong-typed values fail", () => {
  assert.equal(validateConfig(null).ok, false);
  assert.equal(validateConfig([1]).ok, false);
  assert.equal(
    validateConfig(base({ budgets: { ragDeadlineMs: -5 } })).ok,
    false,
  );
  assert.equal(
    validateConfig(base({ features: { observation: "yes" } })).ok,
    false,
  );
  assert.equal(
    validateConfig(base({ model: { route: "just-a-model" } })).ok,
    false,
  );
});

// ---------- model route default ----------

test("model route defaults to the confirmed GLM default", () => {
  const result = validateConfig(base({}));
  assert.equal(result.ok, true);
  if (result.ok)
    assert.equal(result.config.model.route, "openrouter/z-ai/glm-5.3-flash");
  assert.equal(DEFAULT_MODEL_ROUTE, "openrouter/z-ai/glm-5.3-flash");
});

// ---------- private mode: all three domains ----------

test("private mode disables all three feature domains, not only observation", () => {
  const cfg = validateConfig(
    base({
      privateMode: true,
      features: { observation: true, backup: true, board: true },
    }),
  );
  assert.equal(cfg.ok, true);
  if (cfg.ok) {
    const eff = effectiveFeatures(cfg.config);
    assert.deepEqual(eff, { observation: false, backup: false, board: false });
  }
});

test("without private mode, feature flags pass through", () => {
  const cfg = validateConfig(
    base({ features: { observation: true, backup: false, board: false } }),
  );
  assert.equal(cfg.ok, true);
  if (cfg.ok) {
    assert.deepEqual(effectiveFeatures(cfg.config), {
      observation: true,
      backup: false,
      board: false,
    });
  }
});

// ---------- status output: nonsecret settings only ----------

function validConfig(): ReturnType<typeof validateConfig> {
  return validateConfig(
    base({
      enabled: true,
      mcp: {
        url: "https://host:3333/mcp",
        auth: { kind: "env", ref: "KIWIFS_API_KEY" },
      },
      projectIdentity: "example.com/org/repo",
    }),
  );
}

test("status exposes resolved nonsecret settings and no secret material", () => {
  const r = validConfig();
  assert.equal(r.ok, true);
  if (r.ok) {
    const lines = resolvedStatusLines(r.config);
    const text = lines.join("\n");
    assert.match(text, /https:\/\/host:3333\/mcp/);
    assert.match(text, /env:KIWIFS_API_KEY/);
    assert.match(text, /openrouter\/z-ai\/glm-5.3-flash/);
    assert.match(text, /cross-project reads denied by default/);
    // The resolved secret value must never appear (it never entered config).
    assert.ok(statusIsSecretFree(lines));
    assert.ok(!/Bearer\s/.test(text));
  }
});

test("status defensive check rejects token-like lines", () => {
  assert.equal(
    statusIsSecretFree([
      "credentials: 0000000000000000000000000000000000000000000000000000000000000000",
    ]),
    false,
  );
  assert.equal(statusIsSecretFree(["endpoint: https://host/mcp"]), true);
});

// ---------- loader: precedence and file handling ----------

test("deepMerge: later sources win, objects merge, arrays replace", () => {
  const merged = deepMerge(
    { a: { x: 1, y: 2 }, b: [1, 2] },
    { a: { y: 3 }, b: [9] },
  );
  assert.deepEqual(merged, { a: { x: 1, y: 3 }, b: [9] });
});

test("loader precedence: defaults < file < explicit overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-cfg-"));
  const file = join(dir, "kiwifs-memory.json");
  writeFileSync(
    file,
    JSON.stringify({
      enabled: true,
      mcp: {
        url: "https://file-host/mcp",
        auth: { kind: "env", ref: "FILE_VAR" },
      },
    }),
  );
  // Defaults only (no file).
  const r0 = loadConfig({});
  assert.equal(r0.ok, true);
  if (r0.ok) {
    assert.equal(r0.config.enabled, false);
    assert.equal(r0.config.mcp.url, "");
    assert.equal(r0.config.model.route, DEFAULT_MODEL_ROUTE);
    assert.equal(r0.config.budgets.ragDeadlineMs, 2000);
    assert.equal(r0.config.budgets.evidenceTokenCap, 3000);
  }
  // File beats defaults.
  const r1 = loadConfig({ file });
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.config.enabled, true);
    assert.equal(r1.config.mcp.url, "https://file-host/mcp");
    assert.equal(r1.config.model.route, DEFAULT_MODEL_ROUTE);
  }
  // Explicit overrides beat file; objects merge across levels.
  const r2 = loadConfig({
    file,
    overrides: {
      enabled: false,
      mcp: { url: "https://override-host/mcp" },
      budgets: { ragDeadlineMs: 1500 },
    },
  });
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(r2.config.enabled, false);
    assert.equal(r2.config.mcp.url, "https://override-host/mcp");
    // auth comes from the file layer (not overridden), merged across levels.
    assert.equal(r2.config.mcp.auth?.kind, "env");
    assert.equal(r2.config.mcp.auth?.ref, "FILE_VAR");
    assert.equal(r2.config.budgets.ragDeadlineMs, 1500);
    assert.equal(r2.config.budgets.evidenceTokenCap, 3000);
  }
});

test("loader: missing file with no env is defaults; unreadable file is a fatal error", () => {
  const r1 = loadConfig({ file: "/definitely/not/here.json" });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.ok(r1.fatal?.includes("unreadable"));
  const r2 = loadConfig({});
  assert.equal(r2.ok, true);
});

test("loader: invalid JSON and non-object JSON are fatal, visible", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-cfg-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{nope");
  const r = loadConfig({ file: bad });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.fatal ?? "", /not valid JSON/);
  const notObj = join(dir, "arr.json");
  writeFileSync(notObj, "[1,2]");
  const r2 = loadConfig({ file: notObj });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.fatal ?? "", /not a JSON object/);
});

test("loader propagates validation issues from the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-cfg-"));
  const file = join(dir, "c.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 9, mcp: { url: "x" } }));
  const r = loadConfig({ file });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok((r.issues ?? []).length > 0);
});

test("env var KIWIFS_MEMORY_CONFIG selects the config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-cfg-"));
  const file = join(dir, "via-env.json");
  writeFileSync(file, JSON.stringify({ privateMode: true }));
  process.env["KIWIFS_MEMORY_CONFIG"] = file;
  try {
    const r = loadConfig();
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.config.privateMode, true);
  } finally {
    delete process.env["KIWIFS_MEMORY_CONFIG"];
  }
});

test("defaults object is not mutated by validation", () => {
  validateConfig(base({ budgets: { ragDeadlineMs: 7 } }));
  assert.equal(DEFAULT_CONFIG.budgets.ragDeadlineMs, 2000);
});
