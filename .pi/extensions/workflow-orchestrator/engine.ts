export interface TransitionRule {
  when: { field: string; equals: string };
  next: string;
}

export interface StageDefinition {
  id: string;
  transitions?: TransitionRule[];
}

export interface TaskFlowInput<TTask, TOutput> {
  task: TTask;
  stages: StageDefinition[];
  maxRetries: number;
  startStageId?: string;
  runStage: (stage: StageDefinition, task: TTask) => Promise<TOutput>;
  onStageStart?: (stage: StageDefinition, task: TTask) => void;
  onStageEnd?: (stage: StageDefinition, task: TTask, output: TOutput) => void;
  onError?: (stage: StageDefinition, task: TTask, error: Error) => void;
  getField?: (output: any, path: string) => any;
  getNextStageId?: (stages: StageDefinition[], stageId: string) => string | undefined;
  isStopped?: (task: TTask) => boolean;
  markVerified: (task: TTask, stageId: string) => void;
  markFailed: (task: TTask, stageId: string) => void;
  applyOutput: (task: TTask, stageId: string, output: TOutput) => void;
  applyVerifyFailure: (
    task: TTask,
    stageId: string,
    output: TOutput | null,
    error?: string,
    reason?: "verification_failed" | "malformed_output" | "error",
  ) => void;
  applyGenericFailure: (task: TTask, error: string) => void;
}

function defaultGetField(obj: any, path: string): any {
  const parts = path.split(".").filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function defaultGetNextStageId(stages: StageDefinition[], stageId: string): string | undefined {
  const index = stages.findIndex((stage) => stage.id === stageId);
  if (index === -1) return undefined;
  return stages[index + 1]?.id;
}

export async function runTaskFlow<TTask extends { retries: number }, TOutput>(
  input: TaskFlowInput<TTask, TOutput>,
) {
  const getField = input.getField ?? defaultGetField;
  const getNextStageId = input.getNextStageId ?? defaultGetNextStageId;
  let currentStageId = input.startStageId ?? input.stages[0]?.id;

  function recordFailure(): boolean {
    input.task.retries += 1;
    return input.task.retries <= input.maxRetries;
  }

  while (currentStageId) {
    if (input.isStopped?.(input.task)) return;

    const stage = input.stages.find((s) => s.id === currentStageId);
    if (!stage) throw new Error(`Stage not found: ${currentStageId}`);

    input.onStageStart?.(stage, input.task);

    let output: TOutput | null = null;
    try {
      output = await input.runStage(stage, input.task);
      if (input.isStopped?.(input.task)) return;
      input.applyOutput(input.task, stage.id, output);
      input.onStageEnd?.(stage, input.task, output);
    } catch (error: any) {
      if (input.isStopped?.(input.task)) return;
      const message = error?.message || "Stage failed";
      input.onError?.(stage, input.task, error instanceof Error ? error : new Error(message));

      if (stage.transitions?.length) {
        input.applyVerifyFailure(input.task, stage.id, null, message, "error");
        if (!recordFailure()) {
          input.markFailed(input.task, stage.id);
          return;
        }
        currentStageId = input.stages[0]?.id;
        continue;
      }

      input.applyGenericFailure(input.task, message);
      if (!recordFailure()) {
        input.markFailed(input.task, stage.id);
        return;
      }
      continue;
    }

    if (input.isStopped?.(input.task)) return;

    let nextStageId: string | undefined;
    let matchedTransition = false;
    if (stage.transitions && stage.transitions.length > 0) {
      const fieldTarget = (output as any)?.output ?? output;
      for (const transition of stage.transitions) {
        const fieldValue = getField(fieldTarget as any, transition.when.field);
        if (String(fieldValue) === transition.when.equals) {
          matchedTransition = true;
          nextStageId = transition.next;
          break;
        }
      }
      if (!matchedTransition) {
        nextStageId = stage.id;
      }
    } else {
      nextStageId = getNextStageId(input.stages, stage.id);
    }

    if (!nextStageId || nextStageId === "complete") {
      input.markVerified(input.task, stage.id);
      return;
    }

    const stageIndex = input.stages.indexOf(stage);
    const nextStageIndex = input.stages.findIndex((item) => item.id === nextStageId);
    if (nextStageIndex < 0) throw new Error(`Stage not found: ${nextStageId}`);
    if (nextStageIndex <= stageIndex) {
      const reason =
        nextStageId === stage.id && !matchedTransition ? "malformed_output" : "verification_failed";
      input.applyVerifyFailure(input.task, stage.id, output, undefined, reason);
      if (!recordFailure()) {
        input.markFailed(input.task, stage.id);
        return;
      }
    }

    currentStageId = nextStageId;
  }
}
