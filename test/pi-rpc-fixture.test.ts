/**
 * T13: real isolated Pi RPC fixture — retrieve → inject → source-recall
 * against a genuine Pi 0.85.0 session (not fakes).
 *
 * What is proven against the REAL Pi process:
 * - the packed-tree extension registers (`registerSessionHandlers` wiring,
 *   recall tools, lifecycle handlers) inside actual Pi RPC startup;
 * - a fresh user prompt runs ONE retrieval cycle against the local fake
 *   KiwiFS MCP backend and the evidence pack is injected as the single
 *   custom message via `before_agent_start` (persistent, exactly once);
 * - the REAL recall tool `kiwifs_memory_search` is executed by Pi's tool
 *   runner when the model calls it (guard pipeline → fake MCP round trip);
 * - a queued steer prompt (no `before_agent_start`) gets its own pack
 *   injected via the `context` event exactly once (transient — absent from
 *   later provider calls), proving the consumed-input linkage and tool-loop
 *   dedupe in real Pi;
 * - outbound search queries are redacted by the privacy pipeline (the fake
 *   MCP server never receives the raw synthetic secret).
 *
 * Q09C additions (same isolated process, same scripted model — bounded at
 * 8 provider calls):
 * - REPEATED user input: the same fresh prompt is submitted a second time
 *   and gets its own full cycle (input → retrieval → before_agent_start →
 *   persistent pack) — repeated input is never silently deduped away;
 * - QUEUED followUp: a `prompt` with `streamingBehavior: "followUp"`
 *   submitted while the repeated-input run streams is queued, replayed by
 *   Pi as the consuming run's next turn (no new before_agent_start), and
 *   its pack injects via the transient context path exactly once;
 * - PRIVATE-MODE FLIP through the real control surface (`/kiwifs-private-mode
 *   on|off|status`): persists to the fixture config, round-trips via the
 *   live-config owner, and holds the durable outbox while ON;
 * - HEADLESS personal write (`/kiwifs-personal-note … --yes`) enqueues into
 *   the durable outbox while private mode holds it, delivers to the fake
 *   backend after the flip (redact-before-durable-write proven on the wire);
 * - CONFIRM/REFUSAL dialogs over real RPC: `/kiwifs-personal-note` without
 *   `--yes` raises a real `extension_ui_request` confirm dialog — the
 *   fixture answers it (scripted true once, then false) and asserts the
 *   redacted preview is shown and a refusal enqueues nothing.
 *
 * All processes are local and synthetic: the "model" is a scripted
 * openai-completions SSE server on 127.0.0.1, the backend is the in-repo
 * fake MCP server over loopback HTTP. No network services, no credentials.
 * Everything is bounded and the temp tree is removed afterwards.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import test from "node:test";

const EVIDENCE_MARKER = "Memory evidence (UNTRUSTED DATA";
const SECRET = "AKIAIOSFODNN7EXAMPLE"; // exactly AKIA + 16 chars (fixture-only)
const SECRET_QUERY =
  "what does the secret AKIAIOSFODNN7EXAMPLE unlock in the vault";
const REDACTED_QUERY =
  "what does the secret [REDACTED:aws-access-key:20] unlock in the vault";
const CLEAN_QUERY = "where is the flumox widget documented";
const STEER_TEXT = "where is the zorbflint spec documented";
const FOLLOWUP_QUERY = "where is the gribble fixture documented";
const PERSONAL_HEADLESS_NOTE =
  "T13-PERSONAL-HEADLESS note holding the synthetic vault key AKIAIOSFODNN7EXAMPLE for delivery";
const PERSONAL_DIALOG_NOTE =
  "T13-PERSONAL-DIALOG note also referencing the synthetic vault key AKIAIOSFODNN7EXAMPLE";
const PERSONAL_REFUSED_NOTE =
  "T13-PERSONAL-REFUSED note must never appear anywhere";
const FINAL_TEXT = "T13-RPC-FIXTURE-DONE";

test(
  "T13 fixture: real Pi RPC — retrieve → inject → source-recall lifecycle",
  { timeout: 180_000 },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "kiwifs-t13-rpc-"));
    mkdirSync(join(tmp, "agent"), { recursive: true });
    mkdirSync(join(tmp, "state"), { recursive: true });

    // --- Local fake KiwiFS MCP backend (real HTTP, loopback only) ----------
    const { createFakeServer } = await import("./fake-mcp-server.ts");
    const fake = createFakeServer();
    // rec1: matches the clean query (fresh turn + toolcall #2).
    fake.state.store.set(
      "project/t13/demo/memory/flumox.md",
      [
        "---",
        "scope: project/t13/demo",
        "title: flumox notes",
        "---",
        "flumox-widget-note-marker: where is the flumox widget documented",
      ].join("\n"),
    );
    // rec0: matches the steer query (queued-input injection evidence).
    fake.state.store.set(
      "project/t13/demo/memory/zorbflint.md",
      [
        "---",
        "scope: project/t13/demo",
        "title: zorbflint spec",
        "---",
        "zorbflint-spec-marker: where is the zorbflint spec documented",
      ].join("\n"),
    );
    // rec2b: matches the queued followUp query (transient-injection
    // evidence for the consuming run's next turn).
    fake.state.store.set(
      "project/t13/demo/memory/gribble.md",
      [
        "---",
        "scope: project/t13/demo",
        "title: gribble fixture",
        "---",
        "gribble-fixture-marker: where is the gribble fixture documented",
      ].join("\n"),
    );
    // rec2: matches the REDACTED secret query (privacy pipeline evidence).
    fake.state.store.set(
      "project/t13/demo/memory/vault.md",
      [
        "---",
        "scope: project/t13/demo",
        "title: vault",
        "---",
        `vault-note-marker: ${REDACTED_QUERY}`,
      ].join("\n"),
    );
    const mcpServer: Server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        // createFakeServer's fetch handler reads method/headers/body from the
        // init object, not from a Request instance.
        const init: RequestInit = {
          method: req.method ?? "GET",
          headers: { ...req.headers } as Record<string, string>,
        };
        if (chunks.length > 0)
          init.body = Buffer.concat(chunks).toString("utf8");
        const resp = await fake.fetch(`http://127.0.0.1${req.url}`, init);
        res.writeHead(resp.status, { "content-type": "application/json" });
        res.end(Buffer.from(await resp.arrayBuffer()));
      })().catch((err) => {
        res.writeHead(500);
        res.end(String(err));
      });
    });
    await new Promise<void>((r) => mcpServer.listen(0, "127.0.0.1", r));
    const mcpPort = (mcpServer.address() as { port: number }).port;

    // --- Scripted local model (openai-completions SSE, loopback only) -----
    const llmRequests: string[] = [];
    let signalSteer: (() => void) | undefined;
    const steerSignal = new Promise<void>((r) => {
      signalSteer = r;
    });
    let signalRepeat: (() => void) | undefined;
    const repeatSignal = new Promise<void>((r) => {
      signalRepeat = r;
    });
    const sseChunk = (payload: unknown) =>
      `data: ${JSON.stringify(payload)}\n\n`;
    const sse = (
      res: import("node:http").ServerResponse,
      chunks: unknown[],
    ) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks) res.write(sseChunk(c));
      res.write("data: [DONE]\n\n");
      res.end();
    };
    const chunk = (delta: unknown, finish?: string) => ({
      id: "chatcmpl-t13",
      object: "chat.completion.chunk",
      created: 0,
      model: "t13-fixture",
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    });
    const toolCallChunks = (name: string, args: string) => [
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${llmRequests.length}`,
            type: "function",
            function: { name, arguments: args },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ];

    const llmServer: Server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = Buffer.concat(chunks).toString("utf8");
        llmRequests.push(body);
        const callIndex = llmRequests.length;
        // Deterministic call-count script (bounded at 8):
        // 1 → recall tool call with a secret-bearing query (privacy
        //     redaction must fire before the backend sees it); the response
        //     is delayed so the steer is queued while the agent is streaming;
        // 2 → clean recall tool call;
        // 3 → final text (run 1 ends);
        // 4 → the repeated-input run's first call, delayed so the queued
        //     followUp is submitted while this run is streaming;
        // 5+ → final text (the followUp turn's call lands here).
        if (callIndex === 1) {
          signalSteer?.();
          setTimeout(() => {
            sse(
              res,
              toolCallChunks(
                "kiwifs_memory_search",
                JSON.stringify({ query: SECRET_QUERY }),
              ),
            );
          }, 500);
        } else if (callIndex === 2) {
          sse(
            res,
            toolCallChunks(
              "kiwifs_memory_search",
              JSON.stringify({ query: CLEAN_QUERY }),
            ),
          );
        } else if (callIndex === 4) {
          signalRepeat?.();
          setTimeout(() => {
            sse(res, [
              chunk({ role: "assistant", content: FINAL_TEXT }, "stop"),
            ]);
          }, 500);
        } else {
          sse(res, [chunk({ role: "assistant", content: FINAL_TEXT }, "stop")]);
        }
      })().catch((err) => {
        res.writeHead(500);
        res.end(String(err));
      });
    });
    await new Promise<void>((r) => llmServer.listen(0, "127.0.0.1", r));
    const llmPort = (llmServer.address() as { port: number }).port;

    // --- Fixture config, tokenizer, models.json ---------------------------
    writeFileSync(
      join(tmp, "tokenizer-fixture.mjs"),
      "export const tokenizer = { id: 'fixture-1', countTokens: (text) => text.length };\n",
    );
    writeFileSync(
      join(tmp, "kiwifs.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        projectIdentity: "t13/demo",
        mcp: {
          url: `http://127.0.0.1:${mcpPort}`,
          auth: { kind: "env", ref: "T13_FIXTURE_TOKEN" },
        },
        scopes: { allowPersonalGlobal: true, crossProjectOptIn: [] },
        budgets: {
          ragDeadlineMs: 5000,
          evidenceTokenCap: 3000,
          tokenizer: { module: "./tokenizer-fixture.mjs" },
        },
      }),
    );
    writeFileSync(
      join(tmp, "agent", "models.json"),
      JSON.stringify({
        providers: {
          "t13-fixture": {
            name: "T13 fixture local model",
            baseUrl: `http://127.0.0.1:${llmPort}/v1`,
            apiKey: "fixture-local-synthetic",
            api: "openai-completions",
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
            },
            models: [
              {
                id: "t13-fixture",
                name: "T13 Fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );

    // --- Spawn the REAL Pi CLI in RPC mode with the extension -------------
    const child = spawn(
      process.execPath,
      [
        resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "-e",
        resolve("src/index.ts"),
      ],
      {
        cwd: tmp,
        env: {
          PATH: process.env.PATH,
          HOME: tmp,
          PI_CODING_AGENT_DIR: join(tmp, "agent"),
          KIWIFS_MEMORY_CONFIG: join(tmp, "kiwifs.config.json"),
          KIWIFS_MEMORY_STATE_DIR: join(tmp, "state"),
          T13_FIXTURE_TOKEN: "fixture-dummy-mcp-token",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = once(child, "close");
    const stderr: string[] = [];
    child.stderr.setEncoding("utf8").on("data", (c: string) => stderr.push(c));
    const extensionErrors: string[] = [];
    const assistantTexts: string[] = [];
    let agentEndCount = 0;
    const responses = new Map<string, any>();
    const statusNotices: string[] = [];
    const confirmDialogs: string[] = [];
    const confirmAnswers: boolean[] = [];
    const waiters: ((msg: any) => void)[] = [];

    let buffer = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      buffer += c;
      for (;;) {
        const i = buffer.indexOf("\n");
        if (i < 0) break;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "extension_error") extensionErrors.push(line);
        if (msg.type === "agent_end") agentEndCount += 1;
        if (msg.type === "message_end" && msg.message?.role === "assistant") {
          const content = msg.message.content;
          const text = Array.isArray(content)
            ? content
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("")
            : String(content ?? "");
          assistantTexts.push(text);
        }
        if (msg.type === "extension_ui_request" && msg.method === "notify") {
          statusNotices.push(String(msg.message));
        }
        // Q09C harness gap: RPC confirm dialogs MUST be answered or the
        // extension command blocks forever. Scripted answers, refused by
        // default (never auto-confirm an unexpected dialog).
        if (msg.type === "extension_ui_request" && msg.method === "confirm") {
          confirmDialogs.push(String(msg.message));
          const answer = confirmAnswers.shift() ?? false;
          send({
            type: "extension_ui_response",
            id: msg.id,
            ...(answer ? { confirmed: true } : { cancelled: true }),
          });
        }
        if (msg.id !== undefined) {
          responses.set(msg.id, msg);
          for (const w of waiters.splice(0)) w(msg);
        }
      }
    });

    const send = (cmd: unknown) => {
      child.stdin.write(JSON.stringify(cmd) + "\n");
    };
    /** Wait for the RPC response with the given id (bounded). */
    const waitForResponse = (id: string, ms: number) => {
      const existing = responses.get(id);
      if (existing) return Promise.resolve(existing);
      return new Promise<any>((resolveP, rejectP) => {
        const timer = setTimeout(
          () => rejectP(new Error(`timed out waiting for RPC response ${id}`)),
          ms,
        );
        waiters.push((msg) => {
          if (msg.id === id) {
            clearTimeout(timer);
            resolveP(msg);
          }
        });
      });
    };

    let testError: unknown;
    try {
      const modelResp = await (async () => {
        for (let i = 0; i < 10; i++) {
          send({
            id: "model",
            type: "set_model",
            provider: "t13-fixture",
            modelId: "t13-fixture",
          });
          const r = await waitForResponse("model", 30_000);
          if (r.success) return r;
        }
        throw new Error("could not select the fixture model in Pi RPC");
      })();
      void modelResp;

      // The configured tokenizer loads asynchronously; until it attaches the
      // first pack would be visibly skipped (by design). Poll the extension's
      // status command (extension command → notify, no LLM turn) until the
      // status line reports the attached tokenizer, then run the scenario.
      let tokenizerAttached = false;
      for (let i = 0; i < 40 && !tokenizerAttached; i++) {
        send({ type: "prompt", message: "/kiwifs-status" });
        await new Promise((r) => setTimeout(r, 250));
        if (statusNotices.some((n) => n.includes("tokenizer attached"))) {
          tokenizerAttached = true;
        }
      }
      assert.ok(tokenizerAttached, "tokenizer never attached (status poll)");

      // Turn 1 (fresh): retrieval → pack → before_agent_start injection.
      send({ id: "p1", type: "prompt", message: CLEAN_QUERY });

      // The steer is queued while the first model call is still streaming
      // (the scripted server delays its response). Its RPC response may
      // arrive after the run; delivery is asserted via provider bodies.
      await steerSignal;
      send({
        id: "p2",
        type: "prompt",
        message: STEER_TEXT,
        streamingBehavior: "steer",
      });

      // Wait for the scripted final assistant message AND the steer run's
      // LLM call (bounded).
      const deadline = Date.now() + 60_000;
      while (
        Date.now() < deadline &&
        !(
          assistantTexts.some((t) => t.includes(FINAL_TEXT)) &&
          llmRequests.length >= 3
        )
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(
        assistantTexts.some((t) => t.includes(FINAL_TEXT)),
        `agent never produced the final message; got: ${JSON.stringify(assistantTexts)}`,
      );
      await new Promise((r) => setTimeout(r, 250)); // let agent_end land
      // Post-run status: surface any degraded/settle-drop notes.
      send({ type: "prompt", message: "/kiwifs-status" });
      await new Promise((r) => setTimeout(r, 500));

      assert.equal(
        extensionErrors.length,
        0,
        `extension errors: ${extensionErrors.join(" | ")}`,
      );

      // --- Provider-call assertions (raw request bodies to the local model) -
      assert.ok(llmRequests.length >= 3, "expected ≥3 provider calls");
      const r1 = llmRequests[0]!;
      const r2 = llmRequests[1]!;
      const r3 = llmRequests[2]!;

      // Fresh-turn injection: persistent custom evidence message in call 1.
      const count = (s: string, needle: string) => s.split(needle).length - 1;
      assert.ok(
        r1.includes(EVIDENCE_MARKER),
        "fresh pack was not injected before the first LLM call",
      );
      assert.ok(
        r1.includes("project/t13/demo/memory/flumox.md"),
        "injected pack does not cite the synthetic source path",
      );

      // Call 2: the steer was delivered after turn 1's tool calls (no
      // before_agent_start), so its pack must be injected via the transient
      // context path — exactly once, alongside the persistent run-1 pack.
      assert.ok(
        r2.includes("vault-note-marker"),
        "recall tool result (secret query) missing from call 2",
      );
      assert.ok(
        r2.includes(STEER_TEXT),
        "steer input never reached the provider context",
      );
      assert.equal(
        count(r2, EVIDENCE_MARKER),
        2,
        "call 2 must carry exactly two packs (persistent fresh + transient steer)",
      );

      // Call 3: the steer pack was transient (consumed; never replayed on
      // the tool-loop provider call), the persistent fresh pack survives,
      // and the second recall tool result arrived.
      assert.ok(
        r3.includes("flumox-widget-note-marker"),
        "second recall tool result missing from call 3",
      );
      assert.equal(
        count(r3, EVIDENCE_MARKER),
        1,
        "call 3 must carry only the persistent fresh pack (no steer replay)",
      );

      // Privacy: the backend never received the raw synthetic secret.
      const mcpBodies = fake.state.requests.map((r) => r.body).join("\n");
      assert.ok(
        mcpBodies.includes("[REDACTED:aws-access-key:20]"),
        "redacted query never reached the backend",
      );
      assert.ok(
        !mcpBodies.includes(SECRET),
        "raw synthetic secret leaked to the backend",
      );

      // The recall tool ran through Pi's real tool runner (guard → backend).
      assert.ok(
        mcpBodies.includes("kiwi_search"),
        "backend never received a kiwi_search call",
      );

      // Real lifecycle: at least one agent_end after the runs.
      assert.ok(agentEndCount >= 1, "no agent_end event observed");
      assert.ok(
        child.exitCode === null || child.exitCode === 0,
        "pi exited during the fixture",
      );

      // --- Q09C: repeated fresh input + queued followUp (same process) -----
      // The repeated prompt is submitted while idle: a full fresh cycle runs
      // again (retrieval + before_agent_start → a SECOND persistent pack).
      const noticesBeforeRuns = statusNotices.length;
      send({ id: "p3", type: "prompt", message: CLEAN_QUERY });
      await repeatSignal;
      // Queued followUp: submitted while the repeated-input run is streaming
      // (call 4 is delayed 500 ms). Its retrieval cycle completes at
      // submission (awaited input handler); Pi queues the expanded text and
      // replays it as the consuming run's next turn — no new
      // before_agent_start, transient context-path injection exactly once.
      send({
        id: "p4",
        type: "prompt",
        message: FOLLOWUP_QUERY,
        streamingBehavior: "followUp",
      });
      const runsDeadline = Date.now() + 60_000;
      while (
        Date.now() < runsDeadline &&
        !(
          llmRequests.length >= 5 &&
          assistantTexts.filter((t) => t.includes(FINAL_TEXT)).length >= 2
        )
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(
        llmRequests.length >= 5,
        `expected ≥5 provider calls after repeated input + followUp; got ${llmRequests.length}`,
      );
      await new Promise((r) => setTimeout(r, 400)); // let agent_settled land
      send({ type: "prompt", message: "/kiwifs-status" });
      await new Promise((r) => setTimeout(r, 500));
      const r4 = llmRequests[3]!;
      const r5 = llmRequests[4]!;

      // Repeated input: full fresh cycle again — the run-1 persistent pack
      // is still in the session, so call 4 carries exactly two persistent
      // packs (run 1 + repeated input). Never silently deduped.
      assert.equal(
        count(r4, EVIDENCE_MARKER),
        2,
        "repeated fresh input must get its own persistent pack (2 total)",
      );
      assert.ok(
        r4.includes(CLEAN_QUERY),
        "repeated input text missing from the provider call",
      );

      // Queued followUp: replayed text + transient pack (2 persistent +
      // exactly one transient) on the consuming call — and NO new
      // persistent pack (a followUp never gets a before_agent_start).
      assert.ok(
        r5.includes(FOLLOWUP_QUERY),
        "queued followUp text never reached the provider context",
      );
      assert.equal(
        count(r5, EVIDENCE_MARKER),
        3,
        "followUp call must carry 2 persistent packs + exactly 1 transient",
      );

      // The followUp pack matched (consumed), so nothing was dropped at
      // settle — the degraded drop note must NOT appear.
      assert.ok(
        !statusNotices
          .slice(noticesBeforeRuns)
          .some((n) => n.includes("dropped at run settle")),
        `unexpected drop note after matched followUp: ${statusNotices.join(" | ")}`,
      );

      // --- Q09C: private-mode flip through the real control surface -------
      /** Latest `/kiwifs-queue` stats parsed from its sanitized notify. */
      const queueStats = async (): Promise<{
        pending: number;
        acked: number;
        quarantined: number;
      }> => {
        const before = statusNotices.length;
        send({ type: "prompt", message: "/kiwifs-queue" });
        await new Promise((r) => setTimeout(r, 400));
        const notice = statusNotices
          .slice(before)
          .map((n) =>
            /outbox: pending=(\d+) quarantined=(\d+) acked=(\d+)/.exec(n),
          )
          .find(Boolean);
        assert.ok(
          notice,
          `/kiwifs-queue produced no stats: ${statusNotices.join(" | ")}`,
        );
        return {
          pending: Number(notice[1]),
          quarantined: Number(notice[2]),
          acked: Number(notice[3]),
        };
      };
      send({ type: "prompt", message: "/kiwifs-private-mode" });
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(
        statusNotices.some((n) => n.includes("private mode: OFF")),
        `status must read OFF initially: ${statusNotices.join(" | ")}`,
      );
      send({ type: "prompt", message: "/kiwifs-private-mode on" });
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(
        statusNotices.some((n) =>
          n.includes("private mode ON — all domains hold"),
        ),
        `flip ON notify missing: ${statusNotices.join(" | ")}`,
      );
      send({ type: "prompt", message: "/kiwifs-private-mode status" });
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(
        statusNotices.some((n) => n.includes("private mode: ON")),
        `status must read ON after flip: ${statusNotices.join(" | ")}`,
      );

      // --- Q09C: headless personal write + private-mode refusal -----------
      // (The baseline includes backup-chunk jobs held as a retryable gap:
      // the fake backend has no manifest writer.)
      const baseline = await queueStats();
      assert.ok(
        baseline.quarantined === 0,
        `no job may be quarantined in the fixture: ${JSON.stringify(baseline)}`,
      );
      // While private mode is ON the command gate REFUSES the record-mutating
      // command outright (fail closed — nothing is enqueued, no backend I/O).
      send({
        type: "prompt",
        message: `/kiwifs-personal-note ${PERSONAL_HEADLESS_NOTE} --yes`,
      });
      await new Promise((r) => setTimeout(r, 600));
      assert.ok(
        statusNotices.some((n) =>
          n.includes(
            "private mode active — all domains hold (zero reads/writes)",
          ),
        ),
        `private-mode refusal notify missing: ${statusNotices.join(" | ")}`,
      );
      const whilePrivate = await queueStats();
      assert.deepEqual(
        whilePrivate,
        baseline,
        `private mode must refuse to enqueue: ${JSON.stringify({ baseline, whilePrivate })}`,
      );
      assert.ok(
        !fake.state.requests
          .map((r) => r.body)
          .join("\n")
          .includes("T13-PERSONAL-HEADLESS"),
        "refused personal note reached the backend while private mode held",
      );

      // Flip OFF: gated features resume at their next cycle. NOW the
      // headless --yes write saves. In RPC the command context has a UI, so
      // --yes does NOT bypass the confirm dialog — the dialog still guards
      // the write and this script confirms it (a real
      // extension_ui_request/extension_ui_response round trip).
      send({ type: "prompt", message: "/kiwifs-private-mode off" });
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(
        statusNotices.some((n) =>
          n.includes("private mode OFF — gated features resume"),
        ),
        `flip OFF notify missing: ${statusNotices.join(" | ")}`,
      );
      confirmAnswers.push(true);
      send({
        type: "prompt",
        message: `/kiwifs-personal-note ${PERSONAL_HEADLESS_NOTE} --yes`,
      });
      await new Promise((r) => setTimeout(r, 800));
      assert.ok(
        statusNotices.some((n) => n.includes("personal note saved")),
        `headless personal note not saved: ${statusNotices.join(" | ")}`,
      );
      const saved = await queueStats();
      assert.equal(
        saved.pending,
        baseline.pending + 1,
        `exactly the saved personal job may be pending: ${JSON.stringify({ baseline, saved })}`,
      );

      // --- Q09C: confirmed dialog over real RPC (redact-before-preview) ---
      // The first dialog (this note) carries the secret-bearing statement:
      // the preview must already be redacted.
      confirmAnswers.push(true);
      send({
        type: "prompt",
        message: `/kiwifs-personal-note ${PERSONAL_DIALOG_NOTE}`,
      });
      await new Promise((r) => setTimeout(r, 800));
      assert.ok(confirmDialogs.length >= 2, "confirm dialog never rendered");
      const dialog = confirmDialogs[0]!;
      assert.ok(
        dialog.includes("[REDACTED:aws-access-key:20]"),
        `confirm dialog must show the REDACTED preview: ${dialog}`,
      );
      assert.ok(
        confirmDialogs.every((d) => !d.includes(SECRET)),
        "a confirm dialog leaked the raw synthetic secret",
      );
      assert.ok(
        statusNotices.some((n) => n.includes("personal note saved")),
        `confirmed personal note not saved: ${statusNotices.join(" | ")}`,
      );

      // Delivery: the next worker tick delivers BOTH personal jobs
      // idempotently to the fake backend (redact-before-durable-write means
      // the raw synthetic secret cannot appear on the wire).
      const deliveryDeadline = Date.now() + 75_000;
      const personalBodies = () =>
        fake.state.requests.map((r) => r.body).join("\n");
      while (
        Date.now() < deliveryDeadline &&
        !(
          personalBodies().includes("T13-PERSONAL-HEADLESS") &&
          personalBodies().includes("T13-PERSONAL-DIALOG")
        )
      ) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const delivered = personalBodies();
      assert.ok(
        delivered.includes("T13-PERSONAL-HEADLESS"),
        "headless personal note never delivered after private flip",
      );
      assert.ok(
        delivered.includes("T13-PERSONAL-DIALOG"),
        "dialog-confirmed personal note never delivered",
      );
      assert.ok(
        !delivered.includes(SECRET),
        "raw synthetic secret leaked into personal delivery",
      );
      assert.ok(
        delivered.includes("[REDACTED:aws-access-key:20]"),
        "personal delivery missing the redaction marker",
      );

      // Outbox drained of the personal jobs: both acked on the wire, nothing
      // quarantined. The first tick may also deliver the earlier runs'
      // backup-chunk jobs (whatever the baseline held), so only an UPPER
      // bound on pending and a lower bound on acked are asserted — the
      // personal delivery itself is proven by the bodies above.
      const drained = await queueStats();
      assert.ok(
        drained.pending <= baseline.pending,
        `personal jobs must be delivered (pending may only shrink): ${JSON.stringify({ baseline, drained })}`,
      );
      assert.ok(
        drained.acked >= 2,
        `both personal jobs must be acked: ${JSON.stringify(drained)}`,
      );
      assert.equal(drained.quarantined, 0, "nothing may be quarantined");

      // --- Q09C: refusal over real RPC ------------------------------------
      confirmAnswers.push(false);
      send({
        type: "prompt",
        message: `/kiwifs-personal-note ${PERSONAL_REFUSED_NOTE}`,
      });
      await new Promise((r) => setTimeout(r, 800));
      assert.ok(
        statusNotices.some((n) => n.includes("personal note cancelled")),
        `refusal notify missing: ${statusNotices.join(" | ")}`,
      );
      assert.ok(
        !personalBodies().includes("T13-PERSONAL-REFUSED"),
        "refused personal note reached the backend",
      );
      const afterRefusal = await queueStats();
      assert.deepEqual(
        afterRefusal,
        drained,
        `refusal must enqueue nothing: ${JSON.stringify({ drained, afterRefusal })}`,
      );
    } catch (err) {
      testError = err;
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exited.catch(() => {});
      mcpServer.close();
      llmServer.close();
      rmSync(tmp, { recursive: true, force: true });
    }
    if (testError !== undefined) {
      if (testError instanceof assert.AssertionError) throw testError;
      const stack =
        testError instanceof Error
          ? (testError.stack ?? "")
          : String(testError);
      throw new Error(
        `${(testError as Error).message} | stack: ${stack.split("\n").slice(0, 4).join(" << ")} | pi stderr tail: ${stderr.join("").slice(-1200)}`,
      );
    }
  },
);
