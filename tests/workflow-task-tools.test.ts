import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflowTaskTools from "../.pi/extensions/workflow-task-tools/index.js";

describe("workflow-task-tools extension", () => {
  let mockPi: ExtensionAPI;
  let registeredTool: any;

  const developerReport = {
    status: "done",
    summary: "Implemented the feature",
    filesChanged: ["src/feature.ts"],
    evidence: [{ kind: "test", description: "Unit tests pass", outcome: "pass" }],
    issues: [],
  };

  const verifierReport = {
    status: "pass",
    summary: "Verified the feature",
    evidence: [{ kind: "test", description: "Acceptance tests pass", outcome: "pass" }],
    issues: [],
  };

  beforeEach(() => {
    registeredTool = undefined;
    mockPi = {
      registerTool: vi.fn((definition) => {
        registeredTool = definition;
      }),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI;
    workflowTaskTools(mockPi);
  });

  it("registers the shared report tool and schema", () => {
    expect(mockPi.registerTool).toHaveBeenCalled();
    expect(registeredTool.name).toBe("report_task_result");
    expect(registeredTool.description).toContain("developer/verifier");
    expect(registeredTool.parameters).toBeDefined();
  });

  it("accepts a complete developer report", async () => {
    const result = await registeredTool.execute(
      "call",
      developerReport,
      vi.fn(),
      {},
      new AbortController().signal,
    );
    expect(result.content[0].text).toContain("Task completed");
    expect(result.content[0].text).toContain("src/feature.ts");
    expect(result.details.params).toEqual(developerReport);
  });

  it("accepts a partial developer report only with a blocking issue", async () => {
    const params = {
      ...developerReport,
      status: "partial",
      issues: [{ severity: "blocking", description: "The implementation is incomplete" }],
    };
    const result = await registeredTool.execute(
      "call",
      params,
      vi.fn(),
      {},
      new AbortController().signal,
    );
    expect(result.content[0].text).toContain("partially");
  });

  it("rejects developer reports with verifier statuses", async () => {
    await expect(
      registeredTool.execute(
        "call",
        { ...developerReport, status: "pass" },
        vi.fn(),
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("developer reports");
  });

  it("rejects incomplete developer reports", async () => {
    await expect(
      registeredTool.execute(
        "call",
        { status: "done", summary: "Missing fields" },
        vi.fn(),
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("Developer report validation");
  });

  it("rejects unsafe developer file paths", async () => {
    for (const filesChanged of [["/absolute.ts"], ["../escape.ts"], ["src/../escape.ts"]]) {
      await expect(
        registeredTool.execute(
          "call",
          { ...developerReport, filesChanged },
          vi.fn(),
          {},
          new AbortController().signal,
        ),
      ).rejects.toThrow("relative and safe");
    }
  });

  it("accepts a passing verifier report with passing evidence", async () => {
    const result = await registeredTool.execute(
      "call",
      verifierReport,
      vi.fn(),
      {},
      new AbortController().signal,
    );
    expect(result.content[0].text).toContain("Verification passed");
    expect(result.details.params).toEqual(verifierReport);
  });

  it("rejects verifier pass without passing evidence", async () => {
    await expect(
      registeredTool.execute(
        "call",
        { ...verifierReport, evidence: [] },
        vi.fn(),
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("passing evidence");
  });

  it("rejects verifier pass with a failed evidence item or blocking issue", async () => {
    for (const params of [
      { ...verifierReport, evidence: [{ kind: "test", description: "Failed", outcome: "fail" }] },
      {
        ...verifierReport,
        issues: [{ severity: "blocking", description: "Blocked" }],
      },
    ]) {
      await expect(
        registeredTool.execute("call", params, vi.fn(), {}, new AbortController().signal),
      ).rejects.toThrow();
    }
  });

  it("accepts verifier fail only with an actionable blocking issue", async () => {
    const params = {
      status: "fail",
      summary: "Verification found a defect",
      evidence: [{ kind: "test", description: "Acceptance test fails", outcome: "fail" }],
      issues: [{ severity: "blocking", description: "The feature does not satisfy requirement" }],
    };
    const result = await registeredTool.execute(
      "call",
      params,
      vi.fn(),
      {},
      new AbortController().signal,
    );
    expect(result.content[0].text).toContain("Verification failed");
    expect(result.content[0].text).toContain("does not satisfy");
  });

  it("rejects verifier fail without a blocking issue", async () => {
    await expect(
      registeredTool.execute(
        "call",
        {
          status: "fail",
          summary: "Failure",
          evidence: [{ kind: "test", description: "Failed", outcome: "fail" }],
          issues: [],
        },
        vi.fn(),
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("blocking issue");
  });

  it("accepts an environmental verifier partial report", async () => {
    const params = {
      status: "partial",
      summary: "Verification is blocked by the environment",
      evidence: [{ kind: "manual", description: "Environment unavailable", outcome: "blocked" }],
      issues: [{ severity: "blocking", description: "Required environment is unavailable" }],
    };
    const result = await registeredTool.execute(
      "call",
      params,
      vi.fn(),
      {},
      new AbortController().signal,
    );
    expect(result.content[0].text).toContain("partially");
  });

  it("rejects verifier partial without blocked evidence", async () => {
    await expect(
      registeredTool.execute(
        "call",
        {
          status: "partial",
          summary: "Blocked",
          evidence: [{ kind: "test", description: "No run", outcome: "pass" }],
          issues: [{ severity: "blocking", description: "Environment unavailable" }],
        },
        vi.fn(),
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("blocked evidence");
  });

  it("rejects verifier reports containing developer-only filesChanged", async () => {
    await expect(
      registeredTool.execute(
        "call",
        { ...verifierReport, filesChanged: ["src/feature.ts"] },
        vi.fn(),
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  it("returns no side effects beyond the tool result", async () => {
    await registeredTool.execute(
      "call",
      developerReport,
      vi.fn(),
      {},
      new AbortController().signal,
    );
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });
});
