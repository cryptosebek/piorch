import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const IdentifierSchema = Type.String({ pattern: "^[a-zA-Z0-9_-]+$" });

const TransitionSchema = Type.Object({
  when: Type.Object({
    field: Type.String(),
    equals: Type.String(),
  }),
  next: Type.String(),
});

const StageSchema = Type.Object({
  id: IdentifierSchema,
  agent: Type.String(),
  inputTemplate: Type.String(),
  outputSchema: Type.Record(Type.String(), Type.String()),
  transitions: Type.Optional(Type.Array(TransitionSchema)),
});

const TaskFlowMemorySchema = Type.Object({
  keepDeveloperMemory: Type.Optional(Type.Boolean()),
  keepVerifierMemoryOnDeveloperFailure: Type.Optional(Type.Boolean()),
  verifierSelfFailureMemory: Type.Optional(
    Type.Union([
      Type.Literal("keep"),
      Type.Literal("reset"),
      Type.Literal("reset_on_malformed_output"),
    ]),
  ),
});

const TaskSchema = Type.Object({
  id: IdentifierSchema,
  title: Type.String(),
  description: Type.String(),
  requirements: Type.Optional(Type.String()),
  assignee: Type.Optional(Type.String()),
});

const WaveSchema = Type.Object({
  goal: Type.String(),
  tasks: Type.Array(TaskSchema),
});

const WaveSourceSchema = Type.Object({
  type: Type.Union([Type.Literal("pm"), Type.Literal("static")]),
  staticWaves: Type.Optional(Type.Array(WaveSchema)),
});

const AllowedExtensionsByAgentSchema = Type.Record(Type.String(), Type.Array(Type.String()));

const AgentsSchema = Type.Record(Type.String(), Type.String());

const AgentRetrySchema = Type.Object({
  maxAttempts: Type.Optional(Type.Integer()),
  initialDelayMs: Type.Optional(Type.Number()),
  maxDelayMs: Type.Optional(Type.Number()),
  backoffMultiplier: Type.Optional(Type.Number()),
  jitterMs: Type.Optional(Type.Number()),
});

const WorkflowSchema = Type.Object({
  name: Type.String(),
  goal: Type.String(),
  maxWaves: Type.Optional(Type.Integer()),
  maxTaskRetries: Type.Optional(Type.Integer()),
  maxPmRetries: Type.Optional(Type.Integer()),
  parallelism: Type.Optional(Type.Integer()),
  agentRetry: Type.Optional(AgentRetrySchema),
  allowedExtensions: Type.Optional(Type.Array(Type.String())),
  allowedExtensionsByAgent: Type.Optional(AllowedExtensionsByAgentSchema),
  agents: AgentsSchema,
  waveSource: WaveSourceSchema,
  taskFlow: Type.Object({
    stages: Type.Array(StageSchema),
    memory: Type.Optional(TaskFlowMemorySchema),
  }),
});

export type WorkflowConfig = Static<typeof WorkflowSchema>;
export type WorkflowStage = Static<typeof StageSchema>;
export type WorkflowTask = Static<typeof TaskSchema>;
export type WorkflowWave = Static<typeof WaveSchema>;

export function validateWave(wave: unknown): asserts wave is WorkflowWave {
  if (!Value.Check(WaveSchema, wave)) {
    throw new Error(
      "Invalid wave: expected a goal and tasks with safe IDs, titles, and descriptions",
    );
  }
  const ids = new Set<string>();
  for (const task of wave.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
    ids.add(task.id);
  }
}

export interface LoadedWorkflow {
  config: WorkflowConfig;
  path: string;
}

function sanitizeWorkflowName(name: string): string {
  if (!name || typeof name !== "string") {
    throw new Error("Workflow name is required");
  }

  // Only allow alphanumeric, dash, underscore
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `Invalid workflow name: ${name}. Only alphanumeric, dash, and underscore allowed.`,
    );
  }

  if (name.length > 50) {
    throw new Error("Workflow name too long (max 50 characters)");
  }

  return name;
}

