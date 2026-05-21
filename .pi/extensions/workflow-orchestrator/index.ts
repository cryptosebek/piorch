import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { discoverAgents, findAgentByName } from "./agents.js";
import {
  loadWorkflowConfig,
  type WorkflowConfig,
  type WorkflowStage,
  type WorkflowTask,
  type WorkflowWave,
} from "./config.js";
import { runTaskFlow } from "./engine.js";
import { setPmWidgetStatus, setTaskListExpanded, updateStatus } from "./render.js";
import { RpcAgent } from "./runner.js";
import { appendState, restoreState, type TaskState, type WorkflowState } from "./state.js";
import { extractJson, normalizeGoal } from "./utils.js";

interface WorkflowRunHandle {
  abortController: AbortController;
  promise: Promise<void>;
}

const PM_MESSAGE_TYPE = "workflow-pm";

interface TaskRunner {
  key: string;
  agent: RpcAgent;
  stageId: string;
}

let currentRun: WorkflowRunHandle | null = null;
let currentState: WorkflowState | undefined;
let pmBusy = false;
let pmRunner: RpcAgent | null = null;
let statusInterval: ReturnType<typeof setInterval> | null = null;
const taskRunners = new Map<string, TaskRunner>();
const taskLocks = new Set<string>();
const clarificationWaiters = new Map<string, Set<() => void>>();

function setState(pi: ExtensionAPI, ctx: ExtensionContext, state: WorkflowState, persist = true) {
  const previousClarificationToken = currentState?.clarificationToken;
  const nextState = { ...state, updatedAt: Date.now() };
  currentState = nextState;
  if (persist) appendState(pi, nextState);
  updateStatus(ctx, nextState);
  if (
    previousClarificationToken &&
    (previousClarificationToken !== nextState.clarificationToken ||
      !nextState.waitingForClarification ||
      nextState.active === false)
  ) {
    signalClarificationResolved(previousClarificationToken);
  }
}

function startStatusTicker(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(() => {
    if (currentState) updateStatus(ctx, currentState);
  }, 1000);
}

function stopStatusTicker() {
  if (!statusInterval) return;
  clearInterval(statusInterval);
  statusInterval = null;
}

function getByPath(obj: any, path: string): any {
  const parts = path.split(".").filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const value = getByPath(data, path);
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.join("\n");
    return String(value);
  });
}

const MAX_TICKER_CHARS = 160;

function truncateTicker(text: string): string {
  if (text.length <= MAX_TICKER_CHARS) return text;
  const sliceLength = MAX_TICKER_CHARS - 1;
  return `…${text.slice(-sliceLength)}`;
}

function lastSentence(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/[^.!?]*[.!?](?=\s|$)/g);
  if (!match || match.length === 0) return normalized;
  return match[match.length - 1].trim();
}

function appendOutput(task: TaskState, chunk: string, mode: "delta" | "line") {
  const current = task.lastOutput ?? "";
  task.lastActivityAt = Date.now();
  if (mode === "delta") {
    const next = lastSentence(`${current} ${chunk}`);
    task.lastOutput = truncateTicker(next);
    return;
  }
  task.lastOutput = truncateTicker(chunk.replace(/\s+/g, " ").trim());
}

function sendPmMessage(pi: ExtensionAPI, text: string) {
  pi.sendMessage({
    customType: PM_MESSAGE_TYPE,
    content: text,
    display: true,
  });
}

function sendAgentSummary(pi: ExtensionAPI, task: TaskState, stageId: string, summary: string) {
  const agent = task.lastAgent ?? "agent";
  const title = task.title;
  const message = `${agent} (${stageId}) finished ${task.id}: ${title}\n${summary}`;
  pi.sendMessage({
    customType: PM_MESSAGE_TYPE,
    content: message,
    display: true,
  });
}

function setPmStatus(ctx: ExtensionContext, text?: string) {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("workflow-pm", text);
  setPmWidgetStatus(text ? text.replace(/^PM:\s*/i, "") : undefined);
}

function sendWorkflowNotice(pi: ExtensionAPI, text: string) {
  pi.sendMessage({
    customType: PM_MESSAGE_TYPE,
    content: text,
    display: true,
  });
}

