import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getPackagePiRoot,
  materializeProjectDefaults,
  resolveExtensionPaths,
} from "../.pi/extensions/workflow-orchestrator/setup.js";
import { loadWorkflowConfig } from "../.pi/extensions/workflow-orchestrator/config.js";

describe("package installation", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piorch-package-setup-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("creates usable workflow and agent defaults in a new project", () => {
    materializeProjectDefaults(cwd);

    expect(loadWorkflowConfig(cwd, "default").config.name).toBe("default");
    for (const name of ["pm", "developer", "verifier"]) {
      expect(fs.existsSync(path.join(cwd, ".pi", "agents", `${name}.md`))).toBe(true);
    }
    expect(fs.readdirSync(path.join(cwd, ".pi", "workflows"))).toEqual(["default.workflow.json"]);
  });

  it("keeps customized files while filling missing defaults on repeated starts", () => {
    const agentsDir = path.join(cwd, ".pi", "agents");
    const workflowsDir = path.join(cwd, ".pi", "workflows");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "pm.md"), "my custom PM");
    fs.writeFileSync(path.join(workflowsDir, "default.workflow.json"), "my custom workflow");

    materializeProjectDefaults(cwd);
    materializeProjectDefaults(cwd);

    expect(fs.readFileSync(path.join(agentsDir, "pm.md"), "utf8")).toBe("my custom PM");
    expect(fs.readFileSync(path.join(workflowsDir, "default.workflow.json"), "utf8")).toBe(
      "my custom workflow",
    );
    expect(fs.existsSync(path.join(agentsDir, "developer.md"))).toBe(true);
  });

  it("uses project reporting extensions before package defaults and keeps the allowlist", () => {
    const extension = ".pi/extensions/workflow-pm-tools/index.ts";
    const bundled = path.join(getPackagePiRoot(), "extensions", "workflow-pm-tools", "index.ts");
    expect(resolveExtensionPaths(cwd, [extension])).toEqual([bundled]);

    const projectExtension = path.join(cwd, extension);
    fs.mkdirSync(path.dirname(projectExtension), { recursive: true });
    fs.writeFileSync(projectExtension, "project extension");
    expect(resolveExtensionPaths(cwd, [extension])).toEqual([projectExtension]);
    expect(resolveExtensionPaths(cwd, [projectExtension])).toEqual([projectExtension]);
    expect(resolveExtensionPaths(cwd, ["missing.ts"])).toEqual([path.join(cwd, "missing.ts")]);
    expect(resolveExtensionPaths(cwd, [])).toEqual([]);
    expect(resolveExtensionPaths(cwd, undefined)).toBeUndefined();
  });
});
