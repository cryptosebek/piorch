/**
 * Workflow Task Tools Extension
 *
 * Provides the report_task_result tool for developer/verifier agents
 * to report task completion.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const TaskResultSchema = Type.Object({
  status: Type.Union([Type.Literal("done"), Type.Literal("pass"), Type.Literal("fail")], {
    description: "Task status: 'done' for developer, 'pass'/'fail' for verifier",
  }),
  summary: Type.Optional(
    Type.String({
      description: "Brief summary of what was done (for developer)",
    }),
  ),
  filesChanged: Type.Optional(
    Type.Array(Type.String(), {
      description: "List of files created or modified (for developer)",
    }),
  ),
  notes: Type.Optional(
    Type.String({
      description: "Additional notes (for developer)",
    }),
  ),
  issues: Type.Optional(
    Type.Array(Type.String(), {
      description: "List of issues found (for verifier when status='fail')",
    }),
  ),
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "report_task_result",
    label: "Report Task Result",
    description: "Report completion of a task (for developer/verifier agents)",
    parameters: TaskResultSchema,
    async execute(_toolCallId, params) {
      const status = params.status;
      let message: string;

      if (status === "done") {
        message = `Task completed. Summary: ${params.summary ?? "N/A"}. Files: ${(params.filesChanged ?? []).join(", ") || "none"}`;
      } else if (status === "pass") {
        message = "Verification passed. No issues found.";
      } else {
        const issues = params.issues ?? [];
        message = `Verification failed. Issues:\n${issues.map((i) => `- ${i}`).join("\n")}`;
      }

      return {
        content: [{ type: "text", text: message }],
        details: { params },
      };
    },
  });
}
