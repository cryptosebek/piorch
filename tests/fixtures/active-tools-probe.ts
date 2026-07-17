import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Test-only extension used by the opt-in real-Pi compatibility smoke test. */
export default function registerActiveToolsProbe(pi: ExtensionAPI): void {
  pi.registerCommand("piorch-active-tools-probe", {
    description: "Report the active tool allowlist to the RPC test host",
    handler: async () => {
      pi.appendEntry("piorch-active-tools", {
        role: process.env.PIORCH_PROBE_ROLE ?? "unknown",
        tools: pi.getActiveTools(),
      });
    },
  });
}
