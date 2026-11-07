import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Text } from "@mariozechner/pi-tui";
import { discoverAgents, findAgentByName } from "./agents.js";
import {
  loadWorkflowConfig,
  validateWave,
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
import { TaskResultSchema } from "../workflow-task-tools/index.js";
import { PmResultSchema } from "../workflow-pm-tools/index.js";

interface WorkflowRunHandle {
  abortController: AbortController;
  promise: Promise<void>;
}

const PM_MESSAGE_TYPE = "workflow-pm";
const FallbackTaskResultSchema = Type.Omit(TaskResultSchema, ["status"]);

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
const taskExecutions = new Map<string, WorkflowRunHandle>();
let pmRunPromise: Promise<string> | null = null;
const workflowWaiters = new Map<string, Set<() => void>>();

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
    signalWorkflowEvent(previousClarificationToken);
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

function reportWorkflowError(pi: ExtensionAPI, ctx: ExtensionContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendWorkflowNotice(pi, `Workflow error: ${message}`);
  if (ctx.hasUI) ctx.ui.notify(message, "error");
}

function createClarificationToken(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function signalWorkflowEvent(token?: string): void {
  if (!token) return;
  const waiters = workflowWaiters.get(token);
  if (!waiters) return;
  workflowWaiters.delete(token);
  for (const resolve of waiters) resolve();
}

function clearWorkflowWaiters(): void {
  const tokens = Array.from(workflowWaiters.keys());
  for (const token of tokens) signalWorkflowEvent(token);
}

function resetTransientWorkflowState(): void {
  pmBusy = false;
  taskLocks.clear();
  clearWorkflowWaiters();
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

export async function waitForWorkflowEvent(signal: AbortSignal, token: string): Promise<void> {
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
      const waiters = workflowWaiters.get(token);
      if (!waiters) return;
      waiters.delete(onResolve);
      if (waiters.size === 0) workflowWaiters.delete(token);
    };

    let waiters = workflowWaiters.get(token);
    if (!waiters) {
      waiters = new Set();
      workflowWaiters.set(token, waiters);
    }
    waiters.add(onResolve);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function pauseForClarification(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
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

  await waitForWorkflowEvent(signal, clarificationToken);
}

function buildTaskState(task: WorkflowTask): TaskState {
  return {
    ...task,
    status: "pending",
    retries: 0,
  };
}

function ensureSessionFile(
  cwd: string,
  state: WorkflowState,
  task: TaskState,
  stageId: string,
): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(state.runId)) throw new Error("Invalid workflow run ID");
  const runDir = path.join(cwd, ".pi", "workflows", "sessions", state.runId);
  const waveDir = path.join(runDir, `wave-${state.waveIndex}`);
  task.sessionFiles ??= {};
  const sessionFile = path.resolve(
    cwd,
    task.sessionFiles[stageId] ?? path.join(waveDir, `${task.id}-${stageId}.jsonl`),
  );
  if (!sessionFile.startsWith(`${runDir}${path.sep}`))
    throw new Error("Task session is outside its run directory");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  task.sessionFiles[stageId] = sessionFile;
  return sessionFile;
}

function slugify(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}

function ensurePmSessionFile(cwd: string, state: WorkflowState): string {
  const workflowDir = path.join(cwd, ".pi", "workflows", "sessions");
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

  const sessionFile = ensureSessionFile(ctx.cwd, currentState, task, stage.id);
  const runner = new RpcAgent({
    cwd: ctx.cwd,
    sessionFile,
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    tools: agent.tools,
    allowedExtensions: resolveAllowedExtensions(agentName, config, currentState),
    retry: config.agentRetry,
  });

  const taskRunner: TaskRunner = { key, agent: runner, stageId: stage.id };
  taskRunners.set(key, taskRunner);
  return taskRunner;
}

function stopTask(task: TaskState) {
  if (task.status === "verified") return;
  task.status = "stopped";
  task.lastNote = "stopped";
  taskExecutions.get(task.id)?.abortController.abort();
  if (task.stageId) taskRunners.get(getRunnerKey(task.id, task.stageId))?.agent.abort();
}

function resetStageMemory(ctx: ExtensionContext, task: TaskState, stageId: string) {
  if (!currentState) return;
  const key = getRunnerKey(task.id, stageId);
  const runner = taskRunners.get(key);
  runner?.agent.dispose();
  taskRunners.delete(key);

  const workflowDir = path.dirname(ensureSessionFile(ctx.cwd, currentState, task, stageId));
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
  if (task.status === "verified") throw new Error(`Task ${task.id} is already verified`);
  if (currentRun?.abortController.signal.aborted) throw new Error("Workflow is stopping");
  if (taskLocks.has(task.id)) throw new Error(`Task ${task.id} is already being modified`);
  taskLocks.add(task.id);
  try {
    const runner = task.stageId ? taskRunners.get(getRunnerKey(task.id, task.stageId)) : undefined;
    if (task.status === "in_progress" && runner?.agent.isRunning()) {
      runner.agent.sendSteer(message);
      return;
    }
    await taskExecutions.get(task.id)?.promise;
    if (currentRun?.abortController.signal.aborted) throw new Error("Workflow is stopping");
    if (!currentState?.wave || findTask(task.id) !== task)
      throw new Error("Task is no longer in the current wave");
    task.stageId ??= config.taskFlow.stages[0].id;
    if (!findStageById(config.taskFlow.stages, task.stageId))
      throw new Error(`Stage not found: ${task.stageId}`);
    if (task.status === "failed" || task.retries > (config.maxTaskRetries ?? 2)) task.retries = 0;
    task.resumeMessage = message;
    task.status = "pending";
    task.lastNote = "queued";
    setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
    signalWorkflowEvent("tasks");
    if (!currentRun) {
      setState(pi, ctx, { ...currentState, active: true });
      launchWorkflow(pi, ctx, { ...config, goal: currentState.goal }, agents);
    }
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
      try {
        const outputText = await runner.agent.runPrompt(taskPrompt, {
          signal,
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

        const reportCall = toolCalls.filter((tc) => tc.name === "report_task_result").at(-1);

        if (reportCall) {
          // Use the tool arguments directly as output
          output = reportCall.arguments as Record<string, unknown>;
        } else {
          // Fallback to JSON parsing for backward compatibility
          try {
            output = extractJson(outputText);
          } catch {
            // If no tool was called and JSON parsing fails, return null output
            output = null;
          }
        }

        const resultSchema = reportCall ? TaskResultSchema : FallbackTaskResultSchema;
        if (output !== null && !Value.Check(resultSchema, output)) {
          throw new Error(
            "Invalid task report: status and result fields must match report_task_result",
          );
        }
        const expectedStatus = workflowStage.outputSchema.status;
        if (
          output !== null &&
          expectedStatus &&
          (typeof output.status !== "string" ||
            (expectedStatus !== "string" && !expectedStatus.split("|").includes(output.status)))
        ) {
          throw new Error(`Invalid status for stage ${stage.id}: ${String(output.status)}`);
        }

        return { output, outputText, toolCalls };
      } finally {
        runner.agent.dispose();
        taskRunners.delete(runner.key);
      }
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
      const developerStage = config.taskFlow.stages.find(
        (stage) => stage.agent === config.agents.developer,
      )?.id;

      if ((reason === "verification_failed" || reason === "error") && !keepDeveloperMemory) {
        if (developerStage) resetStageMemory(ctx, t, developerStage);
      }
      if (reason === "verification_failed" && !keepVerifierMemoryOnDeveloperFailure) {
        resetStageMemory(ctx, t, stageId);
      }
      if (reason === "malformed_output") {
        if (
          verifierSelfFailureMemory === "reset" ||
          verifierSelfFailureMemory === "reset_on_malformed_output"
        ) {
          resetStageMemory(ctx, t, stageId);
        }
      } else if (reason === "error" && verifierSelfFailureMemory === "reset") {
        resetStageMemory(ctx, t, stageId);
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
      t.issues = [];
      setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
    },
    markFailed: (t, stageId) => {
      if (!currentState) return; // Guard against workflow stop during execution
      t.status = "failed";
      t.stageId = stageId;
      setState(pi, ctx, { ...currentState, tasks: [...currentState.tasks] });
      sendWorkflowNotice(
        pi,
        `Task ${t.id} failed after exhausting retries. Use /workflow message ${t.id} <instructions> to retry, or /workflow stop.`,
      );
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
  while (!signal.aborted) {
    const runnable = tasks
      .filter((task) => task.status === "pending" || task.status === "in_progress")
      .filter((task) => !taskExecutions.has(task.id));
    const available = (config.parallelism ?? 1) - taskExecutions.size;
    for (const task of runnable.slice(0, Math.max(0, available))) {
      const execution: WorkflowRunHandle = {
        abortController: new AbortController(),
        promise: Promise.resolve(),
      };
      taskExecutions.set(task.id, execution);
      execution.promise = processTask(
        pi,
        ctx,
        config,
        task,
        wave,
        agents,
        AbortSignal.any([signal, execution.abortController.signal]),
        task.stageId,
      )
        .catch((error) => {
          if (signal.aborted || execution.abortController.signal.aborted) return;
          task.status = "failed";
          task.issues = [error instanceof Error ? error.message : String(error)];
          task.lastNote = task.issues[0];
          setState(pi, ctx, { ...currentState!, tasks: [...tasks] });
          sendWorkflowNotice(pi, `Task ${task.id} failed: ${task.lastNote}`);
        })
        .finally(() => {
          taskExecutions.delete(task.id);
          signalWorkflowEvent("tasks");
        });
    }
    if (tasks.every((task) => task.status === "verified")) return;
    await waitForWorkflowEvent(signal, "tasks");
  }
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

  const sessionFile = ensurePmSessionFile(ctx.cwd, currentState);
  pmRunner = new RpcAgent({
    cwd: ctx.cwd,
    sessionFile,
    systemPrompt: pmAgent.systemPrompt,
    model: pmAgent.model,
    tools: pmAgent.tools,
    allowedExtensions: resolveAllowedExtensions(pmAgent.name, config, currentState),
    retry: config.agentRetry,
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
    pmRunPromise = runner.runPrompt(prompt, { signal });
    return await pmRunPromise;
  } catch (error) {
    // Dispose runner on error to prevent resource leaks
    disposePmRunner();
    throw error;
  } finally {
    pmRunPromise = null;
    pmBusy = false;
    setPmStatus(ctx, undefined);
  }
}

async function generateWaveFromPm(
  pi: ExtensionAPI,
  config: WorkflowConfig,
  agents: ReturnType<typeof discoverAgents>["agents"],
  ctx: ExtensionContext,
  signal: AbortSignal,
  previousSummary: string,
  errorMessage?: string,
): Promise<{ done: boolean; wave?: WorkflowWave; clarification?: string }> {
  if (pmRunPromise) await pmRunPromise;
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
  const waveCall = toolCalls.filter((tc) => tc.name === "generate_wave").at(-1);

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

  if (output !== null && !Value.Check(PmResultSchema, output)) {
    throw new Error("Invalid generate_wave report");
  }
  if (output?.done === true) {
    sendPmMessage(pi, "PM reports: all work is complete.");
    return { done: true };
  }

  if (output?.wave) {
    const wave = output.wave;
    validateWave(wave);
    sendPmMessage(pi, summarizeWave(wave));
    return { done: false, wave };
  }

  if (output !== null) throw new Error("PM output missing wave");

  // PM didn't call tool or return JSON - treat as clarification request
  if (outputText && outputText.trim()) {
    sendPmMessage(pi, outputText);
    return { done: false, clarification: outputText };
  }

  throw new Error("PM output missing wave");
}

async function resolveWaveForIndex(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
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
    if (signal.aborted) throw new Error("Aborted");
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
      if (signal.aborted) throw error;
      lastError = error.message;
      pmAttempts++;
      if (pmAttempts >= maxPmRetries) throw error;
    }
  }

  return { done: true };
}

function launchWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: WorkflowConfig,
  agents: ReturnType<typeof discoverAgents>["agents"],
): void {
  const handle: WorkflowRunHandle = {
    abortController: new AbortController(),
    promise: Promise.resolve(),
  };
  currentRun = handle;
  handle.promise = runWorkflow(pi, ctx, config, agents, handle.abortController.signal).finally(
    async () => {
      handle.abortController.abort();
      disposePmRunner();
      for (const runner of taskRunners.values()) runner.agent.dispose();
      await Promise.allSettled([...taskExecutions.values()].map((execution) => execution.promise));
      taskRunners.clear();
      if (currentRun === handle) currentRun = null;
    },
  );
}

async function runWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: WorkflowConfig,
  agents: ReturnType<typeof discoverAgents>["agents"],
  signal: AbortSignal,
): Promise<void> {
  let waveIndex = currentState!.waveIndex;
  let previousSummary = currentState!.previousSummary ?? "";
  if (
    currentState!.wave &&
    currentState!.tasks.every((task) => task.status === "verified") &&
    (currentState!.waveSummaries?.length ?? 0) > waveIndex
  )
    waveIndex++;
  let completed = false;
  try {
    while (waveIndex < (config.maxWaves ?? 10)) {
      if (signal.aborted) return;
      const existingWave = waveIndex === currentState!.waveIndex ? currentState!.wave : undefined;
      const resolved = await resolveWaveForIndex(
        pi,
        ctx,
        config,
        agents,
        signal,
        previousSummary,
        waveIndex,
        existingWave,
        existingWave ? currentState!.tasks : undefined,
      );
      if (signal.aborted) return;
      if (resolved.done) {
        completed = true;
        break;
      }
      if (resolved.clarification) {
        await pauseForClarification(pi, ctx, signal, waveIndex, previousSummary);
        continue;
      }
      if (!resolved.wave || !resolved.tasks) throw new Error("Wave is missing tasks");
      const { wave, tasks } = resolved;
      validateWave(wave);
      validateWave({ goal: wave.goal, tasks });
      setState(pi, ctx, {
        ...currentState!,
        waveIndex,
        wave,
        tasks,
        previousSummary,
        active: true,
      });
      await runWaveWithTasks(pi, ctx, config, wave, tasks, agents, signal);
      if (signal.aborted) return;
      previousSummary = buildWaveSummary(currentState!);
      setState(pi, ctx, {
        ...currentState!,
        previousSummary,
        waveSummaries: [
          ...(currentState!.waveSummaries ?? []).slice(0, waveIndex),
          previousSummary,
        ],
      });
      waveIndex++;
    }
    completed ||=
      config.waveSource.type === "static" &&
      waveIndex >= (config.waveSource.staticWaves?.length ?? 0);
    const notice = completed
      ? "Workflow completed."
      : "Workflow paused: reached maxWaves. Increase the limit and resume to continue.";
    sendWorkflowNotice(pi, notice);
    if (ctx.hasUI) ctx.ui.notify(notice, completed ? "info" : "warning");
  } catch (error: any) {
    if (!signal.aborted) reportWorkflowError(pi, ctx, error);
  } finally {
    if (currentState)
      setState(pi, ctx, {
        ...currentState,
        active: false,
        waitingForClarification: false,
        clarificationToken: undefined,
      });
  }
}

async function resumeWorkflow(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (currentRun) throw new Error("Workflow already running");
  if (!currentState) throw new Error("No workflow state to resume");
  const { config } = loadWorkflowConfig(ctx.cwd, currentState.workflowName);
  const { agents } = discoverAgents(ctx.cwd);
  setState(pi, ctx, { ...currentState, active: true });
  sendWorkflowNotice(pi, "Workflow resumed.");
  launchWorkflow(pi, ctx, { ...config, goal: currentState.goal }, agents);
}

async function startWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workflowName: string,
  goalOverride?: string,
): Promise<void> {
  if (currentRun) throw new Error("Workflow already running");
  const { config } = loadWorkflowConfig(ctx.cwd, workflowName);
  const { agents } = discoverAgents(ctx.cwd);
  const effectiveConfig = { ...config, goal: goalOverride ?? config.goal };
  setState(pi, ctx, {
    runId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    workflowName,
    goal: effectiveConfig.goal,
    active: true,
    waveIndex: 0,
    tasks: [],
    updatedAt: Date.now(),
    allowedExtensions: effectiveConfig.allowedExtensions,
    allowedExtensionsByAgent: effectiveConfig.allowedExtensionsByAgent,
    previousSummary: "",
    waveSummaries: [],
  });
  sendWorkflowNotice(pi, `Workflow started: ${effectiveConfig.goal}`);
  launchWorkflow(pi, ctx, effectiveConfig, agents);
}

async function stopWorkflow(pi: ExtensionAPI, ctx: ExtensionContext, notify = true): Promise<void> {
  const run = currentRun;
  if (currentState) {
    for (const task of currentState.tasks) {
      if (task.status === "in_progress" || task.status === "pending") stopTask(task);
    }
    setState(pi, ctx, {
      ...currentState,
      active: false,
      waitingForClarification: false,
      clarificationToken: undefined,
    });
  }
  run?.abortController.abort();
  for (const runner of taskRunners.values()) runner.agent.dispose();
  const pmPromise = pmRunPromise;
  disposePmRunner();
  await Promise.allSettled([
    run?.promise,
    pmPromise,
    ...[...taskExecutions.values()].map((execution) => execution.promise),
  ]);
  taskRunners.clear();
  resetTransientWorkflowState();
  if (notify) sendWorkflowNotice(pi, run ? "Workflow stopped." : "No active workflow.");
}

export default function (pi: ExtensionAPI) {
  const restoreWorkflow = (_event: unknown, ctx: ExtensionContext) => {
    const saved = restoreState(ctx);
    currentState = saved ? structuredClone(saved) : undefined;
    if (currentState) {
      for (const task of currentState.tasks) {
        if (task.status === "in_progress" || task.status === "pending") {
          task.status = "stopped";
          task.lastNote = "stopped";
        }
      }
      setState(pi, ctx, {
        ...currentState,
        active: false,
        waitingForClarification: false,
        clarificationToken: undefined,
      });
    } else updateStatus(ctx);
    setPmStatus(ctx, undefined);
    resetTransientWorkflowState();
    startStatusTicker(ctx);
  };
  pi.on("session_start", restoreWorkflow);
  pi.on("session_switch", restoreWorkflow);
  pi.on("session_fork", restoreWorkflow);
  pi.on("session_tree", restoreWorkflow);
  const stopBeforeSwitch = async (_event: unknown, ctx: ExtensionContext) => {
    await stopWorkflow(pi, ctx, false);
  };
  pi.on("session_before_switch", stopBeforeSwitch);
  pi.on("session_before_fork", stopBeforeSwitch);
  pi.on("session_before_tree", stopBeforeSwitch);
  pi.on("session_shutdown", async (_event, ctx) => {
    stopStatusTicker();
    await stopWorkflow(pi, ctx, false);
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
        currentRun?.abortController.signal ?? new AbortController().signal,
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
        void startWorkflow(pi, ctx, name, goalText).catch((error) =>
          reportWorkflowError(pi, ctx, error),
        );
        return;
      }

      if (command === "resume") {
        void resumeWorkflow(pi, ctx).catch((error) => reportWorkflowError(pi, ctx, error));
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
        void messageTask(pi, ctx, config, task, message, agents).catch((error) =>
          reportWorkflowError(pi, ctx, error),
        );
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await startWorkflow(pi, ctx, params.name, normalizeGoal(params.goal));
      return { content: [{ type: "text", text: `Started workflow: ${params.name}` }], details: {} };
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
