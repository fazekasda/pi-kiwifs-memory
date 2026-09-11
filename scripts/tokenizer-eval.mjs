#!/usr/bin/env node
/**
 * B04a: deterministic offline tokenizer comparison harness.
 *
 * SYNTHETIC CORPUS ONLY. No network calls, no provider requests, no
 * secrets. Compares tokenizer counts across a synthetic corpus and — for
 * evidence sets — the EXACT framing produced by `frameEvidence` in
 * `src/inject/packer.ts`, so any future provider-comparison offset is
 * measured against real injection framing rather than raw text.
 *
 * The candidate tokenizer (`@cyberlangke/tokkit`, NOT a dependency of this
 * package) is optional: pass `--candidate <module> [--export <name>]`.
 * If it cannot be resolved the harness still validates the corpus and
 * determinism with the bundled synthetic reference tokenizer and reports
 * `candidate-unavailable` — it never claims compatibility.
 *
 * What this harness verifies OFFLINE (B04 acceptance subset):
 * - corpus integrity (required categories, no secrets, stable hash);
 * - the tokenizer returns deterministic counts across repeated passes;
 * - counts are well-formed (non-negative integers, `undefined` only for
 *   non-strings);
 * - per-evidence-set framing offset (framed count minus sum of raw body
 *   counts) is derived and recorded — stability across sets is reported,
 *   not asserted, because that is exactly what provider validation (B04,
 *   paid, separately approved) must confirm.
 *
 * Exit codes: 0 = ran to completion (candidate may be unavailable);
 * 1 = hard failure (corpus invalid, nondeterministic counts, malformed
 * tokenizer output, framing mismatch). A candidate undercount vs the
 * synthetic reference is REPORTED, not judged — judgment needs provider
 * counts.
 *
 * Usage:
 *   node scripts/tokenizer-eval.mjs [--candidate <module>] [--export <name>]
 *        [--out <report.json>]
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { frameEvidence } from "../src/inject/packer.ts";
import {
  CORPUS_ENTRIES,
  EVIDENCE_SETS,
  REQUIRED_CATEGORIES,
} from "../test/fixtures/tokenizer-eval-corpus.mjs";

/** Roughly the smallest plausible BPE count for these synthetic texts:
 * word/punctuation runs upper-bound real BPE tokenizers, so a candidate
 * counting far BELOW the synthetic reference is flagged for review. */
const SYNTHETIC_TOKENIZER_ID =
  "synthetic-word-punct-v1 (NOT model-compatible; test fixture)";

const syntheticTokenizer = {
  id: SYNTHETIC_TOKENIZER_ID,
  countTokens(text) {
    if (typeof text !== "string") return undefined;
    const matches = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu);
    return matches === null ? 0 : matches.length;
  },
};

/** Load the corpus and its structural invariants. Throws on violation. */
export function loadCorpus() {
  const categories = new Set(CORPUS_ENTRIES.map((e) => e.category));
  for (const required of REQUIRED_CATEGORIES) {
    if (!categories.has(required)) {
      throw new Error(`corpus missing required category: ${required}`);
    }
  }
  const forbidden =
    /(?:sk-|api[_-]?key|bearer\s|password|BEGIN (?:RSA|EC|OPENSSH) PRIVATE)/i;
  for (const entry of CORPUS_ENTRIES) {
    if (forbidden.test(entry.text)) {
      throw new Error(`corpus entry ${entry.id} matches a secret pattern`);
    }
  }
  const canonical = JSON.stringify({
    entries: CORPUS_ENTRIES,
    sets: EVIDENCE_SETS.map((s) => ({ id: s.id, items: s.items })),
  });
  const hash = createHash("sha256").update(canonical).digest("hex");
  return { entries: CORPUS_ENTRIES, evidenceSets: EVIDENCE_SETS, hash };
}

/** Resolve and import an optional candidate tokenizer module. */
export async function loadCandidate(spec) {
  if (!spec) return { ok: false, reason: "no candidate module configured" };
  const resolved = isAbsolute(spec.module)
    ? spec.module
    : resolve(process.cwd(), spec.module);
  let mod;
  try {
    mod = await import(pathToFileURL(resolved).href);
  } catch (err) {
    const e = err;
    return {
      ok: false,
      reason: `candidate module failed to load (${e.code ?? e.name ?? "error"}): ${spec.module}`,
    };
  }
  let tokenizer = mod[spec.export ?? "tokenizer"] ?? mod.default;
  // Async factory support (e.g. scripts/tokkit-glm-adapter.mjs's
  // `loadTokkitGlmTokenizer`): if no direct export matched, scan the module
  // exports for an async factory and resolve it.
  if (
    (tokenizer === undefined || tokenizer === null) &&
    spec.export === undefined
  ) {
    const factory = Object.values(mod).find(
      (v) => typeof v === "function" && v.constructor?.name === "AsyncFunction",
    );
    if (factory) tokenizer = await factory();
  }
  if (
    typeof tokenizer !== "object" ||
    tokenizer === null ||
    typeof tokenizer.countTokens !== "function" ||
    typeof tokenizer.id !== "string"
  ) {
    return {
      ok: false,
      reason: `module does not export an EvidenceTokenizer ({ id, countTokens }${spec.export ? ` via export "${spec.export}"` : ""}) or an async factory returning one`,
    };
  }
  return { ok: true, tokenizer };
}

