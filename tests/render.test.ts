import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowState, TaskState } from "../.pi/extensions/workflow-orchestrator/state.js";
import {
  updateStatus,
  setPmWidgetStatus,
  setTaskListExpanded,
} from "../.pi/extensions/workflow-orchestrator/render.js";

// Portable frozen clock: works with both vitest and bun test runners.
const FROZEN_NOW = new Date("2026-03-15T12:00:00.000Z").getTime();
let originalDateNow: () => number;

describe("render.ts", () => {
  let mockCtx: ExtensionContext;
  let mockUi: any;

  beforeEach(() => {
    // Freeze Date.now() without relying on vitest fake timers
    originalDateNow = Date.now;
    Date.now = () => FROZEN_NOW;

    mockUi = {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      theme: {
        fg: vi.fn((color, text) => text),
      },
      notify: vi.fn(),
    };

    mockCtx = {
      cwd: "/test",
      hasUI: true,
      ui: mockUi,
      sessionManager: {
        getBranch: vi.fn(),
        appendEntry: vi.fn(),
      },
    } as unknown as ExtensionContext;
  });

  afterEach(() => {
    Date.now = originalDateNow;
    vi.clearAllMocks();
  });

  function createBaseState(overrides?: Partial<WorkflowState>): WorkflowState {
    return {
      runId: "test-run",
      workflowName: "default",
      goal: "Test goal",
      status: "running",
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
      description: "Description",
      status: "pending",
      retries: 0,
      ...overrides,
    } as TaskState;
  }

  describe("setPmWidgetStatus", () => {
    it("sets PM widget status", () => {
      setPmWidgetStatus("generating wave...");
      // The status is stored internally and used by updateStatus
      // We verify it's used by checking updateStatus output
      const state = createBaseState();
      updateStatus(mockCtx, state);

      expect(mockUi.setWidget).toHaveBeenCalled();
    });

    it("clears PM widget status", () => {
      setPmWidgetStatus(undefined);
      const state = createBaseState();
      updateStatus(mockCtx, state);

      expect(mockUi.setWidget).toHaveBeenCalled();
    });
  });

  describe("setTaskListExpanded", () => {
    it("sets task list expanded state", () => {
      setTaskListExpanded(true);
      const state = createBaseState();
      updateStatus(mockCtx, state);

      // When expanded, should show more tasks and no hint
      expect(mockUi.setWidget).toHaveBeenCalled();
    });

    it("collapses task list", () => {
      setTaskListExpanded(false);
      const state = createBaseState({
        tasks: Array(5)
          .fill(null)
          .map((_, i) => createTask({ id: `T${i + 1}`, title: `Task ${i + 1}` })),
      });
      updateStatus(mockCtx, state);

      // When collapsed with >3 tasks, should show hint
      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];
      const hintLine = lines.find((l) => l.includes("+"));
      expect(hintLine).toContain("/workflow expand");
    });
  });

  describe("updateStatus", () => {
    it("clears UI when no state", () => {
      updateStatus(mockCtx, undefined);

      expect(mockUi.setStatus).toHaveBeenCalledWith("workflow", undefined);
      expect(mockUi.setWidget).toHaveBeenCalledWith("workflow", undefined);
    });

    it("does nothing without UI", () => {
      const noUiCtx = { ...mockCtx, hasUI: false };
      updateStatus(noUiCtx, createBaseState());

      expect(mockUi.setStatus).not.toHaveBeenCalled();
      expect(mockUi.setWidget).not.toHaveBeenCalled();
    });

    it("shows workflow status with task counts", () => {
      const state = createBaseState({
        waveIndex: 2,
        tasks: [
          createTask({ status: "verified" }),
          createTask({ status: "verified" }),
          createTask({ status: "failed" }),
          createTask({ status: "pending" }),
        ],
      });

      updateStatus(mockCtx, state);

      expect(mockUi.setStatus).toHaveBeenCalledWith(
        "workflow",
        "running: Wave 3: 2/4 verified, 1 failed",
      );
    });

    it("shows all tasks verified", () => {
      const state = createBaseState({
        tasks: [createTask({ status: "verified" }), createTask({ status: "verified" })],
      });

      updateStatus(mockCtx, state);

      expect(mockUi.setStatus).toHaveBeenCalledWith("workflow", "running: Wave 1: 2/2 verified");
    });

    it("sorts tasks by status (in_progress first)", () => {
      const state = createBaseState({
        tasks: [
          createTask({ id: "T1", status: "verified", title: "Verified" }),
          createTask({ id: "T2", status: "in_progress", title: "In Progress" }),
          createTask({ id: "T3", status: "pending", title: "Pending" }),
          createTask({ id: "T4", status: "failed", title: "Failed" }),
        ],
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];

      // Check order: in_progress should come before pending, verified, failed
      const taskLines = lines.filter((l) => l.includes("T"));
      expect(taskLines[0]).toContain("T2"); // in_progress
    });

    it("shows spinner for active tasks", () => {
      const now = Date.now();
      const state = createBaseState({
        tasks: [
          createTask({
            id: "T1",
            status: "in_progress",
            title: "Active task",
            lastActivityAt: now, // Just now - should show spinner
          }),
        ],
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];
      // Spinner characters: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏
      const spinnerLine = lines.find((l) => l.includes("T1"));
      expect(spinnerLine).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    });

    it("shows ellipsis for inactive tasks", () => {
      const oldTime = Date.now() - 5000; // 5 seconds ago
      const state = createBaseState({
        tasks: [
          createTask({
            id: "T1",
            status: "in_progress",
            title: "Old task",
            lastActivityAt: oldTime,
          }),
        ],
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];
      const taskLine = lines.find((l) => l.includes("T1"));
      expect(taskLine).toContain("…");
    });

    it("shows task status icons", () => {
      setTaskListExpanded(true); // Show all tasks
      const state = createBaseState({
        tasks: [
          createTask({ id: "T1", status: "verified", title: "Done" }),
          createTask({ id: "T2", status: "failed", title: "Failed" }),
          createTask({ id: "T3", status: "stopped", title: "Stopped" }),
          createTask({ id: "T4", status: "pending", title: "Pending" }),
        ],
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];
      const output = lines.join("\n");

      // verified shows ✓
      expect(output).toContain("✓");
      // stopped shows ⏸
      expect(output).toContain("⏸");
      // All tasks should be visible
      expect(output).toContain("T1");
      expect(output).toContain("T2");
      expect(output).toContain("T3");
      expect(output).toContain("T4");
    });

    it("shows stage and agent info", () => {
      const state = createBaseState({
        tasks: [
          createTask({
            id: "T1",
            status: "in_progress",
            title: "Task with stage",
            stageId: "develop",
            lastAgent: "developer",
          }),
        ],
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];
      const taskLine = lines.find((l) => l.includes("T1"));

      expect(taskLine).toContain("[developer]");
      expect(taskLine).toContain("(develop)");
    });

    it("shows task output for in_progress tasks", () => {
      const state = createBaseState({
        tasks: [
          createTask({
            id: "T1",
            status: "in_progress",
            title: "Task with output",
            lastOutput: "Working on it...",
          }),
        ],
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];

      expect(lines).toContainEqual(expect.stringContaining("↳"));
      expect(lines.join("\n")).toContain("Working on it...");
    });

    it("shows age in seconds for recent tasks", () => {
      const recentTime = Date.now() - 30000; // 30 seconds ago
      const state = createBaseState({
        tasks: [
          createTask({
            id: "T1",
            status: "pending",
            title: "Recent task",
            lastActivityAt: recentTime,
          }),
        ],
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];

      expect(lines.join("\n")).toContain("30s");
    });

    it("shows age in minutes for older tasks", () => {
      const minuteAgo = Date.now() - 120000; // 2 minutes ago
      const state = createBaseState({
        tasks: [
          createTask({
            id: "T1",
            status: "pending",
            title: "Minute task",
            lastActivityAt: minuteAgo,
          }),
        ],
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];

      expect(lines.join("\n")).toContain("2m");
    });

    it("shows age in hours for very old tasks", () => {
      const hourAgo = Date.now() - 7200000; // 2 hours ago
      const state = createBaseState({
        tasks: [
          createTask({
            id: "T1",
            status: "pending",
            title: "Hour task",
            lastActivityAt: hourAgo,
          }),
        ],
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];

      expect(lines.join("\n")).toContain("2h");
    });

    it("limits tasks when collapsed", () => {
      setTaskListExpanded(false);
      const state = createBaseState({
        tasks: Array(10)
          .fill(null)
          .map((_, i) =>
            createTask({ id: `T${i + 1}`, title: `Task ${i + 1}`, status: "pending" }),
          ),
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];

      // Should show 3 tasks + header lines + "more" hint
      expect(lines.length).toBeLessThan(10);
      expect(lines.join("\n")).toContain("+7 more");
    });

    it("shows more tasks when expanded", () => {
      setTaskListExpanded(true);
      const state = createBaseState({
        tasks: Array(10)
          .fill(null)
          .map((_, i) =>
            createTask({ id: `T${i + 1}`, title: `Task ${i + 1}`, status: "pending" }),
          ),
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];

      // Should show up to 10 tasks
      expect(lines.length).toBeGreaterThan(5);
      // No hint when expanded
      expect(lines.join("\n")).not.toContain("/workflow expand");
    });

    it("truncates long task titles", () => {
      const state = createBaseState({
        tasks: [
          createTask({
            id: "T1",
            status: "pending",
            title:
              "This is a very long task title that should be truncated to fit within the maximum width allowed",
          }),
        ],
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];

      expect(lines.join("\n")).toContain("…");
    });

    it("shows PM status line", () => {
      setPmWidgetStatus("generating wave");
      const state = createBaseState();

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];

      expect(lines.join("\n")).toContain("PM: generating wave");
    });

    it("shows idle PM status when not set", () => {
      setPmWidgetStatus(undefined);
      const state = createBaseState();

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];

      expect(lines.join("\n")).toContain("PM: idle");
    });

    it("handles task without lastActivityAt", () => {
      const state = createBaseState({
        tasks: [createTask({ id: "T1", status: "pending", lastActivityAt: undefined })],
      });

      updateStatus(mockCtx, state);

      // Should not crash, should render without age
      expect(mockUi.setWidget).toHaveBeenCalled();
    });

    it("handles empty tasks array", () => {
      const state = createBaseState({ tasks: [] });

      updateStatus(mockCtx, state);

      expect(mockUi.setStatus).toHaveBeenCalledWith("workflow", "running: Wave 1: 0/0 verified");
      expect(mockUi.setWidget).toHaveBeenCalled();
    });
  });

  describe("formatAge helper (indirect)", () => {
    it("formats seconds correctly", () => {
      const oneSecond = Date.now() - 1000;
      const state = createBaseState({
        tasks: [createTask({ id: "T1", status: "pending", title: "T", lastActivityAt: oneSecond })],
      });

      updateStatus(mockCtx, state);

      expect(mockUi.setWidget).toHaveBeenCalled();
    });

    it("formats minimum 1 second", () => {
      const now = Date.now() - 100; // 100ms
      const state = createBaseState({
        tasks: [createTask({ id: "T1", status: "pending", title: "T", lastActivityAt: now })],
      });

      updateStatus(mockCtx, state);

      // Should show "1s" minimum
      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];
      expect(lines.join("\n")).toContain("1s");
    });
  });

  describe("shorten helper (indirect)", () => {
    it("truncates text longer than max", () => {
      const state = createBaseState({
        workflowName: "This is a very long workflow name that exceeds the maximum width",
        tasks: [],
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];
      // Should be truncated with ellipsis
      expect(lines[0].length).toBeLessThanOrEqual(61); // 60 + possible ellipsis
    });

    it("does not truncate short text", () => {
      const state = createBaseState({
        workflowName: "short",
        tasks: [],
      });

      updateStatus(mockCtx, state);

      const widgetCall = mockUi.setWidget.mock.calls[0];
      const lines = widgetCall[1] as string[];
      expect(lines[0]).toContain("short");
    });
  });
});
