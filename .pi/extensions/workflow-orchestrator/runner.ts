import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";

export type AgentRunUpdate =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; args: any }
  | { type: "tool_update"; toolName: string; partialResult: any }
  | { type: "tool_end"; toolName: string; isError: boolean };

export interface AgentRunInput {
  name: string;
  task: string;
  cwd: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  signal?: AbortSignal;
  onUpdate?: (update: AgentRunUpdate) => void;
  allowedExtensions?: string[];
}

export interface ToolCallCapture {
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentRunResult {
  outputText: string;
  messages: Message[];
  stderr: string;
  exitCode: number;
  toolCalls: ToolCallCapture[];
}

export interface RpcAgentOptions {
  cwd: string;
  sessionFile: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  allowedExtensions?: string[];
  retry?: Partial<AgentRetryOptions>;
}

export interface RpcRunOptions {
  onUpdate?: (update: AgentRunUpdate) => void;
  signal?: AbortSignal;
}

export interface AgentRetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterMs: number;
}

interface RpcRunState {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  lastAssistantText: string;
  toolCalls: ToolCallCapture[];
  onUpdate?: (update: AgentRunUpdate) => void;
  aborted?: boolean;
}

export const DEFAULT_AGENT_RETRY_OPTIONS: AgentRetryOptions = {
  maxAttempts: 5,
  initialDelayMs: 5000,
  maxDelayMs: 120000,
  backoffMultiplier: 2,
  jitterMs: 1000,
};

const RETRYABLE_ERROR_PATTERNS = [
  /(?:^|\D)429(?:\D|$)/i,
  /rate.?limit/i,
  /too many requests/i,
  /retry.?after/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /overloaded/i,
  /timeout/i,
  /timed out/i,
  /econnreset/i,
  /etimedout/i,
  /(?:^|\D)502(?:\D|$)/i,
  /(?:^|\D)503(?:\D|$)/i,
  /(?:^|\D)504(?:\D|$)/i,
];

export function normalizeAgentRetryOptions(retry?: Partial<AgentRetryOptions>): AgentRetryOptions {
  const merged = { ...DEFAULT_AGENT_RETRY_OPTIONS, ...retry };
  return {
    maxAttempts: Math.max(1, Math.floor(merged.maxAttempts)),
    initialDelayMs: Math.max(0, merged.initialDelayMs),
    maxDelayMs: Math.max(0, merged.maxDelayMs),
    backoffMultiplier: Math.max(1, merged.backoffMultiplier),
    jitterMs: Math.max(0, merged.jitterMs),
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? "";
  } catch {
    return "";
  }
}