function createClarificationToken(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function signalClarificationResolved(token?: string): void {
  if (!token) return;
  const waiters = clarificationWaiters.get(token);
  if (!waiters) return;
  clarificationWaiters.delete(token);
  for (const resolve of waiters) resolve();
}

function clearClarificationWaiters(): void {
  const tokens = Array.from(clarificationWaiters.keys());
  for (const token of tokens) signalClarificationResolved(token);
}

function resetTransientWorkflowState(): void {
  pmBusy = false;
  taskLocks.clear();
  clearClarificationWaiters();
}

function buildWaveSummary(state: WorkflowState): string {
  const lines = (state.tasks ?? []).map((task) => {
    const status =
      task.status === "verified" ? "verified" : task.status === "failed" ? "failed" : task.status;
    const note = task.lastNote ? ` — ${task.lastNote}` : "";
    const issues = task.issues?.length ? ` issues: ${task.issues.join("; ")}` : "";
    const devOutput = task.stageOutputs?.["develop"];
    const filesChanged = Array.isArray(devOutput?.filesChanged)
      ? ` files: ${devOutput.filesChanged.join(", ")}`
      : "";
    return `${task.id}: ${task.title} (${status})${note}${issues}${filesChanged}`;
  });
  return lines.join("\n");
}

function summarizeWave(wave: WorkflowWave): string {
  const lines = (wave.tasks ?? []).map((task) => `${task.id}: ${task.title}`);
  return [`PM generated wave: ${wave.goal}`, ...lines].join("\n");
}

function buildPmChatPrompt(state: WorkflowState, message: string): string {
  const summary = state.tasks.length > 0 ? buildWaveSummary(state) : "No tasks yet.";
  return [
    `Project goal: ${state.goal}`,
    `Current wave: ${state.waveIndex + 1}`,
    `Wave summary:\n${summary}`,
    "User message:",
    message,
    "Respond conversationally. Do NOT output JSON.",
  ].join("\n\n");
}

export async function waitForClarification(signal: AbortSignal, token: string): Promise<void> {
  if (signal.aborted) return;

  await new Promise<void>((resolve) => {
    const onAbort = () => {
      cleanup();
      resolve();
    };

    const onResolve = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      const waiters = clarificationWaiters.get(token);
      if (!waiters) return;
      waiters.delete(onResolve);
      if (waiters.size === 0) clarificationWaiters.delete(token);
    };

    let waiters = clarificationWaiters.get(token);
    if (!waiters) {
      waiters = new Set();
      clarificationWaiters.set(token, waiters);
    }
    waiters.add(onResolve);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function pauseForClarification(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
  waveIndex: number,
  previousSummary: string,
): Promise<void> {
  if (!currentState) throw new Error("No workflow state");

  sendWorkflowNotice(pi, "PM is waiting for your response...");
  const clarificationToken = createClarificationToken();
  setState(pi, ctx, {
    ...currentState,
    waveIndex,
    wave: undefined,
    tasks: [],
    updatedAt: Date.now(),
    previousSummary,
    waveSummaries: currentState.waveSummaries ?? [],
    active: true,
    waitingForClarification: true,
    clarificationToken,
  });

  await waitForClarification(signal, clarificationToken);
}

async function mapWithConcurrencyLimit<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

function buildTaskState(task: WorkflowTask): TaskState {
  return {
    ...task,
    status: "pending",
    retries: 0,
  };
}

function ensureSessionFile(state: WorkflowState, task: TaskState, stageId: string): string {
  const workflowDir = path.join(".pi", "workflows", "sessions", state.runId);
  fs.mkdirSync(workflowDir, { recursive: true });
  if (!task.sessionFiles) task.sessionFiles = {};
  if (!task.sessionFiles[stageId]) {
    task.sessionFiles[stageId] = path.join(workflowDir, `${task.id}-${stageId}.jsonl`);
  }
  return task.sessionFiles[stageId]!;
}

function slugify(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}

function ensurePmSessionFile(state: WorkflowState): string {
  const workflowDir = path.join(".pi", "workflows", "sessions");
  fs.mkdirSync(workflowDir, { recursive: true });
  const name = slugify(state.workflowName || "default");
  return path.join(workflowDir, `pm-${name}.jsonl`);
}

function resolveAllowedExtensions(
  agentName: string,
  config: WorkflowConfig,
  state?: WorkflowState,
): string[] | undefined {
  // Try to find the role by matching agentName to config.agents values
  // This supports custom agent roles beyond pm/developer/verifier
  const role = Object.entries(config.agents).find(([, name]) => name === agentName)?.[0];

  if (role) {
    return (
      state?.allowedExtensionsByAgent?.[role as keyof typeof state.allowedExtensionsByAgent] ??
      config.allowedExtensionsByAgent?.[role as keyof typeof config.allowedExtensionsByAgent] ??
      state?.allowedExtensions ??
      config.allowedExtensions
    );
  }

  return state?.allowedExtensions ?? config.allowedExtensions;
}

function getRunnerKey(taskId: string, stageId: string): string {
  return `${taskId}:${stageId}`;
}

function findTask(taskId: string): TaskState | undefined {
  return currentState?.tasks.find((task) => task.id === taskId);
}

function getTaskRunner(
  ctx: ExtensionContext,
  config: WorkflowConfig,
  task: TaskState,
  stage: WorkflowStage,
  agentName: string,
  agents: ReturnType<typeof discoverAgents>["agents"],
): TaskRunner {
  if (!currentState) throw new Error("No workflow state");
  const key = getRunnerKey(task.id, stage.id);
  const existing = taskRunners.get(key);
  if (existing) return existing;

  const agent = findAgentByName(agents, agentName);
  if (!agent) throw new Error(`Agent not found: ${agentName}`);

  const sessionFile = ensureSessionFile(currentState, task, stage.id);
  const runner = new RpcAgent({
    cwd: ctx.cwd,
    sessionFile,
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    tools: agent.tools,
    allowedExtensions: resolveAllowedExtensions(agentName, config, currentState),
  });

  const taskRunner: TaskRunner = { key, agent: runner, stageId: stage.id };
  taskRunners.set(key, taskRunner);
  return taskRunner;
}

function stopTask(task: TaskState) {
  if (!task.stageId) return;
  const key = getRunnerKey(task.id, task.stageId);
  const runner = taskRunners.get(key);
  runner?.agent.abort();
  task.status = "stopped";
  task.lastNote = "stopped";
}

function resetStageMemory(task: TaskState, stageId: string) {
  if (!currentState) return;
  const key = getRunnerKey(task.id, stageId);
  const runner = taskRunners.get(key);
  runner?.agent.dispose();
  taskRunners.delete(key);

  const workflowDir = path.join(".pi", "workflows", "sessions", currentState.runId);
  fs.mkdirSync(workflowDir, { recursive: true });
  if (!task.sessionResetCounts) task.sessionResetCounts = {};
  const nextReset = (task.sessionResetCounts[stageId] ?? 0) + 1;
  task.sessionResetCounts[stageId] = nextReset;
  if (!task.sessionFiles) task.sessionFiles = {};
  task.sessionFiles[stageId] = path.join(workflowDir, `${task.id}-${stageId}-r${nextReset}.jsonl`);
}

async function messageTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: WorkflowConfig,
  task: TaskState,
  message: string,
  agents: ReturnType<typeof discoverAgents>["agents"],
) {
  if (!task.stageId) throw new Error("Task has no active stage");

  // Prevent concurrent modifications to the same task
  if (taskLocks.has(task.id)) {
    throw new Error(`Task ${task.id} is already being modified`);
  }

  taskLocks.add(task.id);
  try {
    const stage = findStageById(config.taskFlow.stages, task.stageId);
    if (!stage) throw new Error(`Stage not found: ${task.stageId}`);

    const key = getRunnerKey(task.id, task.stageId);
    const runner = taskRunners.get(key);
    if (runner) {
      if (!currentState) throw new Error("No workflow state");
      task.lastNote = "running";
      task.status = "in_progress";
      setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
      if (runner.agent.isRunning()) {
        runner.agent.sendSteer(message);
        return;
      }
      const taskPrompt = `${message}`;
      void runner.agent.runPrompt(taskPrompt).catch(() => {
        // handled by processTask when re-run
      });
      return;
    }

    if (!currentState?.wave) throw new Error("No active wave");
    task.resumeMessage = message;
    task.lastNote = "running";
    task.status = "in_progress";
    setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
    void processTask(
      pi,
      ctx,
      config,
      task,
      currentState.wave,
      agents,
      new AbortController().signal,
      task.stageId,
    );
  } finally {
    taskLocks.delete(task.id);
  }
}

function findStageById(stages: WorkflowStage[], id: string): WorkflowStage | undefined {
  return stages.find((stage) => stage.id === id);
}

function getNextStageId(stages: WorkflowStage[], currentStageId: string): string | undefined {
  const index = stages.findIndex((stage) => stage.id === currentStageId);
  if (index === -1) return undefined;
  return stages[index + 1]?.id;
}

async function processTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: WorkflowConfig,
  task: TaskState,
  wave: WorkflowWave,
  agents: ReturnType<typeof discoverAgents>["agents"],
  signal: AbortSignal,
  startStageId?: string,
): Promise<void> {
  const stages = config.taskFlow.stages;

  await runTaskFlow<TaskState, { output: any; outputText: string }>({
    task,
    stages,
    maxRetries: config.maxTaskRetries ?? 2,
    startStageId: startStageId,
    isStopped: (t) => t.status === "stopped" || signal.aborted,
    onStageStart: (stage, t) => {
      if (!currentState) return; // Guard against workflow stop during execution
      const workflowStage = stage as WorkflowStage;
      t.status = "in_progress";
      t.stageId = workflowStage.id;
      t.lastAgent = workflowStage.agent;
      t.lastNote = "running";
      t.lastOutput = undefined;
      t.lastActivityAt = Date.now();
      setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
    },
    runStage: async (stage, t) => {
      const workflowStage = stage as WorkflowStage;
      const templateData = {
        task: {
          ...t,
          stageOutputs: t.stageOutputs ?? {},
          issues: t.issues,
        },
        workflow: { goal: config.goal },
        wave: { goal: wave.goal, index: currentState?.waveIndex ?? 0 },
      };

      let taskPrompt = renderTemplate(
        workflowStage.inputTemplate,
        templateData as Record<string, unknown>,
      );
      if (t.resumeMessage) {
        taskPrompt = `${taskPrompt}\n\nAdditional instruction:\n${t.resumeMessage}`;
        t.resumeMessage = undefined;
      }

      const runner = getTaskRunner(ctx, config, t, workflowStage, workflowStage.agent, agents);
      const outputText = await runner.agent.runPrompt(taskPrompt, {
        onUpdate: (update) => {
          if (!currentState) return;
          if (update.type === "text_delta") {
            appendOutput(t, update.delta, "delta");
            setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] }, false);
            return;
          }
          if (update.type === "tool_start") {
            appendOutput(t, `tool ${update.toolName}`, "line");
            setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] }, false);
          }
        },
      });

      // Get tool calls from the runner - prefer structured tool output over JSON parsing
      const toolCalls = runner.agent.getLastToolCalls();
      let output: any = null;

      // Look for report_task_result or generate_wave tool calls
      const reportCall = toolCalls.find((tc) => tc.name === "report_task_result");
      const waveCall = toolCalls.find((tc) => tc.name === "generate_wave");

      if (reportCall) {
        // Use the tool arguments directly as output
        output = reportCall.arguments as Record<string, unknown>;
      } else if (waveCall) {
        output = waveCall.arguments as Record<string, unknown>;
      } else {
        // Fallback to JSON parsing for backward compatibility
        try {
          output = extractJson(outputText);
        } catch {
          // If no tool was called and JSON parsing fails, return null output
          output = null;
        }
      }

      return { output, outputText, toolCalls };
    },
    applyOutput: (t, stageId, result) => {
      if (!currentState) return; // Guard against workflow stop during execution

      const output = result.output;

      // Initialize stageOutputs if needed
      if (!t.stageOutputs) t.stageOutputs = {};

      // Fallback: if output is null but we have text, use the text as summary
      if (output === null && result.outputText) {
        const textSummary = result.outputText.split("\n").slice(0, 3).join(" ").trim();
        if (stageId === "develop") {
          t.stageOutputs[stageId] = { summary: textSummary, filesChanged: [] };
        }
        t.lastNote = textSummary.slice(0, 80);
      } else {
        t.stageOutputs[stageId] = output;

        if (typeof output?.status === "string") {
          t.lastNote = String(output.status);
        } else if (typeof output?.summary === "string") {
          t.lastNote = output.summary.slice(0, 80);
        } else {
          t.lastNote = "completed";
        }
      }

      const tickerSource =
        typeof output?.summary === "string"
          ? output.summary
          : (result.outputText.split("\n")[0] ?? "");
      t.lastOutput = truncateTicker(tickerSource.trim());
      t.lastActivityAt = Date.now();

      if (stageId === "develop") {
        const summary =
          typeof output?.summary === "string"
            ? output.summary
            : output === null
              ? (result.outputText.split("\n")[0] ?? "completed")
              : JSON.stringify(output);
        sendAgentSummary(pi, t, stageId, summary);
      }
      if (stageId === "verify") {
        const status = output?.status ? String(output.status) : "unknown";
        const issues = Array.isArray(output?.issues) ? output.issues.join("; ") : "";
        const summary = issues ? `${status}\nissues: ${issues}` : status;
        sendAgentSummary(pi, t, stageId, summary);
      }

      const key = t.stageId ? getRunnerKey(t.id, t.stageId) : undefined;
      if (key) {
        const runner = taskRunners.get(key);
        runner?.agent.dispose();
        taskRunners.delete(key);
      }

      setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
    },
    applyVerifyFailure: (t, stageId, result, errorMessage, reason = "verification_failed") => {
      if (!currentState) return; // Guard against workflow stop during execution
      const output = result?.output;
      const issues = output?.issues ?? (errorMessage ? [errorMessage] : []);
      if (!t.stageOutputs) t.stageOutputs = {};
      t.stageOutputs[stageId] = { status: "fail", issues };
      t.issues = Array.isArray(issues) ? issues.map(String) : [String(issues)];
      t.lastNote = errorMessage ? `error: ${errorMessage}` : "fail";
      if (errorMessage) t.lastOutput = truncateTicker(errorMessage);

      const keepDeveloperMemory = config.taskFlow.memory?.keepDeveloperMemory ?? true;
      const keepVerifierMemoryOnDeveloperFailure =
        config.taskFlow.memory?.keepVerifierMemoryOnDeveloperFailure ?? true;
      const verifierSelfFailureMemory = config.taskFlow.memory?.verifierSelfFailureMemory ?? "keep";

      if ((reason === "verification_failed" || reason === "error") && !keepDeveloperMemory) {
        resetStageMemory(t, "develop");
      }
      if (reason === "verification_failed" && !keepVerifierMemoryOnDeveloperFailure) {
        resetStageMemory(t, "verify");
      }
      if (reason === "malformed_output") {
        if (
          verifierSelfFailureMemory === "reset" ||
          verifierSelfFailureMemory === "reset_on_malformed_output"
        ) {
          resetStageMemory(t, "verify");
        }
      } else if (reason === "error" && verifierSelfFailureMemory === "reset") {
        resetStageMemory(t, "verify");
      }

      setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
    },
    applyGenericFailure: (t, errorMessage) => {
      if (!currentState) return; // Guard against workflow stop during execution
      t.issues = [errorMessage];
      t.lastNote = `error: ${errorMessage}`;
      t.lastOutput = truncateTicker(errorMessage);
      setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
    },
    markVerified: (t, stageId) => {
      if (!currentState) return; // Guard against workflow stop during execution
      t.status = "verified";
      t.stageId = stageId;
      setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
    },
    markFailed: (t, stageId) => {
      if (!currentState) return; // Guard against workflow stop during execution
      t.status = "failed";
      t.stageId = stageId;
      setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
    },
    getField: getByPath,
    getNextStageId: (stagesList, stageId) => getNextStageId(stagesList as WorkflowStage[], stageId),
  });
}

