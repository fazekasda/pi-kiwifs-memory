#!/usr/bin/env node
/**
 * B04b: provider-comparison mode for the GLM-5 tokenizer candidate.
 *
 * Compares local candidate counts (via `scripts/tokkit-glm-adapter.mjs`)
 * with OpenRouter `usage.prompt_tokens` for the SAME texts, sent as user
 * messages, and derives a per-request framing offset:
 *
 *   offset_i = usage.prompt_tokens_i - localCount_i
 *
 * The provider's chat template adds framing tokens on top of the user
 * content, so a validated candidate must show ONE stable offset across the
 * whole corpus. Any deviation, and in particular any request where
 * `prompt_tokens < localCount` (an unexplained undercount), REJECTS the
 * candidate for automatic injection.
 *
 * Safety gates (all mandatory):
 * - Paid network calls require BOTH the CLI flag `--run` AND the explicit
 *   environment opt-in `KIWIFS_TOKENIZER_PROVIDER_OPTIN=1`. Without them
 *   the tool exits 2 and performs no network I/O.
 * - The API key is read from OPENROUTER_API_KEY and is never printed,
 *   logged, or written to the report.
 * - Request/response CONTENT is never printed or persisted: the report
 *   carries only per-entry identifiers (synthetic corpus ids), numeric
 *   counts, and aggregates. Failures record HTTP status codes only.
 * - The corpus is the same synthetic, secret-free fixture used by B04a
 *   (`test/fixtures/tokenizer-eval-corpus.mjs`); evidence sets are sent
 *   through the exact `frameEvidence` framing from `src/inject/packer.ts`.
 *
 * Model slug is pinned to the approved route. Request settings are fixed
 * (temperature 0, max_tokens 1) and recorded in the report.
 *
 * Usage:
 *   KIWIFS_TOKENIZER_PROVIDER_OPTIN=1 node scripts/tokenizer-provider-compare.mjs \
 *     --run [--out tasks/evidence/tokenizer-provider-compare.json]
 *
 * Exit codes: 0 = mapping validated; 1 = candidate rejected (undercount,
 * unstable offset, malformed usage, nondeterministic local counts);
 * 2 = gate refusal / preflight failure (no network performed).
 */

import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadCorpus } from "./tokenizer-eval.mjs";
import { frameEvidence } from "../src/inject/packer.ts";
import { loadTokkitGlmTokenizer } from "./tokkit-glm-adapter.mjs";

export const MODEL_SLUG = "openrouter/z-ai/glm-5.3-flash";
/** OpenRouter API model id for request bodies (MODEL_SLUG minus the pi route prefix). */
export const OPENROUTER_MODEL_ID = "z-ai/glm-5.3-flash";
export const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const OPTIN_ENV = "KIWIFS_TOKENIZER_PROVIDER_OPTIN";
/** Fixed request settings; recorded in the report. */
export const REQUEST_SETTINGS = Object.freeze({
  temperature: 0,
  maxTokens: 1,
  messagesShape: "[{ role: 'user', content: <synthetic corpus text> }]",
});

/* ------------------------------------------------------------------ */
/* Request set construction                                            */
/* ------------------------------------------------------------------ */

/** Build the request list: every corpus entry plus every evidence set as
 * the EXACT framed string produced by `frameEvidence`. Identifiers are
 * synthetic ids only. */
export function buildRequestList(corpus) {
  const requests = corpus.entries.map((entry) => ({
    id: entry.id,
    kind: "entry",
    text: entry.text,
  }));
  for (const set of corpus.evidenceSets) {
    requests.push({
      id: `framed:${set.id}`,
      kind: "framed-evidence-set",
      text: frameEvidence(set.items),
    });
  }
  return requests;
}

/* ------------------------------------------------------------------ */
/* Local counting (deterministic, double-passed)                       */
/* ------------------------------------------------------------------ */

/** Count every request twice. Hard-fail on any nondeterminism. */
export function countLocally(tokenizer, requests) {
  const counts = requests.map((r) => {
    const first = tokenizer.countTokens(r.text);
    const second = tokenizer.countTokens(r.text);
    return { id: r.id, first, second };
  });
  const bad = counts.filter(
    (c) =>
      c.first !== c.second ||
      (typeof c.first === "number" &&
        (!Number.isInteger(c.first) || c.first < 0)),
  );
  if (bad.length > 0) {
    const err = new Error(
      `local counting nondeterministic/malformed for ${bad.length} request(s): ${bad
        .map((b) => b.id)
        .join(", ")}`,
    );
    err.code = "LOCAL_NONDETERMINISTIC";
    throw err;
  }
  return counts.map((c) => ({ id: c.id, localCount: c.first }));
}

/* ------------------------------------------------------------------ */
/* Provider transport                                                  */
/* ------------------------------------------------------------------ */

/**
 * One chat-completion request. Returns ONLY numeric metadata
 * (usage.prompt_tokens, HTTP status); content never leaves this function
 * except in the request body itself.
 */
