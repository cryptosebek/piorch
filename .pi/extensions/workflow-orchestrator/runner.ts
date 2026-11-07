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

export interface ToolCallCapture {
  name: string;
  arguments: Record<string, unknown>;
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
  promptId: string;
  pendingToolCalls: Map<string, ToolCallCapture>;
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
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, retry.maxDelayMs);

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

export class RpcAgent {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private stderr = "";
  private currentRun: RpcRunState | null = null;
  private runController: AbortController | null = null;
  private lastToolCalls: ToolCallCapture[] = [];
  private pendingSteers: string[] = [];
  private nextPromptId = 0;
  private retry: AgentRetryOptions;
  private tmpPromptDir: string | null = null;
  private tmpPromptPath: string | null = null;

  constructor(private options: RpcAgentOptions) {
    this.retry = normalizeAgentRetryOptions(options.retry);
  }

  getLastToolCalls(): ToolCallCapture[] {
    return this.lastToolCalls;
  }

  start(): void {
    if (this.proc) return;
    this.buffer = "";
    this.stderr = "";
    const args = [
      "--mode",
      "rpc",
      "--session",
      this.options.sessionFile,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
    ];
    for (const ext of this.options.allowedExtensions ?? []) args.push("-e", ext);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.tools?.length) args.push("--tools", this.options.tools.join(","));
    if (this.options.systemPrompt.trim()) {
      const tmp = writePromptToTempFile("agent", this.options.systemPrompt);
      this.tmpPromptDir = tmp.dir;
      this.tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmp.filePath);
    }

    const proc = spawn("pi", args, {
      cwd: this.options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (data) => {
      if (this.proc === proc) this.onData(data);
    });
    proc.stderr.on("data", (data) => {
      if (this.proc === proc) this.stderr += data.toString();
    });
    const onError = (error: Error) => {
      if (this.proc !== proc) return;
      this.rejectRun(error);
      this.stopProcess();
    };
    proc.on("error", onError);
    proc.stdin.on("error", onError);
    proc.on("close", () => {
      if (this.proc !== proc) return;
      if (this.buffer.trim()) this.processLine(this.buffer);
      this.rejectRun(new Error(this.stderr || "RPC agent terminated"));
      this.proc = null;
      this.cleanupPrompt();
    });
  }

  isRunning(): boolean {
    return Boolean(this.runController);
  }

  async runPrompt(message: string, options?: RpcRunOptions): Promise<string> {
    if (this.runController) throw new Error("Agent already running");
    const controller = new AbortController();
    this.runController = controller;
    this.lastToolCalls = [];
    const signal = options?.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    let failedAttempts = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Error("Aborted");
        try {
          return await this.runPromptOnce(message, { ...options, signal });
        } catch (error) {
          failedAttempts += 1;
          this.stopProcess();
          if (
            signal.aborted ||
            failedAttempts >= this.retry.maxAttempts ||
            !isRetryableAgentError(error)
          ) {
            throw error;
          }
          const delayMs = getAgentRetryDelayMs(failedAttempts, this.retry, error);
          await waitForRetry(delayMs, signal);
        }
      }
    } finally {
      this.runController = null;
      this.pendingSteers = [];
    }
  }

  private runPromptOnce(message: string, options: RpcRunOptions): Promise<string> {
    this.start();
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        this.send({ type: "abort" });
        this.rejectRun(new Error("Aborted"));
        this.stopProcess();
      };
      const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
      const promptId = String(++this.nextPromptId);
      this.currentRun = {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        promptId,
        lastAssistantText: "",
        toolCalls: [],
        pendingToolCalls: new Map(),
        onUpdate: options.onUpdate,
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      const steers = this.pendingSteers.splice(0);
      this.send({ type: "prompt", id: promptId, message: [message, ...steers].join("\n\n") });
    });
  }

  sendSteer(message: string): void {
    if (!this.runController) throw new Error("Agent is not running");
    if (!this.currentRun) {
      this.pendingSteers.push(message);
      return;
    }
    this.send({ type: "prompt", message, streamingBehavior: "steer" });
  }

  abort(): void {
    this.runController?.abort();
    this.stopProcess();
  }

  dispose(): void {
    this.abort();
  }

  private stopProcess(): void {
    const proc = this.proc;
    this.proc = null;
    proc?.kill("SIGTERM");
    this.cleanupPrompt();
  }

  private rejectRun(error: Error): void {
    const run = this.currentRun;
    this.currentRun = null;
    run?.reject(error);
  }

  private send(payload: Record<string, unknown>): void {
    this.proc?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) this.processLine(line);
  }

  private processLine(line: string): void {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const run = this.currentRun;
    if (!run) return;

    if (
      event.type === "response" &&
      event.command === "prompt" &&
      event.success === false &&
      (event.id === undefined || event.id === run.promptId)
    ) {
      this.rejectRun(new Error(event.error || "RPC prompt failed"));
      return;
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      run.onUpdate?.({ type: "text_delta", delta: event.assistantMessageEvent.delta ?? "" });
    }
    if (event.type === "tool_execution_start") {
      run.pendingToolCalls.set(event.toolCallId, {
        name: event.toolName,
        arguments: event.args ?? {},
      });
      run.onUpdate?.({ type: "tool_start", toolName: event.toolName, args: event.args });
    }
    if (event.type === "tool_execution_update") {
      run.onUpdate?.({
        type: "tool_update",
        toolName: event.toolName,
        partialResult: event.partialResult,
      });
    }
    if (event.type === "tool_execution_end") {
      const call = run.pendingToolCalls.get(event.toolCallId);
      run.pendingToolCalls.delete(event.toolCallId);
      if (call && event.isError === false) run.toolCalls.push(call);
      run.onUpdate?.({ type: "tool_end", toolName: event.toolName, isError: event.isError });
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        this.rejectRun(new Error(event.message.errorMessage || "Aborted"));
        return;
      }
      const msg = event.message as Extract<Message, { role: "assistant" }>;
      run.lastAssistantText = msg.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
    }
    if (event.type === "agent_end") {
      this.lastToolCalls = [...run.toolCalls];
      this.currentRun = null;
      run.resolve(run.lastAssistantText);
    }
  }

  private cleanupPrompt(): void {
    if (this.tmpPromptPath) {
      try {
        fs.unlinkSync(this.tmpPromptPath);
      } catch {
        /* already removed */
      }
    }
    if (this.tmpPromptDir) {
      try {
        fs.rmdirSync(this.tmpPromptDir);
      } catch {
        /* already removed */
      }
    }
    this.tmpPromptPath = null;
    this.tmpPromptDir = null;
  }
}
