/**
 * T17 chunk 2: Pi integration runtime for board delivery (architecture.md
 * §8, §13 row 12, PRD T17).
 *
 * Wraps the chunk-1 domain modules (`DeliveryStateFile`, `BoardDelivery`) in
 * the session lifecycle:
 * - Constructed lazily with the session runtime; HELD VISIBLY when the board
 *   feature is off, the backend is unconfigured, or `board.consumerId` is not
 *   configured (per-consumer cursors require a stable local identity; there
 *   is no safe default).
 * - `start()` schedules bounded poll cycles; `stop()` (session switch/fork/
 *   tree/shutdown) stops all scheduled work. A stopped runtime can be
 *   restarted with `restart()` for the new generation — the durable state
 *   file survives and dedupe absorbs anything already handled.
 * - Private mode is re-checked inside every cycle via a live gate (config is
 * re-read; an invalid config fails closed to private: zero reads).
 * - `deliver` is the notification policy boundary: delivered message bodies
 *   are held in a bounded in-memory buffer surfaced by the
 *   `kiwifs_board_inbox` tool. Nothing interrupts active work — no injection,
 *   no callbacks into the model loop. Messages are UNTRUSTED DATA: the inbox
 *   frames them, never executes or parses them (decisions.md #4).
 * - Ack is LOCAL STATE ONLY (the state file holds no backend reference);
 *   `kiwifs_board_ack` is the explicit user/agent acknowledgment surface.
 *
 * Shared-consumer safety (T18, closing the T17 follow-up): a pid lock file
 * (`delivery-<consumerId>.lock`) is acquired before any poller starts. A
 * second live session reusing the SAME consumerId is REFUSED VISIBLY
 * (`holdReason` names the holder pid) — it never silently shares or
 * overwrites durable cursor state. Distinct consumer ids remain fully
 * independent.
 */

import type { BoardRepository } from "./repository.ts";
import type { AuditSinkLike } from "../privacy/audit.ts";
import {
  acquireConsumerLock,
  ConsumerLockError,
  type ConsumerLock,
} from "./lock.ts";
import {
  BoardDelivery,
  DeliveryStateFile,
  errorFingerprint,
  type DeliveredMessage,
  type DeliveryStatus,
} from "./delivery.ts";

/** Bounded in-memory delivery buffer (newest kept, oldest dropped). */
export const DELIVERY_BUFFER_CAP = 50;

export interface BoardDeliveryRuntimeOptions {
  stateDir: string;
  consumerId: string;
  /** Optional client-side recipient routing filter (labels, not auth). */
  recipient?: string;
  repo: BoardRepository;
  /**
   * Live private-mode gate, re-read per cycle. MUST fail closed (true) when
   * config cannot be loaded — private mode means zero backend reads.
   */
  isPrivate: () => boolean;
  now?: () => number;
  /** Active poll interval override (tests/status tooling); default 60 s. */
  pollMs?: number;
  /** Backoff base override (tests); default 60 s. */
  backoffMs?: number;
  /** Unread backlog pause threshold override; default 500. */
  backlogPauseAt?: number;
  /** Q04c: sanitized metadata-only audit sink (delivery/lock events). */
  audit?: AuditSinkLike;
}

export interface InboxEntry {
  msgId: string;
  path: string;
  channel: string;
  from: string;
  to: string;
  created: string;
  body: string;
}

/**
 * Session-scoped board delivery runtime. Holds the durable state file and the
 * active poller; all mutation stays local (state file + bounded buffer).
 */
export class BoardDeliveryRuntime {
  readonly state: DeliveryStateFile;
  private readonly repo: BoardDeliveryRuntimeOptions["repo"];
  private readonly consumerId: string;
  private readonly recipient: string | undefined;
  private readonly isPrivateFn: () => boolean;
  private readonly nowFn: () => number;
  private readonly pollMs: number | undefined;
  private readonly backoffMs: number | undefined;
  private readonly backlogPauseAt: number | undefined;
  private readonly audit: AuditSinkLike | undefined;
  private delivery: BoardDelivery | undefined;
  private readonly buffer: InboxEntry[] = [];
  private lastError: string | undefined;
  /** Held visibly when the consumer lock is refused (shared consumerId). */
  private lockHoldReason: string | undefined;
  private lock: ConsumerLock | undefined;

  constructor(opts: BoardDeliveryRuntimeOptions) {
    this.state = new DeliveryStateFile(opts.stateDir, opts.consumerId);
    this.repo = opts.repo;
    this.consumerId = opts.consumerId;
    this.recipient = opts.recipient;
    this.isPrivateFn = opts.isPrivate;
    this.nowFn = opts.now ?? (() => Date.now());
    this.pollMs = opts.pollMs;
    this.backoffMs = opts.backoffMs;
    this.backlogPauseAt = opts.backlogPauseAt;
    this.audit = opts.audit;
  }

  /** Visible hold reason (shared consumerId refusal, lock trouble), if any. */
  get holdReason(): string | undefined {
    return this.lockHoldReason;
  }

  /** Consumer id this runtime delivers as (status/inbox disclosure). */
  get id(): string {
    return this.consumerId;
  }

  /**
   * Bounded in-memory buffer of bodies delivered by THIS process. Entries
   * delivered by a previous process (deliveredAt set, buffer empty) are
   * listed path-only by the inbox tool — never lost (durable state), just
   * not re-readable from memory.
   */
  private deliverFn = (msg: DeliveredMessage): void => {
    this.buffer.push({
      msgId: msg.msgId,
      path: msg.path,
      channel: msg.channel,
      from: msg.from,
      to: msg.to,
      created: msg.created,
      body: msg.body,
    });
    while (this.buffer.length > DELIVERY_BUFFER_CAP) this.buffer.shift();
  };