export async function providerPromptTokens({
  text,
  apiKey,
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL_ID,
      messages: [{ role: "user", content: text }],
      temperature: REQUEST_SETTINGS.temperature,
      max_tokens: REQUEST_SETTINGS.maxTokens,
    }),
  });
  if (!res.ok) {
    const err = new Error(`openrouter HTTP ${res.status}`);
    err.code = "PROVIDER_HTTP";
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  const promptTokens = body?.usage?.prompt_tokens;
  const route = body?.provider?.name;
  if (!Number.isInteger(promptTokens) || promptTokens < 0) {
    const err = new Error(
      "openrouter response missing integer usage.prompt_tokens",
    );
    err.code = "PROVIDER_USAGE_MISSING";
    throw err;
  }
  return {
    promptTokens,
    route: typeof route === "string" ? route : "unknown",
  };
}

/* ------------------------------------------------------------------ */
/* Analysis                                                            */
/* ------------------------------------------------------------------ */

/**
 * Derive the framing offset per request and validate the mapping.
 * Rejection rules:
 * - undercount: promptTokens < localCount (the chat framing only ADDS
 *   tokens; a provider total below the raw user content cannot be
 *   explained by framing) → reject;
 * - unstable offset: offsets differ across requests → reject (no single
 *   stable mapping).
 */
export function analyzeOffset(samples) {
  const perRequest = samples.map((s) => ({
    id: s.id,
    localCount: s.localCount,
    promptTokens: s.promptTokens,
    offset: s.promptTokens - s.localCount,
  }));
  const undercounts = perRequest.filter((r) => r.offset < 0);
  const offsets = perRequest.map((r) => r.offset);
  const stable =
    offsets.length > 0 && new Set(offsets).size === 1 ? offsets[0] : undefined;
  return {
    perRequest,
    undercounts,
    framingOffset: stable,
    stableMapping:
      undercounts.length === 0 &&
      offsets.length > 0 &&
      new Set(offsets).size === 1,
  };
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

export async function runProviderComparison({
  apiKey,
  fetchImpl,
  log = () => {},
}) {
  const tokenizer = await loadTokkitGlmTokenizer();
  const corpus = loadCorpus();
  const requests = buildRequestList(corpus);
  const local = countLocally(tokenizer, requests); // throws on nondeterminism

  const samples = [];
  for (let i = 0; i < requests.length; i++) {
    const res = await providerPromptTokens({
      text: requests[i].text,
      apiKey,
      fetchImpl,
    });
    samples.push({
      id: requests[i].id,
      ...res,
      localCount: local[i].localCount,
    });
    log(`request ${i + 1}/${requests.length} ok (status 200)`);
  }

  const analysis = analyzeOffset(samples);
  const verdict = analysis.stableMapping ? "validated" : "rejected";
  return {
    task: "B04b",
    scope:
      "provider comparison via usage.prompt_tokens with framing-offset analysis",
    verdict,
    rejectionReasons: analysis.undercounts.length
      ? [
          `unexplained undercount on ${analysis.undercounts.length} request(s): ${analysis.undercounts.map((u) => u.id).join(", ")}`,
        ]
      : analysis.stableMapping
        ? []
        : ["framing offset not stable across the full corpus"],
    model: MODEL_SLUG,
    requestSettings: REQUEST_SETTINGS,
    node: process.version,
    candidatePackage: tokenizer.id,
    corpusHash: corpus.hash,
    requestCount: requests.length,
    results: analysis.perRequest,
    framingOffset: analysis.framingOffset ?? null,
    stableMapping: analysis.stableMapping,
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

async function main(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const outPath = get("--out");
  const run = args.includes("--run");
  const optIn = process.env[OPTIN_ENV] === "1";

  if (!run || !optIn) {
    console.error(
      "refusing provider comparison: paid OpenRouter calls require BOTH " +
        "--run and the explicit opt-in environment variable " +
        "(set it to 1 immediately before the run, per B04 approval). " +
        "No network I/O was performed.",
    );
    process.exitCode = 2;
    return;
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "OPENROUTER_API_KEY not set; cannot run provider comparison (value never printed)",
    );
    process.exitCode = 2;
    return;
  }

  try {
    const report = await runProviderComparison({
      apiKey,
      log: (m) => console.log(m),
    });
    if (outPath) {
      writeFileSync(
        isAbsolute(outPath) ? outPath : resolve(process.cwd(), outPath),
        JSON.stringify(report, null, 2) + "\n",
      );
      console.log(`report written: ${outPath}`);
    } else {
      // Numeric/aggregate report only; contains no request content.
      console.log(JSON.stringify(report, null, 2));
    }
    if (report.verdict !== "validated") {
      console.error(
        `candidate REJECTED: ${report.rejectionReasons.join("; ")}`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        `candidate validated: stable framing offset ${report.framingOffset} across ${report.requestCount} requests`,
      );
    }
  } catch (err) {
    const e = err;
    // Status codes only; never response bodies or request content.
    console.error(
      `provider comparison failed: ${e.code ?? e.name ?? "error"}${e.status ? ` (HTTP ${e.status})` : ""}`,
    );
    process.exitCode = e.code === "LOCAL_NONDETERMINISTIC" ? 1 : 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main(process.argv);
}
