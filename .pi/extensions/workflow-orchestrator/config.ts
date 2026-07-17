import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import {
  IdentifierSchema,
  SemanticStageIdSchema,
  WaveSchema,
  validateGenerateWave,
} from "./contracts.js";

const TransitionSchema = Type.Object({
  when: Type.Object({
    field: Type.String({ minLength: 1 }),
    equals: Type.String({ minLength: 1 }),
  }),
  next: Type.Union([IdentifierSchema, Type.Literal("complete")]),
});

const StageSchema = Type.Object({
  id: SemanticStageIdSchema,
  agent: Type.String({ minLength: 1 }),
  inputTemplate: Type.String({ minLength: 1 }),
  transitions: Type.Optional(Type.Array(TransitionSchema, { maxItems: 20 })),
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

const WaveSourceSchema = Type.Object({
  type: Type.Union([Type.Literal("pm"), Type.Literal("static")]),
  staticWaves: Type.Optional(Type.Array(WaveSchema, { maxItems: 100 })),
});

const AllowedExtensionsByAgentSchema = Type.Record(Type.String(), Type.Array(Type.String()));
const AgentsSchema = Type.Record(IdentifierSchema, Type.String({ minLength: 1 }));

const WorkflowSchema = Type.Object({
  name: IdentifierSchema,
  goal: Type.String({ minLength: 1, maxLength: 4000 }),
  piCommand: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  maxWaves: Type.Optional(Type.Integer({ minimum: 1 })),
  maxTaskRetries: Type.Optional(Type.Integer({ minimum: 0 })),
  maxPmRetries: Type.Optional(Type.Integer({ minimum: 1 })),
  parallelism: Type.Optional(Type.Integer({ minimum: 1 })),
  allowedExtensions: Type.Optional(Type.Array(Type.String())),
  allowedExtensionsByAgent: Type.Optional(AllowedExtensionsByAgentSchema),
  agents: AgentsSchema,
  waveSource: WaveSourceSchema,
  taskFlow: Type.Object({
    stages: Type.Array(StageSchema, { minItems: 2, maxItems: 2 }),
    memory: Type.Optional(TaskFlowMemorySchema),
  }),
});

export type WorkflowConfig = Static<typeof WorkflowSchema>;
export type WorkflowStage = Static<typeof StageSchema>;
export type WorkflowTask = Static<typeof WaveSchema>["tasks"][number];
export type WorkflowWave = Static<typeof WaveSchema>;

export interface LoadedWorkflow {
  config: WorkflowConfig;
  path: string;
}

function assertPositiveInteger(name: string, value: number, allowZero = false): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
}

function validateCrossFields(config: WorkflowConfig): void {
  const requiredRoles = ["pm", "developer", "verifier"] as const;
  for (const role of requiredRoles) {
    const agentName = config.agents[role];
    if (typeof agentName !== "string" || !agentName.trim()) {
      throw new Error(`agents.${role} must resolve to a non-empty agent name`);
    }
  }

  const stageIds = new Set(config.taskFlow.stages.map((stage) => stage.id));
  if (!stageIds.has("develop") || !stageIds.has("verify") || stageIds.size !== 2) {
    throw new Error(
      'taskFlow.stages must contain exactly the semantic stages "develop" and "verify"',
    );
  }

  const configuredAgentNames = new Set(Object.values(config.agents));
  for (const stage of config.taskFlow.stages) {
    if (!configuredAgentNames.has(stage.agent)) {
      throw new Error(`Stage ${stage.id} references unknown agent: ${stage.agent}`);
    }
    for (const transition of stage.transitions ?? []) {
      if (
        transition.next !== "complete" &&
        !stageIds.has(transition.next as "develop" | "verify")
      ) {
        throw new Error(`Stage ${stage.id} transition targets unknown stage: ${transition.next}`);
      }
    }
  }

  if (config.waveSource.type === "static") {
    for (const [index, wave] of (config.waveSource.staticWaves ?? []).entries()) {
      try {
        validateGenerateWave({ done: false, wave });
      } catch (error) {
        throw new Error(`waveSource.staticWaves[${index}] is invalid: ${(error as Error).message}`);
      }
    }
  }

  assertPositiveInteger("maxWaves", config.maxWaves!);
  assertPositiveInteger("maxTaskRetries", config.maxTaskRetries!, true);
  assertPositiveInteger("maxPmRetries", config.maxPmRetries!);
  assertPositiveInteger("parallelism", config.parallelism!);
}

export function loadWorkflowConfig(cwd: string, name: string): LoadedWorkflow {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Workflow name is required");
  }
  if (name.length > 64) {
    throw new Error("Workflow name too long (max 64 characters)");
  }
  if (!Check(IdentifierSchema, name)) {
    throw new Error(`Invalid workflow name: ${name}. Expected 1-64 safe identifier characters.`);
  }

  const workflowPath = path.join(cwd, ".pi", "workflows", `${name}.workflow.json`);
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

  if (parsed && typeof parsed === "object" && "agentRetry" in parsed) {
    throw new Error(
      "Unsupported workflow configuration: agentRetry was removed. Configure Pi retry.enabled, retry.maxRetries, and retry.baseDelayMs in Pi settings instead.",
    );
  }

  if (!Check(WorkflowSchema, parsed)) {
    const errors = [...Errors(WorkflowSchema, parsed)].map(
      (error) => `${"path" in error && error.path ? error.path : "value"} ${error.message}`,
    );
    throw new Error(`Workflow schema validation failed:\n${errors.join("\n")}`);
  }

  const config = parsed as WorkflowConfig;
  config.piCommand = config.piCommand ?? "pi";
  config.maxWaves = config.maxWaves ?? 10;
  config.maxTaskRetries = config.maxTaskRetries ?? 2;
  config.maxPmRetries = config.maxPmRetries ?? 3;
  config.parallelism = config.parallelism ?? 1;
  config.taskFlow.memory = config.taskFlow.memory ?? {};
  config.taskFlow.memory.keepDeveloperMemory = config.taskFlow.memory.keepDeveloperMemory ?? true;
  config.taskFlow.memory.keepVerifierMemoryOnDeveloperFailure =
    config.taskFlow.memory.keepVerifierMemoryOnDeveloperFailure ?? true;
  config.taskFlow.memory.verifierSelfFailureMemory =
    config.taskFlow.memory.verifierSelfFailureMemory ?? "keep";

  validateCrossFields(config);
  return { config, path: workflowPath };
}
