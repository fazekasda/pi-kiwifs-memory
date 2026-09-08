import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config/loader.ts";
import { resolvedStatusLines, statusIsSecretFree } from "./config/status.ts";

export const STATUS_MESSAGE =
  "KiwiFS memory extension loaded. Memory storage is not implemented yet.";

/**
 * Resolves the configuration for display. Never throws: configuration
 * problems are visible status output, not crashes (fail-visible, T03).
 */
export function resolveStatusText(): string {
  const result = loadConfig();
  if (!result.ok) {
    const detail =
      "fatal" in result && result.fatal
        ? result.fatal
        : (result.issues ?? [])
            .map((i) => `${i.path || "(root)"}: ${i.message}`)
            .join("; ");
    return `${STATUS_MESSAGE}\nconfig: INVALID — extension disabled\n${detail}`;
  }
  const lines = resolvedStatusLines(result.config);
  if (!statusIsSecretFree(lines)) {
    // Defensive: never display potentially secret-bearing output.
    return `${STATUS_MESSAGE}\nconfig: loaded (status suppressed — secret-free check failed)`;
  }
  return `${STATUS_MESSAGE}\n${lines.join("\n")}`;
}

export default function kiwifsMemory(pi: ExtensionAPI): void {
  pi.registerCommand("kiwifs-status", {
    description: "Show KiwiFS memory extension status",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(resolveStatusText(), "info");
      }
    },
  });
}