export function loadWorkflowConfig(cwd: string, name: string): LoadedWorkflow {
  const safeName = sanitizeWorkflowName(name);
  const workflowPath = path.join(cwd, ".pi", "workflows", `${safeName}.workflow.json`);
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Workflow not found: ${workflowPath}`);
  }

  const raw = fs.readFileSync(workflowPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in workflow file: ${workflowPath}`);
  }

  if (!Value.Check(WorkflowSchema, parsed)) {
    const errors = [...Value.Errors(WorkflowSchema, parsed)].map(
      (err) => `${err.path} ${err.message}`,
    );
    throw new Error(`Workflow schema validation failed:\n${errors.join("\n")}`);
  }

  const config = parsed as WorkflowConfig;

  // Apply defaults
  config.maxWaves = config.maxWaves ?? 10;
  config.maxTaskRetries = config.maxTaskRetries ?? 2;
  config.maxPmRetries = config.maxPmRetries ?? 3;
  config.parallelism = config.parallelism ?? 1;
  config.agentRetry = config.agentRetry ?? {};
  config.agentRetry.maxAttempts = config.agentRetry.maxAttempts ?? 5;
  config.agentRetry.initialDelayMs = config.agentRetry.initialDelayMs ?? 5000;
  config.agentRetry.maxDelayMs = config.agentRetry.maxDelayMs ?? 120000;
  config.agentRetry.backoffMultiplier = config.agentRetry.backoffMultiplier ?? 2;
  config.agentRetry.jitterMs = config.agentRetry.jitterMs ?? 1000;
  config.taskFlow.memory = config.taskFlow.memory ?? {};
  config.taskFlow.memory.keepDeveloperMemory = config.taskFlow.memory.keepDeveloperMemory ?? true;
  config.taskFlow.memory.keepVerifierMemoryOnDeveloperFailure =
    config.taskFlow.memory.keepVerifierMemoryOnDeveloperFailure ?? true;
  config.taskFlow.memory.verifierSelfFailureMemory =
    config.taskFlow.memory.verifierSelfFailureMemory ?? "keep";

  if (config.parallelism < 1) {
    throw new Error("parallelism must be at least 1");
  }
  if (config.maxWaves < 1) throw new Error("maxWaves must be at least 1");
  if (config.maxTaskRetries < 0) throw new Error("maxTaskRetries must be at least 0");
  if (config.maxPmRetries < 1) throw new Error("maxPmRetries must be at least 1");
  if (config.agentRetry.maxAttempts < 1) {
    throw new Error("agentRetry.maxAttempts must be at least 1");
  }
  if (config.agentRetry.initialDelayMs < 0) {
    throw new Error("agentRetry.initialDelayMs must be at least 0");
  }
  if (config.agentRetry.maxDelayMs < 0) {
    throw new Error("agentRetry.maxDelayMs must be at least 0");
  }
  if (config.agentRetry.backoffMultiplier < 1) {
    throw new Error("agentRetry.backoffMultiplier must be at least 1");
  }
  if (config.agentRetry.jitterMs < 0) {
    throw new Error("agentRetry.jitterMs must be at least 0");
  }

  const stages = config.taskFlow.stages;
  if (stages.length === 0) throw new Error("At least one task stage is required");
  const stageIds = new Set(stages.map((stage) => stage.id));
  if (stageIds.size !== stages.length) throw new Error("Stage IDs must be unique");
  if (stageIds.has("complete")) throw new Error('Stage ID "complete" is reserved');
  for (const stage of stages) {
    for (const transition of stage.transitions ?? []) {
      if (transition.next !== "complete" && !stageIds.has(transition.next)) {
        throw new Error(`Unknown transition target: ${transition.next}`);
      }
    }
  }
  for (const wave of config.waveSource.staticWaves ?? []) validateWave(wave);

  return { config, path: workflowPath };
}
