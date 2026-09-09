/**
 * T17: board delivery and acknowledgment (PRD T17, architecture.md §8,
 * §13 row 12).
 *
 * Guarantee (documented, never overclaimed): at-least-once delivery with
 * client-side dedupe by msg_id. A crash between the deliver callback
 * resolving and the durable state write replays the message on the next
 * cycle — no exactly-once claim is made anywhere.
 *
 * Local state is AUTHORITATIVE and durable (atomic temp+fsync+rename writes,
 * same discipline as src/outbox/cursor.ts):
 * - Per-consumer state file → two consumers maintain fully independent
 *   cursors and dedupe sets.
 * - Offline startup works with no remote cursor at all: the first successful
 *   poll replays the changes feed from the beginning and dedupe suppresses
 *   already-delivered messages (no repeated logical notifications).
 * - The remote cursor (last_seq / commit hash) is a reconciliation aid only.
 *
 * Acknowledgment is LOCAL STATE ONLY: `ack()` never touches the backend.
 * There is no automatic remote deletion (B6); expired messages are skipped
 * visibly (client-side TTL at read time, B5) and remain on the remote until
 * an explicitly confirmed, ownership-scoped manual GC (out of scope here).
 *
 * Polling bounds (§13 row 12): 60 s active interval; after 3 consecutive
 * empty polls, exponential backoff capped at 15 min; unread backlog pause at
 * 500 with a visible "backlog-paused" status — polling stops, nothing is
 * dropped, delivery resumes when the backlog is acknowledged down.
 *
 * Untrusted data (decisions.md #4): message bodies are opaque data passed
 * verbatim to the deliver callback; nothing here parses or executes them.
 *
 * Routing disclosure: `to`/`channel` are labels on a single-shared-key
 * backend, not confidentiality. Recipient checks are client policy only.
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  writeSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { boardChannelOfPath, type BoardRepository } from "./repository.ts";

export const DELIVERY_SCHEMA_VERSION = 1;

/** §13 row 12 defaults ([P]). */
export const ACTIVE_POLL_MS = 60_000;
export const EMPTY_POLLS_BEFORE_BACKOFF = 3;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_CAP_MS = 15 * 60_000;
export const BACKLOG_PAUSE_THRESHOLD = 500;
/** Bounded catch-up: pages of ≤500 changes per cycle (§6 bound). */
export const MAX_CHANGES_PAGES_PER_CYCLE = 20;
export const CHANGES_PAGE_LIMIT = 500;
/**
 * Dedupe-set bound. Eviction removes ACKED and skipped entries (oldest
 * first) only — undelivered entries are NEVER evicted, so backlog growth
 * surfaces as "backlog-paused", not silent loss.
 */
export const MAX_TRACKED_ENTRIES = 2_000;
/** Acknowledged entries older than this are pruned on save. */
export const ACK_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export type DeliveryEntrySkip =
  "expired" | "unauthorized" | "missing" | "malformed";

export interface DeliveryEntry {
  msgId: string;
  path: string;
  channel: string;
  /** Epoch ms when the deliver callback resolved successfully. */
  deliveredAt?: number;
  /** Epoch ms of the LOCAL-ONLY acknowledgment. */
  ackedAt?: number;
  /** Visible skip reason; skipped messages were never delivered. */
  skip?: DeliveryEntrySkip;
  skippedAt?: number;
}

export interface DeliveryState {
  schemaVersion: number;
  /** Stable consumer identity; one file per consumer → independent cursors. */
  consumerId: string;
  /** Reconciliation aid only — never trusted over the local dedupe set. */
  lastSeq?: string;
  entries: Record<string, DeliveryEntry>;
}

/** Atomic durable per-consumer delivery state (no network, ever). */
export class DeliveryStateFile {
  private state: DeliveryState;
  private readonly file: string;
  private readonly tmp: string;

