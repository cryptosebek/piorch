/**
 * Workflow Task Tools Extension
 *
 * Provides the report_task_result tool for developer/verifier agents
 * to report task completion.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DeveloperReportSchema,
  VerifierReportSchema,
  validateDeveloperReport,
  validateVerifierReport,
  type DeveloperReport,
  type VerifierReport,
} from "../workflow-orchestrator/contracts.js";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "report_task_result",
    label: "Report Task Result",
    description: "Report completion of a task (for developer/verifier agents)",
    parameters: Type.Union([DeveloperReportSchema, VerifierReportSchema]),
    async execute(_toolCallId, params) {
      const status = params.status;
      let message: string;
      let report: DeveloperReport | VerifierReport;
      if ((status === "pass" || status === "fail") && "filesChanged" in params) {
        throw new Error(
          "Developer report validation failed: developer reports cannot use verifier status",
        );
      }
      if (status === "done") report = validateDeveloperReport(params);
      else if (status === "pass" || status === "fail") report = validateVerifierReport(params);
      else
        report =
          "filesChanged" in params
            ? validateDeveloperReport(params)
            : validateVerifierReport(params);

      if (status === "done") {
        const developer = report as DeveloperReport;
        message = `Task completed. Summary: ${developer.summary}. Files: ${developer.filesChanged.join(", ") || "none"}`;
      } else if (status === "partial") {
        message = `Task partially complete. Summary: ${report.summary}`;
      } else if (status === "pass") {
        message = "Verification passed. No issues found.";
      } else {
        message = `Verification failed. Issues:\n${report.issues
          .map((issue) => `- ${issue.description}`)
          .join("\n")}`;
      }

      return {
        content: [{ type: "text", text: message }],
        details: { params: report },
      };
    },
  });
}
