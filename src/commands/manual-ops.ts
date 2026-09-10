/**
 * T18 chunk 2: manual memory operations behind user commands (PRD T18).
 *
 * - Forget (/kiwifs-forget): reversible logical forget via the backend's
 *   `kiwi_forget` (frontmatter rewrite to `memory_status: superseded`; the
 *   body is PRESERVED — nothing is deleted, B6). The forget opId is durably
 *   recorded in a local append-only op log (fsync) BEFORE the side effect,
 *   mirroring the proposal lifecycle discipline. After a successful forget
 *   the advisory tombstone cache is refreshed and cached pending evidence
 *   packs are dropped so stale content cannot be injected later.
 * - Forget-undo (/kiwifs-forget-undo): verified read→write restore of
 *   `memory_status: active` with a provenance line, verified by read-back.
 * - Erasure report (/kiwifs-erasure-report): B6 DISCLOSURE ONLY — lists
 *   where record content is retained, performs no I/O, deletes nothing and
 *   claims no purge capability.
 *
 * All outputs are sanitized (paths/opIds/status only — never record content,
 * never secrets). Headless/RPC safe: no TUI-only APIs are used here.
 */

import { randomUUID } from "node:crypto";
import type { AuditSinkLike } from "../privacy/audit.ts";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { KiwiFSAdapter } from "../backend/adapter.ts";
import type { AuthRef } from "../config/schema.ts";
import { resolveAuthSecret } from "../observation/model.ts";
import { parseFrontmatter } from "../backend/parse.ts";
import { redactText } from "../privacy/redaction.ts";

/**
 * Q03b: forget reasons are user free-text that persists in TWO durable places
 * (the local op log JSONL and the backend `superseded_reason` frontmatter),
 * so the reason is redacted ONCE here — before any persistence — and the
 * sanitized value flows to both sinks.
 *
 * Fail closed on reason only: if the redactor cannot classify the reason
 * (control chars, internal fault), the reason is HELD (omitted from both the
 * op log and the backend call) and the forget itself still proceeds — the
 * reason is optional metadata, but unclassified content is never persisted.
 * The result detail discloses the hold without disclosing the reason.
 */
function sanitizeForgetReason(
  reason: string,
): { ok: true; reason: string } | { ok: false; held: true } {
  const res = redactText(reason);
  if (!res.ok) return { ok: false, held: true };
  return { ok: true, reason: res.content };
}

// ---- durable manual-op log (local audit + opId ledger) ---------------------

export interface ManualOpEntry {
  opId: string;
  action: "forget" | "forget-undo";
  path: string;
  reason?: string;
  actor?: string;
  at: string;
}

interface ManualOpLogLine extends ManualOpEntry {
  schemaVersion: number;
}

/**
 * Append-only local op log for manual forget/forget-undo operations. Doubles
 * as the T04 opId ledger for manual writes: an opId is fsync-persisted here
 * BEFORE any backend side effect. Corrupt history fails closed.
 */
export class ManualOpLog {
  private readonly file: string;
  private readonly known = new Set<string>();

