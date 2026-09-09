/**
 * T03: configuration schema and validation.
 *
 * Rules (docs/architecture.md §4, §10, decisions.md #9/#10/#12):
 * - Credentials are stored by reference (env var name or secret file path),
 *   never inline in config files, never rendered in status output.
 * - Unknown or conflicting configuration fails validation (fail closed);
 *   nothing is silently defaulted away.
 * - Unknown newer schemaVersion fails safely: the config is rejected with a
 *   visible message, never destructively rewritten.
 */

export const CURRENT_SCHEMA_VERSION = 1;

export const DEFAULT_MODEL_ROUTE = "openrouter/z-ai/glm-5.3-flash";

/** Exclusion rule shape (T06, src/privacy/exclusions.ts). */
export interface ExclusionRule {
  /** Exclude content belonging to this project scope value. */
  project?: string;
  /** Exclude whole files under this backend path prefix. */
  pathPrefix?: string;
  /** Exclude content matching this regex source. */
  pattern?: string;
}

/** Credential reference. The resolved secret value never lives in config. */
export type AuthRef =
  { kind: "env"; ref: string } | { kind: "file"; ref: string };

export interface MemoryConfig {
  schemaVersion: number;
  enabled: boolean;
  privateMode: boolean;
  mcp: {
    url: string;
    auth?: AuthRef;
  };
  model: {
    route: string;
    /**
     * Model-provider credential reference (T10). Required in practice for
     * extraction; without it the extractor fails closed at call time with a
     * visible availability error (config stays valid so the status command
     * can still render). The resolved value never lives in config or logs.
     */
    auth?: AuthRef;
  };
  scopes: {
    /** Include the `personal` scope in the authorized scope set. */
    allowPersonalGlobal: boolean;
    /** Per-session cross-project opt-in values, e.g. `cross/{project-id}`. Empty = denied. */
    crossProjectOptIn: string[];
  };
  budgets: {
    /** Total RAG retrieval deadline in ms (decisions.md #7, confirmed default 2000). */
    ragDeadlineMs: number;
    /** Evidence token cap (decisions.md #7, confirmed default 3000). */
    evidenceTokenCap: number;
    /**
     * User-supplied model-compatible tokenizer module (T13, §13 row 5).
     * Without one, automatic injection is skipped visibly — never enforced
     * by character estimation. The resolved secret-free module path is the
     * user's own config value; the module's code never enters logs.
     */
    tokenizer?: { module: string; export?: string };
  };
  features: {
    observation: boolean;
    backup: boolean;
    board: boolean;
  };
  /** Privacy exclusions (T06): content matched here is never captured. */
  privacy: {
    exclusions: ExclusionRule[];
  };
  /**
   * Explicit project identity override (`host/repo`) for non-Git projects or
   * ambiguous remotes (architecture.md §2 [P], decisions.md #5).
   */
  projectIdentity?: string;
}

export const DEFAULT_CONFIG: MemoryConfig = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  enabled: false,
  privateMode: false,
  mcp: {
    url: "",
  },
  model: {
    route: DEFAULT_MODEL_ROUTE,
  },
  scopes: {
    allowPersonalGlobal: true,
    crossProjectOptIn: [],
  },
  budgets: {
    ragDeadlineMs: 2000,
    evidenceTokenCap: 3000,
  },
  features: {
    observation: true,
    backup: true,
    board: true,
  },
  privacy: {
    exclusions: [],
  },
};

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  { ok: true; config: MemoryConfig } | { ok: false; issues: ValidationIssue[] };

const PLAIN_OBJECT = "object";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === PLAIN_OBJECT && v !== null && !Array.isArray(v);
}

function validateAuthRef(
  path: string,
  raw: unknown,
  issues: ValidationIssue[],
): AuthRef | undefined {
  if (!isPlainObject(raw)) {
    issues.push({ path, message: "auth must be an object { kind, ref }" });
    return undefined;
  }
  const kind = raw["kind"];
  const ref = raw["ref"];
  if (kind !== "env" && kind !== "file") {
    issues.push({
      path: `${path}.kind`,
      message: 'auth.kind must be "env" or "file"',
    });
    return undefined;
  }
  if (typeof ref !== "string" || ref.trim() === "") {
    issues.push({
      path: `${path}.ref`,
      message: "auth.ref must be a non-empty reference name",
    });
    return undefined;
  }
  if (kind === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    issues.push({
      path: `${path}.ref`,
      message: "env auth.ref must be a valid environment variable name",
    });
    return undefined;
  }
  if (kind === "file" && !ref.startsWith("/")) {
    issues.push({
      path: `${path}.ref`,
      message: "file auth.ref must be an absolute path to a secret file",
    });
    return undefined;
  }
  return { kind, ref };
}

