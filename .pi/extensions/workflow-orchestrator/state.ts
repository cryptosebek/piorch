import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { WorkflowTask, WorkflowWave } from "./config.js";

export type TaskStatus = "pending" | "in_progress" | "verified" | "failed" | "stopped";

export interface TaskState extends WorkflowTask {
  status: TaskStatus;
  stageId?: string;
  retries: number;
  issues?: string[];
  stageOutputs?: Record<string, Record<string, unknown>>;
  lastAgent?: string;
  lastNote?: string;
  lastOutput?: string;
  lastActivityAt?: number;
  sessionFiles?: Record<string, string>;
  sessionResetCounts?: Record<string, number>;
  resumeMessage?: string;
}

export interface WorkflowState {
  runId: string;
  workflowName: string;
  goal: string;
  active: boolean;
  waveIndex: number;
  wave?: WorkflowWave;
  tasks: TaskState[];
  updatedAt: number;
  allowedExtensions?: string[];
  allowedExtensionsByAgent?: {
    pm?: string[];
    developer?: string[];
    verifier?: string[];
  };
  previousSummary?: string;
  waveSummaries?: string[];
  waitingForClarification?: boolean;
  clarificationToken?: string;
}

export const STATE_TYPE = "workflow-state";

export function appendState(pi: ExtensionAPI, state: WorkflowState): void {
  pi.appendEntry(STATE_TYPE, state);
}

export function restoreState(ctx: ExtensionContext): WorkflowState | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === STATE_TYPE) {
      return entry.data as WorkflowState;
    }
  }
  return undefined;
}
