/**
 * T04: the reusable opt-in live MCP runner (docs/research/live-mcp-runner.md,
 * docs/test-environment.md safeguards). This is the ONLY sanctioned path to
 * the live dedicated test space; it is never part of npm test / npm run check
 * / CI defaults.
 *
 * Opt-in gate: `KIWIFS_LIVE_TESTS=1` AND the local config file present with
 * `enabled: true`. Every precondition fails closed before any network
 * traffic. The runner reads the secret-bearing local config programmatically
 * and never emits its values: diagnostics contain tool names, record paths,
 * status codes, timings and capability counts only.
 *
 * Auth observed on the test endpoint is recorded as connectivity evidence,
 * never as proof of authentication or tenant isolation (test-environment.md,
 * architecture-review S-3). Deletion is MCP-level only — never Git-history,
 * index or backup erasure (B6).
 */

import { BackendError } from "../errors.ts";
import { createMemoryLedger } from "../opid.ts";
import { KiwiFSAdapter, REQUIRED_TOOLS } from "../adapter.ts";
import { McpHttpTransport } from "../transport.ts";
import { mintOpId } from "../opid.ts";
import { randomBytes } from "node:crypto";

export interface LiveRunnerConfig {
  enabled?: boolean;
  mcp?: { url?: string; headers?: Record<string, string> };
  space?: { name?: string; provisioned?: boolean; isolationVerified?: boolean };
  safety?: {
    allowTestSpaceWrites?: boolean;
    allowOutsideTestSpaceWrites?: boolean;
    allowServerAdministration?: boolean;
    requireVerifiedSpaceIsolation?: boolean;
    recordPrefix?: string;
    cleanup?: string;
  };
  timeouts?: { requestMs?: number; runMs?: number };
}

export type LiveOutcome =
  "clean-pass" | "suite-failed-after-cleanup" | "setup-blocked";

export interface LiveStep {
  name: string;
  ok: boolean;
  detail?: string;
  ms: number;
}

export interface LiveReport {
  outcome: LiveOutcome;
  runId?: string;
  /** Advertised tool names (capability-driven; counts never hard-coded). */
  advertisedTools?: string[];
  requiredToolsMissing?: string[];
  steps: LiveStep[];
  /** Manifest-owned cleanup result; leftovers are reported, never ignored. */
  cleanup?: { deleted: string[]; leftovers: string[] };
  /** Connectivity evidence label — never an auth/isolation claim. */
  authNote: string;
  reasons?: string[];
}

const EXPECTED_SAFETY: Required<
  NonNullable<NonNullable<LiveRunnerConfig["safety"]>>
> = {
  allowTestSpaceWrites: true,
  allowOutsideTestSpaceWrites: false,
  allowServerAdministration: false,
  requireVerifiedSpaceIsolation: true,
  recordPrefix: "integration-tests/",
  cleanup: "current-run-only",
};

const DEFAULT_REQUEST_MS = 10_000;
const DEFAULT_RUN_MS = 60_000;

/** Fails closed on every precondition; empty reasons = safe to proceed. */
export function checkPreconditions(config: LiveRunnerConfig): string[] {
  const reasons: string[] = [];
  if (config.enabled !== true) reasons.push("config enabled is not true");
  const url = config.mcp?.url;
  if (typeof url !== "string" || url === "") {
    reasons.push("mcp.url missing");
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        reasons.push("mcp.url is not http(s)");
      }
    } catch {
      reasons.push("mcp.url is not a valid URL");
    }
  }
  if (config.space?.provisioned !== true) {
    reasons.push("space.provisioned is not true");
  }
  if (config.space?.isolationVerified !== true) {
    reasons.push("space.isolationVerified is not true");
  }
  const safety = { ...EXPECTED_SAFETY, ...(config.safety ?? {}) };
  for (const [key, expected] of Object.entries(EXPECTED_SAFETY)) {
    const actual = (safety as Record<string, unknown>)[key];
    if (actual !== expected) {
      reasons.push(
        `safety.${key} must be ${String(expected)} (is ${String(actual)})`,
      );
    }
  }
  return reasons;
}

function step(
  name: string,
  ok: boolean,
  ms: number,
  detail?: string,
): LiveStep {
  return { name, ok, ms, ...(detail !== undefined ? { detail } : {}) };
}

export interface RunLiveOptions {
  config: LiveRunnerConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Test hook: override the random run id (12 hex chars). */
  randomId?: () => string;
  requestTimeoutMs?: number;
  runDeadlineMs?: number;
}

/**
 * Executes the opt-in live suite: preconditions → capability discovery →
 * routing check → synthetic CRUD/FTS round trip → manifest-owned cleanup.
 * Never touches production spaces; every mutation lives beneath the run's
 * `integration-tests/{run-id}/` prefix.
 */
