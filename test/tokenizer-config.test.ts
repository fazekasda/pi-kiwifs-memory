/**
 * T13 — configurable tokenizer loading, config schema parsing, tokenizer
 * readiness timing, and cross-project opt-in scope mapping
 * (test/tokenizer-config.test.ts).
 *
 * - `loadConfiguredTokenizer`: success (default + named export, relative
 *   path resolution), load failure, malformed exports, throwing / NaN /
 *   negative counts fail closed to `undefined` (never a char estimate).
 * - `validateConfig`: `budgets.tokenizer` accepted/rejected shapes.
 * - Readiness timing: a coordinator constructed without a tokenizer skips
 *   automatic injection with the visible note; a tokenizer attached later
 *   covers only inputs retrieved AFTER attachment and never overrides an
 *   existing one (T13 §13 row 5).
 * - Cross-project opt-in mapping: config `scopes.crossProjectOptIn` maps
 *   through `authorizedScopeSet` into the session scope set that gates
 *   both retrieval and the recall tools; non-`cross/` values fail closed.
 *
 * Synthetic local fixtures only.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfiguredTokenizer } from "../src/retrieval/tokenizer.ts";
import {
  TOKENIZER_UNAVAILABLE_NOTE,
  type EvidenceTokenizer,
} from "../src/retrieval/tokenizer.ts";
import { validateConfig, DEFAULT_CONFIG } from "../src/config/schema.ts";
import {
  authorizedScopeSet,
  scopeIsAuthorized,
} from "../src/scope/identity.ts";
import { RetrievalCoordinator } from "../src/retrieval/coordinator.ts";

const WORD_TOKENIZER: EvidenceTokenizer = {
  id: "test-words",
  countTokens: (t) => t.trim().split(/\s+/).length,
};

function makeAdapter() {
  return {
    async searchFts() {
      return { hits: [], text: "" };
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
    async read() {
      return { state: "missing", frontmatter: {}, body: "" };
    },
  } as unknown as ConstructorParameters<
    typeof RetrievalCoordinator
  >[0]["adapter"];
}

// ---- tokenizer module loading ----------------------------------------------

test("configured tokenizer loads with default and named export; relative paths resolve against baseDir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-tok-cfg-"));
  try {
    writeFileSync(
      join(dir, "good.mjs"),
      "export const tokenizer = { id: 'tok-a', countTokens: (t) => t.length };",
    );
    const byDefault = await loadConfiguredTokenizer(
      { module: "./good.mjs" },
      dir,
    );
    assert.ok(byDefault.ok);
    assert.equal(byDefault.ok && byDefault.tokenizer.id, "tok-a");
    assert.equal(byDefault.ok && byDefault.tokenizer.countTokens("abcd"), 4);

    writeFileSync(
      join(dir, "named.mjs"),
      "export const custom = { id: 'tok-b', countTokens: () => 7 };",
    );
    const named = await loadConfiguredTokenizer(
      { module: join(dir, "named.mjs"), export: "custom" },
      dir,
    );
    assert.ok(named.ok);
    assert.equal(named.ok && named.tokenizer.id, "tok-b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tokenizer module failures are sanitized and fail closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-tok-cfg-"));
  try {
    const missing = await loadConfiguredTokenizer(
      { module: join(dir, "absent.mjs") },
      dir,
    );
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.match(missing.reason, /failed to load/);
      assert.match(missing.reason, /absent\.mjs/, "own config path is echoed");
    }

    // Non-object export, missing id, empty id, non-function countTokens.
    for (const [src, name] of [
      ["export const tokenizer = 42;", "not-an-object"],
      ["export const tokenizer = { countTokens: (t) => t.length };", "no-id"],
      [
        "export const tokenizer = { id: '', countTokens: () => 1 };",
        "empty-id",
      ],
      [
        "export const tokenizer = { id: 'x', countTokens: 'nope' };",
        "bad-count",
      ],
      ["export const other = {}; export const tokenizer = undefined;", "undef"],
    ] as const) {
      writeFileSync(join(dir, `${name}.mjs`), src);
      const r = await loadConfiguredTokenizer(
        { module: join(dir, `${name}.mjs`) },
        dir,
      );
      assert.equal(r.ok, false, `${name} must fail closed`);
    }

    // A throwing countTokens loads but yields undefined at count time.
    writeFileSync(
      join(dir, "throwing.mjs"),
      "export const tokenizer = { id: 't', countTokens: () => { throw new Error('boom'); } };",
    );
    const throwing = await loadConfiguredTokenizer(
      { module: join(dir, "throwing.mjs") },
      dir,
    );
    assert.ok(throwing.ok);
    assert.equal(
      throwing.ok && throwing.tokenizer.countTokens("text"),
      undefined,
    );
    assert.equal(throwing.ok && throwing.tokenizer.countTokens(""), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tokenizer counts that are NaN, negative, or non-finite are unreliable → undefined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwifs-tok-cfg-"));
  try {
    for (const [expr, name] of [
      ["NaN", "nan"],
      ["-1", "negative"],
      ["Infinity", "inf"],
      ["'3'", "string"],
    ] as const) {
      writeFileSync(
        join(dir, `${name}.mjs`),
        `export const tokenizer = { id: 't', countTokens: () => ${expr} };`,
      );
      const r = await loadConfiguredTokenizer(
        { module: join(dir, `${name}.mjs`) },
        dir,
      );
      assert.ok(r.ok);
      assert.equal(
        r.ok && r.tokenizer.countTokens("anything"),
        undefined,
        `${expr} must never be treated as a usable count`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- config schema: budgets.tokenizer ---------------------------------------

function budgets(raw: unknown) {
  const r = validateConfig(raw);
  return {
    issues: r.ok ? [] : r.issues,
    value: r.ok ? r.config.budgets : undefined,
  };
}

test("config: a valid budgets.tokenizer is accepted and carried through", () => {
  const raw = {
    ...structuredClone(DEFAULT_CONFIG),
    budgets: {
      ragDeadlineMs: 2000,
      evidenceTokenCap: 3000,
      tokenizer: { module: "./tokenizers/glm.mjs" },
    },
  };
  const { issues, value } = budgets(raw);
  assert.equal(issues.length, 0);
  assert.deepEqual(value?.tokenizer, { module: "./tokenizers/glm.mjs" });
  assert.equal(value?.tokenizer?.export, undefined);
});

test("config: malformed budgets.tokenizer shapes are rejected with issues", () => {
  for (const tokenizer of [
    "glm.mjs",
    42,
    {},
    { module: 7 },
    { module: "" },
    { module: "x.mjs", export: "" },
    { module: "x.mjs", extra: true },
  ]) {
    const raw = {
      ...structuredClone(DEFAULT_CONFIG),
      budgets: { ragDeadlineMs: 1, evidenceTokenCap: 1, tokenizer },
    };
    const { issues } = budgets(raw);
    assert.ok(
      issues.some((i) => i.path.startsWith("budgets.tokenizer")),
      `expected a budgets.tokenizer issue for ${JSON.stringify(tokenizer)}`,
    );
  }
});

// ---- tokenizer readiness timing ---------------------------------------------

function coordinatorWithoutTokenizer() {
  return new RetrievalCoordinator({
    adapter: makeAdapter(),
    authorizedScopes: ["project/alpha"],
    deadlineMs: 1000,
    tokenCap: 3000,
    generation: 1,
  });
}

test("readiness timing: inputs before tokenizer attachment visibly skip injection", async () => {
  const coordinator = coordinatorWithoutTokenizer();
  const outcome = await coordinator.retrieve(
    "early input",
    undefined,
    "interactive",
  );
  assert.equal(outcome.kind, "pack");
  const pack = (
    outcome as { pack: { injectionAllowed: boolean; degraded: string[] } }
  ).pack;
  assert.equal(pack.injectionAllowed, false);
  assert.ok(
    pack.degraded.includes(TOKENIZER_UNAVAILABLE_NOTE),
    "the skip is visible in the pack's degraded notes",
  );
  assert.equal(coordinator.lastDegradedNote, TOKENIZER_UNAVAILABLE_NOTE);
});

test("readiness timing: attachment covers later inputs only; never overrides an existing tokenizer", async () => {
  const coordinator = coordinatorWithoutTokenizer();
  const early = await coordinator.retrieve("early", undefined, "interactive");
  const earlyPack = (early as { pack: { injectionAllowed: boolean } }).pack;
  assert.equal(earlyPack.injectionAllowed, false);

  coordinator.setTokenizer(WORD_TOKENIZER);
  const late = await coordinator.retrieve(
    "late input",
    undefined,
    "interactive",
  );
  const latePack = (late as { pack: { injectionAllowed: boolean } }).pack;
  assert.equal(
    latePack.injectionAllowed,
    true,
    "inputs retrieved after attachment are injection-eligible",
  );

  coordinator.setTokenizer({ id: "second", countTokens: () => 1 });
  const third = await coordinator.retrieve(
    "third input",
    undefined,
    "interactive",
  );
  const thirdPack = (third as { pack: { tokenCount?: number } }).pack;
  assert.notEqual(
    thirdPack.tokenCount,
    1,
    "setTokenizer never overrides an existing tokenizer",
  );
});

// ---- cross-project opt-in mapping -------------------------------------------

test("cross-project opt-in values map into the authorized scope set that gates recall", () => {
  const r = authorizedScopeSet("github.com/org/repo", {
    allowPersonalGlobal: true,
    crossProjectOptIn: ["cross/gitlab.com/org/other"],
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(scopeIsAuthorized("cross/gitlab.com/org/other", r.scopes));
    assert.ok(
      scopeIsAuthorized("project/github.com/org/repo", r.scopes),
      "own project scope is authorized",
    );
    assert.ok(scopeIsAuthorized("personal", r.scopes));
    assert.ok(
      !scopeIsAuthorized("cross/not-opted-in.example", r.scopes),
      "non-opted-in cross scopes stay unauthorized",
    );
  }
});

test("cross-project opt-in with a non-cross/ value fails closed", () => {
  const r = authorizedScopeSet("p", {
    allowPersonalGlobal: false,
    crossProjectOptIn: ["project/other"],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /cross\//);
});

test("cross-project opt-in respects the N≤4 fanout bound (fail closed)", () => {
  const r = authorizedScopeSet("p", {
    allowPersonalGlobal: true,
    crossProjectOptIn: ["cross/a", "cross/b", "cross/c", "cross/d"],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /N≤4/);
});
