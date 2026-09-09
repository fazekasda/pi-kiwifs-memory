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

import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

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

/** T13 config spec: `budgets.tokenizer` — a user-supplied tokenizer module. */
export interface TokenizerSpec {
  /** Module path (absolute, or relative to the config file's directory). */
  module: string;
  /** Named export carrying the tokenizer (default: "tokenizer"). */
  export?: string;
}

export type TokenizerLoadResult =
  { ok: true; tokenizer: EvidenceTokenizer } | { ok: false; reason: string };

/**
 * Load a user-configured tokenizer module (T13, §13 row 5). The module must
 * export `{ id: string, countTokens(text): number | undefined }`. There is
 * deliberately NO bundled fallback tokenizer for the default model: an
 * unloadable/malformed module or a throwing/unreliable count fails closed
 * (undefined → visible automatic-injection skip), never a character
 * estimate. The reason is sanitized: error name/code and the configured
 * path only — the path is the user's own config value, not a secret.
 */
export async function loadConfiguredTokenizer(
  spec: TokenizerSpec,
  baseDir: string,
): Promise<TokenizerLoadResult> {
  const resolved = isAbsolute(spec.module)
    ? spec.module
    : join(baseDir, spec.module);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(resolved).href)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    const e = err as { code?: string; name?: string };
    return {
      ok: false,
      reason: `configured tokenizer module failed to load (${e.code ?? e.name ?? "error"}): ${resolved}`,
    };
  }
  const key = spec.export ?? "tokenizer";
  const candidate = mod[key] as Partial<EvidenceTokenizer> | undefined;
  if (
    candidate === undefined ||
    typeof candidate !== "object" ||
    typeof candidate.id !== "string" ||
    candidate.id.trim() === "" ||
    candidate.id.length > 64 ||
    typeof candidate.countTokens !== "function"
  ) {
    return {
      ok: false,
      reason: `configured tokenizer module does not export a valid '${key}' ({ id, countTokens }): ${resolved}`,
    };
  }
  const inner = candidate as EvidenceTokenizer;
  const tokenizer: EvidenceTokenizer = {
    id: inner.id,
    countTokens(text: string): number | undefined {
      try {
        const n = inner.countTokens(text);
        return typeof n === "number" && Number.isFinite(n) && n >= 0
          ? n
          : undefined;
      } catch {
        return undefined; // unreliable count → fail closed
      }
    },
  };
  return { ok: true, tokenizer };
}
