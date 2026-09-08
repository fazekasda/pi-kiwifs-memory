/**
 * T03: status rendering. Exposes resolved NONSECRET settings only.
 *
 * Never rendered: secret values, auth.ref targets beyond their symbolic
 * reference (`env:NAME` / `file:/path`), credentials embedded in URLs
 * (validation rejects those outright).
 */

import type { MemoryConfig } from "./schema.ts";
import { effectiveFeatures } from "./schema.ts";

function renderAuthRef(config: MemoryConfig): string {
  const auth = config.mcp.auth;
  if (!auth) return "none (disabled or unset)";
  return auth.kind === "env" ? `env:${auth.ref}` : `file:${auth.ref}`;
}

export function resolvedStatusLines(config: MemoryConfig): string[] {
  const features = effectiveFeatures(config);
  const optIn =
    config.scopes.crossProjectOptIn.length > 0
      ? config.scopes.crossProjectOptIn.join(", ")
      : "none (cross-project reads denied by default)";
  return [
    `schemaVersion: ${config.schemaVersion}`,
    `enabled: ${config.enabled}`,
    `privateMode: ${config.privateMode}${config.privateMode ? " (all feature domains disabled)" : ""}`,
    `endpoint: ${config.mcp.url === "" ? "(unset)" : config.mcp.url}`,
    `credentials: ${renderAuthRef(config)} (by reference; value never shown)`,
    `model route: ${config.model.route}`,
    `personal-global scope: ${config.scopes.allowPersonalGlobal ? "allowed" : "denied"}`,
    `cross-project opt-in: ${optIn}`,
    `budgets: ragDeadlineMs=${config.budgets.ragDeadlineMs} evidenceTokenCap=${config.budgets.evidenceTokenCap}`,
    `effective features: observation=${features.observation} backup=${features.backup} board=${features.board}`,
    ...(config.projectIdentity
      ? [`project identity: ${config.projectIdentity} (explicit override)`]
      : []),
  ];
}

/**
 * True if the rendered status could contain a secret. Defensive check used by
 * tests and by the status command before display: rejects obvious secret
 * material in any line (long hex/base64 tokens must never appear).
 */
export function statusIsSecretFree(lines: string[]): boolean {
  const secretish = /^[A-Za-z0-9+/_=-]{32,}$/;
  return !lines.some((line) => {
    const tail = line.includes(": ")
      ? line.slice(line.indexOf(": ") + 2)
      : line;
    return (
      secretish.test(tail.trim()) || /bearer\s+[A-Za-z0-9._-]{16,}/i.test(line)
    );
  });
}