export function isRetryableAgentError(error: unknown): boolean {
  const text = errorText(error);
  if (!text) return false;
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function parseRetryAfterMs(error: unknown): number | undefined {
  const text = errorText(error);
  const retryAfterMatch =
    text.match(/retry-after["':\s]+(\d+(?:\.\d+)?)/i) ??
    text.match(/retry_after["':\s]+(\d+(?:\.\d+)?)/i) ??
    text.match(/try again in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|m|min|minutes)?/i);

  if (!retryAfterMatch) return undefined;

  const value = Number(retryAfterMatch[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;

  const unit = retryAfterMatch[2]?.toLowerCase();
  if (unit === "ms") return value;
  if (unit === "m" || unit === "min" || unit === "minutes") return value * 60_000;
  return value * 1000;
}

export function getAgentRetryDelayMs(
  failedAttempt: number,
  retry: AgentRetryOptions,
  error?: unknown,
  random: () => number = Math.random,
): number {
  const retryAfterMs = parseRetryAfterMs(error);
  if (retryAfterMs !== undefined) return retryAfterMs;

  const exponent = Math.max(0, failedAttempt - 1);
  const exponentialDelay = retry.initialDelayMs * retry.backoffMultiplier ** exponent;
  const cappedDelay = Math.min(exponentialDelay, retry.maxDelayMs);
  const jitter = retry.jitterMs > 0 ? Math.floor(random() * retry.jitterMs) : 0;
  return cappedDelay + jitter;
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("Aborted"));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("Aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
  ];
  if (input.allowedExtensions) {
    for (const ext of input.allowedExtensions) {
      args.push("-e", ext);
    }
  }
  if (input.model) args.push("--model", input.model);
  if (input.tools && input.tools.length > 0) args.push("--tools", input.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  if (input.systemPrompt.trim()) {
    const tmp = writePromptToTempFile(input.name, input.systemPrompt);
    tmpPromptDir = tmp.dir;
    tmpPromptPath = tmp.filePath;
    args.push("--append-system-prompt", tmpPromptPath);
  }

  args.push(input.task);

  const messages: Message[] = [];
  const toolCalls: ToolCallCapture[] = [];
  let stderr = "";
  let assistantError = "";

  const exitCode = await new Promise<number>((resolve) => {
    const proc = spawn("pi", args, {
      cwd: input.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        input.onUpdate?.({ type: "text_delta", delta: event.assistantMessageEvent.delta ?? "" });
      }

      if (event.type === "tool_execution_start") {
        // Capture tool call arguments for structured output
        toolCalls.push({ name: event.toolName, arguments: event.args ?? {} });
        input.onUpdate?.({ type: "tool_start", toolName: event.toolName, args: event.args });
      }

      if (event.type === "tool_execution_update") {
        input.onUpdate?.({
          type: "tool_update",
          toolName: event.toolName,
          partialResult: event.partialResult,
        });
      }

      if (event.type === "tool_execution_end") {
        input.onUpdate?.({ type: "tool_end", toolName: event.toolName, isError: event.isError });
      }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        messages.push(msg);
        if (event.message.stopReason === "error" && event.message.errorMessage) {
          assistantError = event.message.errorMessage;
        }
      }
      if (event.type === "tool_result_end" && event.message) {
        const msg = event.message as Message;
        messages.push(msg);
      }
    };

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      resolve(code ?? 0);
    });

    proc.on("error", () => resolve(1));

    if (input.signal) {
      const killProc = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (input.signal.aborted) killProc();
      else input.signal.addEventListener("abort", killProc, { once: true });
    }
  });

  const outputText = getFinalOutput(messages);

  if (tmpPromptPath)
    try {
      fs.unlinkSync(tmpPromptPath);
    } catch {
      /* ignore */
    }
  if (tmpPromptDir)
    try {
      fs.rmdirSync(tmpPromptDir);
    } catch {
      /* ignore */
    }

  return { outputText, messages, stderr: assistantError || stderr, exitCode, toolCalls };
}

export class RpcAgent {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private stderr = "";
  private currentRun: RpcRunState | null = null;
  private lastToolCalls: ToolCallCapture[] = [];
  private options: RpcAgentOptions;
  private retry: AgentRetryOptions;
  private tmpPromptDir: string | null = null;
  private tmpPromptPath: string | null = null;

  constructor(options: RpcAgentOptions) {
    this.options = options;
    this.retry = normalizeAgentRetryOptions(options.retry);
  }

  getLastToolCalls(): ToolCallCapture[] {
    return this.lastToolCalls;
  }

  start(): void {
    if (this.proc) return;

    const args: string[] = [
      "--mode",
      "rpc",
      "--session",
      this.options.sessionFile,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
    ];

    if (this.options.allowedExtensions) {
      for (const ext of this.options.allowedExtensions) {
        args.push("-e", ext);
      }
    }

    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.tools && this.options.tools.length > 0)
      args.push("--tools", this.options.tools.join(","));

    if (this.options.systemPrompt.trim()) {
      const tmp = writePromptToTempFile("agent", this.options.systemPrompt);
      this.tmpPromptDir = tmp.dir;
      this.tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmp.filePath);
    }

    this.proc = spawn("pi", args, {
      cwd: this.options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.on("data", (data) => this.onData(data.toString()));
    this.proc.stderr.on("data", (data) => (this.stderr += data.toString()));
    this.proc.on("close", () => this.handleClose());
  }

  isRunning(): boolean {
    return Boolean(this.currentRun);
  }

  async runPrompt(message: string, options?: RpcRunOptions): Promise<string> {
    let failedAttempts = 0;

    while (true) {
      try {
        return await this.runPromptOnce(message, options);
      } catch (error) {
        failedAttempts += 1;
        if (
          options?.signal?.aborted ||
          failedAttempts >= this.retry.maxAttempts ||
          !isRetryableAgentError(error)
        ) {
          throw error;
        }

        this.dispose();
        const delayMs = getAgentRetryDelayMs(failedAttempts, this.retry, error);
        await waitForRetry(delayMs, options?.signal);
      }
    }
  }

  private async runPromptOnce(message: string, options?: RpcRunOptions): Promise<string> {
    this.start();
    if (this.currentRun) throw new Error("Agent already running");

    return new Promise<string>((resolve, reject) => {
      let cleanup = () => {};
      const finishResolve = (value: string) => {
        cleanup();
        resolve(value);
      };
      const finishReject = (error: Error) => {
        cleanup();
        reject(error);
      };

      this.currentRun = {
        resolve: finishResolve,
        reject: finishReject,
        lastAssistantText: "",
        toolCalls: [],
        onUpdate: options?.onUpdate,
      };

      if (options?.signal) {
        const onAbort = () => {
          const run = this.currentRun;
          if (!run) return;
          run.aborted = true;
          this.currentRun = null;
          this.abort();
          finishReject(new Error("Aborted"));
        };
        cleanup = () => options.signal?.removeEventListener("abort", onAbort);
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.send({ type: "prompt", message });
    });
  }

  sendSteer(message: string): void {
    this.start();
    const command = this.currentRun
      ? { type: "prompt", message, streamingBehavior: "steer" }
      : { type: "prompt", message };
    this.send(command);
  }

  abort(): void {
    if (!this.proc) return;
    this.send({ type: "abort" });
  }

  dispose(): void {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    this.proc = null;
    this.cleanupPrompt();
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) this.processLine(line);
  }

  private processLine(line: string): void {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      this.currentRun?.onUpdate?.({
        type: "text_delta",
        delta: event.assistantMessageEvent.delta ?? "",
      });
    }

    if (event.type === "tool_execution_start") {
      // Capture tool call arguments for structured output
      this.currentRun?.toolCalls.push({ name: event.toolName, arguments: event.args ?? {} });
      this.currentRun?.onUpdate?.({
        type: "tool_start",
        toolName: event.toolName,
        args: event.args,
      });
    }

    if (event.type === "tool_execution_update") {
      this.currentRun?.onUpdate?.({
        type: "tool_update",
        toolName: event.toolName,
        partialResult: event.partialResult,
      });
    }

    if (event.type === "tool_execution_end") {
      this.currentRun?.onUpdate?.({
        type: "tool_end",
        toolName: event.toolName,
        isError: event.isError,
      });
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const run = this.currentRun;
      if (!run) return; // Race condition: agent_end may have cleared currentRun

      if (event.message.stopReason === "error" && event.message.errorMessage) {
        this.lastToolCalls = [...run.toolCalls];
        this.currentRun = null;
        run.reject(new Error(event.message.errorMessage));
        return;
      }

      const msg = event.message as Message;
      for (const part of msg.content) {
        if (typeof part === "string") {
          run.lastAssistantText = part;
        } else if (part.type === "text") {
          run.lastAssistantText = part.text;
        } else if (part.type === "toolCall") {
          // Capture tool call from message content
          run.toolCalls.push({ name: part.name, arguments: part.arguments });
          run.onUpdate?.({
            type: "tool_start",
            toolName: part.name,
            args: part.arguments,
          });
        }
      }
    }

    if (event.type === "agent_end") {
      const run = this.currentRun;
      if (!run) return;
      // Save tool calls before clearing currentRun
      this.lastToolCalls = [...run.toolCalls];
      this.currentRun = null;
      if (run.aborted) return;
      run.resolve(run.lastAssistantText || "");
    }
  }

  private handleClose(): void {
    if (this.currentRun) {
      this.currentRun.reject(new Error(this.stderr || "RPC agent terminated"));
      this.currentRun = null;
    }
    this.proc = null;
    this.cleanupPrompt();
  }

  private cleanupPrompt(): void {
    if (this.tmpPromptPath)
      try {
        fs.unlinkSync(this.tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (this.tmpPromptDir)
      try {
        fs.rmdirSync(this.tmpPromptDir);
      } catch {
        /* ignore */
      }
    this.tmpPromptPath = null;
    this.tmpPromptDir = null;
  }
}
