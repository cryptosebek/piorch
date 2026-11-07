import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import {
  RpcAgent,
  getAgentRetryDelayMs,
  isRetryableAgentError,
  normalizeAgentRetryOptions,
} from "../.pi/extensions/workflow-orchestrator/runner.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  writes: any[] = [];
  kill = vi.fn(() => true);

  constructor() {
    super();
    this.stdin.on("data", (chunk) => this.writes.push(JSON.parse(chunk.toString())));
  }

  emitEvent(event: unknown) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  finish(text = "done") {
    this.emitEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    this.emitEvent({ type: "agent_end" });
  }
}

describe("RpcAgent", () => {
  let processes: FakeProcess[];
  let agents: RpcAgent[];
  beforeEach(() => {
    processes = [];
    agents = [];
    vi.mocked(spawn).mockImplementation(() => {
      const proc = new FakeProcess();
      processes.push(proc);
      return proc as any;
    });
  });
  afterEach(() => {
    for (const agent of agents) agent.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });
  function createAgent() {
    const agent = new RpcAgent({
      cwd: process.cwd(),
      sessionFile: "unused.jsonl",
      systemPrompt: "",
      retry: { maxAttempts: 2, initialDelayMs: 20, maxDelayMs: 20, jitterMs: 0 },
    });
    agents.push(agent);
    return agent;
  }

  it("captures each successful tool execution once and excludes failed or unfinished calls", async () => {
    const agent = createAgent();
    const run = agent.runPrompt("verify");
    const proc = processes[0];
    const reports = [{ status: "pass" }, { status: "fail", issues: ["bug"] }];
    proc.emitEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "report_task_result", arguments: reports[0] }],
      },
    });
    reports.forEach((args, index) => {
      proc.emitEvent({
        type: "tool_execution_start",
        toolCallId: String(index),
        toolName: "report_task_result",
        args,
      });
      proc.emitEvent({
        type: "tool_execution_end",
        toolCallId: String(index),
        toolName: "report_task_result",
        isError: false,
      });
    });
    proc.emitEvent({
      type: "tool_execution_start",
      toolCallId: "bad",
      toolName: "report_task_result",
      args: { status: "pass", issues: "bad" },
    });
    proc.emitEvent({
      type: "tool_execution_end",
      toolCallId: "bad",
      toolName: "report_task_result",
      isError: true,
    });
    proc.emitEvent({
      type: "tool_execution_start",
      toolCallId: "unfinished",
      toolName: "generate_wave",
      args: { done: true },
    });
    proc.finish();
    await expect(run).resolves.toBe("done");
    expect(agent.getLastToolCalls()).toEqual(
      reports.map((arguments_) => ({ name: "report_task_result", arguments: arguments_ })),
    );
  });

  it("rejects failed prompt responses with the provider error", async () => {
    const agent = createAgent();
    const run = agent.runPrompt("plan");
    const assertion = expect(run).rejects.toThrow("No API key found");
    processes[0].emitEvent({
      type: "response",
      command: "prompt",
      id: processes[0].writes[0].id,
      success: false,
      error: "No API key found",
    });
    await assertion;
    expect(agent.isRunning()).toBe(false);
    expect(processes[0].kill).toHaveBeenCalled();
  });

  it.each(["process", "stdin"])("handles %s errors without an uncaught event", async (source) => {
    const agent = createAgent();
    const run = agent.runPrompt("plan");
    const assertion = expect(run).rejects.toThrow("spawn pi ENOENT");
    const emitter: EventEmitter = source === "stdin" ? processes[0].stdin : processes[0];
    expect(() => emitter.emit("error", new Error("spawn pi ENOENT"))).not.toThrow();
    await assertion;
  });

  it.each(["abort", "signal"])(
    "cancels retry delay through %s without spawning again",
    async (method) => {
      vi.useFakeTimers();
      const agent = createAgent();
      const controller = new AbortController();
      const run = agent.runPrompt("plan", { signal: controller.signal });
      const assertion = expect(run).rejects.toThrow(/aborted/i);
      processes[0].emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "429 rate limit",
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(agent.isRunning()).toBe(true);
      await expect(agent.runPrompt("overlap")).rejects.toThrow("already running");
      if (method === "signal") controller.abort();
      else agent.abort();
      await assertion;
      await vi.runAllTimersAsync();
      expect(processes).toHaveLength(1);
      expect(agent.isRunning()).toBe(false);
    },
  );

  it("retries transient failures, keeps queued steering, and ignores old process events", async () => {
    vi.useFakeTimers();
    const agent = createAgent();
    const run = agent.runPrompt("plan");
    processes[0].emitEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "503 unavailable",
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    agent.sendSteer("Use the corrected requirement");
    await vi.advanceTimersByTimeAsync(20);
    expect(processes).toHaveLength(2);
    processes[0].emit("close", 1);
    processes[0].finish("stale result");
    expect(processes[1].writes[0].message).toContain("corrected requirement");
    processes[1].finish("correct result");
    await expect(run).resolves.toBe("correct result");
  });

  it("does not launch an agent for an already aborted prompt", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createAgent().runPrompt("plan", { signal: controller.signal })).rejects.toThrow(
      "Aborted",
    );
    expect(processes).toHaveLength(0);
  });
});

describe("agent retry helpers", () => {
  it("detects OpenRouter-style rate limit errors as retryable", () => {
    expect(isRetryableAgentError(new Error("OpenRouter API error 429: rate limit exceeded"))).toBe(
      true,
    );
    expect(isRetryableAgentError("Too many requests. Retry-After: 12")).toBe(true);
  });

  it("detects transient transport errors as retryable", () => {
    expect(isRetryableAgentError(new Error("ECONNRESET while reading response"))).toBe(true);
    expect(isRetryableAgentError(new Error("provider returned 503 service unavailable"))).toBe(
      true,
    );
  });

  it("does not retry ordinary agent failures", () => {
    expect(isRetryableAgentError(new Error("Verifier found missing tests"))).toBe(false);
    expect(isRetryableAgentError(new Error("Agent already running"))).toBe(false);
  });

  it("normalizes invalid retry options to safe bounds", () => {
    const retry = normalizeAgentRetryOptions({
      maxAttempts: 0,
      initialDelayMs: -1,
      maxDelayMs: -1,
      backoffMultiplier: 0,
      jitterMs: -1,
    });

    expect(retry).toEqual({
      maxAttempts: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 1,
      jitterMs: 0,
    });
  });

  it("uses exponential backoff with cap and jitter", () => {
    const retry = normalizeAgentRetryOptions({
      initialDelayMs: 1000,
      maxDelayMs: 2500,
      backoffMultiplier: 2,
      jitterMs: 100,
    });

    expect(getAgentRetryDelayMs(1, retry, undefined, () => 0.5)).toBe(1050);
    expect(getAgentRetryDelayMs(2, retry, undefined, () => 0.5)).toBe(2050);
    expect(getAgentRetryDelayMs(3, retry, undefined, () => 0.5)).toBe(2550);
  });

  it("honors retry-after hints from provider errors up to maxDelayMs", () => {
    const retry = normalizeAgentRetryOptions({
      initialDelayMs: 1000,
      maxDelayMs: 2000,
      jitterMs: 1000,
    });

    expect(getAgentRetryDelayMs(1, retry, new Error("429 retry-after: 7"), () => 0.5)).toBe(2000);
    expect(getAgentRetryDelayMs(1, retry, new Error("try again in 250ms"), () => 0.5)).toBe(250);
  });
});