async function runWaveWithTasks(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: WorkflowConfig,
  wave: WorkflowWave,
  tasks: TaskState[],
  agents: ReturnType<typeof discoverAgents>["agents"],
  signal: AbortSignal,
): Promise<void> {
  const newState: WorkflowState = {
    ...currentState!,
    wave,
    tasks,
    updatedAt: Date.now(),
    previousSummary: currentState?.previousSummary,
    waveSummaries: currentState?.waveSummaries ?? [],
  };
  setState(pi, ctx, newState);

  const runnable = tasks.filter(
    (task) =>
      task.status === "pending" || task.status === "in_progress" || task.status === "stopped",
  );

  await mapWithConcurrencyLimit(runnable, config.parallelism ?? 1, async (task) =>
    processTask(pi, ctx, config, task, wave, agents, signal, task.stageId),
  );
}

async function runWave(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: WorkflowConfig,
  wave: WorkflowWave,
  agents: ReturnType<typeof discoverAgents>["agents"],
  signal: AbortSignal,
): Promise<void> {
  const tasks = (wave.tasks ?? []).map(buildTaskState);
  await runWaveWithTasks(pi, ctx, config, wave, tasks, agents, signal);
}

function disposePmRunner() {
  if (!pmRunner) return;
  pmRunner.abort();
  pmRunner.dispose();
  pmRunner = null;
}