  constructor(stateDir: string) {
    this.file = join(stateDir, "manual-oplog.jsonl");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const raw = readFileSync(this.file, "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(
          "manual op log is corrupt (failing closed; forget commands disabled)",
        );
      }
      const rec = parsed as ManualOpLogLine;
      if (
        typeof rec !== "object" ||
        rec === null ||
        typeof rec.opId !== "string" ||
        rec.opId === ""
      ) {
        throw new Error(
          "manual op log contains a malformed entry (failing closed)",
        );
      }
      this.known.add(rec.opId);
    }
  }

  /** Durably records the op (fsync) before any side effect. */
  record(entry: ManualOpEntry): void {
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    const line: ManualOpLogLine = { schemaVersion: 1, ...entry };
    appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    const fd = openSync(this.file, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const dirFd = openSync(join(this.file, ".."), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    this.known.add(entry.opId);
  }

  has(opId: string): boolean {
    return this.known.has(opId);
  }

  /** T04 opId ledger view for the backend adapter (fail closed). */
  ledger(): {
    record: (opId: string) => void;
    assertPersisted: (opId: string) => void;
  } {
    return {
      record: (opId: string) => {
        if (!this.has(opId)) {
          throw new Error(
            "refusing to record opId that is not durably persisted",
          );
        }
      },
      assertPersisted: (opId: string) => {
        if (!this.has(opId)) {
          throw new Error(
            "opId was not durably persisted before mutation (refusing side effect)",
          );
        }
      },
    };
  }
}

// ---- manual ops store (minimal structural surface) -------------------------

export interface ManualOpsStore {
  read(
    path: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    state: "ok" | "missing" | "not_modified";
    content?: string;
    frontmatter: Record<string, string>;
    body: string;
  }>;
  write(
    path: string,
    content: string,
    opts: {
      opId: string;
      actor?: string;
      provenance?: string;
      signal?: AbortSignal;
    },
  ): Promise<unknown>;
  forget(
    path: string,
    opts: { reason?: string; opId: string; signal?: AbortSignal },
  ): Promise<unknown>;
}

/** Sanitized error fingerprint: name(+code) only, never message content. */
export function errorName(err: unknown): string {
  if (err instanceof Error) {
    const code =
      typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    return code ? `${err.name}:${code}` : err.name;
  }
  return "unknown";
}

export type ManualOpLogger = Pick<ManualOpLog, "record" | "has">;

export type ManualOpResult =
  { ok: true; opId: string; detail: string } | { ok: false; reason: string };

export interface ManualOpsDeps {
  opLog: ManualOpLogger;
  openStore: () => Promise<ManualOpsStore | undefined>;
  path: string;
  reason?: string;
  actor?: string;
  /** Advisory tombstone cache (refreshed after a successful forget). */
  tombstoneCache?: { refresh(signal?: AbortSignal): Promise<void> };
  /** Pending evidence-pack registry (cleared after a successful forget). */
  registry?: { dropUnmatched(): { inputId: string; origin: string }[] };
  /** Q04c: sanitized metadata-only audit sink (command events). */
  audit?: AuditSinkLike;
  now?: () => Date;
}

/**
 * Reversible logical forget: opId durably recorded first, then the backend
 * `kiwi_forget` (superseded frontmatter, body preserved), then advisory
 * cache/registry invalidation so forgotten content cannot be re-served from
 * cached evidence. Failures after the durable record leave a harmless audit
 * entry with no side effect.
 */
export async function forgetMemoryPath(
  deps: ManualOpsDeps,
): Promise<ManualOpResult> {
  const opId = randomUUID();
  const at = (deps.now ?? (() => new Date()))().toISOString();
  // Q03b: redact BEFORE both durable sinks (local op log + backend).
  const sanitized =
    deps.reason !== undefined
      ? sanitizeForgetReason(deps.reason)
      : { ok: true, reason: undefined as string | undefined };
  const reasonHeld =
    deps.reason !== undefined && !sanitized.ok
      ? "; reason held (could not be classified safely)"
      : "";
  const reason: string | undefined = sanitized.ok
    ? sanitized.reason
    : undefined;
  deps.opLog.record({
    opId,
    action: "forget",
    path: deps.path,
    ...(reason !== undefined ? { reason } : {}),
    ...(deps.actor !== undefined ? { actor: deps.actor } : {}),
    at,
  });
  let store;
  try {
    store = await deps.openStore();
  } catch (err) {
    // Q04c: an openStore failure is audited, never silent.
    deps.audit?.record({
      kind: "command",
      feature: "commands",
      decision: `failed (forget: ${errorName(err)})`,
      targetId: opId,
    });
    return {
      ok: false,
      reason: `forget failed: ${errorName(err)} (no content disclosed)`,
    };
  }
  if (!store) {
    return {
      ok: false,
      reason:
        "backend not configured or credential unresolved — forget unavailable (retryable)",
    };
  }
  try {
    await store.forget(deps.path, {
      ...(reason !== undefined ? { reason } : {}),
      opId,
    });
    // Advisory invalidation: stale tombstones and cached evidence must not
    // outlive the forget (the read-back guard remains the hard gate).
    let dropped = 0;
    if (deps.registry) dropped = deps.registry.dropUnmatched().length;
    await deps.tombstoneCache?.refresh();
    deps.audit?.record({
      kind: "command",
      feature: "commands",
      decision: `ok (forget)${reasonHeld}`,
      targetId: opId,
    });
    return {
      ok: true,
      opId,
      detail: `forgotten (reversible): ${deps.path}${reasonHeld}${dropped > 0 ? `; ${dropped} cached evidence pack(s) dropped` : ""}; tombstone cache refreshed`,
    };
  } catch (err) {
    deps.audit?.record({
      kind: "command",
      feature: "commands",
      decision: `failed (forget: ${errorName(err)})`,
      targetId: opId,
    });
    return {
      ok: false,
      reason: `forget failed: ${errorName(err)} (no content disclosed)`,
    };
  }
}

/** Re-serializes frontmatter + body deterministically (stable key order). */
export function serializeFrontmatterDoc(
  frontmatter: Record<string, string>,
  body: string,
): string {
  const lines = Object.entries(frontmatter).map(([k, v]) =>
    v.includes("\n") || v.includes('"') || v !== v.trim()
      ? `${k}: ${JSON.stringify(v)}`
      : `${k}: ${v}`,
  );
  return `---\n${lines.join("\n")}\n---\n${body.startsWith("\n") ? "" : "\n"}${body}`;
}

/**
 * Verified restore of a forgotten record: fresh read, strict pre-state check
 * (`memory_status: superseded`), status flip to `active` with a provenance
 * line, opId durably recorded BEFORE the write, then a byte-identical
 * read-back verification. A mismatch fails visibly — no silent overwrite.
 */
export async function unforgetMemoryPath(
  deps: Omit<ManualOpsDeps, "reason" | "tombstoneCache" | "registry"> & {
    tombstoneCache?: { refresh(signal?: AbortSignal): Promise<void> };
  },
): Promise<ManualOpResult> {
  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();
  let store;
  try {
    store = await deps.openStore();
  } catch (err) {
    deps.audit?.record({
      kind: "command",
      feature: "commands",
      decision: `failed (forget-undo: ${errorName(err)})`,
    });
    return {
      ok: false,
      reason: `forget-undo failed: ${errorName(err)} (no content disclosed)`,
    };
  }
  if (!store) {
    return {
      ok: false,
      reason:
        "backend not configured or credential unresolved — forget-undo unavailable (retryable)",
    };
  }
  let doc: string;
  try {
    const res = await store.read(deps.path);
    if (res.state !== "ok" || res.content === undefined) {
      return {
        ok: false,
        reason: `record not readable at ${deps.path} (state: ${res.state}) — nothing to restore`,
      };
    }
    const fm = res.frontmatter;
    if (fm["memory_status"] !== "superseded") {
      return {
        ok: false,
        reason: `record at ${deps.path} is not forgotten (memory_status: ${fm["memory_status"] ?? "unset"})`,
      };
    }
    const restored: Record<string, string> = { ...fm };
    restored["memory_status"] = "active";
    delete restored["superseded_reason"];
    const opId = randomUUID();
    const provLine = `kiwifs-provenance: forget undone by ${deps.actor ?? "user"} at ${at} (op ${opId})`;
    const body = `${res.body.trimEnd()}\n\n${provLine}\n`;
    doc = serializeFrontmatterDoc(restored, body);
    deps.opLog.record({
      opId,
      action: "forget-undo",
      path: deps.path,
      ...(deps.actor !== undefined ? { actor: deps.actor } : {}),
      at,
    });
    await store.write(deps.path, doc, {
      opId,
      ...(deps.actor !== undefined ? { actor: deps.actor } : {}),
      provenance: "forget-undo",
    });
    // Byte-identical read-back verification: the restore only counts when
    // the backend serves EXACTLY what we wrote.
    const verify = await store.read(deps.path);
    if (verify.state !== "ok" || verify.content !== doc) {
      return {
        ok: false,
        reason:
          "restore not verified (read-back mismatch) — the record was modified concurrently; inspect before retrying",
      };
    }
    await deps.tombstoneCache?.refresh();
    deps.audit?.record({
      kind: "command",
      feature: "commands",
      decision: "ok (forget-undo)",
      targetId: opId,
    });
    return {
      ok: true,
      opId,
      detail: `restored to active: ${deps.path} (read-back verified)`,
    };
  } catch (err) {
    deps.audit?.record({
      kind: "command",
      feature: "commands",
      decision: `failed (forget-undo: ${errorName(err)})`,
    });
    return {
      ok: false,
      reason: `forget-undo failed: ${errorName(err)} (no content disclosed)`,
    };
  }
}

// ---- backend factory (mirrors the proposal lifecycle wiring) ---------------

/**
 * Cached backend for manual ops: opIds must be durably persisted in the
 * manual op log BEFORE any mutation, so the adapter ledger checks that log.
 * An unconfigured/unresolvable credential returns undefined (retryable gap —
 * never an unauthenticated write).
 */
export function createManualOps(
  config: {
    url: string;
    auth: AuthRef;
  },
  opLog: ManualOpLog,
): { openStore: () => Promise<ManualOpsStore | undefined> } {
  let cached: KiwiFSAdapter | undefined;
  return {
    openStore: async () => {
      if (!cached) {
        const secret = resolveAuthSecret(config.auth);
        if (secret === undefined) return undefined;
        cached = new KiwiFSAdapter({
          url: config.url,
          headers: { Authorization: `Bearer ${secret}` },
          ledger: opLog.ledger(),
        });
        await cached.connect();
      }
      return cached;
    },
  };
}

// ---- B6 erasure disclosure (disclosure-only, zero I/O) ---------------------

/**
 * B6: the extension performs NO permanent erasure. `kiwi_forget` is
 * reversible by design (superseded frontmatter; body preserved). Memory
 * records (observations/reflections/proposals/backups) have no remote-delete
 * path; the ONE remote-delete surface is the user-confirmed manual board
 * cleanup command (Q05R3, decisions.md #14), which deletes only the user's
 * own board messages at MCP level and purges nothing else. This report
 * discloses where record content is retained so an operator can plan any
 * true erasure procedure themselves.
 */
export function erasureReportLines(): string[] {
  return [
    "KiwiFS erasure report (B6) — disclosure only; no I/O, nothing is deleted by this command.",
    "",
    "Permanent erasure is NOT supported by this extension by design:",
    "- kiwi_forget is REVERSIBLE: it marks records superseded (memory_status:",
    "  superseded) and PRESERVES the body. /kiwifs-forget-undo restores them.",
    "- No remote-delete capability for MEMORY records exists (the only",
    "  remote delete is the user-confirmed /kiwifs-board-cleanup command:",
    "  own board messages only, MCP-level, no index/history/backup purge)",
    "",
    "Where record content is retained (for operator planning):",
    "- Backend record bodies (active AND superseded records, memory/ namespace)",
    "- Transcript backups (backup/{project}/... chunks, incl. redacted originals)",
    "- Merge-proposal records and their provenance history (memory/merge-proposals/)",
    "- The backend's vector/search index (server-side; not client-accessible)",
    "- Git history/remotes if the backend storage is git-backed or mirrored",
    "- LOCAL durable state: outbox queue (already-redacted payloads), board",
    "  delivery state files, proposal/manual op logs (paths + opIds only)",
    "",
    "A true erasure requires an operator procedure against the backend storage",
    "directly, plus verification against the copies listed above. Read-back",
    "guards (B3) keep forgotten records out of retrieval regardless.",
  ];
}
