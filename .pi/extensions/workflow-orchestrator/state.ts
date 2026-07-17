import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowTask, WorkflowWave } from "./config.js";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import {
  IdentifierSchema,
  PriorWaveSummarySchema,
  StageOutputSchema,
  SemanticStageIdSchema,
  WaveSchema,
  type PriorWaveSummary,
  type StageOutput,
  type SemanticStageId,
} from "./contracts.js";

export type TaskStatus = "pending" | "in_progress" | "stopping" | "verified" | "failed" | "stopped";

export type WorkflowStatus =
  | "idle"
  | "running"
  | "waiting_for_clarification"
  | "stopping"
  | "completed"
  | "exhausted"
  | "failed"
  | "stopped"
  | "partial";

export const TaskStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("stopping"),
  Type.Literal("verified"),
  Type.Literal("failed"),
  Type.Literal("stopped"),
]);

export const WorkflowStatusSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("running"),
  Type.Literal("waiting_for_clarification"),
  Type.Literal("stopping"),
  Type.Literal("completed"),
  Type.Literal("exhausted"),
  Type.Literal("failed"),
  Type.Literal("stopped"),
  Type.Literal("partial"),
]);

const StageOutputByIdSchema = Type.Partial(
  Type.Object({
    develop: Type.Optional(StageOutputSchema),
    verify: Type.Optional(StageOutputSchema),
  }),
);

