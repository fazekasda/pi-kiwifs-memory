/**
 * T05: versioned domain records and provenance (PRD T05, architecture.md §2).
 *
 * All stored records carry `schemaVersion` (starts at 1), a stable id, a
 * single-owner `scope`, timestamps and a lifecycle status. Source references
 * distinguish session, branch and entry ids. Unknown future schema versions
 * fail safely as read-only — parsing never produces a rewrite of data the
 * reader does not fully understand.
 *
 * Backend records are markdown with frontmatter (flat `key: value` lines);
 * local artifacts (tombstones, cursors, manifests) are plain JSON. Local
 * state also carries `schemaVersion` with the same fail-safe rule.
 */

import { parseFrontmatter } from "../backend/parse.ts";
import { validateId, validateProjectId, PathEscapeError } from "./paths.ts";

/** Current schema version emitted by this extension. */
export const SCHEMA_VERSION = 1;

export type RecordType =
  "observation" | "reflection" | "proposal" | "backup-chunk" | "board-message";

export type LifecycleStatus = "active" | "superseded" | "pending-approval";

export type RecordScope = "personal" | `project/${string}`;

/**
 * Provenance. Session, branch and entry ids are three distinct identity
 * spaces (architecture.md §2): `entryIds` are entry ids *within* the session
 * tree identified by `sessionId`; `branchId` distinguishes the Pi tree branch
 * when the session forked.
 */
export interface SourceRef {
  sessionId: string;
  branchId?: string;
  /** Entry ids consumed to produce this record, in capture order. */
  entryIds: string[];
}

export interface RecordFrontmatter {
  schemaVersion: number;
  id: string;
  type: RecordType;
  scope: RecordScope;
  created: string; // ISO-8601 UTC
  sources: SourceRef[];
  model?: string; // model-generated records only
  status: LifecycleStatus;
  /** Board messages only (architecture.md §2). */
  to?: string;
  from?: string;
  channel?: string;
  ttl?: string;
}

export interface StoredRecord {
  frontmatter: RecordFrontmatter;
  /** Markdown body (the observation/reflection/proposal content). */
  body: string;
}

export type RecordReadResult =
  | { ok: true; record: StoredRecord }
  | {
      ok: false;
      reason: "malformed" | "future-version" | "unsupported-version";
      detail: string;
      /** True when the content must be treated as read-only, never rewritten. */
      readOnly: true;
    };

const RECORD_TYPES: readonly RecordType[] = [
  "observation",
  "reflection",
  "proposal",
  "backup-chunk",
  "board-message",
];
const STATUSES: readonly LifecycleStatus[] = [
  "active",
  "superseded",
  "pending-approval",
];

function fail(
  reason: "malformed" | "future-version" | "unsupported-version",
  detail: string,
): RecordReadResult {
  return { ok: false, reason, detail, readOnly: true };
}

function parseSourceRefs(raw: string): SourceRef[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "sources is not valid JSON";
  }
  if (!Array.isArray(parsed)) return "sources must be a JSON array";
  const out: SourceRef[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      return "each source must be an object";
    }
    const s = item as Record<string, unknown>;
    if (typeof s.sessionId !== "string" || s.sessionId === "") {
      return "source sessionId missing";
    }
    const entryIds = s.entryIds;
    if (
      !Array.isArray(entryIds) ||
      entryIds.some((e) => typeof e !== "string" || e === "")
    ) {
      return "source entryIds must be a non-empty string array";
    }
    out.push({
      sessionId: s.sessionId,
      ...(typeof s.branchId === "string" && s.branchId !== ""
        ? { branchId: s.branchId }
        : {}),
      entryIds: entryIds as string[],
    });
  }
  return out;
}

/**
 * Parses and validates a backend markdown record. A record whose
 * schemaVersion is newer than `SCHEMA_VERSION` fails safely as
 * `future-version` (read-only, never destructively rewritten); malformed
 * input fails as `malformed`.
 */
