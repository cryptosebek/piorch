import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadWorkflowConfig } from "../.pi/extensions/workflow-orchestrator/config.js";

function writeConfig(config: Record<string, unknown>, name = "temp"): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-config-extended-"));
  const directory = path.join(cwd, ".pi", "workflows");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.workflow.json`), JSON.stringify(config));
  return cwd;
}

function stageConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: "temp",
    goal: "test",
    agents: { pm: "pm", developer: "developer", verifier: "verifier" },
    waveSource: { type: "static", staticWaves: [] },
    taskFlow: {
      stages: [
        { id: "develop", agent: "developer", inputTemplate: "Implement {{task.title}}" },
        { id: "verify", agent: "verifier", inputTemplate: "Verify {{task.title}}" },
      ],
    },
    ...overrides,
  };
}

function task(id = "T1") {
  return {
    id,
    title: "Task",
    description: "Do the task",
    requirements: "Run verification",
    assignee: "developer",
  };
}

describe("config.ts extended coverage", () => {
  it("accepts safe workflow identifiers and rejects unsafe names", () => {
    for (const name of ["my-workflow", "my_workflow", "workflow123"]) {
      const cwd = writeConfig({ ...stageConfig(), name }, name);
      expect(loadWorkflowConfig(cwd, name).config.name).toBe(name);
    }
    const cwd = writeConfig(stageConfig());
    expect(() => loadWorkflowConfig(cwd, "my workflow")).toThrow("Invalid workflow name");
    expect(() => loadWorkflowConfig(cwd, "a".repeat(65))).toThrow("too long");
  });

  it("rejects missing required configuration sections", () => {
    for (const invalid of [
      { name: "temp" },
      { ...stageConfig(), agents: undefined },
      { ...stageConfig(), waveSource: undefined },
      { ...stageConfig(), taskFlow: undefined },
    ]) {
      const cwd = writeConfig(invalid);
      expect(() => loadWorkflowConfig(cwd, "temp")).toThrow();
    }
  });

  it("validates parallelism and retry limits", () => {
    for (const field of ["parallelism", "maxWaves", "maxPmRetries"]) {
      const cwd = writeConfig({ ...stageConfig(), [field]: 0 });
      expect(() => loadWorkflowConfig(cwd, "temp")).toThrow();
    }
    const zeroTaskRetry = writeConfig({ ...stageConfig(), maxTaskRetries: 0 });
    expect(loadWorkflowConfig(zeroTaskRetry, "temp").config.maxTaskRetries).toBe(0);
    const negativeTaskRetry = writeConfig({ ...stageConfig(), maxTaskRetries: -1 });
    expect(() => loadWorkflowConfig(negativeTaskRetry, "temp")).toThrow();
  });

  it("validates semantic stage IDs and stage agent references", () => {
    const invalidId = writeConfig({
      ...stageConfig(),
      taskFlow: {
        stages: [
          { id: "plan", agent: "developer", inputTemplate: "x" },
          { id: "verify", agent: "verifier", inputTemplate: "x" },
        ],
      },
    });
    expect(() => loadWorkflowConfig(invalidId, "temp")).toThrow("schema validation");

    const missingAgent = writeConfig({
      ...stageConfig(),
      taskFlow: {
        stages: [
          { id: "develop", agent: "unknown", inputTemplate: "x" },
          { id: "verify", agent: "verifier", inputTemplate: "x" },
        ],
      },
    });
    expect(() => loadWorkflowConfig(missingAgent, "temp")).toThrow("unknown agent");
  });

  it("accepts transitions to complete or known stages", () => {
    const cwd = writeConfig({
      ...stageConfig(),
      taskFlow: {
        stages: [
          {
            id: "develop",
            agent: "developer",
            inputTemplate: "x",
            transitions: [{ when: { field: "status", equals: "done" }, next: "verify" }],
          },
          {
            id: "verify",
            agent: "verifier",
            inputTemplate: "x",
            transitions: [{ when: { field: "status", equals: "pass" }, next: "complete" }],
          },
        ],
      },
    });
    expect(loadWorkflowConfig(cwd, "temp").config.taskFlow.stages).toHaveLength(2);
  });

  it("rejects unknown transition targets", () => {
    const cwd = writeConfig({
      ...stageConfig(),
      taskFlow: {
        stages: [
          { id: "develop", agent: "developer", inputTemplate: "x" },
          {
            id: "verify",
            agent: "verifier",
            inputTemplate: "x",
            transitions: [{ when: { field: "status", equals: "pass" }, next: "missing" }],
          },
        ],
      },
    });
    expect(() => loadWorkflowConfig(cwd, "temp")).toThrow("unknown stage");
  });

  it("loads all memory policies", () => {
    const cwd = writeConfig({
      ...stageConfig(),
      taskFlow: {
        stages: stageConfig().taskFlow.stages,
        memory: {
          keepDeveloperMemory: false,
          keepVerifierMemoryOnDeveloperFailure: false,
          verifierSelfFailureMemory: "reset",
        },
      },
    });
    expect(loadWorkflowConfig(cwd, "temp").config.taskFlow.memory).toEqual({
      keepDeveloperMemory: false,
      keepVerifierMemoryOnDeveloperFailure: false,
      verifierSelfFailureMemory: "reset",
    });
  });

  it("rejects invalid memory policy values", () => {
    const cwd = writeConfig({
      ...stageConfig(),
      taskFlow: {
        stages: stageConfig().taskFlow.stages,
        memory: { verifierSelfFailureMemory: "invalid" },
      },
    });
    expect(() => loadWorkflowConfig(cwd, "temp")).toThrow("schema validation");
  });

  it("accepts complete static waves with requirements", () => {
    const cwd = writeConfig({
      ...stageConfig(),
      waveSource: { type: "static", staticWaves: [{ goal: "Wave", tasks: [task()] }] },
    });
    const loaded = loadWorkflowConfig(cwd, "temp").config;
    expect(loaded.waveSource.type).toBe("static");
    expect(loaded.waveSource.staticWaves?.[0].tasks[0].requirements).toBe("Run verification");
  });

  it("rejects duplicate, unsafe, and unassigned static tasks", () => {
    for (const tasks of [
      [task("T1"), task("T1")],
      [{ ...task(), id: "../escape" }],
      [{ ...task(), assignee: "verifier" }],
    ]) {
      const cwd = writeConfig({
        ...stageConfig(),
        waveSource: { type: "static", staticWaves: [{ goal: "Wave", tasks }] },
      });
      expect(() => loadWorkflowConfig(cwd, "temp")).toThrow();
    }
  });

  it("rejects static waves without tasks or requirements", () => {
    const empty = writeConfig({
      ...stageConfig(),
      waveSource: { type: "static", staticWaves: [{ goal: "Wave", tasks: [] }] },
    });
    expect(() => loadWorkflowConfig(empty, "temp")).toThrow("nonempty wave");

    const missing = writeConfig({
      ...stageConfig(),
      waveSource: {
        type: "static",
        staticWaves: [{ goal: "Wave", tasks: [{ id: "T1", title: "Task", description: "Do" }] }],
      },
    });
    expect(() => loadWorkflowConfig(missing, "temp")).toThrow("schema validation");
  });

  it("supports PM and static wave sources", () => {
    const pm = writeConfig({ ...stageConfig(), waveSource: { type: "pm" } });
    expect(loadWorkflowConfig(pm, "temp").config.waveSource.type).toBe("pm");

    const staticCwd = writeConfig({
      ...stageConfig(),
      waveSource: { type: "static", staticWaves: [{ goal: "Wave", tasks: [task()] }] },
    });
    expect(loadWorkflowConfig(staticCwd, "temp").config.waveSource.type).toBe("static");
  });

  it("loads global and per-agent extension allowlists", () => {
    const cwd = writeConfig({
      ...stageConfig(),
      allowedExtensions: ["/global.ts"],
      allowedExtensionsByAgent: {
        pm: ["/pm.ts"],
        developer: ["/developer.ts"],
        verifier: ["/verifier.ts"],
      },
    });
    const config = loadWorkflowConfig(cwd, "temp").config;
    expect(config.allowedExtensions).toEqual(["/global.ts"]);
    expect(config.allowedExtensionsByAgent?.verifier).toEqual(["/verifier.ts"]);
  });

  it("applies configured numeric limits", () => {
    const cwd = writeConfig({
      ...stageConfig(),
      maxWaves: 5,
      maxTaskRetries: 4,
      maxPmRetries: 2,
      parallelism: 10,
    });
    const config = loadWorkflowConfig(cwd, "temp").config;
    expect(config.maxWaves).toBe(5);
    expect(config.maxTaskRetries).toBe(4);
    expect(config.maxPmRetries).toBe(2);
    expect(config.parallelism).toBe(10);
  });

  it("rejects the removed agentRetry configuration", () => {
    const cwd = writeConfig({ ...stageConfig(), agentRetry: { maxAttempts: 2 } });
    expect(() => loadWorkflowConfig(cwd, "temp")).toThrow("agentRetry was removed");
  });

  it("rejects duplicate stage IDs through the schema", () => {
    const cwd = writeConfig({
      ...stageConfig(),
      taskFlow: {
        stages: [
          { id: "develop", agent: "developer", inputTemplate: "x" },
          { id: "develop", agent: "verifier", inputTemplate: "x" },
        ],
      },
    });
    expect(() => loadWorkflowConfig(cwd, "temp")).toThrow();
  });

  it("throws when the workflow file is absent", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-missing-"));
    expect(() => loadWorkflowConfig(cwd, "missing")).toThrow("Workflow not found");
  });
});