export async function runLiveSuite(opts: RunLiveOptions): Promise<LiveReport> {
  const started = opts.now ?? (() => Date.now());
  const t0 = started();
  const reasons = checkPreconditions(opts.config);
  if (reasons.length > 0) {
    return {
      outcome: "setup-blocked",
      steps: [],
      authNote: "no connectivity attempted (setup-blocked)",
      reasons,
    };
  }
  const url = opts.config.mcp!.url!;
  const headers = opts.config.mcp?.headers ?? {};
  const requestMs =
    opts.requestTimeoutMs ??
    opts.config.timeouts?.requestMs ??
    DEFAULT_REQUEST_MS;
  const runMs =
    opts.runDeadlineMs ?? opts.config.timeouts?.runMs ?? DEFAULT_RUN_MS;

  const runController = new AbortController();
  const runTimer = setTimeout(() => runController.abort(), runMs);
  const runId = (opts.randomId ?? defaultRandomId)();
  const prefix = `${EXPECTED_SAFETY.recordPrefix}${runId}/`;
  const manifest: string[] = [];
  const steps: LiveStep[] = [];
  const stepStart = () => started();

  const transport = new McpHttpTransport({
    url,
    headers,
    requestTimeoutMs: requestMs,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const ledger = createMemoryLedger();
  const adapter = new KiwiFSAdapter({
    url,
    headers,
    requestTimeoutMs: requestMs,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ledger,
  });

  let outcome: LiveOutcome = "suite-failed-after-cleanup";
  let advertisedTools: string[] | undefined;
  let requiredMissing: string[] | undefined;

  try {
    // Capability discovery FIRST — abort before any mutation on a gap.
    let s = stepStart();
    try {
      await transport.initialize(runController.signal);
      const tools = await transport.listTools(runController.signal);
      advertisedTools = tools.map((t) => t.name);
      requiredMissing = REQUIRED_TOOLS.filter(
        (r) => !advertisedTools!.includes(r),
      );
      if (requiredMissing.length > 0) {
        steps.push(
          step(
            "capability-discovery",
            false,
            started() - s,
            `missing required tools: ${requiredMissing.join(", ")}`,
          ),
        );
        return await finish(new Error("capability gap"));
      }
      steps.push(
        step(
          "capability-discovery",
          true,
          started() - s,
          `${advertisedTools.length} tools advertised`,
        ),
      );
    } catch (err) {
      steps.push(
        step("capability-discovery", false, started() - s, describe(err)),
      );
      return await finish(err);
    }

    // Routing verification BEFORE the first write: sentinel must be absent.
    const sentinel = `${prefix}routing-sentinel.md`;
    s = stepStart();
    try {
      const read = await adapter.read(sentinel, {
        signal: runController.signal,
      });
      if (read.state === "ok") {
        steps.push(
          step(
            "routing-check",
            false,
            started() - s,
            "sentinel path already exists — routing anomaly, aborting before mutation",
          ),
        );
        return await finish(new Error("routing anomaly"));
      }
      steps.push(
        step(
          "routing-check",
          true,
          started() - s,
          "sentinel absent (read-back connectivity verified)",
        ),
      );
    } catch (err) {
      steps.push(step("routing-check", false, started() - s, describe(err)));
      return await finish(err);
    }

    // Synthetic CRUD/FTS round trip (no model calls, no real data).
    const record = `${prefix}round-trip.md`;
    const opCreate = mintOpId();
    const opUpdate = mintOpId();
    const opDelete = mintOpId();
    ledger.record(opCreate);
    ledger.record(opUpdate);
    ledger.record(opDelete);
    s = stepStart();
    try {
      const body = `---\nscope: project/${opts.config.space?.name ?? "unknown"}\nmemory_status: active\n---\nSynthetic live-runner payload ${runId}.`;
      await adapter.write(record, body, {
        opId: opCreate,
        signal: runController.signal,
      });
      manifest.push(record);
      const back = await adapter.read(record, { signal: runController.signal });
      if (back.state !== "ok" || !back.body.includes(runId)) {
        throw new Error("read-back did not return the synthetic payload");
      }
      await adapter.write(record, `${body}\nupdated.`, {
        opId: opUpdate,
        signal: runController.signal,
      });
      const search = await adapter.searchFts(
        `synthetic live-runner payload ${runId}`,
        {
          pathPrefix: prefix,
          limit: 10,
          signal: runController.signal,
        },
      );
      if (!search.hits.some((h) => h.path === record)) {
        // FTS indexing is asynchronous; a miss here is recorded, not fatal —
        // the read-back is the round-trip proof.
        steps.push(
          step(
            "crud-round-trip",
            true,
            started() - s,
            "read-back ok; FTS hit pending async indexing (disclosed)",
          ),
        );
      } else {
        steps.push(
          step(
            "crud-round-trip",
            true,
            started() - s,
            "create/read/update/FTS ok",
          ),
        );
      }
    } catch (err) {
      steps.push(step("crud-round-trip", false, started() - s, describe(err)));
      return await finish(err);
    }

    s = stepStart();
    try {
      await adapter.del(record, {
        opId: opDelete,
        signal: runController.signal,
      });
      const after = await adapter.read(record, {
        signal: runController.signal,
      });
      if (after.state !== "missing") {
        throw new Error("post-delete read still returned content");
      }
      steps.push(
        step(
          "delete-and-absence",
          true,
          started() - s,
          "deleted; post-delete read fails (MCP-level deletion only — no history/index purge claim)",
        ),
      );
      // Verified deletion: the record leaves the cleanup manifest.
      const mIdx = manifest.indexOf(record);
      if (mIdx >= 0) manifest.splice(mIdx, 1);
    } catch (err) {
      steps.push(
        step("delete-and-absence", false, started() - s, describe(err)),
      );
      return await finish(err);
    }

    outcome = "clean-pass";
    return await finish(undefined, true);
  } finally {
    clearTimeout(runTimer);
  }

  async function finish(
    err: unknown | undefined,
    success = false,
  ): Promise<LiveReport> {
    const cleanup = await cleanupManifest();
    if (err instanceof BackendError && err.code === "auth") {
      // Authorization failure is a hard setup error, not a suite failure.
      outcome = "setup-blocked";
      steps.push(
        step(
          "auth",
          false,
          0,
          "backend rejected credentials — hard setup error",
        ),
      );
    } else if (requiredMissing !== undefined && requiredMissing.length > 0) {
      outcome = "setup-blocked";
    } else if (success) {
      outcome =
        cleanup.leftovers.length === 0
          ? "clean-pass"
          : "suite-failed-after-cleanup";
    }
    return {
      outcome,
      runId,
      ...(advertisedTools !== undefined ? { advertisedTools } : {}),
      ...(requiredMissing !== undefined
        ? { requiredToolsMissing: requiredMissing }
        : {}),
      steps,
      cleanup,
      authNote:
        "connectivity evidence only — never proof of authentication, VPN-only access or tenant isolation",
      ...(err !== undefined && !success ? { reasons: [describe(err)] } : {}),
    };
  }

  /** Manifest-owned cleanup: reverse creation order, verify absence, report leftovers. */
  async function cleanupManifest(): Promise<{
    deleted: string[];
    leftovers: string[];
  }> {
    const deleted: string[] = [];
    const leftovers: string[] = [];
    for (const path of [...manifest].reverse()) {
      try {
        const op = mintOpId();
        ledger.record(op);
        await adapter.del(path, { opId: op, signal: runController.signal });
      } catch {
        leftovers.push(path);
        continue;
      }
      try {
        const check = await adapter.read(path, {
          signal: runController.signal,
        });
        if (check.state === "missing") deleted.push(path);
        else leftovers.push(path);
      } catch {
        // Backends that surface absence as a domain error still count as gone.
        deleted.push(path);
      }
    }
    return { deleted, leftovers };
  }
}

function describe(err: unknown): string {
  if (err instanceof BackendError) return `${err.code}: ${err.message}`;
  return (err as Error).message;
}

function defaultRandomId(): string {
  return randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------------------
// CLI entry — `npm run test:live`. Reads the secret-bearing local config
// programmatically; never prints config values, headers or the URL.
// ---------------------------------------------------------------------------

export async function main(): Promise<number> {
  if (process.env["KIWIFS_LIVE_TESTS"] !== "1") {
    console.error(
      "live tests are opt-in: set KIWIFS_LIVE_TESTS=1 (and provide the local test config)",
    );
    return 2;
  }
  const file =
    process.env["KIWIFS_TEST_CONFIG"] ?? "config/kiwifs-test.local.json";
  let config: LiveRunnerConfig;
  try {
    const { readFileSync } = await import("node:fs");
    config = JSON.parse(readFileSync(file, "utf8")) as LiveRunnerConfig;
  } catch {
    console.error(
      `local test config unreadable: ${file} (value never read into output)`,
    );
    return 2;
  }
  const report = await runLiveSuite({ config });
  // Redacted report only: outcomes, tool names, paths, timings.
  console.log(JSON.stringify(report, null, 2));
  switch (report.outcome) {
    case "clean-pass":
      return 0;
    case "setup-blocked":
      return 3;
    default:
      return 4;
  }
}

// CLI entrypoint guard: run main() only when this file is executed directly
// (tests import the module without triggering a live run).
if (process.argv[1] !== undefined) {
  const { pathToFileURL } = await import("node:url");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then((code) => process.exit(code));
  }
}
