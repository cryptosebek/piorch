import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findProjectRoot,
  getSubagentEnv,
  loadProjectEnv,
} from "../.pi/extensions/workflow-orchestrator/env.js";

describe("workflow env", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
    delete process.env.PIORCH_ENV_TEST;
  });

  it("finds project root via .pi/agents", () => {
    const root = path.join(os.tmpdir(), `piorch-env-${Date.now()}`);
    fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
    tempDirs.push(root);

    const nested = path.join(root, "src", "deep");
    fs.mkdirSync(nested, { recursive: true });

    expect(findProjectRoot(nested)).toBe(root);
  });

  it("loads .env from project root into subagent env", () => {
    const root = path.join(os.tmpdir(), `piorch-env-${Date.now()}`);
    fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "PIORCH_ENV_TEST=from-dotenv\n");
    tempDirs.push(root);

    delete process.env.PIORCH_ENV_TEST;
    const env = getSubagentEnv(root);
    expect(env.PIORCH_ENV_TEST).toBe("from-dotenv");
  });

  it("does not override existing process.env values", () => {
    const root = path.join(os.tmpdir(), `piorch-env-${Date.now()}`);
    fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "PIORCH_ENV_TEST=from-dotenv\n");
    tempDirs.push(root);

    process.env.PIORCH_ENV_TEST = "from-shell";
    loadProjectEnv(root);
    expect(process.env.PIORCH_ENV_TEST).toBe("from-shell");
  });
});
