/**
 * B04b: example adapter bridging `@cyberlangke/tokkit-glm` (GLM-5 BPE
 * tokenizer) to the `{ id, countTokens }` EvidenceTokenizer shape expected
 * by `scripts/tokenizer-eval.mjs` and `scripts/tokenizer-provider-compare.mjs`.
 *
 * The candidate package is a devDependency only; it is NOT a runtime
 * dependency of the shipped extension. It is still a CANDIDATE: nothing
 * here claims provider compatibility — that verdict comes exclusively from
 * a completed provider comparison with a validated framing offset.
 *
 * API-compat evidence (offline, tokkit-glm 1.11.0):
 * - `getEncoding(family)` async-loads the family ("glm-5" is listed);
 * - `getTokenizerSync(family)` then returns an object whose `encode(text)`
 *   returns a synchronous array of token ids.
 * The adapter wraps `encode(...).length` so counts are synchronous and
 * deterministic, matching the harness contract. Non-string input returns
 * `undefined` (harness treats it as "not applicable", not a count).
 */

let cached = null;

/**
 * Load the GLM-5 tokenizer and return the adapter. Throws with a clear
 * message if the optional devDependency is absent.
 */
export async function loadTokkitGlmTokenizer() {
  if (cached) return cached;
  let mod;
  try {
    mod = await import("@cyberlangke/tokkit-glm");
  } catch (err) {
    const e = err;
    throw new Error(
      `@cyberlangke/tokkit-glm is not installed (devDependency); run \`npm install\` first (${e.code ?? e.name ?? "error"})`,
    );
  }
  await mod.getEncoding("glm-5");
  const enc = mod.getTokenizerSync("glm-5");
  if (typeof enc?.encode !== "function") {
    throw new Error(
      "tokkit-glm API mismatch: getTokenizerSync('glm-5').encode is not a function",
    );
  }
  cached = {
    id: "@cyberlangke/tokkit-glm@1.11.0 glm-5 (CANDIDATE — not validated)",
    countTokens(text) {
      if (typeof text !== "string") return undefined;
      const ids = enc.encode(text);
      return Array.isArray(ids) ? ids.length : undefined;
    },
  };
  return cached;
}
