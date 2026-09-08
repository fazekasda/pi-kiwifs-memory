/**
 * T06: pattern-based secret redaction with entropy heuristics
 * (architecture.md §5, decisions.md #10).
 *
 * Mechanics:
 * - Structural replacement `[REDACTED:{type}:{length}]` preserves the length
 *   class of the removed secret (useful for token budgeting) and never
 *   contains any part of the secret value.
 * - Entropy heuristic: long token-like character runs above a Shannon-entropy
 *   threshold are treated as potential secrets even without a named pattern.
 * - Fail closed: if redaction itself cannot classify/process the content
 *   (internal error, unprocessable input), the result is `ok: false` and the
 *   caller must HOLD the content — it is never silently sent.
 *
 * The redactor is a LOCAL gate. It never receives or produces network I/O.
 */

/** A secret detection rule. Synthetic pattern sources only in fixtures. */
export interface SecretPattern {
  /** Stable type label used in the structural replacement. */
  type: string;
  /** Global regex; the full match is treated as the secret. */
  regex: RegExp;
}

export interface RedactionFinding {
  type: string;
  start: number;
  length: number;
}

export type RedactionResult =
  | { ok: true; content: string; findings: RedactionFinding[] }
  | { ok: false; reason: string; held: true };

export interface RedactionOptions {
  patterns?: SecretPattern[];
  /**
   * Minimum Shannon entropy (bits/char) for an unpatterned token-like run to
   * be treated as a potential secret. Default 4.0 [P].
   */
  entropyThreshold?: number;
  /** Minimum length for the entropy heuristic. Default 20. */
  entropyMinLength?: number;
}

/** Entropy-only finding type label. */
export const HIGH_ENTROPY_TYPE = "high-entropy";

/** Structural replacement; never carries secret material. */
export function redactionPlaceholder(type: string, length: number): string {
  return `[REDACTED:${type}:${length}]`;
}

/** Shannon entropy in bits per character over the byte-level distribution. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Default secret patterns. These cover common secret FORMATS — they are a
 * best-effort scanner, not a guarantee (see docs/privacy.md, limitations).
 * All regexes are compiled with the global flag by this module.
 */
function defaultPatterns(): SecretPattern[] {
  const raw: [string, RegExp][] = [
    // AWS access key id
    ["aws-access-key", /AKIA[0-9A-Z]{16}/],
    // OpenAI-style API keys
    ["api-key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
    // GitHub tokens
    ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    // Slack tokens
    ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
    // JWTs (three base64url segments)
    [
      "jwt",
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    ],
    // Bearer/authorization headers
    [
      "bearer-token",
      /\b(?:Bearer|authorization:\s*(?:Bearer|token|Basic))\s+[A-Za-z0-9._~+/=-]{16,}/i,
    ],
    // PEM private key blocks (full block, including delimiters)
    [
      "private-key-block",
      /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/,
    ],
    // Credentials embedded in URLs (scheme://user:pass@host)
    ["credential-url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/i],
    // Assignment-style secrets: password = hunter2 / "api_key": "..."
    [
      "key-value-assignment",
      /\b(?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token|secret|password|passwd|token)\b["']?\s*[:=]\s*["']?[^\s"',;]{8,}/i,
    ],
  ];
  return raw.map(([type, regex]) => ({
    type,
    regex: new RegExp(regex.source, regex.flags + "g"),
  }));
}

const ENTROPY_TOKEN = /[A-Za-z0-9+/_=-]{20,}/g;

/**
 * Applies redaction to a piece of outbound-bound content. Every finding is
 * replaced structurally. Returns `ok: false` (held) when the content cannot
 * be processed safely — the caller must not send it.
 */
export function redactText(
  content: string,
  opts: RedactionOptions = {},
): RedactionResult {
  const patterns = opts.patterns ?? defaultPatterns();
  const threshold = opts.entropyThreshold ?? 4.0;
  const minLength = opts.entropyMinLength ?? 20;

  try {
    if (typeof content !== "string") {
      return {
        ok: false,
        reason: "redaction input is not a string; content held (fail closed)",
        held: true,
      };
    }
    // NUL bytes / other control characters make classification unreliable.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000e-\u001f]/.test(content)) {
      return {
        ok: false,
        reason:
          "content contains control characters and cannot be classified safely; held (fail closed)",
        held: true,
      };
    }

    const spans: { start: number; end: number; type: string }[] = [];
    for (const { type, regex } of patterns) {
      regex.lastIndex = 0;
      for (let m = regex.exec(content); m !== null; m = regex.exec(content)) {
        if (m[0].length > 0) {
          spans.push({ start: m.index, end: m.index + m[0].length, type });
        }
        if (m.index === regex.lastIndex) regex.lastIndex++; // zero-width guard
      }
    }
    // Entropy heuristic over runs not already covered by a named pattern.
    ENTROPY_TOKEN.lastIndex = 0;
    for (
      let m = ENTROPY_TOKEN.exec(content);
      m !== null;
      m = ENTROPY_TOKEN.exec(content)
    ) {
      const covered = spans.some(
        (s) => m!.index < s.end && m!.index + m![0].length > s.start,
      );
      if (
        !covered &&
        m[0].length >= minLength &&
        shannonEntropy(m[0]) >= threshold
      ) {
        spans.push({
          start: m.index,
          end: m.index + m[0].length,
          type: HIGH_ENTROPY_TYPE,
        });
      }
      if (m.index === ENTROPY_TOKEN.lastIndex) ENTROPY_TOKEN.lastIndex++;
    }

    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    // Merge overlaps (keep the earliest, longest span).
    const merged: typeof spans = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span.start < last.end) continue;
      merged.push(span);
    }

    const findings: RedactionFinding[] = [];
    let out = "";
    let pos = 0;
    for (const span of merged) {
      out += content.slice(pos, span.start);
      out += redactionPlaceholder(span.type, span.end - span.start);
      findings.push({
        type: span.type,
        start: span.start,
        length: span.end - span.start,
      });
      pos = span.end;
    }
    out += content.slice(pos);
    return { ok: true, content: out, findings };
  } catch (err) {
    // Never let a redactor fault leak content through a message.
    return {
      ok: false,
      reason: `redaction failed internally (${(err as Error).name}); content held (fail closed)`,
      held: true,
    };
  }
}

/**
 * Builds a guard-compatible `Redactor` (src/backend/guard.ts step 5).
 * Classification failure maps to the guard's fail-closed rejection.
 */
export function createRedactor(
  opts: RedactionOptions = {},
): (
  content: string,
) => { ok: true; content: string } | { ok: false; reason: string } {
  return (content) => {
    const result = redactText(content, opts);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, content: result.content };
  };
}

/**
 * True if the text still contains something resembling secret material
 * (long opaque token runs). Used as a defensive post-condition by the audit
 * sink and tests — it is a heuristic, not a proof.
 */
export function looksSecretBearing(text: string): boolean {
  if (
    /(?:sk-|gh[pousr]_|xox[baprs]-|AKIA|eyJ[\w-]{10,}\.|BEGIN [A-Z ]*PRIVATE KEY)/.test(
      text,
    )
  ) {
    return true;
  }
  // Long opaque runs are only treated as secrets when they are also
  // high-entropy. This keeps ordinary structured identifiers (UUIDs, hex IDs,
  // dates, etags) from tripping the audit post-check while still catching
  // random token material.
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    if (shannonEntropy(m[0]) >= 4.0) return true;
  }
  return false;
}