function getPmRunner(
  ctx: ExtensionContext,
  config: WorkflowConfig,
  agents: ReturnType<typeof discoverAgents>["agents"],
): RpcAgent {
  if (!currentState) throw new Error("No workflow state");
  if (pmRunner) return pmRunner;

  const pmAgent = findAgentByName(agents, config.agents.pm);
  if (!pmAgent) throw new Error(`PM agent not found: ${config.agents.pm}`);

  const sessionFile = ensurePmSessionFile(currentState);
  pmRunner = new RpcAgent({
    cwd: ctx.cwd,
    sessionFile,
    systemPrompt: pmAgent.systemPrompt,
    model: pmAgent.model,
    tools: pmAgent.tools,
    allowedExtensions: resolveAllowedExtensions(pmAgent.name, config, currentState),
  });
  return pmRunner;
}

async function runPmAgent(
  pi: ExtensionAPI,
  config: WorkflowConfig,
  agents: ReturnType<typeof discoverAgents>["agents"],
  ctx: ExtensionContext,
  signal: AbortSignal,
  prompt: string,
): Promise<string> {
  if (pmBusy) throw new Error("PM is already running");
  pmBusy = true;
  setPmStatus(ctx, "PM: responding...");
  try {
    const runner = getPmRunner(ctx, config, agents);
    return await runner.runPrompt(prompt, { signal });
  } catch (error) {
    // Dispose runner on error to prevent resource leaks
    disposePmRunner();
    throw error;
  } finally {
    pmBusy = false;
    setPmStatus(ctx, undefined);
  }
}