function validatePositiveInt(
  path: string,
  raw: unknown,
  issues: ValidationIssue[],
): number | undefined {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    issues.push({ path, message: "must be a positive integer" });
    return undefined;
  }
  return raw;
}

function validateBoolean(
  path: string,
  raw: unknown,
  issues: ValidationIssue[],
): boolean | undefined {
  if (typeof raw !== "boolean") {
    issues.push({ path, message: "must be a boolean" });
    return undefined;
  }
  return raw;
}

/**
 * Validates a raw (partially filled) configuration object against the schema.
 * Missing optional fields fall back to defaults; anything present must be
 * valid. Inline secrets in `mcp.headers` are a hard validation error.
 */
export function validateConfig(raw: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      issues: [{ path: "", message: "config must be a JSON object" }],
    };
  }

  const known = new Set([
    "schemaVersion",
    "enabled",
    "privateMode",
    "mcp",
    "model",
    "scopes",
    "budgets",
    "features",
    "privacy",
    "projectIdentity",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      issues.push({
        path: key,
        message: "unknown configuration key (conflict — fix or remove)",
      });
    }
  }

  const schemaVersion = raw["schemaVersion"];
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    issues.push({ path: "schemaVersion", message: "must be an integer" });
  } else if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    issues.push({
      path: "schemaVersion",
      message: `unsupported newer schemaVersion ${schemaVersion} (supported: ${CURRENT_SCHEMA_VERSION}); refusing to run or rewrite`,
    });
  } else if (schemaVersion < CURRENT_SCHEMA_VERSION) {
    issues.push({
      path: "schemaVersion",
      message: `schemaVersion ${schemaVersion} is older than supported ${CURRENT_SCHEMA_VERSION}; run the explicit upgrade command`,
    });
  }

  const enabled =
    raw["enabled"] === undefined
      ? DEFAULT_CONFIG.enabled
      : validateBoolean("enabled", raw["enabled"], issues);
  const privateMode =
    raw["privateMode"] === undefined
      ? DEFAULT_CONFIG.privateMode
      : validateBoolean("privateMode", raw["privateMode"], issues);

  let url = "";
  let auth: AuthRef | undefined;
  const mcp = raw["mcp"];
  if (mcp === undefined) {
    // Defaults: empty endpoint, no credential reference.
  } else if (!isPlainObject(mcp)) {
    issues.push({ path: "mcp", message: "mcp must be an object" });
  } else {
    for (const key of Object.keys(mcp)) {
      if (key !== "url" && key !== "auth") {
        issues.push({
          path: `mcp.${key}`,
          message:
            "unknown mcp key; inline headers/credentials are not allowed in config",
        });
      }
    }
    const rawUrl = mcp["url"];
    if (rawUrl === undefined || rawUrl === "") {
      if (enabled) {
        issues.push({
          path: "mcp.url",
          message: "mcp.url is required when enabled",
        });
      }
    } else if (typeof rawUrl !== "string") {
      issues.push({ path: "mcp.url", message: "must be a string URL" });
    } else {
      let parsed: URL | undefined;
      try {
        parsed = new URL(rawUrl);
      } catch {
        /* handled below */
      }
      if (
        !parsed ||
        (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      ) {
        issues.push({
          path: "mcp.url",
          message: "must be a valid http(s) URL",
        });
      } else if (parsed.username !== "" || parsed.password !== "") {
        issues.push({
          path: "mcp.url",
          message: "URL must not embed credentials; use mcp.auth by reference",
        });
      } else {
        url = parsed.toString();
      }
    }
    if (mcp["auth"] !== undefined && mcp["auth"] !== null) {
      auth = validateAuthRef("mcp.auth", mcp["auth"], issues);
    } else if (enabled) {
      issues.push({
        path: "mcp.auth",
        message:
          "credential reference is required when enabled (env var name or secret file path)",
      });
    }
  }

  let route = DEFAULT_CONFIG.model.route;
  let modelAuth_: AuthRef | undefined;
  const model = raw["model"];
  if (model !== undefined) {
    if (!isPlainObject(model)) {
      issues.push({ path: "model", message: "model must be an object" });
    } else {
      const rawRoute = model["route"];
      if (typeof rawRoute !== "string" || rawRoute.trim() === "") {
        issues.push({
          path: "model.route",
          message: "must be a non-empty model route",
        });
      } else if (!/^[^\s/]+\/[^\s]+$/.test(rawRoute)) {
        issues.push({
          path: "model.route",
          message:
            "must look like provider/model (e.g. openrouter/z-ai/glm-5.3-flash)",
        });
      } else {
        route = rawRoute;
      }
      let modelAuth: AuthRef | undefined;
      if (model["auth"] !== undefined && model["auth"] !== null) {
        modelAuth = validateAuthRef("model.auth", model["auth"], issues);
      }
      for (const key of Object.keys(model)) {
        if (key !== "route" && key !== "auth") {
          issues.push({
            path: `model.${key}`,
            message: "unknown model key (allowed: route, auth)",
          });
        }
      }
      if (issues.every((i) => !i.path.startsWith("model."))) {
        if (modelAuth !== undefined) modelAuth_ = modelAuth;
      }
    }
  }

  const scopes: MemoryConfig["scopes"] = { ...DEFAULT_CONFIG.scopes };
  const rawScopes = raw["scopes"];
  if (rawScopes !== undefined) {
    if (!isPlainObject(rawScopes)) {
      issues.push({ path: "scopes", message: "scopes must be an object" });
    } else {
      if (rawScopes["allowPersonalGlobal"] !== undefined) {
        const v = validateBoolean(
          "scopes.allowPersonalGlobal",
          rawScopes["allowPersonalGlobal"],
          issues,
        );
        if (v !== undefined) scopes.allowPersonalGlobal = v;
      }
      if (rawScopes["crossProjectOptIn"] !== undefined) {
        const v = rawScopes["crossProjectOptIn"];
        if (
          !Array.isArray(v) ||
          !v.every((x) => typeof x === "string" && x.startsWith("cross/"))
        ) {
          issues.push({
            path: "scopes.crossProjectOptIn",
            message:
              'must be an array of explicit per-session opt-in values like "cross/{project-id}"',
          });
        } else {
          scopes.crossProjectOptIn = v as string[];
        }
      }
    }
  }

  const budgets: MemoryConfig["budgets"] = { ...DEFAULT_CONFIG.budgets };
  const rawBudgets = raw["budgets"];
  if (rawBudgets !== undefined) {
    if (!isPlainObject(rawBudgets)) {
      issues.push({ path: "budgets", message: "budgets must be an object" });
    } else {
      if (rawBudgets["ragDeadlineMs"] !== undefined) {
        const v = validatePositiveInt(
          "budgets.ragDeadlineMs",
          rawBudgets["ragDeadlineMs"],
          issues,
        );
        if (v !== undefined) budgets.ragDeadlineMs = v;
      }
      if (rawBudgets["evidenceTokenCap"] !== undefined) {
        const v = validatePositiveInt(
          "budgets.evidenceTokenCap",
          rawBudgets["evidenceTokenCap"],
          issues,
        );
        if (v !== undefined) budgets.evidenceTokenCap = v;
      }
      if (rawBudgets["tokenizer"] !== undefined) {
        const t = rawBudgets["tokenizer"];
        if (
          !isPlainObject(t) ||
          typeof t["module"] !== "string" ||
          t["module"].trim() === ""
        ) {
          issues.push({
            path: "budgets.tokenizer",
            message:
              "tokenizer must be an object { module: string, export?: string }",
          });
        } else {
          const unknown = Object.keys(t).filter(
            (k) => k !== "module" && k !== "export",
          );
          if (unknown.length > 0) {
            issues.push({
              path: "budgets.tokenizer",
              message: `unknown tokenizer key(s): ${unknown.join(", ")}`,
            });
          }
          const spec: { module: string; export?: string } = {
            module: t["module"] as string,
          };
          if (t["export"] !== undefined) {
            if (typeof t["export"] !== "string" || t["export"].trim() === "") {
              issues.push({
                path: "budgets.tokenizer.export",
                message: "tokenizer.export must be a non-empty string",
              });
            } else {
              spec.export = t["export"] as string;
            }
          }
          budgets.tokenizer = spec;
        }
      }
    }
  }

  const features: MemoryConfig["features"] = { ...DEFAULT_CONFIG.features };
  const rawFeatures = raw["features"];
  if (rawFeatures !== undefined) {
    if (!isPlainObject(rawFeatures)) {
      issues.push({ path: "features", message: "features must be an object" });
    } else {
      for (const key of ["observation", "backup", "board"] as const) {
        if (rawFeatures[key] !== undefined) {
          const v = validateBoolean(
            `features.${key}`,
            rawFeatures[key],
            issues,
          );
          if (v !== undefined) features[key] = v;
        }
      }
    }
  }

  const privacy: MemoryConfig["privacy"] = { exclusions: [] };
  const rawPrivacy = raw["privacy"];
  if (rawPrivacy !== undefined) {
    if (!isPlainObject(rawPrivacy)) {
      issues.push({ path: "privacy", message: "privacy must be an object" });
    } else {
      for (const key of Object.keys(rawPrivacy)) {
        if (key !== "exclusions") {
          issues.push({
            path: `privacy.${key}`,
            message: "unknown privacy key",
          });
        }
      }
      const rawExclusions = rawPrivacy["exclusions"];
      if (rawExclusions !== undefined) {
        if (!Array.isArray(rawExclusions)) {
          issues.push({
            path: "privacy.exclusions",
            message: "must be an array of rules",
          });
        } else {
          const rules: ExclusionRule[] = [];
          rawExclusions.forEach((item, i) => {
            const path = `privacy.exclusions[${i}]`;
            if (!isPlainObject(item)) {
              issues.push({ path, message: "rule must be an object" });
              return;
            }
            const rule: ExclusionRule = {};
            for (const key of ["project", "pathPrefix", "pattern"] as const) {
              if (item[key] !== undefined) {
                if (typeof item[key] !== "string" || item[key] === "") {
                  issues.push({
                    path: `${path}.${key}`,
                    message: "must be a non-empty string",
                  });
                } else {
                  rule[key] = item[key] as string;
                }
              }
            }
            for (const key of Object.keys(item)) {
              if (
                key !== "project" &&
                key !== "pathPrefix" &&
                key !== "pattern"
              ) {
                issues.push({
                  path: `${path}.${key}`,
                  message: "unknown exclusion key",
                });
              }
            }
            if (
              Object.keys(rule).length === 0 &&
              issues.every((x) => !x.path.startsWith(path))
            ) {
              issues.push({
                path,
                message:
                  "rule must set at least one of project/pathPrefix/pattern",
              });
            }
            rules.push(rule);
          });
          privacy.exclusions = rules;
        }
      }
    }
  }

  let projectIdentity: string | undefined;
  if (raw["projectIdentity"] !== undefined) {
    const v = raw["projectIdentity"];
    if (typeof v !== "string" || !/^[^\s]+\/[^\s]+$/.test(v)) {
      issues.push({
        path: "projectIdentity",
        message: "must be an explicit identity like host/repo",
      });
    } else {
      projectIdentity = v;
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    config: {
      privacy,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      enabled: enabled as boolean,
      privateMode: privateMode as boolean,
      mcp: { url, ...(auth ? { auth } : {}) },
      model: { route, ...(modelAuth_ ? { auth: modelAuth_ } : {}) },
      scopes,
      budgets,
      features,
      ...(projectIdentity ? { projectIdentity } : {}),
    },
  };
}

/**
 * Effective feature switches. Private mode disables ALL three feature domains
 * (observation, backup, board) — not only observation extraction
 * (decisions.md #10, architecture.md §5).
 */
export function effectiveFeatures(
  config: MemoryConfig,
): MemoryConfig["features"] {
  if (config.privateMode) {
    return { observation: false, backup: false, board: false };
  }
  return { ...config.features };
}