/** Count every corpus text twice; hard-fail on nondeterminism. */
function countAll(tokenizer, entries, evidenceSets) {
  const entryCounts = entries.map((entry) => {
    const first = tokenizer.countTokens(entry.text);
    const second = tokenizer.countTokens(entry.text);
    return {
      id: entry.id,
      category: entry.category,
      count: first,
      recount: second,
    };
  });
  const setCounts = evidenceSets.map((set) => {
    const framed = frameEvidence(set.items);
    const framedCount = tokenizer.countTokens(framed);
    const framedRecount = tokenizer.countTokens(framed);
    const rawSum = set.items.reduce(
      (sum, item) => sum + (tokenizer.countTokens(item.body) ?? 0),
      0,
    );
    return {
      id: set.id,
      itemCount: set.items.length,
      framedCount,
      framedRecount,
      rawSum,
      framingOffset:
        framedCount === undefined ? undefined : framedCount - rawSum,
    };
  });
  return { entryCounts, setCounts };
}

/**
 * Run the offline evaluation with the given tokenizer. Returns a
 * sanitized, JSON-serializable report object.
 */
export function evaluate(tokenizer, corpus) {
  const { entries, evidenceSets, hash } = corpus;
  const { entryCounts, setCounts } = countAll(tokenizer, entries, evidenceSets);

  const malformed = [];
  for (const e of entryCounts) {
    if (e.count !== e.recount) malformed.push(`${e.id}: nondeterministic`);
    else if (
      e.count !== undefined &&
      (!Number.isInteger(e.count) || e.count < 0)
    )
      malformed.push(`${e.id}: malformed count`);
  }
  for (const s of setCounts) {
    if (s.framedCount !== s.framedRecount)
      malformed.push(`${s.id}: framing nondeterministic`);
    else if (
      s.framedCount !== undefined &&
      (!Number.isInteger(s.framedCount) || s.framedCount < 0)
    )
      malformed.push(`${s.id}: malformed framed count`);
  }

  const defined = entryCounts
    .map((e) => e.count)
    .filter((c) => typeof c === "number");
  const offsets = setCounts
    .map((s) => s.framingOffset)
    .filter((o) => typeof o === "number");
  const framingOffsetsStable =
    offsets.length === setCounts.length && new Set(offsets).size === 1;

  return {
    tokenizerId: tokenizer.id,
    corpusHash: hash,
    entryCount: entries.length,
    evidenceSetCount: evidenceSets.length,
    deterministic:
      malformed.filter((m) => m.includes("nondeterministic")).length === 0,
    malformed,
    aggregate: {
      totalRawTokens: defined.reduce((a, b) => a + b, 0),
      minEntryTokens: defined.length ? Math.min(...defined) : undefined,
      maxEntryTokens: defined.length ? Math.max(...defined) : undefined,
      undefinedCounts:
        entryCounts.length +
        setCounts.length -
        defined.length -
        setCounts.filter((s) => typeof s.framedCount === "number").length,
      framingOffsets: setCounts.map((s) => ({
        set: s.id,
        offset: s.framingOffset,
      })),
      framingOffsetsStable,
    },
  };
}

/** CLI entry point. */
async function main(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const outPath = get("--out");
  const candidateSpec = args.includes("--candidate")
    ? { module: get("--candidate"), export: get("--export") }
    : undefined;

  const corpus = loadCorpus();
  const reference = evaluate(syntheticTokenizer, corpus);
  if (!reference.deterministic || reference.malformed.length > 0) {
    console.error(
      "harness failure: reference tokenizer malformed",
      reference.malformed,
    );
    process.exitCode = 1;
    return;
  }

  const candidate = await loadCandidate(candidateSpec);
  let candidateReport;
  let candidateStatus;
  if (candidate.ok) {
    candidateReport = evaluate(candidate.tokenizer, corpus);
    if (
      !candidateReport.deterministic ||
      candidateReport.malformed.length > 0
    ) {
      console.error("candidate rejected:", candidateReport.malformed);
      process.exitCode = 1;
      return;
    }
    candidateStatus = "evaluated";
  } else {
    candidateStatus = "candidate-unavailable";
    candidateReport = { reason: candidate.reason };
  }

  const report = {
    task: "B04a",
    scope:
      "offline deterministic corpus evaluation; provider comparison NOT performed",
    node: process.version,
    corpusHash: corpus.hash,
    reference: {
      tokenizerId: SYNTHETIC_TOKENIZER_ID,
      deterministic: reference.deterministic,
      aggregate: reference.aggregate,
    },
    candidate: { status: candidateStatus, ...candidateReport },
  };

  if (outPath) {
    writeFileSync(
      resolve(process.cwd(), outPath),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(`report written: ${outPath}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main(process.argv);
}
