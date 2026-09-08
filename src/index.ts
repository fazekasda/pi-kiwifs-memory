import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STATUS_MESSAGE =
  "KiwiFS memory extension loaded. Memory storage is not implemented yet.";

export default function kiwifsMemory(pi: ExtensionAPI): void {
  pi.registerCommand("kiwifs-status", {
    description: "Show KiwiFS memory extension status",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(STATUS_MESSAGE, "info");
      }
    },
  });
}