  constructor(dir: string, consumerId: string) {
    this.file = join(dir, `delivery-${consumerId}.json`);
    this.tmp = `${this.file}.tmp`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(this.file)) {
      const parsed = JSON.parse(
        readFileSync(this.file, "utf8"),
      ) as DeliveryState;
      if (parsed.schemaVersion > DELIVERY_SCHEMA_VERSION) {
        // Fail safe: keep the newer-format data unread-but-intact; the
        // delivery layer treats unknown versions as "dedupe unavailable"
        // and callers must not run delivery (fail closed, not reset).
        throw new Error(
          `delivery state schema ${parsed.schemaVersion} is newer than supported ${DELIVERY_SCHEMA_VERSION}`,
        );
      }
      this.state = parsed;
    } else {
      this.state = {
        schemaVersion: DELIVERY_SCHEMA_VERSION,
        consumerId,
        entries: {},
      };
      this.save();
    }
  }

  get value(): Readonly<DeliveryState> {
    return this.state;
  }

  /** Directory holding this state file (consumer lock lives here too). */
  get dir(): string {
    return dirname(this.file);
  }

  get lastSeq(): string | undefined {
    return this.state.lastSeq;
  }

  getEntry(msgId: string): Readonly<DeliveryEntry> | undefined {
    return this.state.entries[msgId];
  }

  /** Undelivered + unacknowledged = the visible unread backlog. */
  unreadCount(): number {
    let n = 0;
    for (const e of Object.values(this.state.entries)) {
      if (e.deliveredAt !== undefined && e.ackedAt === undefined) n++;
      else if (e.deliveredAt === undefined && e.skip === undefined) n++;
    }
    return n;
  }

  setLastSeq(seq: string): void {
    this.state.lastSeq = seq;
    this.save();
  }

  recordDelivered(entry: DeliveryEntry, now: number): void {
    this.state.entries[entry.msgId] = { ...entry, deliveredAt: now };
    this.save();
  }

  recordSkip(entry: DeliveryEntry, skip: DeliveryEntrySkip, now: number): void {
    this.state.entries[entry.msgId] = { ...entry, skip, skippedAt: now };
    this.save();
  }

  /**
   * LOCAL acknowledgment only. Mutates nothing remote — this class holds no
   * backend reference at all, which makes the no-remote-mutation property
   * structural, not merely conventional.
   */
  recordAck(msgId: string, now: number): boolean {
    const e = this.state.entries[msgId];
    if (!e) return false;
    if (e.ackedAt !== undefined) return true; // idempotent
    e.ackedAt = now;
    this.save();
    return true;
  }

  /**
   * Explicit LOCAL-ONLY GC (T18, /kiwifs-board-gc): prunes acknowledged AND
   * skipped entries past the ack retention window. Undelivered entries are
   * NEVER touched (they are the backlog). No backend reference exists on
   * this class — the no-remote-mutation property is structural.
   * Returns the number of removed entries.
   */
  gc(): number {
    const now = Date.now();
    const entries = this.state.entries;
    let removed = 0;
    for (const [id, e] of Object.entries(entries)) {
      const settledAt = e.ackedAt ?? e.skippedAt;
      if (settledAt === undefined) continue; // undelivered — never touched
      if (now - settledAt > ACK_RETENTION_MS) {
        delete entries[id];
        removed++;
      }
    }
    if (removed > 0) this.save();
    return removed;
  }

  /**
   * Bounded set: prune acked entries past retention, then evict oldest
   * acked/skipped entries over the cap. Undelivered entries are never
   * evicted (never drop undelivered work silently).
   */
  private save(): void {
    const entries = this.state.entries;
    let now = 0;
    for (const e of Object.values(entries)) {
      now = Math.max(now, e.deliveredAt ?? 0, e.ackedAt ?? 0, e.skippedAt ?? 0);
    }
    for (const [id, e] of Object.entries(entries)) {
      if (e.ackedAt !== undefined && now - e.ackedAt > ACK_RETENTION_MS) {
        delete entries[id];
      }
    }
    const list = Object.values(entries).sort(
      (a, b) =>
        (a.ackedAt ?? a.skippedAt ?? a.deliveredAt ?? 0) -
        (b.ackedAt ?? b.skippedAt ?? b.deliveredAt ?? 0),
    );
    let over = list.length - MAX_TRACKED_ENTRIES;
    if (over > 0) {
      for (const e of list) {
        if (over <= 0) break;
        if (e.ackedAt !== undefined || e.skip !== undefined) {
          delete entries[e.msgId];
          over--;
        }
      }
    }
    const fd = openSync(this.tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(this.state, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(this.tmp, this.file);
    const dirFd = openSync(dirname(this.file), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}

/** Opaque payload handed to the deliver callback. Body is data, never code. */
export interface DeliveredMessage {
  msgId: string;
  path: string;
  channel: string;
  from: string;
  to: string;
  created: string;
  body: string;
}

export type DeliverFn = (msg: DeliveredMessage) => Promise<void> | void;

export type DeliveryRunState =
  "idle" | "polling" | "backoff" | "backlog-paused" | "private" | "stopped";

export interface DeliveryStatus {
  runState: DeliveryRunState;
  unread: number;
  consecutiveEmptyPolls: number;
  /** ms until the next scheduled cycle (undefined when stopped/paused). */
  nextPollInMs?: number;
  lastCycleAt?: number;
  lastError?: string; // error name:code only — never message content
}

export interface CycleResult {
  /** Changes pages fetched this cycle. */
  pages: number;
  changes: number;
  /** Messages whose deliver callback resolved (durable before return). */
  delivered: string[];
  skipped: { msgId: string; reason: DeliveryEntrySkip }[];
  /** Cycle aborted early — backlog pause, private mode, or backend unavailable. */
  paused: boolean;
  pauseReason?: "backlog" | "private" | "unavailable";
}

export interface BoardDeliveryOptions {
  repo: BoardRepository;
  state: DeliveryStateFile;
  /** Deliver callback; resolves before the durable delivered marker is written. */
  deliver: DeliverFn;
  /**
   * Client recipient policy (a routing check, NOT access control): when set,
   * messages whose `to` differs are skipped as unauthorized.
   */
  recipient?: string;
  /** Private-mode gate: when active, no reads and no delivery at all. */
  privateMode?: { isPrivate: boolean };
  now?: () => number;
  activePollMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  backlogPauseAt?: number;
  maxChangesPages?: number;
  /** Test hook: skip scheduling, only runCycle is exercised. */
  schedule?: boolean;
}

/**
 * Bounded poll/event consumer over `kiwi_changes` (B5: no push exists).
 * `start()` schedules cycles; every cycle is bounded (≤20 pages) and never
 * throws. Delivery stops on private mode and on teardown.
 */
export class BoardDelivery {
  private readonly repo: BoardRepository;
  private readonly state: DeliveryStateFile;
  private readonly deliver: DeliverFn;
  private readonly recipient: string | undefined;
  private readonly privateMode: { isPrivate: boolean } | undefined;
  private readonly nowFn: () => number;
  private readonly activePollMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly backlogPauseAt: number;
  private readonly maxChangesPages: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = false;
  private consecutiveEmptyPolls = 0;
  private lastCycleAt: number | undefined;
  private lastError: string | undefined;
  private readonly scheduling: boolean;

  constructor(opts: BoardDeliveryOptions) {
    this.repo = opts.repo;
    this.state = opts.state;
    this.deliver = opts.deliver;
    this.recipient = opts.recipient;
    this.privateMode = opts.privateMode;
    this.nowFn = opts.now ?? (() => Date.now());
    this.activePollMs = opts.activePollMs ?? ACTIVE_POLL_MS;
    this.backoffBaseMs = opts.backoffBaseMs ?? BACKOFF_BASE_MS;
    this.backoffCapMs = opts.backoffCapMs ?? BACKOFF_CAP_MS;
    this.backlogPauseAt = opts.backlogPauseAt ?? BACKLOG_PAUSE_THRESHOLD;
    this.maxChangesPages = opts.maxChangesPages ?? MAX_CHANGES_PAGES_PER_CYCLE;
    this.scheduling = opts.schedule ?? true;
  }

  /** Current backoff = min(cap, base * 2^(empty-3)) once past the empty cap. */
  nextIntervalMs(): number {
    const over = this.consecutiveEmptyPolls - EMPTY_POLLS_BEFORE_BACKOFF;
    if (over <= 0) return this.activePollMs;
    return Math.min(
      this.backoffCapMs,
      this.backoffBaseMs * 2 ** Math.min(over, 8),
    );
  }

  start(): void {
    // Idempotent: a second start() must not chain a second timer tree (the
    // poller reschedules itself; two chains would double the poll rate).
    if (this.stopped || this.timer !== undefined || !this.scheduling) return;
    this.scheduleNext();
  }

  /** Teardown: stops all scheduled work; private mode stops delivery too. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  statusSnapshot(): DeliveryStatus {
    const unread = this.state.unreadCount();
    const pausedForBacklog = unread >= this.backlogPauseAt;
    let runState: DeliveryRunState = this.stopped ? "stopped" : "idle";
    let nextPollInMs: number | undefined;
    if (!this.stopped && this.running) runState = "polling";
    else if (!this.stopped) {
      if (this.privateMode?.isPrivate) runState = "private";
      else if (pausedForBacklog) runState = "backlog-paused";
      else if (this.consecutiveEmptyPolls >= EMPTY_POLLS_BEFORE_BACKOFF)
        runState = "backoff";
      else runState = "idle";
      if (!pausedForBacklog) {
        return {
          runState,
          unread,
          consecutiveEmptyPolls: this.consecutiveEmptyPolls,
          nextPollInMs: this.nextIntervalMs(),
          ...(this.lastCycleAt !== undefined
            ? { lastCycleAt: this.lastCycleAt }
            : {}),
          ...(this.lastError !== undefined
            ? { lastError: this.lastError }
            : {}),
        };
      }
    }
    return {
      runState,
      unread,
      consecutiveEmptyPolls: this.consecutiveEmptyPolls,
      ...(nextPollInMs !== undefined ? { nextPollInMs } : {}),
      ...(this.lastCycleAt !== undefined
        ? { lastCycleAt: this.lastCycleAt }
        : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const delay = this.nextIntervalMs();
    this.timer = setTimeout(() => {
      void this.runCycle().finally(() => this.scheduleNext());
    }, delay);
    this.timer.unref?.();
  }

  /**
   * One bounded delivery cycle. Never throws; a backend availability error
   * pauses the cycle (cursor untouched, nothing marked, retried next cycle).
   */
  async runCycle(): Promise<CycleResult> {
    const result: CycleResult = {
      pages: 0,
      changes: 0,
      delivered: [],
      skipped: [],
      paused: false,
    };
    if (this.stopped) {
      result.paused = true;
      result.pauseReason = "private";
      return result;
    }
    this.running = true;
    this.lastCycleAt = this.nowFn();
    try {
      if (this.privateMode?.isPrivate) {
        result.paused = true;
        result.pauseReason = "private";
        return result;
      }
      const unread = this.state.unreadCount();
      if (unread >= this.backlogPauseAt) {
        result.paused = true;
        result.pauseReason = "backlog";
        return result;
      }

      let since = this.state.lastSeq ?? "";
      let empty = true;
      // The remote cursor is persisted ONLY after every message this feed
      // segment produced is durably delivered or visibly skipped. A pause
      // (unavailable/private) leaves the stored cursor untouched, so the
      // segment replays next cycle and the local dedupe set absorbs the
      // already-handled messages — undelivered work is never lost.
      let lastSeqSeen: string | undefined;
      const seenThisCycle = new Set<string>();
      const pending: { path: string; msgId: string; channel: string }[] = [];
      for (let page = 0; page < this.maxChangesPages; page++) {
        const feed = await this.fetchChanges(since);
        result.pages++;
        result.changes += feed.changes.length;
        for (const c of feed.changes) {
          const channel = boardChannelOfPath(c.path);
          if (channel === undefined) continue; // not a board path
          const msgId = msgIdOfPath(c.path);
          if (msgId === undefined) continue;
          if (this.state.getEntry(msgId) !== undefined) continue; // dedupe
          if (seenThisCycle.has(msgId)) continue; // overlapping pages
          seenThisCycle.add(msgId);
          pending.push({ path: c.path, msgId, channel });
          empty = false;
        }
        if (feed.lastSeq === undefined || feed.lastSeq === since) break;
        since = feed.lastSeq;
        lastSeqSeen = feed.lastSeq;
        if (feed.changes.length === 0) break;
      }
      // Server ordering is not trusted (live sort unverified): deliver in
      // created order after reading, oldest first.
      const read = new Map<
        string,
        Awaited<ReturnType<BoardRepository["read"]>>
      >();
      for (const p of pending) {
        if (this.privateMode?.isPrivate) {
          result.paused = true;
          result.pauseReason = "private";
          break;
        }
        const r = await this.repo.read(p.path);
        if (r.ok === false && r.reason === "unavailable") {
          // Transient: leave cursor/message untouched; retried next cycle.
          result.paused = true;
          result.pauseReason = "unavailable";
          break;
        }
        read.set(p.path, r);
      }
      const deliverable: {
        path: string;
        msgId: string;
        channel: string;
        created: string;
      }[] = [];
      for (const p of pending) {
        const r = read.get(p.path);
        if (r === undefined) break; // aborted before read; leave pending
        if (!r.ok) {
          const reason: DeliveryEntrySkip =
            r.reason === "expired"
              ? "expired"
              : r.reason === "missing"
                ? "missing"
                : r.reason === "out-of-channel" || r.reason === "bad-request"
                  ? "unauthorized"
                  : "malformed";
          this.state.recordSkip(
            { msgId: p.msgId, path: p.path, channel: p.channel },
            reason,
            this.nowFn(),
          );
          result.skipped.push({ msgId: p.msgId, reason });
          continue;
        }
        if (this.recipient !== undefined && r.to !== this.recipient) {
          this.state.recordSkip(
            { msgId: p.msgId, path: p.path, channel: p.channel },
            "unauthorized",
            this.nowFn(),
          );
          result.skipped.push({ msgId: p.msgId, reason: "unauthorized" });
          continue;
        }
        deliverable.push({
          path: p.path,
          msgId: p.msgId,
          channel: p.channel,
          created: r.created,
        });
      }
      deliverable.sort((a, b) => a.created.localeCompare(b.created));
      for (const d of deliverable) {
        if (this.privateMode?.isPrivate) {
          result.paused = true;
          result.pauseReason = "private";
          break;
        }
        const r = read.get(d.path);
        if (r === undefined || !r.ok) continue;
        await this.deliver({
          msgId: d.msgId,
          path: d.path,
          channel: d.channel,
          from: r.from,
          to: r.to,
          created: r.created,
          body: r.body,
        });
        // Durable marker only after the callback resolved; a crash before
        // this write replays the message (documented at-least-once).
        this.state.recordDelivered(
          { msgId: d.msgId, path: d.path, channel: d.channel },
          this.nowFn(),
        );
        result.delivered.push(d.msgId);
      }
      if (result.pauseReason === undefined) {
        // Empty-poll accounting only advances on a COMPLETED cycle; a paused
        // cycle (unavailable/private) must not inflate backoff.
        this.consecutiveEmptyPolls = empty ? this.consecutiveEmptyPolls + 1 : 0;
        if (lastSeqSeen !== undefined) this.state.setLastSeq(lastSeqSeen);
      }
      return result;
    } catch (err) {
      this.lastError = errorFingerprint(err);
      result.paused = true;
      result.pauseReason = "unavailable";
      return result;
    } finally {
      this.running = false;
    }
  }

  /** LOCAL-ONLY acknowledgment: no backend call exists on this path. */
  ack(msgId: string): boolean {
    return this.state.recordAck(msgId, this.nowFn());
  }

  private async fetchChanges(since: string): Promise<{
    changes: { path: string }[];
    lastSeq?: string | undefined;
  }> {
    // Typed narrow seam on the repo (no reaching into the private adapter
    // field). Contains NO channel containment — board-path filtering happens
    // in the cycle above; change payloads are never parsed or executed.
    const res = await this.repo.changes(since, { limit: CHANGES_PAGE_LIMIT });
    return { changes: res.changes, lastSeq: res.lastSeq };
  }
}

/** msg_id is the hex file name stem of a board path (board/{channel}/{id}.md). */
function msgIdOfPath(path: string): string | undefined {
  const m = /^board\/[a-z0-9][a-z0-9-]{0,63}\/([0-9a-f]{16,64})\.md$/.exec(
    path,
  );
  return m?.[1];
}

/** Error fingerprint for durable status: name:code only, never a message. */
export function errorFingerprint(err: unknown): string {
  if (err instanceof Error) {
    const code =
      typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    return code ? `${err.name}:${code}` : err.name;
  }
  return "unknown";
}
