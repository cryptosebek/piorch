import { describe, expect, it } from "vitest";
import {
  runTaskFlow,
  type StageDefinition,
} from "../.pi/extensions/workflow-orchestrator/engine.js";

interface TestTask {
  id: string;
  status: "pending" | "in_progress" | "verified" | "failed" | "stopped";
  retries: number;
  stageId?: string;
  issues?: string[];
  devOutput?: any;
  verifyOutput?: any;
}

const stages: StageDefinition[] = [
  { id: "develop" },
  {
    id: "verify",
    transitions: [
      { when: { field: "status", equals: "fail" }, next: "develop" },
      { when: { field: "status", equals: "pass" }, next: "complete" },
    ],
  },
];

function baseOptions(task: TestTask) {
  return {
    task,
    stages,
    maxRetries: 2,
    isStopped: (t: TestTask) => t.status === "stopped",
    applyOutput: (t: TestTask, stageId: string, result: any) => {
      if (stageId === "develop") t.devOutput = result.output;
      if (stageId === "verify") t.verifyOutput = result.output;
    },
    applyVerifyFailure: (t: TestTask, _stageId: string, result: any, error?: string) => {
      const issues = result?.output?.issues ?? (error ? [error] : []);
      t.verifyOutput = { status: "fail", issues };
      t.issues = issues;
    },
    applyGenericFailure: (t: TestTask, error: string) => {
      t.issues = [error];
    },
    markVerified: (t: TestTask, stageId: string) => {
      t.status = "verified";
      t.stageId = stageId;
    },
    markFailed: (t: TestTask, stageId: string) => {
      t.status = "failed";
      t.stageId = stageId;
    },
  };
}

describe("runTaskFlow", () => {
  it("completes on verify pass", async () => {
    const task: TestTask = { id: "T1", status: "pending", retries: 0 };
    let calls = 0;
    await runTaskFlow({
      ...baseOptions(task),
      runStage: async (stage) => {
        calls += 1;
        if (stage.id === "develop") return { output: { status: "done" }, outputText: "dev" };
        return { output: { status: "pass", issues: [] }, outputText: "verify" };
      },
    });
    expect(calls).toBe(2);
    expect(task.status).toBe("verified");
    expect(task.verifyOutput?.status).toBe("pass");
  });

  it("retries when verify fails", async () => {
    const task: TestTask = { id: "T1", status: "pending", retries: 0 };
    let verifyCount = 0;
    await runTaskFlow({
      ...baseOptions(task),
      runStage: async (stage) => {
        if (stage.id === "develop") return { output: { status: "done" }, outputText: "dev" };
        verifyCount += 1;
        if (verifyCount === 1)
          return { output: { status: "fail", issues: ["bug"] }, outputText: "verify" };
        return { output: { status: "pass", issues: [] }, outputText: "verify" };
      },
    });
    expect(task.retries).toBeGreaterThan(0);
    expect(task.status).toBe("verified");
  });

  it("fails after retries exceeded", async () => {
    const task: TestTask = { id: "T1", status: "pending", retries: 2 };
    await runTaskFlow({
      ...baseOptions(task),
      maxRetries: 2,
      runStage: async (stage) => {
        if (stage.id === "develop") return { output: { status: "done" }, outputText: "dev" };
        return { output: { status: "fail", issues: ["still broken"] }, outputText: "verify" };
      },
    });
    expect(task.status).toBe("failed");
  });

  it("enforces maxRetries even if retry callbacks allow more", async () => {
    const task: TestTask = { id: "T1", status: "pending", retries: 0 };
    let developCount = 0;
    let verifyCount = 0;

    await runTaskFlow({
      ...baseOptions(task),
      maxRetries: 1,
      applyVerifyFailure: (t: TestTask, _stageId: string, result: any, error?: string) => {
        const issues = result?.output?.issues ?? (error ? [error] : []);
        t.verifyOutput = { status: "fail", issues };
        t.issues = issues;
      },
      runStage: async (stage) => {
        if (stage.id === "develop") {
          developCount += 1;
          return { output: { status: "done" }, outputText: "dev" };
        }
        verifyCount += 1;
        return { output: { status: "fail", issues: ["still broken"] }, outputText: "verify" };
      },
    });

    expect(developCount).toBe(2);
    expect(verifyCount).toBe(2);
    expect(task.retries).toBe(2);
    expect(task.status).toBe("failed");
  });

  it("returns early when stopped", async () => {
    const task: TestTask = { id: "T1", status: "stopped", retries: 0 };
    let calls = 0;
    await runTaskFlow({
      ...baseOptions(task),
      runStage: async () => {
        calls += 1;
        return { output: { status: "done" }, outputText: "dev" };
      },
    });
    expect(calls).toBe(0);
  });

  it("retries verifier when status is unknown", async () => {
    const task: TestTask = { id: "T1", status: "pending", retries: 0 };
    let verifyCount = 0;
    let developCount = 0;
    await runTaskFlow({
      ...baseOptions(task),
      runStage: async (stage) => {
        if (stage.id === "develop") {
          developCount += 1;
          return { output: { status: "done" }, outputText: "dev" };
        }
        verifyCount += 1;
        if (verifyCount === 1)
          return { output: { status: "unknown" }, outputText: "verifier failed to parse" };
        return { output: { status: "pass", issues: [] }, outputText: "verify" };
      },
    });
    expect(developCount).toBe(1);
    expect(verifyCount).toBe(2);
    expect(task.status).toBe("verified");
  });

  it("fails when verifier keeps returning unknown status", async () => {
    const task: TestTask = { id: "T1", status: "pending", retries: 2 };
    let verifyCount = 0;
    await runTaskFlow({
      ...baseOptions(task),
      maxRetries: 2,
      runStage: async (stage) => {
        if (stage.id === "develop") return { output: { status: "done" }, outputText: "dev" };
        verifyCount += 1;
        return { output: { status: "unknown" }, outputText: "verifier unknown" };
      },
    });
    expect(verifyCount).toBe(1);
    expect(task.status).toBe("failed");
  });

  it("passes verify failure reasons for fail vs malformed outputs", async () => {
    const task: TestTask = { id: "T1", status: "pending", retries: 0 };
    const reasons: string[] = [];
    let verifyCount = 0;

    await runTaskFlow({
      ...baseOptions(task),
      maxRetries: 3,
      applyVerifyFailure: (t, stageId, result, error, reason) => {
        reasons.push(String(reason));
        baseOptions(t).applyVerifyFailure(t, stageId, result, error);
      },
      runStage: async (stage) => {
        if (stage.id === "develop") return { output: { status: "done" }, outputText: "dev" };
        verifyCount += 1;
        if (verifyCount === 1) return { output: { status: "unknown" }, outputText: "unknown" };
        if (verifyCount === 2)
          return { output: { status: "fail", issues: ["needs fix"] }, outputText: "fail" };
        return { output: { status: "pass", issues: [] }, outputText: "pass" };
      },
    });

    expect(reasons).toContain("malformed_output");
    expect(reasons).toContain("verification_failed");
    expect(task.status).toBe("verified");
  });
});
