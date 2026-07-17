import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_RPC_TIMEOUTS,
  RpcAgent,
  parsePiVersion,
  preflightPiExecutable,
  selectStructuredToolResult,
} from "../.pi/extensions/workflow-orchestrator/runner.js";

const fixture = path.resolve("tests/fixtures/fake-pi.mjs");
const children: RpcAgent[] = [];

function makeAgent(scenario: string, extraEnv: Record<string, string> = {}): RpcAgent {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piorch-rpc-test-"));
  const original = { ...process.env };
  for (const [key, value] of Object.entries({ PIORCH_FAKE_PI_SCENARIO: scenario, ...extraEnv })) {
    process.env[key] = value;
  }
  const agent = new RpcAgent({
    piCommand: fixture,
    cwd: directory,
    sessionFile: path.join(directory, "session.jsonl"),
    systemPrompt: "",
    startupTimeoutMs: 500,
    commandTimeoutMs: 500,
    runTimeoutMs: 500,
    abortGraceMs: 50,
    killGraceMs: 50,
  });
  children.push(agent);
  (agent as unknown as { __restoreEnv: () => void }).__restoreEnv = () => {
    process.env = original;
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return agent;
}

afterEach(() => {
  for (const agent of children.splice(0)) {
    agent.dispose();
    (agent as unknown as { __restoreEnv?: () => void }).__restoreEnv?.();
  }
});

describe("Pi version preflight", () => {
  it("parses numeric versions from command output", () => {
    expect(parsePiVersion("pi 0.80.10\n")).toBe("0.80.10");
    expect(parsePiVersion("no version here")).toBeUndefined();
  });

  it("accepts the supported fake executable", async () => {
    const info = await preflightPiExecutable(fixture, process.cwd());
    expect(info.version).toBe("0.80.10");
  });

  it("rejects an unsupported executable version", async () => {
    process.env.PIORCH_FAKE_PI_VERSION = "0.79.9";
    await expect(preflightPiExecutable(fixture, process.cwd())).rejects.toThrow("Unsupported Pi");
    delete process.env.PIORCH_FAKE_PI_VERSION;
  });
});

describe("PiRpcProcess protocol", () => {
  it("performs readiness and resolves only after agent_settled", async () => {
    const agent = makeAgent("agent-end-before-settled");
    const start = Date.now();
    const result = await agent.runPrompt("run");
    expect(Date.now() - start).toBeGreaterThanOrEqual(35);
    expect(result.lifecycleEvents).toContain("agent_settled");
  });

  it("rejects a prompt accepted by Pi as unsuccessful", async () => {
    const agent = makeAgent("reject-prompt");
    await expect(agent.runPrompt("run")).rejects.toThrow("rejected command");
  });

  it("fails when Pi exits before readiness", async () => {
    const agent = makeAgent("exit-before-ready");
    await expect(agent.runPrompt("run")).rejects.toThrow("exited before RPC completion");
  });

  it("reports a spawn error for a missing executable", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piorch-rpc-missing-"));
    const agent = new RpcAgent({
      piCommand: path.join(directory, "missing-pi"),
      cwd: directory,
      sessionFile: path.join(directory, "session.jsonl"),
      systemPrompt: "",
      startupTimeoutMs: 500,
      commandTimeoutMs: 500,
      runTimeoutMs: 500,
      abortGraceMs: 50,
      killGraceMs: 50,
    });
    children.push(agent);
    await expect(agent.runPrompt("run")).rejects.toThrow("Pi process error");
  });

  it("treats unknown response IDs as fatal protocol errors", async () => {
    const agent = makeAgent("unknown-response");
    await expect(agent.runPrompt("run")).rejects.toThrow("unknown or duplicate id");
  });

  it("handles UTF-8 split across stdout chunks and CRLF records", async () => {
    const utf8Agent = makeAgent("utf8-split");
    const utf8Result = await utf8Agent.runPrompt("run");
    expect(utf8Result.outputText).toContain("✓");

    const crlfAgent = makeAgent("crlf");
    await expect(crlfAgent.runPrompt("run")).resolves.toBeDefined();
  });

  it("fails malformed, oversized, and partial JSONL", async () => {
    await expect(makeAgent("malformed").runPrompt("run")).rejects.toThrow("Malformed RPC JSONL");
    await expect(makeAgent("oversized").runPrompt("run")).rejects.toThrow("exceeds");
    await expect(makeAgent("partial-final").runPrompt("run")).rejects.toThrow("partial final");
  });

  it("correlates successful, failed, and corrected tool executions", async () => {
    const failed = await makeAgent("failed-tool").runPrompt("run");
    expect(failed.failedToolExecutions).toHaveLength(1);
    expect(() => selectStructuredToolResult(failed, "report_task_result")).toThrow("No successful");

    const corrected = await makeAgent("corrected-tool").runPrompt("run");
    const selected = selectStructuredToolResult(corrected, "report_task_result");
    expect(selected.execution.toolCallId).toBe("success");
  });

  it("rejects ambiguous reports and malformed tool lifecycle", async () => {
    await expect(
      (async () =>
        selectStructuredToolResult(
          await makeAgent("duplicate-success").runPrompt("run"),
          "report_task_result",
        ))(),
    ).rejects.toThrow("Ambiguous");
    await expect(makeAgent("end-without-start").runPrompt("run")).rejects.toThrow("without start");
    await expect(makeAgent("duplicate-start").runPrompt("run")).rejects.toThrow(
      "duplicate tool execution start",
    );
  });

  it("lets Pi auto-retry settle the same accepted prompt", async () => {
    const result = await makeAgent("retry").runPrompt("run");
    expect(result.lifecycleEvents).toContain("auto_retry_end:success");
    expect(result.successfulToolExecutions).toHaveLength(1);
  });

  it("times out a run with bounded diagnostics", async () => {
    const agent = makeAgent("run-timeout");
    await expect(agent.runPrompt("run")).rejects.toThrow("RPC run timed out");
    expect(agent.getStderr().length).toBeLessThanOrEqual(DEFAULT_RPC_TIMEOUTS.maxStderrBytes);
  });

  it("uses correlated steer and abort commands", async () => {
    const agent = makeAgent("run-timeout");
    const prompt = agent.runPrompt("run");
    for (let attempt = 0; attempt < 20 && !agent.isRunning(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(agent.isRunning()).toBe(true);
    await agent.sendSteer("continue");
    await agent.abort();
    await expect(prompt).rejects.toThrow();
  });

  it("escalates an abort that does not receive a response", async () => {
    const agent = makeAgent("abort-timeout");
    const prompt = agent.runPrompt("run");
    for (let attempt = 0; attempt < 20 && !agent.isRunning(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await agent.abort();
    await expect(prompt).rejects.toThrow();
  });
});
