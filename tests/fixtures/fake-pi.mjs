#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises";

const scenario = process.env.PIORCH_FAKE_PI_SCENARIO ?? "success";
const reportParams = JSON.parse(
  process.env.PIORCH_FAKE_PI_PARAMS ??
    JSON.stringify({
      status: "done",
      summary: "Implemented",
      filesChanged: ["src/feature.ts"],
      evidence: [{ kind: "test", description: "Tests pass", outcome: "pass" }],
      issues: [],
    }),
);

if (process.argv.includes("--version")) {
  process.stdout.write(`${process.env.PIORCH_FAKE_PI_VERSION ?? "0.80.10"}\n`);
  process.exit(0);
}

if (scenario === "exit-before-ready") process.exit(7);

function write(value, options = {}) {
  const line = JSON.stringify(value);
  if (options.crlf) process.stdout.write(`${line}\r\n`);
  else process.stdout.write(`${line}\n`);
}

function writeUtf8Split(value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const split = Math.max(1, Math.floor(bytes.length / 2));
  process.stdout.write(bytes.subarray(0, split));
  process.stdout.write(bytes.subarray(split));
}

function response(command, id, success = true, data, crlf = false) {
  if (success)
    write(
      { id, type: "response", command, success, ...(data === undefined ? {} : { data }) },
      { crlf },
    );
  else write({ id, type: "response", command, success: false, error: "fake Pi rejected command" });
}

function toolStart(id, name, args = reportParams) {
  write({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
}

function toolEnd(id, name, result = { details: { params: reportParams } }, isError = false) {
  write({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError });
}

async function settlePrompt() {
  write({ type: "agent_start" });
  const toolName = process.env.PIORCH_FAKE_PI_TOOL ?? "report_task_result";
  if (scenario === "retry") {
    // The first attempt fails before a report tool executes; the retry is the
    // only attempt that can produce an accepted structured result.
  } else if (scenario === "end-without-start") {
    toolEnd("missing", toolName);
  } else if (scenario === "duplicate-start") {
    toolStart("duplicate", toolName);
    toolStart("duplicate", toolName);
  } else if (scenario === "duplicate-success") {
    toolStart("one", toolName);
    toolEnd("one", toolName);
    toolStart("two", toolName);
    toolEnd("two", toolName);
  } else if (scenario === "failed-tool") {
    toolStart("failed", toolName);
    toolEnd("failed", toolName, { details: { params: reportParams } }, true);
  } else if (scenario === "corrected-tool") {
    toolStart("failed", toolName);
    toolEnd("failed", toolName, { details: { params: reportParams } }, true);
    toolStart("success", toolName);
    toolEnd("success", toolName);
  } else if (scenario !== "no-tool") {
    toolStart("report", toolName);
    toolEnd("report", toolName);
  }
  if (scenario === "agent-end-before-settled") {
    write({ type: "agent_end", messages: [], willRetry: false });
    await delay(50);
    write({ type: "agent_settled" });
  }
  if (scenario === "retry") {
    write({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [], stopReason: "error", errorMessage: "temporary" },
      ],
      willRetry: true,
    });
    write({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 0,
      errorMessage: "temporary",
    });
    write({ type: "auto_retry_end", success: true, attempt: 1 });
    write({ type: "agent_start" });
    toolStart("retry-report", "report_task_result");
    toolEnd("retry-report", "report_task_result");
    write({ type: "agent_end", messages: [], willRetry: false });
    write({ type: "agent_settled" });
  } else {
    write({ type: "agent_end", messages: [], willRetry: false });
    write({ type: "agent_settled" });
  }
}

let promptCount = 0;
let ready = false;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") {
      if (scenario === "malformed") process.stdout.write("not json\n");
      else if (scenario === "oversized")
        process.stdout.write(`${"x".repeat(4 * 1024 * 1024 + 10)}\n`);
      else {
        response(
          "get_state",
          command.id,
          true,
          { sessionId: "fake", isStreaming: false },
          scenario === "crlf",
        );
        ready = true;
      }
      continue;
    }
    if (command.type === "prompt") {
      promptCount += 1;
      if (scenario === "reject-prompt") {
        response("prompt", command.id, false);
        continue;
      }
      response("prompt", command.id);
      if (scenario === "utf8-split") {
        writeUtf8Split({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "✓" },
        });
      }
      if (scenario === "run-timeout" || scenario === "abort-timeout") continue;
      if (scenario === "partial-final") {
        process.stdout.write('{"type":"agent_end"');
        process.exit(0);
      }
      if (scenario === "unknown-response") {
        write({ id: "unknown", type: "response", command: "prompt", success: true });
        continue;
      }
      if (scenario === "retry" && promptCount > 1) continue;
      void settlePrompt();
      continue;
    }
    if (command.type === "steer") {
      response("steer", command.id);
      continue;
    }
    if (command.type === "abort") {
      if (scenario !== "abort-timeout") {
        response("abort", command.id);
        write({ type: "agent_end", messages: [], willRetry: false });
        write({ type: "agent_settled" });
      }
    }
  }
});