  /** Start (or restart after stop) the bounded poller. */
  start(): void {
    this.stop();
    // T18 shared-consumer guard: acquire the exclusive consumer lock BEFORE
    // any read happens. A second live session on the same consumerId is
    // refused visibly — durable cursor state is never co-written.
    if (this.lock === undefined) {
      try {
        this.lock = acquireConsumerLock(
          this.state.dir,
          this.consumerId,
          this.nowFn(),
        );
        this.lockHoldReason = undefined;
      } catch (err) {
        if (err instanceof ConsumerLockError) {
          this.lockHoldReason = err.message;
          this.lastError = err.name;
          // Q04c: sanitized hold event (never authorizes a read).
          this.audit?.record({
            kind: "board",
            feature: "board",
            decision: "held (consumer lock)",
            degraded: true,
          });
          return; // HELD — never share the consumer
        }
        throw err;
      }
    }
    // Live gate: BoardDelivery reads `.isPrivate` per cycle, so the getter
    // re-evaluates the config each time (fail closed → private → zero reads).
    const runtime = this;
    const privateGate = {
      get isPrivate() {
        return runtime.isPrivateFn();
      },
    };
    this.delivery = new BoardDelivery({
      repo: this.repo,
      state: this.state,
      deliver: this.deliverFn,
      ...(this.recipient !== undefined ? { recipient: this.recipient } : {}),
      privateMode: privateGate,
      now: this.nowFn,
      schedule: true,
      ...(this.pollMs !== undefined ? { activePollMs: this.pollMs } : {}),
      ...(this.backoffMs !== undefined
        ? { backoffBaseMs: this.backoffMs }
        : {}),
      ...(this.backlogPauseAt !== undefined
        ? { backlogPauseAt: this.backlogPauseAt }
        : {}),
      ...(this.audit !== undefined ? { audit: this.audit } : {}),
    });
    this.delivery.start();
  }

  /**
   * Teardown for the current generation (switch/fork/tree/shutdown): stops
   * all scheduled work. In-flight cycle completes best-effort (§133); the
   * durable cursor only advances on a fully completed cycle, so a pause
   * never strands undelivered messages.
   */
  stop(): void {
    this.delivery?.stop();
    this.delivery = undefined;
    // Release the consumer lock so another session can take over only after
    // THIS runtime is fully torn down (never while it could still write).
    this.lock?.release();
    this.lock = undefined;
  }

  /** Explicit LOCAL-ONLY acknowledgment (no remote mutation, ever). */
  ack(msgId: string): boolean {
    const ok = this.state.recordAck(msgId, this.nowFn());
    if (ok) {
      // Acked bodies no longer need to sit in the in-memory buffer until
      // cap eviction — drop them now (durable state remains authoritative).
      const i = this.buffer.findIndex((m) => m.msgId === msgId);
      if (i >= 0) this.buffer.splice(i, 1);
    }
    return ok;
  }

  /**
   * Inbox view: buffered delivered-unread entries (with bodies, untrusted)
   * plus older durable delivered-unread entries (path-only). Bounded; the
   * full unread backlog count comes from the durable state.
   */
  inbox(limit: number): {
    buffered: InboxEntry[];
    unbufferedUnread: { msgId: string; path: string; channel: string }[];
    unread: number;
  } {
    const unreadIds = new Set<string>();
    for (const e of Object.values(this.state.value.entries)) {
      if (e.deliveredAt !== undefined && e.ackedAt === undefined) {
        unreadIds.add(e.msgId);
      }
    }
    const buffered = this.buffer
      .filter((m) => unreadIds.has(m.msgId))
      .slice(-limit);
    const bufferedIds = new Set(buffered.map((m) => m.msgId));
    const unbufferedUnread: {
      msgId: string;
      path: string;
      channel: string;
    }[] = [];
    for (const e of Object.values(this.state.value.entries)) {
      if (
        e.deliveredAt !== undefined &&
        e.ackedAt === undefined &&
        !bufferedIds.has(e.msgId)
      ) {
        unbufferedUnread.push({
          msgId: e.msgId,
          path: e.path,
          channel: e.channel,
        });
      }
    }
    return {
      buffered,
      unbufferedUnread: unbufferedUnread.slice(
        0,
        Math.max(0, limit - buffered.length),
      ),
      unread: unreadIds.size,
    };
  }

  /**
   * Sanitized status snapshot for /kiwifs-status and the board note probe:
   * ids/counters/error fingerprints only — never message content, never
   * credentials.
   */
  statusSnapshot(): DeliveryStatus & {
    consumerId: string;
    holdReason?: string;
  } {
    if (this.delivery)
      return { ...this.delivery.statusSnapshot(), consumerId: this.consumerId };
    return {
      consumerId: this.consumerId,
      runState: "idle",
      unread: this.state.unreadCount(),
      consecutiveEmptyPolls: 0,
      ...(this.lockHoldReason !== undefined
        ? { holdReason: this.lockHoldReason }
        : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  /** Last cycle error fingerprint (name:code), if any. */
  lastErrorFingerprint(): string | undefined {
    return this.delivery?.statusSnapshot().lastError ?? this.lastError;
  }

  /** Test/inspection hook: record an error fingerprint without a cycle. */
  noteError(err: unknown): void {
    this.lastError = errorFingerprint(err);
  }
}
