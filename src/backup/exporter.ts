/**
 * T14: session-tree exporter — converts Pi session entries into redactable
 * backup entries that preserve the tree structure (architecture.md §7,
 * decisions.md #2).
 *
 * - Every included entry keeps its Pi `id` and `parentId`, so branch
 *   relationships survive the export (backup identity is Pi entry IDs —
 *   lineage is never a content hash, §3.3).
 * - Message text and tool-result text are extracted; non-text content
 *   blocks (images, binary tool payloads) are OMITTED and recorded as
 *   `{entryId, reason: "binary-omitted"}` — binaries never reach storage.
 * - Extension-internal entries (`kiwifs.` custom prefix) are excluded from
 *   capture (no recursion of our own injections) and recorded as omissions.
 * - Raw text returned by this module is LOCAL capture state: it is redacted
 *   by the backup capture engine before it is ever serialized into a chunk
 *   or sent anywhere (privacy gate on every outbound edge, §5).
 */

/** Extension-owned custom entry prefix — never captured (no recursion). */
const KIWIFS_CUSTOM_PREFIX = "kiwifs.";

export const BACKUP_SCHEMA_VERSION = 1;

/** Recorded reasons why an entry's content is absent from the backup. */
export type BackupOmissionReason =
  "binary-omitted" | "excluded-by-policy" | "extension-internal";

/**
 * One backup entry, pre-redaction. `text` is raw local session text; the
 * capture engine redacts it before serialization (never the reverse).
 */
export interface BackupView {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  /** Message role when the Pi entry is a message. */
  role?: string;
  /** Extracted raw text (may be undefined when there is none). */
  text?: string;
  /** Content-absence reasons recorded for this entry (see module doc). */
  omissions: BackupOmissionReason[];
}

interface ContentBlock {
  type: string;
  text?: string;
}

function extractText(
  content: unknown,
  omissions: BackupOmissionReason[],
): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Partial<ContentBlock>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (typeof block.type === "string") {
      // Non-text content (images, binary tool payloads, ...): omitted and
      // recorded — never guessed at, never partially serialized.
      if (!omissions.includes("binary-omitted")) {
        omissions.push("binary-omitted");
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Adapts Pi session entries (defensively typed) into backup views, ordered
 * as delivered by the session manager, preserving `id`/`parentId`.
 */
export function toBackupViews(entries: readonly unknown[]): BackupView[] {
  const views: BackupView[] = [];
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const id = e["id"];
    if (typeof id !== "string" || id === "") continue;
    const omissions: BackupOmissionReason[] = [];
    const type = typeof e["type"] === "string" ? e["type"] : "";
    const view: BackupView = {
      id,
      parentId:
        typeof e["parentId"] === "string" || e["parentId"] === null
          ? (e["parentId"] as string | null)
          : null,
      type,
      timestamp: typeof e["timestamp"] === "string" ? e["timestamp"] : "",
      omissions,
    };
    let text: string | undefined;
    if (type === "message") {
      const msg = e["message"] as Record<string, unknown> | undefined;
      if (!msg || typeof msg !== "object") continue;
      if (typeof msg["role"] === "string") view.role = msg["role"];
      text = extractText(msg["content"], omissions);
    } else if (type === "custom_message") {
      if (
        typeof e["customType"] === "string" &&
        e["customType"].startsWith(KIWIFS_CUSTOM_PREFIX)
      ) {
        view.omissions.push("extension-internal");
        views.push(view);
        continue;
      }
      text = extractText(e["content"], omissions);
    } else if (type === "custom") {
      if (
        typeof e["customType"] === "string" &&
        e["customType"].startsWith(KIWIFS_CUSTOM_PREFIX)
      ) {
        view.omissions.push("extension-internal");
        views.push(view);
        continue;
      }
      // Extension metadata: serialized as data, never executed (decisions #4).
      text = JSON.stringify(e["data"] ?? null);
    } else if (
      type === "compaction" ||
      type === "branch_summary" ||
      type === "label" ||
      type === "session_info" ||
      type === "thinking_level_change" ||
      type === "model_change"
    ) {
      // Lifecycle metadata entries: summarized as text so the tree shape is
      // preserved without special-casing each type downstream.
      const summary = e["summary"];
      if (typeof summary === "string") {
        text = summary;
      } else if (type === "label") {
        text =
          typeof e["label"] === "string"
            ? e["label"]
            : `label target=${String(e["targetId"] ?? "")}`;
      } else if (type === "model_change") {
        text = `${String(e["provider"] ?? "")}/${String(e["modelId"] ?? "")}`;
      } else if (type === "thinking_level_change") {
        text = String(e["thinkingLevel"] ?? "");
      } else if (type === "session_info") {
        text = typeof e["name"] === "string" ? e["name"] : "";
      }
    } else {
      // Unknown entry type: keep the shell (id/parent/timestamp), no text —
      // tree relationships still survive; content is unknown by definition.
      text = undefined;
    }
    if (text !== undefined && text.trim() !== "") view.text = text;
    views.push(view);
  }
  return views;
}
