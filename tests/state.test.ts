import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  appendState,
  restoreState,
  STATE_TYPE,
  type WorkflowState,
  type TaskState,
} from "../.pi/extensions/workflow-orchestrator/state.js";

describe("state.ts", () => {
  function createBaseState(overrides?: Partial<WorkflowState>): WorkflowState {
    return {
      runId: "test-run-123",
      workflowName: "default",
      goal: "Test workflow goal",
      active: true,
      waveIndex: 0,
      wave: { goal: "Wave 1", tasks: [] },
      tasks: [],
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  function createTask(overrides?: Partial<TaskState>): TaskState {
    return {
      id: "T1",
      title: "Test task",
      description: "Task description",
      status: "pending",
      retries: 0,
      ...overrides,
    } as TaskState;
  }

  describe("appendState", () => {
    it("keeps past branch snapshots unchanged when a task later advances", () => {
      const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
      const state = createBaseState({ tasks: [createTask({ status: "pending" })] });
      appendState(pi, state);
      state.tasks[0].status = "verified";
      const saved = (pi.appendEntry as any).mock.calls[0][1] as WorkflowState;
      expect(saved.tasks[0].status).toBe("pending");
    });

    it("appends state to session via extension API", () => {
      const mockPi = {
        appendEntry: vi.fn(),
      } as unknown as ExtensionAPI;

      const state = createBaseState();
      appendState(mockPi, state);

      expect(mockPi.appendEntry).toHaveBeenCalledWith(STATE_TYPE, state);
    });

    it("appends state with tasks", () => {
      const mockPi = {
        appendEntry: vi.fn(),
      } as unknown as ExtensionAPI;

      const state = createBaseState({
        tasks: [
          createTask({ id: "T1", status: "in_progress" }),
          createTask({ id: "T2", status: "verified" }),
        ],
      });

      appendState(mockPi, state);

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        STATE_TYPE,
        expect.objectContaining({
          tasks: expect.arrayContaining([
            expect.objectContaining({ id: "T1" }),
            expect.objectContaining({ id: "T2" }),
          ]),
        }),
      );
    });

    it("appends state with allowedExtensions", () => {
      const mockPi = {
        appendEntry: vi.fn(),
      } as unknown as ExtensionAPI;

      const state = createBaseState({
        allowedExtensions: ["/path/to/extension.ts"],
      });

      appendState(mockPi, state);

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        STATE_TYPE,
        expect.objectContaining({
          allowedExtensions: ["/path/to/extension.ts"],
        }),
      );
    });

    it("appends state with allowedExtensionsByAgent", () => {
      const mockPi = {
        appendEntry: vi.fn(),
      } as unknown as ExtensionAPI;

      const state = createBaseState({
        allowedExtensionsByAgent: {
          pm: ["./.pi/extensions/workflow-pm-tools/index.ts"],
          developer: ["./.pi/extensions/workflow-task-tools/index.ts"],
          verifier: ["./.pi/extensions/workflow-task-tools/index.ts"],
        },
      });

      appendState(mockPi, state);

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        STATE_TYPE,
        expect.objectContaining({
          allowedExtensionsByAgent: {
            pm: expect.arrayContaining(["./.pi/extensions/workflow-pm-tools/index.ts"]),
            developer: expect.arrayContaining(["./.pi/extensions/workflow-task-tools/index.ts"]),
            verifier: expect.arrayContaining(["./.pi/extensions/workflow-task-tools/index.ts"]),
          },
        }),
      );
    });

    it("appends state with previousSummary", () => {
      const mockPi = {
        appendEntry: vi.fn(),
      } as unknown as ExtensionAPI;

      const state = createBaseState({
        previousSummary: "Previous wave completed successfully",
      });

      appendState(mockPi, state);

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        STATE_TYPE,
        expect.objectContaining({
          previousSummary: "Previous wave completed successfully",
        }),
      );
    });

    it("appends state with waveSummaries", () => {
      const mockPi = {
        appendEntry: vi.fn(),
      } as unknown as ExtensionAPI;

      const state = createBaseState({
        waveSummaries: ["Wave 1: Setup project", "Wave 2: Implement features"],
      });

      appendState(mockPi, state);

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        STATE_TYPE,
        expect.objectContaining({
          waveSummaries: expect.arrayContaining([
            "Wave 1: Setup project",
            "Wave 2: Implement features",
          ]),
        }),
      );
    });

    it("appends state with waitingForClarification flag", () => {
      const mockPi = {
        appendEntry: vi.fn(),
      } as unknown as ExtensionAPI;

      const state = createBaseState({
        waitingForClarification: true,
      });

      appendState(mockPi, state);

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        STATE_TYPE,
        expect.objectContaining({
          waitingForClarification: true,
        }),
      );
    });

    it("updates timestamp on append", () => {
      const mockPi = {
        appendEntry: vi.fn(),
      } as unknown as ExtensionAPI;

      const originalTime = Date.now() - 10000;
      const state = createBaseState({ updatedAt: originalTime });

      appendState(mockPi, state);

      const capturedState = (mockPi.appendEntry as any).mock.calls[0][1] as WorkflowState;
      expect(capturedState.updatedAt).toBeGreaterThanOrEqual(originalTime);
    });
  });

  describe("restoreState", () => {
    it("restores state from session entries", () => {
      const stateToRestore = createBaseState();

      const mockCtx = {
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([
            { type: "message", role: "user", content: "Hello" },
            { type: "custom", customType: STATE_TYPE, data: stateToRestore },
            { type: "message", role: "assistant", content: "Hi" },
          ]),
        },
      } as unknown as ExtensionContext;

      const restored = restoreState(mockCtx);

      expect(restored).toEqual(stateToRestore);
    });

    it("returns latest state when multiple states exist", () => {
      const oldState = createBaseState({ waveIndex: 0 });
      const newState = createBaseState({ waveIndex: 1 });

      const mockCtx = {
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([
            { type: "custom", customType: STATE_TYPE, data: oldState },
            { type: "message", role: "user", content: "Continue" },
            { type: "custom", customType: STATE_TYPE, data: newState },
          ]),
        },
      } as unknown as ExtensionContext;

      const restored = restoreState(mockCtx);

      expect(restored).toEqual(newState);
    });

    it("returns undefined when no state in session", () => {
      const mockCtx = {
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([
            { type: "message", role: "user", content: "Hello" },
            { type: "message", role: "assistant", content: "Hi" },
          ]),
        },
      } as unknown as ExtensionContext;

      const restored = restoreState(mockCtx);

      expect(restored).toBeUndefined();
    });

    it("returns undefined for empty session", () => {
      const mockCtx = {
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([]),
        },
      } as unknown as ExtensionContext;

      const restored = restoreState(mockCtx);

      expect(restored).toBeUndefined();
    });

    it("skips non-custom entries", () => {
      const stateToRestore = createBaseState();

      const mockCtx = {
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([
            { type: "message", role: "user", content: "Hello" },
            { type: "tool", name: "read", content: "" },
            { type: "custom", customType: "other-type", data: { foo: "bar" } },
            { type: "custom", customType: STATE_TYPE, data: stateToRestore },
          ]),
        },
      } as unknown as ExtensionContext;

      const restored = restoreState(mockCtx);

      expect(restored).toEqual(stateToRestore);
    });

    it("restores state with complex task data", () => {
      const complexState = createBaseState({
        tasks: [
          createTask({
            id: "T1",
            status: "verified",
            stageId: "verify",
            retries: 1,
            issues: ["Initial issue fixed"],
            stageOutputs: {
              develop: { status: "done", summary: "Implemented", filesChanged: ["src/index.ts"] },
              verify: { status: "pass", issues: [] },
            },
            lastAgent: "verifier",
            lastNote: "Verification passed",
            sessionFiles: {
              develop: ".pi/workflows/sessions/run1/T1-develop.jsonl",
              verify: ".pi/workflows/sessions/run1/T1-verify.jsonl",
            },
          }),
        ],
      });

      const mockCtx = {
        sessionManager: {
          getBranch: vi
            .fn()
            .mockReturnValue([{ type: "custom", customType: STATE_TYPE, data: complexState }]),
        },
      } as unknown as ExtensionContext;

      const restored = restoreState(mockCtx);

      expect(restored).toEqual(complexState);
      expect(restored?.tasks[0].stageOutputs?.develop).toEqual({
        status: "done",
        summary: "Implemented",
        filesChanged: ["src/index.ts"],
      });
    });

    it("restores state with resumeMessage", () => {
      const stateWithResume = createBaseState({
        tasks: [
          createTask({
            id: "T1",
            status: "stopped",
            resumeMessage: "Please continue from where you left off",
          }),
        ],
      });

      const mockCtx = {
        sessionManager: {
          getBranch: vi
            .fn()
            .mockReturnValue([{ type: "custom", customType: STATE_TYPE, data: stateWithResume }]),
        },
      } as unknown as ExtensionContext;

      const restored = restoreState(mockCtx);

      expect(restored?.tasks[0].resumeMessage).toBe("Please continue from where you left off");
    });

    it("restores state with lastOutput", () => {
      const stateWithOutput = createBaseState({
        tasks: [
          createTask({
            id: "T1",
            status: "in_progress",
            lastOutput: "Working on implementation...",
            lastActivityAt: Date.now(),
          }),
        ],
      });

      const mockCtx = {
        sessionManager: {
          getBranch: vi
            .fn()
            .mockReturnValue([{ type: "custom", customType: STATE_TYPE, data: stateWithOutput }]),
        },
      } as unknown as ExtensionContext;

      const restored = restoreState(mockCtx);

      expect(restored?.tasks[0].lastOutput).toBe("Working on implementation...");
    });
  });

  describe("STATE_TYPE constant", () => {
    it("is exported as workflow-state", () => {
      expect(STATE_TYPE).toBe("workflow-state");
    });
  });
});
