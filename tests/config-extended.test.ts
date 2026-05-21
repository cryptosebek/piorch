import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadWorkflowConfig } from "../.pi/extensions/workflow-orchestrator/config.js";

describe("config.ts - additional coverage", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createWorkflowConfig(name: string, content: string): string {
    const workflowDir = path.join(tempDir, ".pi", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    const workflowPath = path.join(workflowDir, `${name}.workflow.json`);
    fs.writeFileSync(workflowPath, content);
    return workflowPath;
  }

  describe("sanitizeWorkflowName", () => {
    it("rejects empty name", () => {
      createWorkflowConfig("", JSON.stringify({}));
      expect(() => loadWorkflowConfig(tempDir, "")).toThrow("name is required");
    });

    it("rejects name with invalid characters", () => {
      createWorkflowConfig("my@workflow", JSON.stringify({}));
      expect(() => loadWorkflowConfig(tempDir, "my@workflow")).toThrow("Invalid workflow name");
    });

    it("rejects name with spaces", () => {
      createWorkflowConfig("my workflow", JSON.stringify({}));
      expect(() => loadWorkflowConfig(tempDir, "my workflow")).toThrow("Invalid workflow name");
    });

    it("rejects name that is too long", () => {
      const longName = "a".repeat(51);
      createWorkflowConfig(longName, JSON.stringify({}));
      expect(() => loadWorkflowConfig(tempDir, longName)).toThrow("too long");
    });

    it("accepts valid name with dash", () => {
      const config = {
        name: "my-workflow",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("my-workflow", JSON.stringify(config));
      expect(() => loadWorkflowConfig(tempDir, "my-workflow")).not.toThrow();
    });

    it("accepts valid name with underscore", () => {
      const config = {
        name: "my_workflow",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("my_workflow", JSON.stringify(config));
      expect(() => loadWorkflowConfig(tempDir, "my_workflow")).not.toThrow();
    });

    it("accepts name with numbers", () => {
      const config = {
        name: "workflow123",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("workflow123", JSON.stringify(config));
      expect(() => loadWorkflowConfig(tempDir, "workflow123")).not.toThrow();
    });
  });

  describe("workflow validation", () => {
    it("validates required fields", () => {
      const config = {
        name: "test",
        // Missing goal
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      expect(() => loadWorkflowConfig(tempDir, "test")).toThrow();
    });

    it("validates agents configuration", () => {
      const config = {
        name: "test",
        goal: "test",
        // Missing agents
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      expect(() => loadWorkflowConfig(tempDir, "test")).toThrow();
    });

    it("validates waveSource configuration", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        // Missing waveSource
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      expect(() => loadWorkflowConfig(tempDir, "test")).toThrow();
    });

    it("validates taskFlow configuration", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        // Missing taskFlow
      };
      createWorkflowConfig("test", JSON.stringify(config));
      expect(() => loadWorkflowConfig(tempDir, "test")).toThrow();
    });

    it("validates stage configuration", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: {
          stages: [
            {
              // Missing required fields
              id: "s1",
              // Missing agent, inputTemplate, outputSchema
            },
          ],
        },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      expect(() => loadWorkflowConfig(tempDir, "test")).toThrow();
    });
  });

  describe("parallelism validation", () => {
    it("rejects parallelism less than 1", () => {
      const config = {
        name: "test",
        goal: "test",
        parallelism: 0,
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      expect(() => loadWorkflowConfig(tempDir, "test")).toThrow("parallelism must be at least 1");
    });

    it("accepts parallelism of 1", () => {
      const config = {
        name: "test",
        goal: "test",
        parallelism: 1,
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      expect(() => loadWorkflowConfig(tempDir, "test")).not.toThrow();
    });

    it("accepts high parallelism", () => {
      const config = {
        name: "test",
        goal: "test",
        parallelism: 10,
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.parallelism).toBe(10);
    });
  });

  describe("transitions validation", () => {
    it("accepts valid transitions", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: {
          stages: [
            {
              id: "develop",
              agent: "dev",
              inputTemplate: "t",
              outputSchema: {},
              transitions: [
                { when: { field: "status", equals: "fail" }, next: "develop" },
                { when: { field: "status", equals: "pass" }, next: "complete" },
              ],
            },
          ],
        },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.taskFlow.stages[0].transitions).toHaveLength(2);
    });

    it("accepts stages without transitions", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: {
          stages: [
            {
              id: "develop",
              agent: "dev",
              inputTemplate: "t",
              outputSchema: {},
              // No transitions
            },
          ],
        },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.taskFlow.stages[0].transitions).toBeUndefined();
    });
  });

  describe("task memory configuration", () => {
    it("accepts memory configuration values", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: {
          memory: {
            keepDeveloperMemory: false,
            keepVerifierMemoryOnDeveloperFailure: false,
            verifierSelfFailureMemory: "reset",
          },
          stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }],
        },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.taskFlow.memory?.keepDeveloperMemory).toBe(false);
      expect(loaded.config.taskFlow.memory?.keepVerifierMemoryOnDeveloperFailure).toBe(false);
      expect(loaded.config.taskFlow.memory?.verifierSelfFailureMemory).toBe("reset");
    });

    it("rejects invalid verifierSelfFailureMemory values", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: {
          memory: {
            verifierSelfFailureMemory: "invalid",
          },
          stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }],
        },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      expect(() => loadWorkflowConfig(tempDir, "test")).toThrow();
    });
  });

  describe("task validation", () => {
    it("accepts task with requirements", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: {
          type: "static",
          staticWaves: [
            {
              goal: "wave",
              tasks: [
                {
                  id: "T1",
                  title: "Task",
                  description: "Do it",
                  requirements: "Must pass tests",
                  assignee: "developer",
                },
              ],
            },
          ],
        },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      const task = loaded.config.waveSource.staticWaves?.[0].tasks[0];
      expect(task?.requirements).toBe("Must pass tests");
    });

    it("accepts task without requirements", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: {
          type: "static",
          staticWaves: [
            {
              goal: "wave",
              tasks: [
                {
                  id: "T1",
                  title: "Task",
                  description: "Do it",
                  // No requirements
                },
              ],
            },
          ],
        },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      const task = loaded.config.waveSource.staticWaves?.[0].tasks[0];
      expect(task?.requirements).toBeUndefined();
    });

    it("accepts task without assignee", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: {
          type: "static",
          staticWaves: [
            {
              goal: "wave",
              tasks: [
                {
                  id: "T1",
                  title: "Task",
                  description: "Do it",
                  // No assignee
                },
              ],
            },
          ],
        },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      const task = loaded.config.waveSource.staticWaves?.[0].tasks[0];
      expect(task?.assignee).toBeUndefined();
    });
  });

  describe("allowedExtensions", () => {
    it("accepts global allowedExtensions", () => {
      const config = {
        name: "test",
        goal: "test",
        allowedExtensions: ["/path/to/ext.ts"],
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.allowedExtensions).toEqual(["/path/to/ext.ts"]);
    });

    it("accepts per-agent allowedExtensions", () => {
      const config = {
        name: "test",
        goal: "test",
        allowedExtensionsByAgent: {
          pm: ["/pm-ext.ts"],
          developer: ["/dev-ext.ts"],
          verifier: ["/ver-ext.ts"],
        },
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.allowedExtensionsByAgent?.pm).toEqual(["/pm-ext.ts"]);
      expect(loaded.config.allowedExtensionsByAgent?.developer).toEqual(["/dev-ext.ts"]);
      expect(loaded.config.allowedExtensionsByAgent?.verifier).toEqual(["/ver-ext.ts"]);
    });

    it("accepts both global and per-agent allowedExtensions", () => {
      const config = {
        name: "test",
        goal: "test",
        allowedExtensions: ["/global-ext.ts"],
        allowedExtensionsByAgent: {
          pm: ["/pm-ext.ts"],
          developer: [],
          verifier: [],
        },
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.allowedExtensions).toEqual(["/global-ext.ts"]);
      expect(loaded.config.allowedExtensionsByAgent).toBeDefined();
    });
  });

  describe("maxWaves and maxTaskRetries", () => {
    it("applies default maxWaves", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.maxWaves).toBe(10);
    });

    it("applies custom maxWaves", () => {
      const config = {
        name: "test",
        goal: "test",
        maxWaves: 5,
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.maxWaves).toBe(5);
    });

    it("applies default maxTaskRetries", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.maxTaskRetries).toBe(2);
    });

    it("applies custom maxTaskRetries", () => {
      const config = {
        name: "test",
        goal: "test",
        maxTaskRetries: 5,
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.maxTaskRetries).toBe(5);
    });
  });

  describe("waveSource types", () => {
    it("accepts pm waveSource type", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "pm" },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.waveSource.type).toBe("pm");
    });

    it("accepts static waveSource type", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: {
          type: "static",
          staticWaves: [
            { goal: "wave1", tasks: [] },
            { goal: "wave2", tasks: [] },
          ],
        },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      const loaded = loadWorkflowConfig(tempDir, "test");
      expect(loaded.config.waveSource.type).toBe("static");
      expect(loaded.config.waveSource.staticWaves).toHaveLength(2);
    });

    it("rejects invalid waveSource type", () => {
      const config = {
        name: "test",
        goal: "test",
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "invalid" },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
      createWorkflowConfig("test", JSON.stringify(config));
      expect(() => loadWorkflowConfig(tempDir, "test")).toThrow();
    });
  });

  describe("file not found", () => {
    it("throws when workflow file does not exist", () => {
      expect(() => loadWorkflowConfig(tempDir, "nonexistent")).toThrow("Workflow not found");
    });
  });

  describe("agent retry validation", () => {
    function baseConfig(agentRetry: Record<string, number>) {
      return {
        name: "test",
        goal: "test",
        agentRetry,
        agents: { pm: "pm", developer: "dev", verifier: "ver" },
        waveSource: { type: "static", staticWaves: [] },
        taskFlow: { stages: [{ id: "s1", agent: "dev", inputTemplate: "t", outputSchema: {} }] },
      };
    }

    it("rejects maxAttempts less than 1", () => {
      createWorkflowConfig("test", JSON.stringify(baseConfig({ maxAttempts: 0 })));
      expect(() => loadWorkflowConfig(tempDir, "test")).toThrow(
        "agentRetry.maxAttempts must be at least 1",
      );
    });

    it("rejects negative delays and jitter", () => {
      createWorkflowConfig(
        "test",
        JSON.stringify(
          baseConfig({
            initialDelayMs: -1,
            maxDelayMs: -1,
            jitterMs: -1,
          }),
        ),
      );
      expect(() => loadWorkflowConfig(tempDir, "test")).toThrow(
        "agentRetry.initialDelayMs must be at least 0",
      );
    });

    it("rejects backoffMultiplier less than 1", () => {
      createWorkflowConfig("test", JSON.stringify(baseConfig({ backoffMultiplier: 0 })));
      expect(() => loadWorkflowConfig(tempDir, "test")).toThrow(
        "agentRetry.backoffMultiplier must be at least 1",
      );
    });
  });
});