export const TaskStateSchema = Type.Intersect([
  Type.Object({
    id: IdentifierSchema,
    title: Type.String({ minLength: 1, maxLength: 1000 }),
    description: Type.String({ minLength: 1, maxLength: 4000 }),
    requirements: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
  Type.Object({
    assignee: Type.Optional(Type.Literal("developer")),
    status: TaskStatusSchema,
    stageId: Type.Optional(SemanticStageIdSchema),
    retries: Type.Integer({ minimum: 0 }),
    issues: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 100 }),
    ),
    stageOutputs: Type.Optional(StageOutputByIdSchema),
    lastAgent: Type.Optional(Type.String({ maxLength: 256 })),
    lastNote: Type.Optional(Type.String({ maxLength: 4000 })),
    lastOutput: Type.Optional(Type.String({ maxLength: 4000 })),
    lastActivityAt: Type.Optional(Type.Integer({ minimum: 0 })),
    sessionFiles: Type.Optional(
      Type.Partial(
        Type.Object({
          develop: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
          verify: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        }),
      ),
    ),
    sessionResetCounts: Type.Optional(
      Type.Partial(
        Type.Object({
          develop: Type.Optional(Type.Integer({ minimum: 0 })),
          verify: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      ),
    ),
    resumeMessage: Type.Optional(Type.String({ maxLength: 4000 })),
  }),
]);

export const WorkflowStateSchema = Type.Object({
  runId: IdentifierSchema,
  workflowName: IdentifierSchema,
  goal: Type.String({ minLength: 1, maxLength: 4000 }),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  status: WorkflowStatusSchema,
  active: Type.Boolean(),
  waveIndex: Type.Integer({ minimum: 0 }),
  wave: Type.Optional(WaveSchema),
  tasks: Type.Array(TaskStateSchema, { maxItems: 100 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  allowedExtensions: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
  allowedExtensionsByAgent: Type.Optional(
    Type.Partial(
      Type.Object({
        pm: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        developer: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        verifier: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
      }),
    ),
  ),
  previousSummary: Type.Optional(PriorWaveSummarySchema),
  waveSummaries: Type.Optional(Type.Array(PriorWaveSummarySchema, { maxItems: 100 })),
  waitingForClarification: Type.Optional(Type.Boolean()),
  clarificationToken: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

export interface TaskState extends WorkflowTask {
  status: TaskStatus;
  stageId?: SemanticStageId;
  retries: number;
  issues?: string[];
  stageOutputs?: Partial<Record<SemanticStageId, StageOutput>>;
  lastAgent?: string;
  lastNote?: string;
  lastOutput?: string;
  lastActivityAt?: number;
  sessionFiles?: Partial<Record<SemanticStageId, string>>;
  sessionResetCounts?: Partial<Record<SemanticStageId, number>>;
  resumeMessage?: string;
}

export interface WorkflowState {
  runId: string;
  workflowName: string;
  goal: string;
  model?: string;
  status: WorkflowStatus;
  /** Compatibility field for older renderers. `status` is authoritative. */
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
  previousSummary?: PriorWaveSummary;
  waveSummaries?: PriorWaveSummary[];
  waitingForClarification?: boolean;
  clarificationToken?: string;
}

export const STATE_TYPE = "workflow-state";

export function isWorkflowActive(status: WorkflowStatus): boolean {
  return status === "running" || status === "waiting_for_clarification" || status === "stopping";
}

function migrateTask(value: unknown): TaskState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = { ...(value as Record<string, unknown>) };
  if (typeof candidate.requirements !== "string" || !candidate.requirements.trim()) {
    candidate.requirements = "Verification requirements were not recorded in the saved state.";
  }
  if (candidate.status === undefined) candidate.status = "pending";
  if (!Number.isInteger(candidate.retries) || (candidate.retries as number) < 0) {
    candidate.retries = 0;
  }
  if (candidate.stageId !== "develop" && candidate.stageId !== "verify") {
    delete candidate.stageId;
  }
  if (candidate.assignee !== undefined && candidate.assignee !== "developer") {
    delete candidate.assignee;
  }
  if (candidate.stageOutputs && typeof candidate.stageOutputs === "object") {
    const outputs: Record<string, StageOutput> = {};
    for (const [stageId, output] of Object.entries(candidate.stageOutputs)) {
      if ((stageId === "develop" || stageId === "verify") && Check(StageOutputSchema, output)) {
        outputs[stageId] = output as StageOutput;
      }
    }
    candidate.stageOutputs = Object.keys(outputs).length > 0 ? outputs : undefined;
  }
  return candidate as unknown as TaskState;
}

function migrateWave(value: unknown): WorkflowWave | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { tasks?: unknown[] } & Record<string, unknown>;
  if (!Array.isArray(candidate.tasks)) return undefined;
  const tasks = candidate.tasks.map(migrateTask);
  if (tasks.some((task) => !task)) return undefined;
  const wave = { ...candidate, tasks };
  return Check(WaveSchema, wave) ? (wave as WorkflowWave) : undefined;
}

function migrateSummary(value: unknown, waveIndex: number): PriorWaveSummary | undefined {
  if (Check(PriorWaveSummarySchema, value)) return value as PriorWaveSummary;
  if (typeof value !== "string") return undefined;
  return {
    waveIndex,
    goal: value.slice(0, 4000),
    outcome: "partial",
    tasks: [],
  };
}

export function appendState(pi: ExtensionAPI, state: WorkflowState): void {
  if (!Check(WorkflowStateSchema, state)) {
    const errors = [...Errors(WorkflowStateSchema, state)].map(
      (error) => `${"path" in error && error.path ? error.path : "value"} ${error.message}`,
    );
    throw new Error(`Workflow state validation failed: ${errors.join("; ")}`);
  }
  pi.appendEntry(STATE_TYPE, state);
}

function migrateState(data: unknown): WorkflowState | undefined {
  if (!data || typeof data !== "object") return undefined;
  const candidate = data as Partial<WorkflowState> & { active?: boolean };
  const status = candidate.status ?? (candidate.active ? "running" : "completed");
  const waveIndex =
    Number.isInteger(candidate.waveIndex) && candidate.waveIndex! >= 0 ? candidate.waveIndex! : 0;
  const tasks = Array.isArray(candidate.tasks)
    ? candidate.tasks.map(migrateTask).filter((task): task is TaskState => task !== undefined)
    : [];
  const previousSummary = migrateSummary(candidate.previousSummary, waveIndex);
  const waveSummaries = Array.isArray(candidate.waveSummaries)
    ? candidate.waveSummaries
        .map((summary, index) => migrateSummary(summary, index))
        .filter((summary): summary is PriorWaveSummary => summary !== undefined)
    : undefined;
  const migrated: WorkflowState = {
    ...(candidate as WorkflowState),
    status,
    active: isWorkflowActive(status),
    waveIndex,
    wave: migrateWave(candidate.wave),
    tasks,
    previousSummary,
    waveSummaries,
    updatedAt:
      Number.isInteger(candidate.updatedAt) && candidate.updatedAt! >= 0
        ? candidate.updatedAt!
        : Date.now(),
  };

  if (!migrated.runId || !migrated.workflowName || !migrated.goal) return undefined;
  if (!Check(WorkflowStateSchema, migrated)) return undefined;
  return migrated;
}

export function restoreState(ctx: ExtensionContext): WorkflowState | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === STATE_TYPE) {
      return migrateState(entry.data);
    }
  }
  return undefined;
}
