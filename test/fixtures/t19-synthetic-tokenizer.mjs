/**
 * T19 AC5 synthetic tokenizer fixture (chunk 3).
 *
 * SYNTHETIC, NOT PRODUCTION: this is a deterministic local tokenizer used to
 * exercise the real cap-enforcement path (`loadConfiguredTokenizer` →
 * RetrievalCoordinator.buildPack) with actual tokenization including framing.
 * It is NOT compatible with any production model's tokenizer (in particular
 * not with the default OpenRouter `z-ai/glm-5.3-flash` route); the measured
 * token counts are therefore labeled synthetic in docs/t19-quality-baselines.md
 * and never claimed as production context accounting.
 *
 * Rule: word tokens are maximal runs of letters/digits (Unicode classes);
 * every other non-whitespace character is its own token. Deterministic and
 * context-free.
 */

export const tokenizer = {
  id: "synthetic-word-punct-v1 (NOT model-compatible; test fixture)",
  countTokens(text) {
    if (typeof text !== "string") return undefined;
    const matches = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu);
    if (matches === null) return 0;
    return matches.length;
  },
};