async function generateWaveFromPm(
  pi: ExtensionAPI,
  config: WorkflowConfig,
  agents: ReturnType<typeof discoverAgents>["agents"],
  ctx: ExtensionCommandContext,
  signal: AbortSignal,
  previousSummary: string,
  errorMessage?: string,
): Promise<{ done: boolean; wave?: WorkflowWave; clarification?: string }> {
  const promptParts = [`Project goal: ${config.goal}`];

  if (previousSummary) {
    promptParts.push(`Previous wave summary:\n${previousSummary}`);
  }

  if (errorMessage) {
    promptParts.push(`\nError from previous attempt: ${errorMessage}`);
    promptParts.push("Please fix this and call generate_wave again with a valid wave object.");
  }

  promptParts.push(
    "Call the generate_wave tool with your response. If you need clarification from the user, respond conversationally instead.",
  );

  const prompt = promptParts.join("\n\n");
  const outputText = await runPmAgent(pi, config, agents, ctx, signal, prompt);

  // Get tool calls from PM runner - prefer structured tool output
  const runner = getPmRunner(ctx, config, agents);
  const toolCalls = runner.getLastToolCalls();
  const waveCall = toolCalls.find((tc) => tc.name === "generate_wave");

  let output: any;
  if (waveCall) {
    output = waveCall.arguments as Record<string, unknown>;
  } else {
    // Try JSON parsing for backward compatibility
    try {
      output = extractJson(outputText || "");
    } catch {
      output = null;
    }
  }

  if (output?.done === true) {
    sendPmMessage(pi, "PM reports: all work is complete.");
    return { done: true };
  }

  if (output?.wave) {
    const wave = output.wave as WorkflowWave;
    // Validate wave structure before using it
    if (!wave.tasks || !Array.isArray(wave.tasks)) {
      throw new Error('generate_wave returned invalid wave - "tasks" is missing or not an array');
    }
    sendPmMessage(pi, summarizeWave(wave));
    return { done: false, wave };
  }

  // PM didn't call tool or return JSON - treat as clarification request
  if (outputText && outputText.trim()) {
    sendPmMessage(pi, outputText);
    return { done: false, clarification: outputText };
  }

  throw new Error("PM output missing wave");
}

async function resolveWaveForIndex(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: WorkflowConfig,
  agents: ReturnType<typeof discoverAgents>["agents"],
  signal: AbortSignal,
  previousSummary: string,
  waveIndex: number,
  currentWave?: WorkflowWave,
  currentTasks?: TaskState[],
): Promise<{
  wave?: WorkflowWave;
  tasks?: TaskState[];
  done?: boolean;
  clarification?: boolean;
}> {
  if (currentWave && currentTasks) {
    return { wave: currentWave, tasks: currentTasks };
  }

  if (config.waveSource.type === "static") {
    const wave = config.waveSource.staticWaves?.[waveIndex];
    if (!wave) return { done: true };
    return { wave, tasks: wave.tasks.map(buildTaskState) };
  }

  const maxPmRetries = config.maxPmRetries ?? 3;
  let pmResult: Awaited<ReturnType<typeof generateWaveFromPm>> | null = null;
  let pmAttempts = 0;
  let lastError: string | undefined;

  while (pmAttempts < maxPmRetries) {
    try {
      pmResult = await generateWaveFromPm(
        pi,
        config,
        agents,
        ctx,
        signal,
        previousSummary,
        lastError,
      );
      if (pmResult.done) return { done: true };
      if (pmResult.wave) {
        return { wave: pmResult.wave, tasks: pmResult.wave.tasks.map(buildTaskState) };
      }

      // PM returned clarification - surface it and let the caller wait for user input.
      return { done: false, clarification: true };
    } catch (error: any) {
      lastError = error.message;
      pmAttempts++;
      if (pmAttempts >= maxPmRetries) throw error;
    }
  }

  return { done: true };
}

