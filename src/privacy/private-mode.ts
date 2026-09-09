/**
 * T06: private mode (architecture.md §5, §13 row 21, decisions.md #10).
 *
 * Behavior:
 * - ON: no network reads or writes in any of the three feature domains, no
 *   new capture/backup/board jobs; pending outbox jobs are HELD, never
 *   deleted (no drop-oldest).
 * - Transition ON and OFF is explicit and visible: every transition is
 *   recorded as an event and surfaced.
 * - Resume (turning private mode off) is EXPLICIT (`resume()`), and it
 *   releases held jobs to sendable state via registered listeners (T07
 *   outbox wires these). Resume never silently drops anything.
 *
 * Error messages from this module never carry user content — only feature
 * names and counts.
 */

export type FeatureDomain = "observation" | "backup" | "board";

export interface PrivateModeEvent {
  ts: string;
  action: "enabled" | "resumed";
  /** Feature names that were newly blocked (enabled) or released (resumed). */
  features: FeatureDomain[];
  heldJobs: number;
}

/** Thrown when an operation is attempted while private mode is active. */
export class PrivateModeActiveError extends Error {
  readonly feature: FeatureDomain | "network";

  constructor(feature: FeatureDomain | "network") {
    super(
      `blocked by private mode: ${feature} network operation refused (pending work is held locally, not deleted)`,
    );
    this.name = "PrivateModeActiveError";
    this.feature = feature;
  }
}

export interface PendingJobRef {
  readonly opId: string;
  readonly kind: string;
}

export class PrivateModeGate {
  /** Transition-log bound (T19 long-session audit): metadata-only FIFO cap. */
  static readonly MAX_EVENTS = 100;

  private privateMode: boolean;
  private readonly events: PrivateModeEvent[] = [];
  private readonly held: PendingJobRef[] = [];
  private readonly releaseListeners: ((jobs: PendingJobRef[]) => void)[] = [];
  private readonly nowFn: () => Date;

  constructor(initial = false, now: () => Date = () => new Date()) {
    this.privateMode = initial;
    this.nowFn = now;
  }

  get isPrivate(): boolean {
    return this.privateMode;
  }

  /** Explicit, visible transition ON. */
  enable(): PrivateModeEvent {
    if (this.privateMode) return this.lastEvent();
    this.privateMode = true;
    const event: PrivateModeEvent = {
      ts: this.nowFn().toISOString(),
      action: "enabled",
      features: ["observation", "backup", "board"],
      heldJobs: this.held.length,
    };
    this.pushEvent(event);
    return event;
  }

  /** Explicit, visible resume (transition OFF). Releases held jobs. */
  resume(): PrivateModeEvent {
    if (!this.privateMode) return this.lastEvent();
    this.privateMode = false;
    const released = [...this.held];
    this.held.length = 0;
    const event: PrivateModeEvent = {
      ts: this.nowFn().toISOString(),
      action: "resumed",
      features: ["observation", "backup", "board"],
      heldJobs: released.length,
    };
    this.pushEvent(event);
    for (const listener of this.releaseListeners) {
      listener(released);
    }
    return event;
  }

  /** Transition log (visible in status later; metadata only). */
  eventLog(): readonly PrivateModeEvent[] {
    return this.events;
  }

  /**
   * Registers a job as pending. While private mode is active the job is
   * HELD (never sent, never dropped); otherwise it is immediately sendable
   * and the caller proceeds.
   *
   * Deduped by opId (T19 long-session fix): the outbox worker re-holds the
   * SAME pending job on every tick while private mode is active, so the raw
   * per-tick push would grow the held set (and the resume release list)
   * linearly with tick count. One ref per distinct job is the actual state.
   */
  holdWhilePrivate(job: PendingJobRef): { held: boolean } {
    if (this.privateMode) {
      if (!this.held.some((h) => h.opId === job.opId)) {
        this.held.push(job);
      }
      return { held: true };
    }
    return { held: false };
  }

  /** T07 wiring: listener invoked with the released jobs on resume. */
  onRelease(listener: (jobs: PendingJobRef[]) => void): void {
    this.releaseListeners.push(listener);
  }

  /** Currently held pending jobs (metadata refs only). */
  heldJobs(): readonly PendingJobRef[] {
    return this.held;
  }

  /** Gate for any network read/write. Throws (fail closed) when private. */
  assertNetworkAllowed(feature: FeatureDomain | "network" = "network"): void {
    if (this.privateMode) throw new PrivateModeActiveError(feature);
  }

  /** Gate for creating new capture/backup/board jobs. */
  assertCaptureAllowed(feature: FeatureDomain): void {
    if (this.privateMode) throw new PrivateModeActiveError(feature);
  }

  /** Bounded transition log: metadata-only FIFO cap (oldest dropped). */
  private pushEvent(event: PrivateModeEvent): void {
    this.events.push(event);
    if (this.events.length > PrivateModeGate.MAX_EVENTS) {
      this.events.splice(0, this.events.length - PrivateModeGate.MAX_EVENTS);
    }
  }

  private lastEvent(): PrivateModeEvent {
    const ts = this.nowFn().toISOString();
    return {
      ts,
      action: this.privateMode ? "enabled" : "resumed",
      features: [],
      heldJobs: 0,
    };
  }
}
