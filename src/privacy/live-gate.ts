/**
 * Production private-mode gate adapter over the persisted config file
 * (Q02a). This is the shared production dependency that `buildSessionRuntime`
 * passes into the outbox worker — NOT a test-only assembly.
 *
 * Semantics (same fail-closed live-gate pattern as retrieval/backup/board in
 * src/index.ts):
 * - Every check re-reads the config file (`loadConfig`); an INVALID or
 *   missing config fails CLOSED to private (zero network).
 * - A private-mode flip persisted via `setPrivateModeInFile` therefore takes
 *   effect at the worker's next tick: NEW sends are refused (held, never
 *   dropped), and `assertNetworkAllowed` re-checks immediately before the
 *   side effect.
 * - Resume (private→normal) is detected lazily on the next gate read — the
 *   worker's own next tick. Release listeners registered via `onRelease` are
 *   stored for interface compatibility but deliberately NOT auto-fired on a
 *   lazy transition: firing from inside a `tick()`-driven read would re-enter
 *   the worker mid-tick and risk a duplicate delivery of the same job. The
 *   periodic tick is the release path; pending work is retained until then.
 * - Held pending-job refs are metadata only (opId/kind), deduped per job —
 *   mirroring the in-memory gate's long-session fix.
 *
 * No user content is ever read or carried by this module.
 */

import { loadConfig } from "../config/loader.ts";
import {
  PrivateModeActiveError,
  type FeatureDomain,
  type PendingJobRef,
  type PrivateModeGateAdapter,
} from "./private-mode.ts";

/** Fail-closed live private-mode read: invalid config counts as private. */
export function liveConfigPrivateMode(): boolean {
  const result = loadConfig();
  return !result.ok || result.config.privateMode;
}

export class LiveConfigPrivateModeGate implements PrivateModeGateAdapter {
  private lastObserved: boolean | undefined;
  private readonly held: PendingJobRef[] = [];
  private readonly listeners: ((jobs: PendingJobRef[]) => void)[] = [];
  /**
   * Q02c: transition-notification subscribers. Fired exactly once per
   * observed normal→private transition — the cancellation seam the model
   * modules (`ModelRequestGate.onCancel`) already accept.
   */
  private readonly cancelListeners: ((reason: string) => void)[] = [];
  private disposed = false;
  private readonly read: () => boolean;

  constructor(read: () => boolean = liveConfigPrivateMode) {
    this.read = read;
  }

  /**
   * Fail-closed read + transition observation. A read error counts as
   * private. A false→true (normal→private) transition fires the cancel
   * subscribers exactly once — AFTER the state is recorded as private, so
   * every listener already observes private mode when it runs. The first
   * ever read is not a transition (no subscriber fire at startup under
   * private mode). Repeated reads while private do not re-fire.
   */
  private observe(): boolean {
    let value: boolean;
    try {
      value = this.read();
    } catch {
      value = true; // config read failure fails CLOSED to private
    }
    const wasPrivate = this.lastObserved === true;
    // Resume detected lazily: clear held refs so the next release report is
    // accurate. Pending jobs themselves live in the durable outbox.
    if (wasPrivate && !value) this.held.length = 0;
    this.lastObserved = value;
    if (
      !wasPrivate &&
      value &&
      !this.disposed &&
      this.cancelListeners.length > 0
    ) {
      for (const listener of [...this.cancelListeners]) {
        // Best-effort: one throwing subscriber must never break the gate
        // read that observed the transition (the read is the fail-closed
        // path every worker relies on).
        try {
          listener("private mode enabled");
        } catch {
          // subscriber fault is contained; remaining listeners still fire
        }
      }
    }
    return value;
  }

  get isPrivate(): boolean {
    return this.observe();
  }

  /**
   * Q02c push path for the command bridge: after a persisted private-mode
   * flip, observe immediately instead of waiting for the next pull read. A
   * normal→private transition fires the cancel subscribers; private→normal
   * resolves the lazy resume exactly like any read. No-ops after dispose.
   */
  notifyTransition(): void {
    this.observe();
  }

  /**
   * Q02c: cancellation subscription (ModelRequestGate.onCancel shape).
   * Fired on every observed normal→private transition; never fires for
   * private→normal. Subscribers are released by `dispose()` at shutdown.
   */
  onCancel(listener: (reason: string) => void): void {
    this.cancelListeners.push(listener);
  }

  /**
   * Q02c: model-request seam (ModelRequestGate shape — factory hookup is
   * deliberately NOT wired here; Q06 does that). Fail-closed: private (or a
   * failing config read) refuses the call before any bytes are sent.
   */
  assertModelCallAllowed(): void {
    if (this.observe()) throw new PrivateModeActiveError("observation");
  }

  holdWhilePrivate(job: PendingJobRef): { held: boolean } {
    if (this.isPrivate) {
      if (!this.held.some((h) => h.opId === job.opId)) {
        this.held.push(job);
      }
      return { held: true };
    }
    return { held: false };
  }

  assertNetworkAllowed(feature: FeatureDomain | "network" = "network"): void {
    if (this.read()) throw new PrivateModeActiveError(feature);
  }

  /**
   * Registration-only (see module docs): resume is resolved lazily by the
   * worker's own next tick, which re-reads the gate.
   */
  onRelease(listener: (jobs: PendingJobRef[]) => void): void {
    this.listeners.push(listener);
  }

  heldJobs(): readonly PendingJobRef[] {
    return this.held;
  }

  /**
   * Q02c: shutdown release — all transition/cancel subscriptions are
   * dropped so nothing holds a reference to a dead runtime. Called from the
   * extension's session_shutdown handler.
   */
  dispose(): void {
    this.disposed = true;
    this.cancelListeners.length = 0;
    this.listeners.length = 0;
  }
}