async function resumeWorkflow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (currentRun) {
    if (ctx.hasUI) ctx.ui.notify("Workflow already running", "warning");
    return;
  }
  if (!currentState) {
    if (ctx.hasUI) ctx.ui.notify("No workflow state to resume", "warning");
    return;
  }

  const { config } = loadWorkflowConfig(ctx.cwd, currentState.workflowName);
  const { agents } = discoverAgents(ctx.cwd);
  const effectiveConfig: WorkflowConfig = { ...config, goal: currentState.goal };

  const abortController = new AbortController();
  const runPromise = (async () => {
    try {
      setState(pi, ctx, { ...currentState!, active: true });
      sendWorkflowNotice(pi, "Workflow resumed.");

      let previousSummary = currentState?.previousSummary ?? "";

      for (
        let waveIndex = currentState!.waveIndex;
        waveIndex < (effectiveConfig.maxWaves ?? 10);
        waveIndex++
      ) {
        if (abortController.signal.aborted) throw new Error("Workflow aborted");

        const hasExistingWave =
          waveIndex === currentState!.waveIndex &&
          currentState?.wave &&
          currentState.tasks.length > 0;
        const resolved = await resolveWaveForIndex(
          pi,
          ctx,
          effectiveConfig,
          agents,
          abortController.signal,
          previousSummary,
          waveIndex,
          hasExistingWave ? currentState!.wave : undefined,
          hasExistingWave ? currentState!.tasks : undefined,
        );
        if (resolved.done) break;
        if (resolved.clarification) {
          await pauseForClarification(pi, ctx, abortController.signal, waveIndex, previousSummary);
          waveIndex -= 1;
          continue;
        }
        if (!resolved.wave || !resolved.tasks) continue;

        const { wave, tasks } = resolved;

        const updatedState: WorkflowState = {
          ...currentState!,
          waveIndex,
          wave,
          tasks,
          updatedAt: Date.now(),
          previousSummary,
          waveSummaries: currentState?.waveSummaries ?? [],
          active: true,
        };
        setState(pi, ctx, updatedState);

        await runWaveWithTasks(
          pi,
          ctx,
          effectiveConfig,
          wave,
          tasks,
          agents,
          abortController.signal,
        );

        previousSummary = buildWaveSummary(currentState!);
        const summaries = currentState?.waveSummaries ?? [];
        const nextSummaries = [...summaries, previousSummary];
        if (currentState) {
          setState(pi, ctx, {
            ...currentState,
            previousSummary,
            waveSummaries: nextSummaries,
          });
        }
      }

      const finalState: WorkflowState = {
        ...currentState!,
        active: false,
        waitingForClarification: false,
        clarificationToken: undefined,
        updatedAt: Date.now(),
      };
      setState(pi, ctx, finalState);
      sendWorkflowNotice(pi, "Workflow completed.");
      if (ctx.hasUI) ctx.ui.notify("Workflow completed", "info");
    } catch (error: any) {
      const message = error?.message || "Workflow failed";
      sendWorkflowNotice(pi, `Workflow error: ${message}`);
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      if (currentState) {
        setState(pi, ctx, {
          ...currentState,
          active: false,
          waitingForClarification: false,
          clarificationToken: undefined,
          updatedAt: Date.now(),
        });
      }
    } finally {
      disposePmRunner();
      currentRun = null;
    }
  })();

  currentRun = { abortController, promise: runPromise };
}

