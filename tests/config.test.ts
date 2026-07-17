import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadWorkflowConfig } from "../.pi/extensions/workflow-orchestrator/config.js";

function setup(content: unknown, name = "temp"): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-config-test-"));
  const directory = path.join(cwd, ".pi", "workflows");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${name}.workflow.json`),
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return cwd;
}

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: "temp",
    goal: "Build the feature",
    agents: { pm: "pm", developer: "developer", verifier: "verifier" },
    waveSource: { type: "static", staticWaves: [] },
    taskFlow: {
      stages: [
        { id: "develop", agent: "developer", inputTemplate: "Implement {{task.title}}" },
        {
          id: "verify",
          agent: "verifier",
          inputTemplate: "Verify {{task.title}}",
          transitions: [
            { when: { field: "status", equals: "fail" }, next: "develop" },
            { when: { field: "status", equals: "pass" }, next: "complete" },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe("loadWorkflowConfig", () => {
  it("throws on invalid JSON and schema mismatch", () => {
    const invalidJson = setup("{ invalid json }");
    expect(() => loadWorkflowConfig(invalidJson, "temp")).toThrow("Invalid JSON");

    const invalidSchema = setup({ name: "temp" });
    expect(() => loadWorkflowConfig(invalidSchema, "temp")).toThrow("schema validation");
  });

  it("loads a valid config and applies defaults", () => {
    const cwd = setup(validConfig());
    const config = loadWorkflowConfig(cwd, "temp").config;
    expect(config.name).toBe("temp");
    expect(config.piCommand).toBe("pi");
    expect(config.maxWaves).toBe(10);
    expect(config.maxTaskRetries).toBe(2);
    expect(config.maxPmRetries).toBe(3);
    expect(config.parallelism).toBe(1);
    expect(config.taskFlow.memory?.keepDeveloperMemory).toBe(true);
  });

  it("rejects the removed agentRetry setting with migration guidance", () => {
    const cwd = setup(validConfig({ agentRetry: { maxAttempts: 2 } }));
    expect(() => loadWorkflowConfig(cwd, "temp")).toThrow("agentRetry was removed");
  });

  it("loads custom task memory policy", () => {
    const cwd = setup(
      validConfig({
        taskFlow: {
          stages: validConfig().taskFlow.stages,
          memory: {
            keepDeveloperMemory: false,
            keepVerifierMemoryOnDeveloperFailure: false,
            verifierSelfFailureMemory: "reset_on_malformed_output",
          },
        },
      }),
    );
    const memory = loadWorkflowConfig(cwd, "temp").config.taskFlow.memory;
    expect(memory).toEqual({
      keepDeveloperMemory: false,
      keepVerifierMemoryOnDeveloperFailure: false,
      verifierSelfFailureMemory: "reset_on_malformed_output",
    });
  });

  it("accepts requirements and per-agent extensions", () => {
    const cwd = setup(
      validConfig({
        allowedExtensionsByAgent: { pm: ["/pm.ts"], developer: ["/dev.ts"], verifier: [] },
        waveSource: {
          type: "static",
          staticWaves: [
            {
              goal: "Implement",
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
      }),
    );
    const config = loadWorkflowConfig(cwd, "temp").config;
    expect(config.waveSource.staticWaves?.[0].tasks[0].requirements).toBe("Verify the thing");
    expect(config.allowedExtensionsByAgent?.pm).toEqual(["/pm.ts"]);
  });

  it("rejects unsafe workflow names", () => {
    const cwd = setup(validConfig(), "temp");
    expect(() => loadWorkflowConfig(cwd, "../escape")).toThrow("Invalid workflow name");
    expect(() => loadWorkflowConfig(cwd, "")).toThrow("Workflow name is required");
    expect(() => loadWorkflowConfig(cwd, "a".repeat(65))).toThrow("too long");
  });

  it("requires exactly the develop and verify semantic stages", () => {
    const cwd = setup(
      validConfig({
        taskFlow: {
          stages: [{ id: "plan", agent: "developer", inputTemplate: "x" }],
        },
      }),
    );
    expect(() => loadWorkflowConfig(cwd, "temp")).toThrow("schema validation");
  });

  it("validates transition targets and configured agents", () => {
    const unknownTransition = setup(
      validConfig({
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
      }),
    );
    expect(() => loadWorkflowConfig(unknownTransition, "temp")).toThrow("unknown stage");

    const unknownAgent = setup(
      validConfig({
        taskFlow: {
          stages: [
            { id: "develop", agent: "missing", inputTemplate: "x" },
            { id: "verify", agent: "verifier", inputTemplate: "x" },
          ],
        },
      }),
    );
    expect(() => loadWorkflowConfig(unknownAgent, "temp")).toThrow("unknown agent");
  });

  it("rejects duplicate or incomplete static tasks", () => {
    const cwd = setup(
      validConfig({
        waveSource: {
          type: "static",
          staticWaves: [
            {
              goal: "Wave",
              tasks: [
                { id: "T1", title: "One", description: "Do one", requirements: "Verify one" },
                { id: "T1", title: "Two", description: "Do two", requirements: "Verify two" },
              ],
            },
          ],
        },
      }),
    );
    expect(() => loadWorkflowConfig(cwd, "temp")).toThrow("duplicate task id");

    const incomplete = setup(
      validConfig({
        waveSource: {
          type: "static",
          staticWaves: [
            { goal: "Wave", tasks: [{ id: "T1", title: "One", description: "Do one" }] },
          ],
        },
      }),
    );
    expect(() => loadWorkflowConfig(incomplete, "temp")).toThrow("schema validation");
  });

  it("requires positive integer limits", () => {
    for (const field of ["maxWaves", "maxPmRetries", "parallelism"]) {
      const cwd = setup(validConfig({ [field]: 0 }));
      expect(() => loadWorkflowConfig(cwd, "temp")).toThrow();
    }
    const retries = setup(validConfig({ maxTaskRetries: -1 }));
    expect(() => loadWorkflowConfig(retries, "temp")).toThrow();
  });
});
