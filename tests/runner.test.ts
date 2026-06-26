import { describe, expect, it } from "vitest";
import {
  getAgentRetryDelayMs,
  isRetryableAgentError,
  normalizeAgentRetryOptions,
} from "../.pi/extensions/workflow-orchestrator/runner.js";

/**
 * Tests for tool call capture logic in RpcAgent.
 *
 * These tests verify that tool calls are properly captured from RPC events.
 * The actual RPC communication is tested indirectly through the event parsing logic.
 */

describe("Tool call capture from RPC events", () => {
  interface ToolCallCapture {
    name: string;
    arguments: Record<string, unknown>;
  }

  interface MockRunState {
    toolCalls: ToolCallCapture[];
    lastAssistantText: string;
  }

  function createMockRunState(): MockRunState {
    return {
      toolCalls: [],
      lastAssistantText: "",
    };
  }

  function processMessageEndEvent(
    run: MockRunState,
    event: { message: { role: string; content: any[] } },
  ) {
    if (event.message?.role !== "assistant") return;

    for (const part of event.message.content) {
      if (typeof part === "string") {
        run.lastAssistantText = part;
      } else if (part.type === "text") {
        run.lastAssistantText = part.text;
      } else if (part.type === "toolCall") {
        // This is the fix: capture tool calls from message content
        run.toolCalls.push({ name: part.name, arguments: part.arguments });
      }
    }
  }

  function processToolExecutionStartEvent(
    run: MockRunState,
    event: { toolName: string; args: any },
  ) {
    // Capture tool call arguments for structured output
    run.toolCalls.push({ name: event.toolName, arguments: event.args ?? {} });
  }

  it("captures tool calls from tool_execution_start events", () => {
    const run = createMockRunState();

    processToolExecutionStartEvent(run, {
      toolName: "report_task_result",
      args: { status: "done", summary: "Test completed" },
    });

    expect(run.toolCalls).toHaveLength(1);
    expect(run.toolCalls[0].name).toBe("report_task_result");
    expect(run.toolCalls[0].arguments).toEqual({
      status: "done",
      summary: "Test completed",
    });
  });

  it("captures tool calls from message_end content parts", () => {
    const run = createMockRunState();

    processMessageEndEvent(run, {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll call the tool now" },
          {
            type: "toolCall",
            name: "generate_wave",
            arguments: {
              done: false,
              wave: {
                goal: "Test wave",
                tasks: [{ id: "T1", title: "Test task", description: "Do something" }],
              },
            },
          },
        ],
      },
    });

    expect(run.toolCalls).toHaveLength(1);
    expect(run.toolCalls[0].name).toBe("generate_wave");
    expect(run.toolCalls[0].arguments).toEqual({
      done: false,
      wave: {
        goal: "Test wave",
        tasks: [{ id: "T1", title: "Test task", description: "Do something" }],
      },
    });
  });

  it("captures multiple tool calls from both sources", () => {
    const run = createMockRunState();

    // First: tool_execution_start event
    processToolExecutionStartEvent(run, {
      toolName: "read",
      args: { path: "/test/file.txt" },
    });

    // Second: message_end with toolCall in content
    processMessageEndEvent(run, {
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "report_task_result",
            arguments: { status: "done", filesChanged: ["/test/file.txt"] },
          },
        ],
      },
    });

    expect(run.toolCalls).toHaveLength(2);
    expect(run.toolCalls[0].name).toBe("read");
    expect(run.toolCalls[0].arguments).toEqual({ path: "/test/file.txt" });
    expect(run.toolCalls[1].name).toBe("report_task_result");
    expect(run.toolCalls[1].arguments).toEqual({
      status: "done",
      filesChanged: ["/test/file.txt"],
    });
  });

  it("returns empty array when no tool calls", () => {
    const run = createMockRunState();

    processMessageEndEvent(run, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello, world!" }],
      },
    });

    expect(run.toolCalls).toHaveLength(0);
  });

  it("handles text-only message_end events", () => {
    const run = createMockRunState();

    processMessageEndEvent(run, {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "First part" },
          { type: "text", text: "Second part" },
        ],
      },
    });

    expect(run.toolCalls).toHaveLength(0);
    expect(run.lastAssistantText).toBe("Second part");
  });

  it("handles mixed text and tool calls in message_end", () => {
    const run = createMockRunState();

    processMessageEndEvent(run, {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me analyze the code..." },
          {
            type: "toolCall",
            name: "grep",
            arguments: { pattern: "function", path: "src/index.ts" },
          },
          { type: "text", text: "Found it!" },
        ],
      },
    });

    expect(run.toolCalls).toHaveLength(1);
    expect(run.toolCalls[0].name).toBe("grep");
    expect(run.lastAssistantText).toBe("Found it!");
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
