import {
  execFile as nodeExecFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

export const SUPPORTED_PI_MIN_VERSION = "0.80.10";
export const SUPPORTED_PI_MAX_MAJOR_MINOR = "0.81.0";
export const DEFAULT_RPC_TIMEOUTS = {
  startupTimeoutMs: 10_000,
  commandTimeoutMs: 10_000,
  runTimeoutMs: 30 * 60_000,
  abortGraceMs: 5_000,
  killGraceMs: 2_000,
  maxRecordBytes: 4 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
} as const;

export type AgentRunUpdate =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string };

export interface RpcToolExecution {
  toolCallId: string;
  name: string;
  attemptedArgs: unknown;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
  result?: unknown;
}

export interface ToolCallCapture {
  name: string;
  arguments: Record<string, unknown>;
  toolCallId?: string;
  isError?: boolean;
}

export interface RpcRunResult {
  outputText: string;
  executions: RpcToolExecution[];
  successfulToolExecutions: RpcToolExecution[];
  failedToolExecutions: RpcToolExecution[];
  stderr: string;
  lifecycleEvents: string[];
  usage?: unknown;
  metrics?: RpcRunMetrics;
}

export interface RpcRunMetrics {
  turns: number;
  retries: number;
  successfulToolExecutions: number;
  failedToolExecutions: number;
}

export interface RpcAgentOptions {
  cwd: string;
  sessionFile: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  allowedExtensions?: string[];
  piCommand?: string;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  runTimeoutMs?: number;
  abortGraceMs?: number;
  killGraceMs?: number;
  maxRecordBytes?: number;
  maxStderrBytes?: number;
}

export interface RpcRunOptions {
  onUpdate?: (update: AgentRunUpdate) => void;
  signal?: AbortSignal;
}

interface PendingCommand {
  id: string;
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface RpcRunState {
  resolve: (value: RpcRunResult) => void;
  reject: (error: Error) => void;
  promptAccepted: boolean;
  lifecycle: "prompt_pending" | "running" | "settling";
  outputText: string;
  executions: Map<string, RpcToolExecution>;
  lifecycleEvents: string[];
  promptAcceptedPromise: Promise<void>;
  resolvePromptAccepted: () => void;
  rejectPromptAccepted: (error: Error) => void;
  assistantError?: string;
  retrySucceeded: boolean;
  retryCount: number;
  turnCount: number;
  usage?: unknown;
  abortRequested: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  abortTimeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  onUpdate?: (update: AgentRunUpdate) => void;
  settled: boolean;
}

export interface PiVersionInfo {
  command: string;
  version: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export function parsePiVersion(output: string): string | undefined {
  return output.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
}

function isSupportedVersion(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major === 0 && minor === 80 && patch >= 10;
}

export async function preflightPiExecutable(
  command = "pi",
  cwd = process.cwd(),
): Promise<PiVersionInfo> {
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFile(command, ["--version"], { cwd, shell: false });
    stdout = String(result.stdout ?? "");
    stderr = String(result.stderr ?? "");
  } catch (error) {
    const detail = errorMessage(error);
    throw new Error(`Pi executable preflight failed for ${command}: ${detail}`);
  }