export function parseStoredRecord(doc: string): RecordReadResult {
  const { frontmatter: fm, body } = parseFrontmatter(doc);
  const rawVersion = fm["schemaVersion"];
  if (rawVersion === undefined) {
    return fail("malformed", "schemaVersion missing");
  }
  const version = Number(rawVersion);
  if (!Number.isInteger(version) || version < 1) {
    return fail(
      "malformed",
      `schemaVersion is not a positive integer: ${rawVersion}`,
    );
  }
  if (version > SCHEMA_VERSION) {
    return fail(
      "future-version",
      `schemaVersion ${version} is newer than supported ${SCHEMA_VERSION}; failing safe read-only`,
    );
  }
  // version === 1 only; older versions cannot exist yet, but stay explicit.
  if (version !== SCHEMA_VERSION) {
    return fail("unsupported-version", `schemaVersion ${version} not readable`);
  }
  const id = fm["id"];
  const type = fm["type"] as RecordType | undefined;
  const scope = fm["scope"] as RecordScope | undefined;
  const created = fm["created"];
  const status = fm["status"] as LifecycleStatus | undefined;
  const rawSources = fm["sources"];
  if (!id || !type || !scope || !created || !status || !rawSources) {
    return fail(
      "malformed",
      "required frontmatter fields missing (id, type, scope, created, status, sources)",
    );
  }
  if (!RECORD_TYPES.includes(type)) {
    return fail("malformed", `unknown record type: ${type}`);
  }
  if (!STATUSES.includes(status)) {
    return fail("malformed", `unknown lifecycle status: ${status}`);
  }
  if (scope !== "personal" && !scope.startsWith("project/")) {
    return fail("malformed", `scope is not an owner scope: ${scope}`);
  }
  try {
    validateId(type, id);
    if (scope.startsWith("project/")) {
      validateProjectId(scope.slice("project/".length));
    }
  } catch (err) {
    return fail("malformed", (err as PathEscapeError).message);
  }
  if (Number.isNaN(Date.parse(created))) {
    return fail(
      "malformed",
      `created is not an ISO-8601 timestamp: ${created}`,
    );
  }
  const sources = parseSourceRefs(rawSources);
  if (typeof sources === "string") return fail("malformed", sources);
  const model = fm["model"];
  const record: StoredRecord = {
    frontmatter: {
      schemaVersion: version,
      id,
      type,
      scope,
      created,
      status,
      sources,
      ...(model !== undefined ? { model } : {}),
      ...(type === "board-message"
        ? {
            to: fm["to"] ?? "",
            from: fm["from"] ?? "",
            channel: fm["channel"] ?? "",
            ttl: fm["ttl"] ?? "",
          }
        : {}),
    },
    body,
  };
  return { ok: true, record };
}

/** Stable `key: value` frontmatter line for markdown serialization. */
function fmLine(key: string, value: string): string {
  if (/[\n\r]/.test(value)) {
    throw new Error(`frontmatter value for ${key} contains a newline`);
  }
  return `${key}: ${value}`;
}

/** Serializes a validated record to its markdown wire format. */
export function serializeStoredRecord(record: StoredRecord): string {
  const fm = record.frontmatter;
  if (fm.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `refusing to write schemaVersion ${fm.schemaVersion}; only ${SCHEMA_VERSION} is writable`,
    );
  }
  const lines = [
    fmLine("schemaVersion", String(fm.schemaVersion)),
    fmLine("id", fm.id),
    fmLine("type", fm.type),
    fmLine("scope", fm.scope),
    fmLine("created", fm.created),
    fmLine("sources", JSON.stringify(fm.sources)),
  ];
  if (fm.model !== undefined) lines.push(fmLine("model", fm.model));
  lines.push(fmLine("status", fm.status));
  if (fm.type === "board-message") {
    lines.push(fmLine("to", fm.to ?? ""));
    lines.push(fmLine("from", fm.from ?? ""));
    lines.push(fmLine("channel", fm.channel ?? ""));
    lines.push(fmLine("ttl", fm.ttl ?? ""));
  }
  return `---\n${lines.join("\n")}\n---\n${record.body}`;
}

// ---------- local JSON artifacts (tombstone cache, cursor, manifest) ----------

export interface TombstoneEntry {
  schemaVersion: number;
  /** Backend path of the superseded/deleted record. */
  path: string;
  status: "superseded" | "deleted";
  supersededAt: string;
  reason: string;
}

export interface ProcessingCursor {
  schemaVersion: number;
  sessionId: string;
  /** Last durably consumed entry id (coverage cursor, architecture.md §4). */
  lastConsumedEntryId: string;
  updatedAt: string;
}

