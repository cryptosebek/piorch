import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseWorkflowShorthandGoal,
  parseWorkflowStartArgs,
  tokenizeWorkflowArgs,
} from "../.pi/extensions/workflow-orchestrator/commands.js";
import {
  materializeProjectDefaults,
  getPackagePiRoot,
  resolveExtensionPath,
  resolveWorkflowPath,
} from "../.pi/extensions/workflow-orchestrator/setup.js";
import { loadWorkflowConfig } from "../.pi/extensions/workflow-orchestrator/config.js";

describe("setup.ts", () => {
  it("resolves package .pi root from extension location", () => {
    const root = getPackagePiRoot();
    expect(fs.existsSync(path.join(root, "workflows", "default.workflow.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "agents", "pm.md"))).toBe(true);
  });

  it("resolves default workflow from package when project has no config", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-setup-test-"));
    const workflowPath = resolveWorkflowPath(cwd, "default");

    expect(workflowPath).toBe(path.join(getPackagePiRoot(), "workflows", "default.workflow.json"));
    materializeProjectDefaults(cwd);
    expect(loadWorkflowConfig(cwd, "default").config.name).toBe("default");

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("prefers project workflow over package default", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-setup-test-"));
    const workflowDir = path.join(cwd, ".pi", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, "default.workflow.json"),
      JSON.stringify({
        name: "default",
        goal: "project override",
        agents: { pm: "pm", developer: "developer", verifier: "verifier" },
        waveSource: {
          type: "static",
          staticWaves: [
            {
              goal: "g",
              tasks: [
                {
                  id: "T1",
                  title: "Task",
                  description: "Complete the task",
                  requirements: "The task is complete",
                },
              ],
            },
          ],
        },
        taskFlow: {
          stages: [
            { id: "develop", agent: "developer", inputTemplate: "x" },
            { id: "verify", agent: "verifier", inputTemplate: "x" },
          ],
        },
      }),
      "utf-8",
    );

    expect(resolveWorkflowPath(cwd, "default")).toBe(
      path.join(workflowDir, "default.workflow.json"),
    );
    expect(loadWorkflowConfig(cwd, "default").config.goal).toBe("project override");

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("resolves package extensions from a .pi-prefixed path without basename heuristics", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-setup-test-"));
    const resolved = resolveExtensionPath(cwd, "./.pi/extensions/workflow-pm-tools/index.ts");

    expect(resolved).toBe(
      path.join(getPackagePiRoot(), "extensions", "workflow-pm-tools", "index.ts"),
    );

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("materializes editable defaults on first use", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-setup-test-"));
    const created = materializeProjectDefaults(cwd);

    expect(created).toContain(".pi/workflows");
    expect(created).toContain(".pi/agents");
    expect(fs.existsSync(path.join(cwd, ".pi", "workflows", "default.workflow.json"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".pi", "agents", "pm.md"))).toBe(true);
    expect(materializeProjectDefaults(cwd)).toEqual([]);

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("fills missing defaults inside existing project directories", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-setup-test-"));
    fs.mkdirSync(path.join(cwd, ".pi", "workflows"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });

    const created = materializeProjectDefaults(cwd);

    expect(created).toEqual(expect.arrayContaining([".pi/workflows", ".pi/agents"]));
    expect(fs.existsSync(path.join(cwd, ".pi", "workflows", "default.workflow.json"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".pi", "agents", "pm.md"))).toBe(true);

    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("commands.ts", () => {
  it("parses shorthand start with goal only", () => {
    expect(parseWorkflowStartArgs(["start", "Build a bot"])).toEqual({
      workflowName: "default",
      goal: "Build a bot",
    });
  });

  it("parses explicit workflow name and goal", () => {
    expect(parseWorkflowStartArgs(["start", "custom", "Build a bot"])).toEqual({
      workflowName: "custom",
      goal: "Build a bot",
    });
  });

  it("treats broken quoted goals as default workflow goals", () => {
    expect(parseWorkflowStartArgs(["start", '"build', 'something"'])).toEqual({
      workflowName: "default",
      goal: "build something",
    });
  });

  it("starts a named workflow without a goal override", () => {
    expect(parseWorkflowStartArgs(["start", "default"])).toEqual({
      workflowName: "default",
      goal: undefined,
    });
  });

  it("parses quoted shorthand goals", () => {
    expect(parseWorkflowShorthandGoal(["Build a bot"])).toEqual({ goal: "Build a bot" });
    expect(parseWorkflowShorthandGoal(['"Build a bot"'])).toEqual({ goal: "Build a bot" });
  });

  it("parses model flag in shorthand goals", () => {
    expect(
      parseWorkflowShorthandGoal(["--model", "google/gemini-2.0-flash", "Build a bot"]),
    ).toEqual({
      model: "google/gemini-2.0-flash",
      goal: "Build a bot",
    });
  });

  it("keeps model-like text inside a quoted goal", () => {
    expect(tokenizeWorkflowArgs('"support --model locally"')).toEqual(["support --model locally"]);
    expect(parseWorkflowShorthandGoal(tokenizeWorkflowArgs('"support --model locally"'))).toEqual({
      goal: "support --model locally",
    });
  });

  it("normalizes a quoted model flag value", () => {
    expect(
      parseWorkflowShorthandGoal(tokenizeWorkflowArgs('--model "google/gemini-2.0-flash" Build')),
    ).toEqual({
      model: "google/gemini-2.0-flash",
      goal: "Build",
    });
  });

  it("does not treat a missing model value as a goal", () => {
    expect(parseWorkflowShorthandGoal(tokenizeWorkflowArgs("--model"))).toEqual({
      model: undefined,
      goal: undefined,
    });
  });
});
