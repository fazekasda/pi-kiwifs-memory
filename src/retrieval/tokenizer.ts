/**
 * T12: token accounting for the evidence pack (architecture.md §3.1,
 * decisions.md #7, §13 rows 2/5).
 *
 * The confirmed 3,000-token evidence cap is enforced against a tokenizer
 * compatible with the active model, counting the COMPLETE injected payload —
 * evidence bodies, framing and source-ID citations — not just the raw
 * evidence text. `kiwi_brief`'s server `budget_tokens` and character
 * estimates are advisory/diagnostic only and never enforce the cap.
 *
 * There is no reliable tokenizer for the default OpenRouter
 * `z-ai/glm-5.3-flash` model bundled with this extension. Per decisions.md
 * #7 and §13 row 5, when no reliable tokenizer is available automatic
 * injection is SKIPPED with a visible degraded status (explicit search/read
 * tools remain available) — the cap is never enforced by character
 * estimation. A user may supply a model-compatible tokenizer via config in
 * a later task; the interface below is the contract.
 */

export interface EvidenceTokenizer {
  /** Stable identifier used in status output (model/ tokenizer name). */
  readonly id: string;
  /**
   * Count tokens for the given text. Returns `undefined` when the text
   * cannot be tokenized reliably — the caller must then skip automatic
   * injection (fail closed), never fall back to character estimation.
   */
  countTokens(text: string): number | undefined;
}

/**
 * Status-facing reason when no tokenizer is configured. Sanitized: carries
 * no user content and no capability claims.
 */
export const TOKENIZER_UNAVAILABLE_NOTE =
  "automatic injection skipped: no reliable tokenizer available for the configured model — the evidence cap cannot be enforced (use explicit search/read instead)";
