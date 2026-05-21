import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadWorkflowConfig } from "../.pi/extensions/workflow-orchestrator/config.js";

function setupTempConfig(content: string): { cwd: string; name: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-test-"));
  const workflowDir = path.join(dir, ".pi", "workflows");
  fs.mkdirSync(workflowDir, { recursive: true });
  const name = "temp";
  fs.writeFileSync(path.join(workflowDir, `${name}.workflow.json`), content, "utf-8");
  return { cwd: dir, name };
}

describe("loadWorkflowConfig", () => {
  it("throws on invalid JSON", () => {
    const { cwd, name } = setupTempConfig("{ invalid json }");
    expect(() => loadWorkflowConfig(cwd, name)).toThrow();
  });

  it("throws on schema mismatch", () => {
    const { cwd, name } = setupTempConfig(JSON.stringify({ name: "x" }));
    expect(() => loadWorkflowConfig(cwd, name)).toThrow();
  });

  it("loads valid config", () => {
    const config = {
      name: "temp",
      goal: "test",
      parallelism: 1,
      agents: { pm: "pm", developer: "dev", verifier: "ver" },
      waveSource: { type: "static", staticWaves: [{ goal: "g", tasks: [] }] },
      taskFlow: { stages: [{ id: "develop", agent: "dev", inputTemplate: "x", outputSchema: {} }] },
    };
    const { cwd, name } = setupTempConfig(JSON.stringify(config));
    const loaded = loadWorkflowConfig(cwd, name);
    expect(loaded.config.name).toBe("temp");
    expect(loaded.config.parallelism).toBe(1);
    expect(loaded.config.agentRetry).toEqual({
      maxAttempts: 5,
      initialDelayMs: 5000,
      maxDelayMs: 120000,
      backoffMultiplier: 2,
      jitterMs: 1000,
    });
    expect(loaded.config.taskFlow.memory?.keepDeveloperMemory).toBe(true);
    expect(loaded.config.taskFlow.memory?.keepVerifierMemoryOnDeveloperFailure).toBe(true);
    expect(loaded.config.taskFlow.memory?.verifierSelfFailureMemory).toBe("keep");
  });

  it("loads custom agent retry policy", () => {
    const config = {
      name: "temp",
      goal: "test",
      agentRetry: {
        maxAttempts: 2,
        initialDelayMs: 10,
        maxDelayMs: 100,
        backoffMultiplier: 3,
        jitterMs: 0,
      },
      agents: { pm: "pm", developer: "dev", verifier: "ver" },
      waveSource: { type: "static", staticWaves: [{ goal: "g", tasks: [] }] },
      taskFlow: { stages: [{ id: "develop", agent: "dev", inputTemplate: "x", outputSchema: {} }] },
    };
    const { cwd, name } = setupTempConfig(JSON.stringify(config));
    const loaded = loadWorkflowConfig(cwd, name);
    expect(loaded.config.agentRetry).toEqual(config.agentRetry);
  });

  it("loads custom task memory policy", () => {
    const config = {
      name: "temp",
      goal: "test",
      agents: { pm: "pm", developer: "dev", verifier: "ver" },
      waveSource: { type: "static", staticWaves: [{ goal: "g", tasks: [] }] },
      taskFlow: {
        memory: {
          keepDeveloperMemory: false,
          keepVerifierMemoryOnDeveloperFailure: false,
          verifierSelfFailureMemory: "keep",
        },
        stages: [{ id: "develop", agent: "dev", inputTemplate: "x", outputSchema: {} }],
      },
    };
    const { cwd, name } = setupTempConfig(JSON.stringify(config));
    const loaded = loadWorkflowConfig(cwd, name);
    expect(loaded.config.taskFlow.memory?.keepDeveloperMemory).toBe(false);
    expect(loaded.config.taskFlow.memory?.keepVerifierMemoryOnDeveloperFailure).toBe(false);
    expect(loaded.config.taskFlow.memory?.verifierSelfFailureMemory).toBe("keep");
  });

  it("accepts requirements and per-agent extensions", () => {
    const config = {
      name: "temp",
      goal: "test",
      agents: { pm: "pm", developer: "dev", verifier: "ver" },
      allowedExtensionsByAgent: { pm: ["/ext/pm.ts"], developer: [], verifier: [] },
      waveSource: {
        type: "static",
        staticWaves: [
          {
            goal: "g",
            tasks: [
              {
                id: "T1",
                title: "Task",
                description: "Do the thing",
                requirements: "Verify the thing",
                assignee: "developer",
              },
            ],
          },
        ],
      },
      taskFlow: { stages: [{ id: "develop", agent: "dev", inputTemplate: "x", outputSchema: {} }] },
    };
    const { cwd, name } = setupTempConfig(JSON.stringify(config));
    const loaded = loadWorkflowConfig(cwd, name);
    const task = loaded.config.waveSource.staticWaves?.[0].tasks[0];
    expect(task?.requirements).toBe("Verify the thing");
    expect(loaded.config.allowedExtensionsByAgent?.pm?.[0]).toBe("/ext/pm.ts");
  });
});
