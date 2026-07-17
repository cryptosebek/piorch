import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendState,
  restoreState,
  STATE_TYPE,
  type WorkflowState,
  type TaskState,
} from "../.pi/extensions/workflow-orchestrator/state.js";
import type {
  PriorWaveSummary,
  StageOutput,
} from "../.pi/extensions/workflow-orchestrator/contracts.js";

describe("workflow state", () => {
  function createBaseState(overrides: Partial<WorkflowState> = {}): WorkflowState {
    return {
      runId: "test-run-123",
      workflowName: "default",
      goal: "Test workflow goal",
      status: "running",
      active: true,
      waveIndex: 0,
      wave: { goal: "Wave 1", tasks: [] },
      tasks: [],
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  function createTask(overrides: Partial<TaskState> = {}): TaskState {
    return {
      id: "T1",
      title: "Test task",
      description: "Task description",
      requirements: "Run verification",
      status: "pending",
      retries: 0,
      ...overrides,
    };
  }

  const developerOutput: StageOutput = {
    runId: "test-run-123",
    waveIndex: 0,
    taskId: "T1",
    stageId: "develop",
    role: "developer",
    report: {
      status: "done",
      summary: "Implemented",
      filesChanged: ["src/index.ts"],
      evidence: [{ kind: "test", description: "Unit tests pass", outcome: "pass" }],
      issues: [],
    },
    toolCallId: "developer-call",
    startedAt: 1,
    completedAt: 2,
  };

  const verifierOutput: StageOutput = {
    runId: "test-run-123",
    waveIndex: 0,
    taskId: "T1",
    stageId: "verify",
    role: "verifier",
    report: {
      status: "pass",
      summary: "Verified",
      evidence: [{ kind: "test", description: "Verification pass", outcome: "pass" }],
      issues: [],
    },
    toolCallId: "verifier-call",
    startedAt: 3,
    completedAt: 4,
  };

  const summary: PriorWaveSummary = {
    waveIndex: 0,
    goal: "Wave 1",
    outcome: "verified",
    tasks: [
      {
        id: "T1",
        title: "Test task",
        status: "verified",
        retries: 0,
        developerSummary: "Implemented",
        filesChanged: ["src/index.ts"],
        verifierSummary: "Verified",
        evidence: [{ kind: "test", description: "Pass", outcome: "pass" }],
        issues: [],
      },
    ],
  };

  describe("appendState", () => {
    it("appends a valid state through the extension API", () => {
      const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
      const state = createBaseState();
      appendState(pi, state);
      expect(pi.appendEntry).toHaveBeenCalledWith(STATE_TYPE, state);
    });

    it("persists typed tasks, stage outputs, summaries, and extension allowlists", () => {
      const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
      const state = createBaseState({
        allowedExtensions: ["/path/to/extension.ts"],
        allowedExtensionsByAgent: {
          pm: ["./pm.ts"],
          developer: ["./developer.ts"],
          verifier: ["./verifier.ts"],
        },
        previousSummary: summary,
        waveSummaries: [summary],
        tasks: [
          createTask({
            status: "verified",
            stageId: "verify",
            stageOutputs: { develop: developerOutput, verify: verifierOutput },
            sessionFiles: { develop: ".pi/sessions/T1-develop.jsonl" },
            sessionResetCounts: { develop: 1 },
          }),
        ],
      });
      appendState(pi, state);
      expect(pi.appendEntry).toHaveBeenCalledWith(STATE_TYPE, state);
    });

    it("preserves clarification state and stopped tasks", () => {
      const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
      const state = createBaseState({
        status: "waiting_for_clarification",
        active: true,
        waitingForClarification: true,
        clarificationToken: "clarification-1",
        tasks: [createTask({ status: "stopped", resumeMessage: "Continue from here" })],
      });
      appendState(pi, state);
      expect(pi.appendEntry).toHaveBeenCalledWith(STATE_TYPE, state);
    });

    it("rejects malformed state before persistence", () => {
      const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
      const state = createBaseState({ status: "invalid" as WorkflowState["status"] });
      expect(() => appendState(pi, state)).toThrow("Workflow state validation failed");
      expect(pi.appendEntry).not.toHaveBeenCalled();
    });
  });

  describe("restoreState", () => {
    it("restores the latest typed state and skips unrelated entries", () => {
      const state = createBaseState();
      const ctx = {
        sessionManager: {
          getBranch: vi
            .fn()
            .mockReturnValue([
              { type: "message" },
              { type: "custom", customType: "other", data: {} },
              { type: "custom", customType: STATE_TYPE, data: state },
            ]),
        },
      } as unknown as ExtensionContext;
      expect(restoreState(ctx)).toEqual(state);
    });

    it("returns the latest state when multiple state entries exist", () => {
      const oldState = createBaseState({ waveIndex: 0 });
      const newState = createBaseState({ waveIndex: 1 });
      const ctx = {
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([
            { type: "custom", customType: STATE_TYPE, data: oldState },
            { type: "custom", customType: STATE_TYPE, data: newState },
          ]),
        },
      } as unknown as ExtensionContext;
      expect(restoreState(ctx)).toEqual(newState);
    });

    it("returns undefined when the session has no state", () => {
      const ctx = {
        sessionManager: { getBranch: vi.fn().mockReturnValue([{ type: "message" }]) },
      } as unknown as ExtensionContext;
      expect(restoreState(ctx)).toBeUndefined();
    });

    it("restores complex typed task data", () => {
      const state = createBaseState({
        tasks: [
          createTask({
            status: "verified",
            stageId: "verify",
            retries: 1,
            issues: ["Initial issue fixed"],
            stageOutputs: { develop: developerOutput, verify: verifierOutput },
            lastAgent: "verifier",
            lastNote: "Verification passed",
            lastOutput: "Verified",
            lastActivityAt: 10,
            sessionFiles: {
              develop: ".pi/workflows/sessions/run1/T1-develop.jsonl",
              verify: ".pi/workflows/sessions/run1/T1-verify.jsonl",
            },
          }),
        ],
      });
      const ctx = {
        sessionManager: {
          getBranch: vi
            .fn()
            .mockReturnValue([{ type: "custom", customType: STATE_TYPE, data: state }]),
        },
      } as unknown as ExtensionContext;
      expect(restoreState(ctx)).toEqual(state);
    });

    it("restores resume messages and last output", () => {
      const state = createBaseState({
        tasks: [
          createTask({
            status: "stopped",
            resumeMessage: "Please continue from here",
            lastOutput: "Working on implementation",
          }),
        ],
      });
      const ctx = {
        sessionManager: {
          getBranch: vi
            .fn()
            .mockReturnValue([{ type: "custom", customType: STATE_TYPE, data: state }]),
        },
      } as unknown as ExtensionContext;
      const restored = restoreState(ctx);
      expect(restored?.tasks[0].resumeMessage).toBe("Please continue from here");
      expect(restored?.tasks[0].lastOutput).toBe("Working on implementation");
    });

    it("migrates active-only state to a status and supplies missing persisted metadata", () => {
      const ctx = {
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([
            {
              type: "custom",
              customType: STATE_TYPE,
              data: { runId: "run-1", workflowName: "default", goal: "g", active: true, tasks: [] },
            },
          ]),
        },
      } as unknown as ExtensionContext;
      expect(restoreState(ctx)).toMatchObject({
        status: "running",
        active: true,
        waveIndex: 0,
      });
      expect(restoreState(ctx)?.updatedAt).toEqual(expect.any(Number));
    });

    it("ignores malformed state entries", () => {
      const ctx = {
        sessionManager: {
          getBranch: vi
            .fn()
            .mockReturnValue([{ type: "custom", customType: STATE_TYPE, data: null }]),
        },
      } as unknown as ExtensionContext;
      expect(restoreState(ctx)).toBeUndefined();
    });
  });

  it("exports the expected state entry type", () => {
    expect(STATE_TYPE).toBe("workflow-state");
  });
});
