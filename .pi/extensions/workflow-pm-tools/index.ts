/**
 * Workflow PM Tools Extension
 *
 * Provides the generate_wave tool for PM agents to generate task waves.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GenerateWaveSchema, validateGenerateWave } from "../workflow-orchestrator/contracts.js";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "generate_wave",
    label: "Generate Wave",
    description: "Generate a new wave of tasks (for PM agent)",
    parameters: GenerateWaveSchema,
    async execute(_toolCallId, params) {
      const validated = validateGenerateWave(params);
      if (validated.done) {
        return {
          content: [{ type: "text", text: "Project completion reported." }],
          details: { params: validated },
        };
      }

      const wave = validated.wave!;

      const taskCount = wave.tasks.length;
      return {
        content: [{ type: "text", text: `Wave generated: "${wave.goal}" (${taskCount} tasks)` }],
        details: { params: validated },
      };
    },
  });
}