  const version = parsePiVersion(`${stdout}\n${stderr}`);
  if (!version || !isSupportedVersion(version)) {
    throw new Error(
      `Unsupported Pi executable for ${command}: reported ${version ?? "no numeric version"}; supported range is >=${SUPPORTED_PI_MIN_VERSION} <${SUPPORTED_PI_MAX_MAJOR_MINOR}`,
    );
  }
  return { command, version };
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

function getTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { role?: string; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((part): part is { type: "text"; text: string } => {
      return Boolean(
        part && typeof part === "object" && (part as { type?: string }).type === "text",
      );
    })
    .map((part) => part.text)
    .join("");
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && deepEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

export interface SelectedStructuredToolResult {
  execution: RpcToolExecution;
  params: unknown;
}

export function selectStructuredToolResult(
  result: Pick<RpcRunResult, "executions">,
  expectedToolName: string,
): SelectedStructuredToolResult {
  const candidates = result.executions.filter(
    (execution) =>
      execution.name === expectedToolName &&
      execution.endedAt !== undefined &&
      execution.isError === false,
  );
  if (candidates.length === 0) {
    throw new Error(`No successful terminal ${expectedToolName} execution was recorded`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous ${expectedToolName} result: ${candidates.length} successful executions`,
    );
  }

  const execution = candidates[0];
  const details = execution.result;
  const detailsParams =
    details && typeof details === "object" && "details" in details
      ? (details as { details?: { params?: unknown } }).details?.params
      : undefined;
  if (detailsParams !== undefined && !deepEqual(detailsParams, execution.attemptedArgs)) {
    throw new Error(
      `${expectedToolName} execution arguments differ from its terminal result details`,
    );
  }
  return { execution, params: detailsParams ?? execution.attemptedArgs };
}

export class PiRpcProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stdoutDecoder = new StringDecoder("utf8");
  private stderrDecoder = new StringDecoder("utf8");
  private stderr = "";
  private pending = new Map<string, PendingCommand>();
  private currentRun: RpcRunState | null = null;
  private lastRunResult: RpcRunResult | null = null;
  private lastToolCalls: ToolCallCapture[] = [];
  private commandCounter = 0;
  private ready = false;
  private disposed = false;
  private closing = false;
  private startupPromise: Promise<void> | null = null;
  private abortPromise: Promise<void> | null = null;
  private tmpPromptDir: string | null = null;
  private tmpPromptPath: string | null = null;
  private options: Required<
    Pick<
      RpcAgentOptions,
      | "piCommand"
      | "startupTimeoutMs"
      | "commandTimeoutMs"
      | "runTimeoutMs"
      | "abortGraceMs"
      | "killGraceMs"
      | "maxRecordBytes"
      | "maxStderrBytes"
    >
  > &
    RpcAgentOptions;

  constructor(options: RpcAgentOptions) {
    this.options = {
      ...options,
      piCommand: options.piCommand ?? "pi",
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_RPC_TIMEOUTS.startupTimeoutMs,
      commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_RPC_TIMEOUTS.commandTimeoutMs,
      runTimeoutMs: options.runTimeoutMs ?? DEFAULT_RPC_TIMEOUTS.runTimeoutMs,
      abortGraceMs: options.abortGraceMs ?? DEFAULT_RPC_TIMEOUTS.abortGraceMs,
      killGraceMs: options.killGraceMs ?? DEFAULT_RPC_TIMEOUTS.killGraceMs,
      maxRecordBytes: options.maxRecordBytes ?? DEFAULT_RPC_TIMEOUTS.maxRecordBytes,
      maxStderrBytes: options.maxStderrBytes ?? DEFAULT_RPC_TIMEOUTS.maxStderrBytes,
    };
  }

  getLastToolCalls(): ToolCallCapture[] {
    return this.lastToolCalls.map((call) => ({ ...call }));
  }

  getLastRunResult(): RpcRunResult | null {
    return this.lastRunResult;
  }

  getStderr(): string {
    return this.stderr;
  }

  isRunning(): boolean {
    return this.currentRun !== null;
  }

  async start(): Promise<void> {
    if (this.ready && this.proc) return;
    if (this.startupPromise) return this.startupPromise;
    if (this.disposed) throw new Error("RPC process has been disposed");

    this.startupPromise = (async () => {
      this.spawnProcess();
      await this.sendCommand({ type: "get_state" }, "get_state", this.options.startupTimeoutMs);
      this.ready = true;
      this.cleanupPrompt();
    })();
    try {
      await this.startupPromise;
    } catch (error) {
      this.startupPromise = null;
      this.terminateProcess();
      throw error;
    }
    this.startupPromise = null;
  }

  async runPrompt(message: string, options?: RpcRunOptions): Promise<RpcRunResult> {
    await this.start();
    if (this.currentRun) throw new Error("Agent already running");
    if (!this.proc || !this.ready) throw new Error("RPC process is not ready");
    if (options?.signal?.aborted) throw new Error("Aborted");

    const result = new Promise<RpcRunResult>((resolve, reject) => {
      let resolvePromptAccepted!: () => void;
      let rejectPromptAccepted!: (error: Error) => void;
      const promptAcceptedPromise = new Promise<void>((resolveAccepted, rejectAccepted) => {
        resolvePromptAccepted = resolveAccepted;
        rejectPromptAccepted = rejectAccepted;
      });
      void promptAcceptedPromise.catch(() => {});
      const run: RpcRunState = {
        resolve,
        reject,
        promptAccepted: false,
        lifecycle: "prompt_pending",
        outputText: "",
        executions: new Map(),
        lifecycleEvents: [],
        promptAcceptedPromise,
        resolvePromptAccepted,
        rejectPromptAccepted,
        retrySucceeded: false,
        retryCount: 0,
        turnCount: 0,
        abortRequested: false,
        signal: options?.signal,
        onUpdate: options?.onUpdate,
        settled: false,
      };
      this.currentRun = run;

      const finishAbort = () => {
        if (!this.currentRun || this.currentRun !== run) return;
        run.abortRequested = true;
        void this.abort();
      };
      if (options?.signal) {
        run.onAbort = finishAbort;
        options.signal.addEventListener("abort", finishAbort, { once: true });
      }
      run.timeout = setTimeout(() => {
        this.failRun(
          new Error(
            `RPC run timed out: session=${this.options.sessionFile}, lastEvent=${run.lifecycleEvents.at(-1) ?? "none"}, stderr=${this.boundedStderr()}`,
          ),
          true,
        );
      }, this.options.runTimeoutMs);

      void this.sendCommand(
        { type: "prompt", message },
        "prompt",
        this.options.commandTimeoutMs,
      ).then(
        () => {
          if (this.currentRun !== run || run.settled) return;
          if (!run.promptAccepted) {
            run.promptAccepted = true;
            run.lifecycle = "running";
            run.lifecycleEvents.push("prompt_accepted");
            run.resolvePromptAccepted();
          }
        },
        (error: Error) => this.failRun(error),
      );
    });

    return result;
  }

  async sendSteer(message: string): Promise<void> {
    const run = this.currentRun;
    if (!run) {
      throw new Error("Cannot steer an RPC process without an accepted prompt");
    }
    if (!run.promptAccepted) await run.promptAcceptedPromise;
    if (this.currentRun !== run || !run.promptAccepted) {
      throw new Error("Cannot steer an RPC process without an accepted prompt");
    }
    await this.sendCommand({ type: "steer", message }, "steer");
  }

  async abort(): Promise<void> {
    if (this.abortPromise) return this.abortPromise;
    this.abortPromise = this.abortProcess();
    try {
      await this.abortPromise;
    } finally {
      this.abortPromise = null;
    }
  }

  private async abortProcess(): Promise<void> {
    if (!this.proc) return;
    if (this.currentRun) this.currentRun.abortRequested = true;
    try {
      await this.sendCommand({ type: "abort" }, "abort", this.options.abortGraceMs);
    } catch (error) {
      if (this.currentRun)
        this.currentRun.lifecycleEvents.push(`abort_error:${errorMessage(error)}`);
      this.terminateProcess();
      return;
    }

    if (this.currentRun) {
      const run = this.currentRun;
      if (run.abortTimeout) clearTimeout(run.abortTimeout);
      run.abortTimeout = setTimeout(() => {
        if (this.currentRun === run && !run.settled) this.terminateProcess();
      }, this.options.abortGraceMs);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closing = true;
    this.failRun(new Error("RPC process disposed"));
    this.rejectPending(new Error("RPC process disposed"));
    this.terminateProcess();
    this.cleanupPrompt();
  }

  private spawnProcess(): void {
    const args: string[] = [
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

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(this.options.piCommand, args, {
        cwd: this.options.cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.cleanupPrompt();
      throw new Error(
        `Failed to spawn Pi executable ${this.options.piCommand}: ${errorMessage(error)}`,
      );
    }
    this.proc = proc;
    this.ready = false;
    this.closing = false;
    this.stdoutBuffer = "";
    this.stdoutDecoder = new StringDecoder("utf8");
    this.stderrDecoder = new StringDecoder("utf8");
    this.stderr = "";

    proc.stdout.on("data", (chunk: Buffer | string) => this.onStdout(chunk));
    proc.stderr.on("data", (chunk: Buffer | string) => this.onStderr(chunk));
    proc.stdin.on("error", (error) =>
      this.handleProcessError(new Error(`Pi stdin error: ${error.message}`)),
    );
    proc.stdout.on("error", (error) =>
      this.handleProcessError(new Error(`Pi stdout error: ${error.message}`)),
    );
    proc.stderr.on("error", (error) =>
      this.handleProcessError(new Error(`Pi stderr error: ${error.message}`)),
    );
    proc.on("error", (error) =>
      this.handleProcessError(new Error(`Pi process error: ${error.message}`)),
    );
    proc.on("exit", (code, signal) => {
      if (this.currentRun)
        this.currentRun.lifecycleEvents.push(`exit:${code ?? "null"}:${signal ?? "null"}`);
    });
    proc.on("close", (code, signal) => this.handleClose(code, signal));
  }

  private sendCommand(
    payload: Record<string, unknown>,
    command: string,
    timeoutMs = this.options.commandTimeoutMs,
  ): Promise<unknown> {
    if (!this.proc || this.closing) return Promise.reject(new Error("RPC process is not running"));
    const id = `piorch-${++this.commandCounter}`;
    const body = { id, ...payload };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`RPC command timed out: ${command} (${id})`);
        reject(error);
        if (command === "prompt" || command === "get_state") this.failRun(error, true);
      }, timeoutMs);
      this.pending.set(id, { id, command, resolve, reject, timeout });
      try {
        this.proc?.stdin.write(`${JSON.stringify(body)}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(`Failed to write RPC command ${command}: ${errorMessage(error)}`));
      }
    });
  }