async function startWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  workflowName: string,
  goalOverride?: string,
): Promise<void> {
  if (currentRun) {
    if (ctx.hasUI) ctx.ui.notify("Workflow already running", "warning");
    return;
  }

  const { config } = loadWorkflowConfig(ctx.cwd, workflowName);
  const { agents } = discoverAgents(ctx.cwd);
  const effectiveConfig: WorkflowConfig = {
    ...config,
    goal: goalOverride ?? config.goal,
  };

  const abortController = new AbortController();
  const runPromise = (async () => {
    try {
      const initialState: WorkflowState = {
        runId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        workflowName: effectiveConfig.name,
        goal: effectiveConfig.goal,
        active: true,
        waveIndex: 0,
        tasks: [],
        updatedAt: Date.now(),
        allowedExtensions: effectiveConfig.allowedExtensions,
        allowedExtensionsByAgent: effectiveConfig.allowedExtensionsByAgent,
        previousSummary: "",
        waveSummaries: [],
      };
      setState(pi, ctx, initialState);
      sendWorkflowNotice(pi, `Workflow started: ${effectiveConfig.goal}`);

      let previousSummary = initialState.previousSummary ?? "";

      for (let waveIndex = 0; waveIndex < (effectiveConfig.maxWaves ?? 10); waveIndex++) {
        if (abortController.signal.aborted) throw new Error("Workflow aborted");
        const resolved = await resolveWaveForIndex(
          pi,
          ctx,
          effectiveConfig,
          agents,
          abortController.signal,
          previousSummary,
          waveIndex,
        );
        if (resolved.done) break;
        if (resolved.clarification) {
          await pauseForClarification(pi, ctx, abortController.signal, waveIndex, previousSummary);
          waveIndex -= 1;
          continue;
        }
        if (!resolved.wave || !resolved.tasks) continue;
        const { wave } = resolved;
        const updatedState: WorkflowState = {
          ...currentState!,
          waveIndex,
          wave,
          tasks: [],
          updatedAt: Date.now(),
          previousSummary,
          waveSummaries: currentState?.waveSummaries ?? [],
        };
        setState(pi, ctx, updatedState);

        await runWave(pi, ctx, effectiveConfig, wave, agents, abortController.signal);

        previousSummary = buildWaveSummary(currentState!);
        const summaries = currentState?.waveSummaries ?? [];
        const nextSummaries = [...summaries, previousSummary];
        if (currentState) {
          setState(pi, ctx, {
            ...currentState,
            previousSummary,
            waveSummaries: nextSummaries,
          });
        }
      }

      const finalState: WorkflowState = {
        ...currentState!,
        active: false,
        waitingForClarification: false,
        clarificationToken: undefined,
        updatedAt: Date.now(),
      };
      setState(pi, ctx, finalState);
      sendWorkflowNotice(pi, "Workflow completed.");
      if (ctx.hasUI) ctx.ui.notify("Workflow completed", "info");
    } catch (error: any) {
      const message = error?.message || "Workflow failed";
      sendWorkflowNotice(pi, `Workflow error: ${message}`);
      if (ctx.hasUI) ctx.ui.notify(message, "error");
      if (currentState) {
        setState(pi, ctx, {
          ...currentState,
          active: false,
          waitingForClarification: false,
          clarificationToken: undefined,
          updatedAt: Date.now(),
        });
      }
    } finally {
      disposePmRunner();
      currentRun = null;
    }
  })();

  currentRun = { abortController, promise: runPromise };
}

