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
  };
  features: {
    observation: boolean;
    backup: boolean;
    board: boolean;
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
      schemaVersion: CURRENT_SCHEMA_VERSION,
      enabled: enabled as boolean,
      privateMode: privateMode as boolean,
      mcp: { url, ...(auth ? { auth } : {}) },
      model: { route },
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
