/**
 * Workflow PM Tools Extension
 *
 * Provides the generate_wave tool for PM agents to generate task waves.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const PmResultSchema = Type.Object({
  done: Type.Boolean({
    description: "True if all work is complete, false if generating a new wave",
  }),
  wave: Type.Optional(
    Type.Object(
      {
        goal: Type.String({ description: "Goal for this wave" }),
        tasks: Type.Array(
          Type.Object({
            id: Type.String({ description: "Unique task identifier" }),
            title: Type.String({ description: "Short task title" }),
            description: Type.String({ description: "Detailed instructions for developer" }),
            requirements: Type.Optional(
              Type.String({ description: "Verification requirements for verifier" }),
            ),
            assignee: Type.Optional(
              Type.String({ description: "Task assignee (default: developer)" }),
            ),
          }),
          { description: "Tasks in this wave" },
        ),
      },
      { description: "Wave details (required when done=false)" },
    ),
  ),
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "generate_wave",
    label: "Generate Wave",
    description: "Generate a new wave of tasks (for PM agent)",
    parameters: PmResultSchema,
    async execute(_toolCallId, params) {
      if (params.done) {
        return {
          content: [{ type: "text", text: "Project completion reported." }],
          details: { params },
        };
      }

      if (!params.wave) {
        return {
          content: [{ type: "text", text: "Error: wave is required when done=false" }],
          details: { params },
        };
      }

      const taskCount = params.wave.tasks.length;
      return {
        content: [
          { type: "text", text: `Wave generated: "${params.wave.goal}" (${taskCount} tasks)` },
        ],
        details: { params },
      };
    },
  });
}