async function stopWorkflow(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (!currentRun) {
    if (ctx.hasUI) ctx.ui.notify("No active workflow", "warning");
    return;
  }
  const runPromise = currentRun.promise;
  currentRun.abortController.abort();
  currentRun = null;
  for (const runner of taskRunners.values()) {
    runner.agent.abort();
    runner.agent.dispose();
  }
  taskRunners.clear();
  disposePmRunner();
  if (currentState) {
    currentState.active = false;
    currentState.waitingForClarification = false;
    currentState.clarificationToken = undefined;
    setState(pi, ctx, currentState);
  }
  resetTransientWorkflowState();
  sendWorkflowNotice(pi, "Workflow stopped.");
  if (ctx.hasUI) ctx.ui.notify("Workflow stopped", "info");
  await runPromise.catch(() => {});
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    currentState = restoreState(ctx);
    if (currentState?.active) {
      setState(pi, ctx, {
        ...currentState,
        active: false,
        waitingForClarification: false,
        clarificationToken: undefined,
      });
    } else if (currentState) {
      updateStatus(ctx, currentState);
    }
    setPmStatus(ctx, undefined);
    taskRunners.clear();
    disposePmRunner();
    resetTransientWorkflowState();
    startStatusTicker(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopStatusTicker();
    if (currentRun) {
      currentRun.abortController.abort();
      currentRun = null;
    }
    for (const runner of taskRunners.values()) {
      runner.agent.abort();
      runner.agent.dispose();
    }
    taskRunners.clear();
    disposePmRunner();
    if (currentState) {
      currentState.active = false;
      currentState.waitingForClarification = false;
      currentState.clarificationToken = undefined;
      currentState.tasks = (currentState.tasks ?? []).map((task) => {
        if (task.status === "in_progress") {
          return { ...task, status: "stopped", lastNote: "stopped" };
        }
        return task;
      });
      setState(pi, ctx, currentState);
    }
    resetTransientWorkflowState();
  });

  pi.on("input", async (event, ctx) => {
    if (!currentState?.active) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    if (event.text.trim().startsWith("/")) return { action: "continue" };
    if (pmBusy) {
      if (ctx.hasUI) ctx.ui.notify("PM is busy. Try again shortly.", "warning");
      return { action: "handled" };
    }

    try {
      const { config } = loadWorkflowConfig(ctx.cwd, currentState.workflowName);
      const { agents } = discoverAgents(ctx.cwd);
      const effectiveConfig: WorkflowConfig = { ...config, goal: currentState.goal };

      // If waiting for clarification, include that context
      const prompt = buildPmChatPrompt(currentState, event.text);
      const outputText = await runPmAgent(
        pi,
        effectiveConfig,
        agents,
        ctx,
        new AbortController().signal,
        prompt,
      );
      sendPmMessage(pi, outputText);

      // Clear the clarification flag - user has responded
      if (currentState.waitingForClarification) {
        setState(pi, ctx, {
          ...currentState,
          waitingForClarification: false,
          clarificationToken: undefined,
        });
      }

      return { action: "handled" };
    } catch (error: any) {
      if (ctx.hasUI) ctx.ui.notify(error?.message || "PM chat failed", "error");
      return { action: "handled" };
    }
  });

  pi.registerCommand("workflow", {
    description: "Manage workflow orchestrator",
    handler: async (args, ctx) => {
      const tokens = (args || "").split(/\s+/).filter(Boolean);
      const command = tokens[0];
      const name = tokens[1];
      const goalText = normalizeGoal(tokens.slice(2).join(" "));

      if (!command || command === "help") {
        sendWorkflowNotice(
          pi,
          [
            "Workflow commands:",
            "  /workflow start <name> [goal]",
            "  /workflow resume",
            "  /workflow status",
            "  /workflow stop",
            "  /workflow stop-task <id>",
            "  /workflow message <id> <message>",
            "  /workflow expand",
            "  /workflow collapse",
            "Example:",
            '  /workflow start default "Build a Telegram bot"',
          ].join("\n"),
        );
        return;
      }

      if (command === "start") {
        if (!name) {
          ctx.ui?.notify("Usage: /workflow start <name> [goal]", "warning");
          return;
        }
        if (currentState && !currentState.active) {
          ctx.ui?.notify("Existing workflow state found. Use /workflow resume.", "warning");
          return;
        }
        void startWorkflow(pi, ctx, name, goalText);
        return;
      }

      if (command === "resume") {
        void resumeWorkflow(pi, ctx);
        return;
      }

      if (command === "status") {
        if (!currentState) {
          ctx.ui?.notify("No workflow state", "info");
          return;
        }
        updateStatus(ctx, currentState);
        return;
      }

      if (command === "stop") {
        await stopWorkflow(pi, ctx);
        return;
      }

      if (command === "stop-task") {
        if (!currentState) {
          ctx.ui?.notify("No workflow state", "info");
          return;
        }
        if (!name) {
          ctx.ui?.notify("Usage: /workflow stop-task <id>", "warning");
          return;
        }
        const task = findTask(name);
        if (!task) {
          ctx.ui?.notify(`Task not found: ${name}`, "warning");
          return;
        }
        stopTask(task);
        setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
        return;
      }

      if (command === "message") {
        if (!currentState) {
          ctx.ui?.notify("No workflow state", "info");
          return;
        }
        if (!name) {
          ctx.ui?.notify("Usage: /workflow message <id> <message>", "warning");
          return;
        }
        const message = tokens.slice(2).join(" ");
        if (!message) {
          ctx.ui?.notify("Usage: /workflow message <id> <message>", "warning");
          return;
        }
        const task = findTask(name);
        if (!task) {
          ctx.ui?.notify(`Task not found: ${name}`, "warning");
          return;
        }
        const { config } = loadWorkflowConfig(ctx.cwd, currentState.workflowName);
        const { agents } = discoverAgents(ctx.cwd);
        void messageTask(pi, ctx, config, task, message, agents);
        return;
      }

      if (command === "expand") {
        setTaskListExpanded(true);
        if (currentState) updateStatus(ctx, currentState);
        return;
      }

      if (command === "collapse") {
        setTaskListExpanded(false);
        if (currentState) updateStatus(ctx, currentState);
        return;
      }

      ctx.ui?.notify(
        "Usage: /workflow start|resume|status|stop|stop-task|message|expand|collapse",
        "warning",
      );
    },
  });

  pi.registerMessageRenderer(PM_MESSAGE_TYPE, (message, _options, theme) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => {
              if (typeof part === "string") return part;
              if (part.type === "text") return part.text;
              return "";
            })
            .join("");
    const text = theme.fg("toolTitle", content);
    return new Text(text, 0, 0);
  });

  pi.registerTool({
    name: "workflow_run",
    label: "Workflow Run",
    description: "Start a workflow by name (optional goal override).",
    parameters: Type.Object({
      name: Type.String({ description: "Workflow name" }),
      goal: Type.Optional(Type.String({ description: "Optional goal override" })),
    }),
    async execute(_toolCallId, params) {
      const goal = normalizeGoal(params.goal);
      const command = goal
        ? `/workflow start ${params.name} "${goal}"`
        : `/workflow start ${params.name}`;
      pi.sendUserMessage(command, { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: `Queued workflow start: ${params.name}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "workflow_stop_task",
    label: "Workflow Stop Task",
    description: "Stop a task by id without discarding progress.",
    parameters: Type.Object({
      id: Type.String({ description: "Task id" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!currentState)
        return { content: [{ type: "text", text: "No workflow state." }], details: {} };
      const task = findTask(params.id);
      if (!task)
        return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
      stopTask(task);
      setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
      return { content: [{ type: "text", text: `Stopped task ${params.id}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "workflow_message_task",
    label: "Workflow Message Task",
    description: "Send a message to a running task or resume a stopped task.",
    parameters: Type.Object({
      id: Type.String({ description: "Task id" }),
      message: Type.String({ description: "Message to send" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!currentState)
        return { content: [{ type: "text", text: "No workflow state." }], details: {} };
      const task = findTask(params.id);
      if (!task)
        return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
      const { config } = loadWorkflowConfig(ctx.cwd, currentState.workflowName);
      const { agents } = discoverAgents(ctx.cwd);
      await messageTask(pi, ctx, config, task, params.message, agents);
      return {
        content: [{ type: "text", text: `Sent message to task ${params.id}` }],
        details: {},
      };
    },
  });
}