export interface BackupManifest {
  schemaVersion: number;
  projectId: string;
  sessionId: string;
  /** Covered entry range (first/last entry ids, inclusive). */
  coveredRange: { firstEntryId: string; lastEntryId: string };
  chunks: { seq: number; path: string; checksum: string }[];
  /** Redaction counts by type — counts only, never secret values. */
  redactionSummary: Record<string, number>;
  omissions: { entryId: string; reason: string }[];
  createdAt: string;
}

export type LocalArtifact = TombstoneEntry | ProcessingCursor | BackupManifest;

export type LocalArtifactReadResult<T> =
  | { ok: true; artifact: T }
  | {
      ok: false;
      reason: "malformed" | "future-version" | "unsupported-version";
      detail: string;
      readOnly: true;
    };

/**
 * Generic fail-safe JSON reader for local artifacts. Unknown newer versions
 * fail read-only; malformed JSON/shape fails; nothing is ever rewritten.
 */
export function parseLocalArtifact<T extends LocalArtifact>(
  kind: "tombstone" | "cursor" | "manifest",
  json: string,
): LocalArtifactReadResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      ok: false,
      reason: "malformed",
      detail: "not valid JSON",
      readOnly: true,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      reason: "malformed",
      detail: "not an object",
      readOnly: true,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const version = obj.schemaVersion;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    return {
      ok: false,
      reason: "malformed",
      detail: "schemaVersion missing or not a positive integer",
      readOnly: true,
    };
  }
  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "future-version",
      detail: `schemaVersion ${version} is newer than supported ${SCHEMA_VERSION}; failing safe read-only`,
      readOnly: true,
    };
  }
  if (version !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "unsupported-version",
      detail: `schemaVersion ${version} not readable`,
      readOnly: true,
    };
  }
  switch (kind) {
    case "tombstone": {
      if (
        typeof obj.path !== "string" ||
        (obj.status !== "superseded" && obj.status !== "deleted") ||
        typeof obj.supersededAt !== "string" ||
        typeof obj.reason !== "string"
      ) {
        return {
          ok: false,
          reason: "malformed",
          detail: "tombstone requires path, status, supersededAt, reason",
          readOnly: true,
        };
      }
      return {
        ok: true,
        artifact: {
          schemaVersion: version,
          path: obj.path,
          status: obj.status,
          supersededAt: obj.supersededAt,
          reason: obj.reason,
        } as unknown as T,
      };
    }
    case "cursor": {
      if (
        typeof obj.sessionId !== "string" ||
        obj.sessionId === "" ||
        typeof obj.lastConsumedEntryId !== "string" ||
        typeof obj.updatedAt !== "string"
      ) {
        return {
          ok: false,
          reason: "malformed",
          detail: "cursor requires sessionId, lastConsumedEntryId, updatedAt",
          readOnly: true,
        };
      }
      return {
        ok: true,
        artifact: {
          schemaVersion: version,
          sessionId: obj.sessionId,
          lastConsumedEntryId: obj.lastConsumedEntryId,
          updatedAt: obj.updatedAt,
        } as unknown as T,
      };
    }
    case "manifest": {
      if (
        typeof obj.projectId !== "string" ||
        typeof obj.sessionId !== "string" ||
        typeof obj.coveredRange !== "object" ||
        obj.coveredRange === null ||
        !Array.isArray(obj.chunks) ||
        typeof obj.redactionSummary !== "object" ||
        obj.redactionSummary === null ||
        !Array.isArray(obj.omissions) ||
        typeof obj.createdAt !== "string"
      ) {
        return {
          ok: false,
          reason: "malformed",
          detail: "manifest shape invalid",
          readOnly: true,
        };
      }
      try {
        validateProjectId(obj.projectId as string);
      } catch (err) {
        return {
          ok: false,
          reason: "malformed",
          detail: (err as Error).message,
          readOnly: true,
        };
      }
      return {
        ok: true,
        artifact: {
          schemaVersion: version,
          projectId: obj.projectId,
          sessionId: obj.sessionId,
          coveredRange: obj.coveredRange as BackupManifest["coveredRange"],
          chunks: obj.chunks as BackupManifest["chunks"],
          redactionSummary: obj.redactionSummary as Record<string, number>,
          omissions: obj.omissions as BackupManifest["omissions"],
          createdAt: obj.createdAt,
        } as unknown as T,
      };
    }
  }
}