  private onStdout(chunk: Buffer | string): void {
    const decoded = this.stdoutDecoder.write(
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    );
    this.stdoutBuffer += decoded;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const record = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (Buffer.byteLength(record) > this.options.maxRecordBytes) {
        this.protocolFailure(`RPC JSONL record exceeds ${this.options.maxRecordBytes} bytes`);
        return;
      }
      this.processRecord(record.endsWith("\r") ? record.slice(0, -1) : record);
      if (this.disposed) return;
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stdoutBuffer) > this.options.maxRecordBytes) {
      this.protocolFailure(`RPC JSONL record exceeds ${this.options.maxRecordBytes} bytes`);
    }
  }

  private onStderr(chunk: Buffer | string): void {
    const decoded = this.stderrDecoder.write(
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    );
    this.stderr = `${this.stderr}${decoded}`.slice(-this.options.maxStderrBytes);
  }

  private processRecord(record: string): void {
    if (!record.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(record);
    } catch (error) {
      this.protocolFailure(`Malformed RPC JSONL record: ${errorMessage(error)}`);
      return;
    }
    this.processEvent(event as Record<string, unknown>);
  }

  private processEvent(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === "response") {
      this.processResponse(event);
      return;
    }

    const run = this.currentRun;
    if (type === "message_update") {
      const assistantEvent = event.assistantMessageEvent as
        | { type?: string; delta?: string }
        | undefined;
      if (assistantEvent?.type === "text_delta") {
        const delta = assistantEvent.delta ?? "";
        if (run) {
          run.outputText += delta;
          run.onUpdate?.({ type: "text_delta", delta });
        }
      }
      return;
    }
    if (type === "message_end") {
      const text = getTextFromMessage(event.message);
      if (run && text) run.outputText = text;
      const message = event.message as
        | { stopReason?: string; errorMessage?: string; usage?: unknown }
        | undefined;
      if (run && message?.usage !== undefined) run.usage = message.usage;
      if (run && message?.stopReason === "error" && message.errorMessage)
        run.assistantError = message.errorMessage;
      return;
    }
    if (!run) {
      if (
        type === "queue_update" ||
        type === "entry_appended" ||
        type === "session_info_changed" ||
        type === "extension_ui_request"
      ) {
        return;
      }
      if (type === "agent_settled") return;
      this.protocolFailure(`RPC event ${String(type)} arrived without an active prompt`);
      return;
    }

    if (type === "agent_start") {
      if (!run.promptAccepted || run.lifecycle === "prompt_pending") {
        this.protocolFailure("agent_start arrived before prompt acceptance");
        return;
      }
      run.lifecycle = "running";
      run.turnCount += 1;
      run.lifecycleEvents.push("agent_start");
      return;
    }
    if (type === "agent_end") {
      if (!run.promptAccepted || run.lifecycle === "prompt_pending") {
        this.protocolFailure("agent_end arrived before prompt acceptance");
        return;
      }
      const messages = Array.isArray(event.messages) ? event.messages : [];
      for (const message of messages) {
        const text = getTextFromMessage(message);
        if (text) run.outputText = text;
        const candidate = message as {
          stopReason?: string;
          errorMessage?: string;
          usage?: unknown;
        };
        if (candidate.usage !== undefined) run.usage = candidate.usage;
        if (candidate.stopReason === "error" && candidate.errorMessage)
          run.assistantError = candidate.errorMessage;
      }
      run.lifecycle = "settling";
      run.lifecycleEvents.push(`agent_end:${event.willRetry === true ? "retry" : "done"}`);
      return;
    }
    if (type === "agent_settled") {
      if (!run.promptAccepted || run.lifecycle === "prompt_pending") {
        this.protocolFailure("agent_settled arrived before prompt acceptance");
        return;
      }
      if ([...run.executions.values()].some((execution) => execution.endedAt === undefined)) {
        this.protocolFailure("agent_settled arrived with unfinished tool execution");
        return;
      }
      this.finishRun(run);
      return;
    }
    if (type === "auto_retry_start") {
      run.retryCount += 1;
      run.lifecycleEvents.push("auto_retry_start");
      run.onUpdate?.({
        type: "retry",
        attempt: Number(event.attempt ?? 0),
        maxAttempts: Number(event.maxAttempts ?? 0),
        delayMs: Number(event.delayMs ?? 0),
        errorMessage: String(event.errorMessage ?? ""),
      });
      return;
    }
    if (type === "auto_retry_end") {
      const success = event.success === true;
      if (success) {
        run.assistantError = undefined;
        run.retrySucceeded = true;
      }
      run.lifecycleEvents.push(`auto_retry_end:${success ? "success" : "failure"}`);
      return;
    }
    if (type === "tool_execution_start") {
      const toolCallId = event.toolCallId;
      const toolName = event.toolName;
      if (
        typeof toolCallId !== "string" ||
        !toolCallId ||
        typeof toolName !== "string" ||
        !toolName
      ) {
        this.protocolFailure("tool_execution_start is missing toolCallId or toolName");
        return;
      }
      if (run.executions.has(toolCallId)) {
        this.protocolFailure(`duplicate tool execution start: ${toolCallId}`);
        return;
      }
      const execution: RpcToolExecution = {
        toolCallId,
        name: toolName,
        attemptedArgs: event.args,
        startedAt: Date.now(),
      };
      run.executions.set(toolCallId, execution);
      run.onUpdate?.({ type: "tool_start", toolCallId, toolName, args: event.args });
      return;
    }
    if (type === "tool_execution_update") {
      const toolCallId = event.toolCallId;
      const execution = typeof toolCallId === "string" ? run.executions.get(toolCallId) : undefined;
      if (!execution || execution.endedAt !== undefined) {
        this.protocolFailure(`tool execution update without active start: ${String(toolCallId)}`);
        return;
      }
      run.onUpdate?.({
        type: "tool_update",
        toolCallId: execution.toolCallId,
        toolName: execution.name,
        partialResult: event.partialResult,
      });
      return;
    }
    if (type === "tool_execution_end") {
      const toolCallId = event.toolCallId;
      const execution = typeof toolCallId === "string" ? run.executions.get(toolCallId) : undefined;
      if (!execution) {
        this.protocolFailure(`tool execution end without start: ${String(toolCallId)}`);
        return;
      }
      if (execution.endedAt !== undefined) {
        this.protocolFailure(`duplicate tool execution end: ${toolCallId}`);
        return;
      }
      if (event.toolName !== execution.name) {
        this.protocolFailure(`tool execution name changed for ${toolCallId}`);
        return;
      }
      if (typeof event.isError !== "boolean") {
        this.protocolFailure(`tool execution end is missing boolean isError for ${toolCallId}`);
        return;
      }
      execution.endedAt = Date.now();
      execution.isError = event.isError === true;
      execution.result = event.result;
      run.onUpdate?.({
        type: "tool_end",
        toolCallId: execution.toolCallId,
        toolName: execution.name,
        isError: execution.isError,
      });
      return;
    }
    if (
      type === "turn_start" ||
      type === "turn_end" ||
      type === "queue_update" ||
      type === "compaction_start" ||
      type === "compaction_end" ||
      type === "entry_appended" ||
      type === "session_info_changed" ||
      type === "thinking_level_changed" ||
      type === "extension_ui_request"
    ) {
      run.lifecycleEvents.push(String(type));
      return;
    }
    this.protocolFailure(`Unknown RPC event type: ${String(type)}`);
  }

  private processResponse(event: Record<string, unknown>): void {
    const id = event.id;
    if (typeof id !== "string") {
      this.protocolFailure("RPC response is missing id");
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      this.protocolFailure(`RPC response has unknown or duplicate id: ${id}`);
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (event.command !== pending.command) {
      this.protocolFailure(`RPC response command mismatch for ${id}`);
      return;
    }
    if (event.success !== true) {
      pending.reject(new Error(String(event.error ?? `Pi rejected ${pending.command}`)));
      return;
    }
    if (pending.command === "prompt" && this.currentRun && !this.currentRun.promptAccepted) {
      this.currentRun.promptAccepted = true;
      this.currentRun.lifecycle = "running";
      this.currentRun.lifecycleEvents.push("prompt_accepted");
      this.currentRun.resolvePromptAccepted();
    }
    pending.resolve(event.data);
  }

  private finishRun(run: RpcRunState): void {
    if (run.settled || this.currentRun !== run) return;
    run.settled = true;
    this.clearRunTimers(run);
    if (run.signal && run.onAbort) run.signal.removeEventListener("abort", run.onAbort);
    const executions = [...run.executions.values()];
    const successfulToolExecutions = executions.filter(
      (execution) => execution.endedAt !== undefined && execution.isError === false,
    );
    const failedToolExecutions = executions.filter(
      (execution) => execution.endedAt !== undefined && execution.isError === true,
    );
    const result: RpcRunResult = {
      outputText: run.outputText,
      executions,
      successfulToolExecutions,
      failedToolExecutions,
      stderr: this.boundedStderr(),
      lifecycleEvents: [...run.lifecycleEvents, "agent_settled"],
      usage: run.usage,
      metrics: {
        turns: run.turnCount,
        retries: run.retryCount,
        successfulToolExecutions: successfulToolExecutions.length,
        failedToolExecutions: failedToolExecutions.length,
      },
    };
    this.lastRunResult = result;
    this.lastToolCalls = executions.map((execution) => ({
      name: execution.name,
      arguments: (execution.attemptedArgs ?? {}) as Record<string, unknown>,
      toolCallId: execution.toolCallId,
      isError: execution.isError,
    }));
    this.currentRun = null;
    run.resolvePromptAccepted();
    if (run.abortRequested) {
      run.reject(new Error("Aborted"));
      return;
    }
    if (run.assistantError && !run.retrySucceeded) {
      run.reject(new Error(run.assistantError));
      return;
    }
    run.resolve(result);
  }

  private failRun(error: Error, terminate = false): void {
    const run = this.currentRun;
    if (!run || run.settled) {
      if (terminate) this.terminateProcess();
      return;
    }
    run.settled = true;
    this.clearRunTimers(run);
    if (run.signal && run.onAbort) run.signal.removeEventListener("abort", run.onAbort);
    const executions = [...run.executions.values()];
    const successfulToolExecutions = executions.filter(
      (execution) => execution.endedAt !== undefined && execution.isError === false,
    );
    const failedToolExecutions = executions.filter(
      (execution) => execution.endedAt !== undefined && execution.isError === true,
    );
    this.lastRunResult = {
      outputText: run.outputText,
      executions,
      successfulToolExecutions,
      failedToolExecutions,
      stderr: this.boundedStderr(),
      lifecycleEvents: [...run.lifecycleEvents, `failed:${error.message}`],
      usage: run.usage,
      metrics: {
        turns: run.turnCount,
        retries: run.retryCount,
        successfulToolExecutions: successfulToolExecutions.length,
        failedToolExecutions: failedToolExecutions.length,
      },
    };
    this.lastToolCalls = executions.map((execution) => ({
      name: execution.name,
      arguments: (execution.attemptedArgs ?? {}) as Record<string, unknown>,
      toolCallId: execution.toolCallId,
      isError: execution.isError,
    }));
    this.currentRun = null;
    run.rejectPromptAccepted(error);
    run.reject(error);
    if (terminate) this.terminateProcess();
  }

  private protocolFailure(message: string): void {
    const error = new Error(`RPC protocol error: ${message}`);
    this.failRun(error, true);
    this.rejectPending(error);
    this.disposed = true;
  }

  private handleProcessError(error: Error): void {
    this.failRun(error, true);
    this.rejectPending(error);
  }

  private handleClose(code: number | null, signal: string | null): void {
    const tail = this.stdoutDecoder.end();
    this.stdoutBuffer += tail;
    if (this.stdoutBuffer.trim()) this.protocolFailure("partial final RPC JSONL record");
    this.stderr += this.stderrDecoder.end();
    const error = new Error(
      `${this.options.piCommand} exited before RPC completion (code=${code ?? "null"}, signal=${signal ?? "null"})${this.stderr ? `: ${this.boundedStderr()}` : ""}`,
    );
    this.failRun(error);
    this.rejectPending(error);
    this.proc = null;
    this.ready = false;
    this.startupPromise = null;
    this.cleanupPrompt();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private terminateProcess(): void {
    const proc = this.proc;
    if (!proc) return;
    this.closing = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* process already gone */
    }
    setTimeout(() => {
      if (this.proc !== proc) return;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* process already gone */
      }
    }, this.options.killGraceMs);
  }

  private clearRunTimers(run: RpcRunState): void {
    if (run.timeout) clearTimeout(run.timeout);
    if (run.abortTimeout) clearTimeout(run.abortTimeout);
    run.timeout = undefined;
    run.abortTimeout = undefined;
  }

  private boundedStderr(): string {
    return this.stderr.slice(-this.options.maxStderrBytes);
  }

  private cleanupPrompt(): void {
    if (this.tmpPromptPath) {
      try {
        fs.unlinkSync(this.tmpPromptPath);
      } catch {
        /* ignore */
      }
    }
    if (this.tmpPromptDir) {
      try {
        fs.rmdirSync(this.tmpPromptDir);
      } catch {
        /* ignore */
      }
    }
    this.tmpPromptPath = null;
    this.tmpPromptDir = null;
  }
}

/** Backwards-compatible name retained for existing extension consumers. */
export class RpcAgent extends PiRpcProcess {}
