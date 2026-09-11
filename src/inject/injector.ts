/**
 * T13: matched context injection (architecture.md §3.1, §13 row 6, PRD T13).
 *
 * Two injection points, verified against the installed Pi 0.85.0 source:
 *
 * - Fresh turns: `before_agent_start` fires once per agent-run start with
 *   the EXPANDED prompt (`agent-session.js:914–932`). Eligible (non-slash)
 *   inputs pass expansion unchanged, so the pending fresh pack's matchKey
 * matches the prompt; the handler returns ONE custom extension message
 *   (`result.message`, `types.d.ts:845–849`) carrying the framed evidence.
 *   This injection is PERSISTENT: Pi appends the custom message to the
 *   session. It happens exactly once per pack (the pack is consumed from
 *   the registry), so repeated LLM calls can never append a duplicate
 *   persistent entry.
 * - Steered/followUp inputs: no new `before_agent_start` fires (verified:
 *   the emission exists only inside `prompt()`); a followUp may begin a new
 *   agent run via `agent.continue()` — still without one. Their packs are
 *   delivered through the `context` event (`transformContext`,
 *   agent-loop.js:179–181), which fires per provider call with a CLONED
 *   message list (`runner.js emitContext` uses structuredClone) — the
 *   returned replacement is transient, so context injection adds NO
 *   persistent entries. Injection happens only when the LAST user message
 *   matches the pending pack (newly consumed occurrence —
 *   PendingPackRegistry barrier semantics); tool-loop replays are deduped
 *   by the per-key count barrier; unmatched packs fail closed and are
 *   dropped at run settle (wired in T12's `agent_settled` handler).
 *
 * Packs whose automatic injection is skipped (no reliable tokenizer) are
 * consumed but never injected — the skip note is already visible via the
 * retrieval coordinator's degraded status. Packs with zero evidence items
 * are consumed without injecting an empty framing block (noise reduction;
 * the "no evidence passed the guard pipeline" note remains visible).
 *
 * `EvidencePack.rawText` is never included in the message content or
 * details: it is local matching state, never outbound.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { frameEvidence } from "./packer.ts";
import type {
  EvidencePack,
  PendingPackRegistry,
} from "../retrieval/coordinator.ts";

export const EVIDENCE_MESSAGE_TYPE = "kiwifs-evidence";

/**
 * Structural shape of the single custom extension message a
 * `before_agent_start` handler may return (Pi 0.85.0:
 * `Pick<CustomMessage, "customType" | "content" | "display" | "details">`,
 * `types.d.ts:845–849`). Declared structurally because the root package
 * does not re-export the CustomMessage type.
 */
export type EvidenceCustomMessage = {
  /** Pi AgentMessage role; required for the `context`-path injected message
   * to survive pi's convertToLlm (verified against real Pi RPC, T13). */
  role: "custom";
  customType: string;
  content:
    | string
    | (
        | { type: "text"; text: string }
        | {
            type: "image";
            data: string;
            mimeType: string;
          }
      )[];
  display: boolean;
  details?: unknown;
};

/** Safe metadata in message details: ids/paths/status only — never rawText. */
export interface EvidenceMessageDetails {
  inputId: string;
  generation: number;
  streamingBehavior?: string;
  tokenCount?: number;
  degraded: string[];
  items: {
    path: string;
    scope: string;
    leg: string;
    attribution?: string;
  }[];
}

/** Build the single custom message carrying the framed evidence pack. */
export function buildEvidenceMessage(
  pack: EvidencePack,
): EvidenceCustomMessage {
  const details: EvidenceMessageDetails = {
    inputId: pack.inputId,
    generation: pack.generation,
    degraded: [...pack.degraded],
    items: pack.items.map((i) => ({
      path: i.path,
      scope: i.scope,
      leg: i.leg,
      ...(i.attribution !== undefined ? { attribution: i.attribution } : {}),
    })),
    ...(pack.streamingBehavior !== undefined
      ? { streamingBehavior: pack.streamingBehavior }
      : {}),
    ...(pack.tokenCount !== undefined ? { tokenCount: pack.tokenCount } : {}),
  };
  return {
    role: "custom",
    customType: EVIDENCE_MESSAGE_TYPE,
    content: frameEvidence(pack.items),
    display: true,
    details,
  };
}

/**
 * Injectable = the pack exists, carries evidence, and its payload was
 * verified within the cap by a reliable tokenizer. Consumed-but-not-
 * injected is a visible degradation (skipped tokenizer), not a silent loss.
 */
function injectable(pack: EvidencePack): boolean {
  return pack.injectionAllowed && pack.items.length > 0;
}

export class EvidenceInjector {
  private readonly registry: PendingPackRegistry;

  constructor(registry: PendingPackRegistry) {
    this.registry = registry;
  }

  /**
   * `before_agent_start` handler: consume the fresh pack matching the
   * prompt and return the single custom message. Fail closed: no matching
   * fresh pack → undefined (nothing injected; the pack, if any, stays
   * pending and fails closed at run settle or on the context path).
   */
  onBeforeAgentStart(
    prompt: string,
  ): { message: EvidenceCustomMessage } | undefined {
    const pack = this.registry.consumeFresh(prompt);
    if (!pack || !injectable(pack)) return undefined;
    return { message: buildEvidenceMessage(pack) };
  }

  /**
   * `context` handler: consume the pending pack matched to the CONSUMED
   * input (last user message, new occurrence) and return the message list
   * with the evidence appended after it. The returned list is a transient
   * per-provider-call replacement (structuredClone in Pi's runner) — no
   * persistent entry is created, and the registry's consumed set plus
   * count barriers prevent duplicate injection on tool-loop replays.
   * Fail closed: no match → undefined (nothing injected).
   */
  onContext(
    messages: readonly AgentMessage[],
  ): { messages: AgentMessage[] } | undefined {
    const result = this.registry.consumeMatching(messages);
    if (!result.matched) return undefined;
    if (!injectable(result.pack)) return undefined;
    return {
      messages: [
        ...messages,
        buildEvidenceMessage(result.pack) as AgentMessage,
      ],
    };
  }
}
