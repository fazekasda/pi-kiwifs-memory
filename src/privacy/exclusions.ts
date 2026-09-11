/**
 * T06: user-configurable exclusion rules (architecture.md §5, PRD T06).
 *
 * An exclusion rule may match on:
 * - `project` — the project scope id (e.g. "cross/other-proj" or a project
 *   id); content belonging to an excluded project is never captured.
 * - `pathPrefix` — a backend path prefix (whole-file exclusion by path).
 * - `pattern` — a content regex; matching content is never captured.
 *
 * Every configured dimension of a rule must match for the rule to fire
 * (dimensions are ANDed within a rule; rules are ORed across).
 */

export interface ExclusionRule {
  project?: string;
  pathPrefix?: string;
  pattern?: string;
}

export interface ExclusionContext {
  scope?: string;
  path?: string;
  content?: string;
}

export type ExclusionCheck =
  { ok: true; excluded: boolean; by?: string } | { ok: false; reason: string };

/**
 * Validates and compiles rules. An invalid pattern is a validation error,
 * never a silently-disabled rule (fail closed on configuration).
 */
export function compileExclusions(
  rules: ExclusionRule[],
):
  | { ok: true; compiled: { rule: ExclusionRule; regex?: RegExp }[] }
  | { ok: false; reason: string } {
  const compiled: { rule: ExclusionRule; regex?: RegExp }[] = [];
  for (const rule of rules) {
    const keys = Object.keys(rule).filter(
      (k) => k === "project" || k === "pathPrefix" || k === "pattern",
    );
    if (keys.length === 0) {
      return {
        ok: false,
        reason:
          "exclusion rule must set at least one of project/pathPrefix/pattern",
      };
    }
    if (rule.pattern !== undefined) {
      try {
        new RegExp(rule.pattern);
      } catch (err) {
        return {
          ok: false,
          reason: `exclusion pattern is not a valid regex: ${(err as Error).message}`,
        };
      }
    }
    compiled.push({
      rule,
      ...(rule.pattern !== undefined
        ? { regex: new RegExp(rule.pattern) }
        : {}),
    });
  }
  return { ok: true, compiled };
}

/** Checks content against compiled rules. Invalid input fails closed. */
export function isExcluded(
  ctx: ExclusionContext,
  compiled: { rule: ExclusionRule; regex?: RegExp }[],
): ExclusionCheck {
  for (const { rule, regex } of compiled) {
    if (rule.project !== undefined) {
      // A configured dimension with no corresponding context cannot match,
      // so the ANDed rule as a whole cannot fire — skip this entire rule.
      if (ctx.scope !== rule.project) continue;
    }
    if (rule.pathPrefix !== undefined) {
      if (ctx.path === undefined) continue;
      if (!ctx.path.startsWith(rule.pathPrefix)) continue;
    }
    if (regex !== undefined) {
      if (ctx.content === undefined) continue;
      if (!regex.test(ctx.content)) continue;
    }
    const dims = [
      ...(rule.project !== undefined ? ["project"] : []),
      ...(rule.pathPrefix !== undefined ? ["pathPrefix"] : []),
      ...(rule.pattern !== undefined ? ["pattern"] : []),
    ];
    return { ok: true, excluded: true, by: dims.join("+") };
  }
  return { ok: true, excluded: false };
}
