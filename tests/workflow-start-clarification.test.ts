import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type RegisteredHandlers = {
  commands: Record<string, (args: string, ctx: ExtensionCommandContext) => Promise<void> | void>;
  events: Record<string, (event: any, ctx: ExtensionContext) => Promise<any> | any>;
};

type FakeRpcOptions = {
  systemPrompt?: string;
};

const rpcInstances: FakeRpcAgent[] = [];

class FakeRpcAgent {
  private toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  private pmWaveCalls = 0;
  readonly role: "pm" | "developer" | "verifier" | "unknown";

  constructor(readonly options: FakeRpcOptions) {
    const prompt = options.systemPrompt ?? "";
    if (prompt.includes("technical PM")) this.role = "pm";
    else if (prompt.includes("You are a developer")) this.role = "developer";
    else if (prompt.includes("You are a verifier")) this.role = "verifier";
    else this.role = "unknown";
    rpcInstances.push(this);
  }

  isRunning(): boolean {
    return false;
  }

  abort(): void {}

  dispose(): void {}

  sendSteer(): void {}

  getLastToolCalls(): Array<{ name: string; arguments: Record<string, unknown> }> {
    return this.toolCalls;
  }

  async runPrompt(message: string): Promise<string> {
    this.toolCalls = [];

    if (this.role === "pm") {
      if (message.includes("User message:")) {
        return "Thanks, I have the clarification.";
      }

      this.pmWaveCalls += 1;
      if (this.pmWaveCalls === 1) {
        return "I need a little clarification before I can generate the wave.";
      }

      if (this.pmWaveCalls === 2) {
        this.toolCalls = [
          {
            name: "generate_wave",
            arguments: {
              done: false,
              wave: {
                goal: "Wave 1",
                tasks: [
                  {
                    id: "T1",
                    title: "Implement the feature",
                    description: "Build the requested feature.",
                    requirements: "The feature works end to end.",
                    assignee: "developer",
                  },
                ],
              },
            },
          },
        ];
        return "";
      }

      this.toolCalls = [
        {
          name: "generate_wave",
          arguments: { done: true },
        },
      ];
      return "";
    }

    if (this.role === "developer") {
      this.toolCalls = [
        {
          name: "report_task_result",
          arguments: {
            status: "done",
            summary: "Implemented the feature.",
            filesChanged: ["src/feature.ts"],
            notes: "Looks good.",
          },
        },
      ];
      return "";
    }

    if (this.role === "verifier") {
      this.toolCalls = [
        {
          name: "report_task_result",
          arguments: {
            status: "pass",
            issues: [],
          },
        },
      ];
      return "";
    }

    return "";
  }
}

vi.mock("../.pi/extensions/workflow-orchestrator/runner.js", () => {
  return { RpcAgent: FakeRpcAgent };
});

const { default: registerWorkflowExtension } = await import(
  "../.pi/extensions/workflow-orchestrator/index.js"
);

function createMockContext(branch: any[] = []): ExtensionCommandContext {
  return {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: {
      getBranch: vi.fn().mockImplementation(() => branch),
    },
  } as unknown as ExtensionCommandContext;
}

function createMockPi(branch: any[] = []): ExtensionAPI & RegisteredHandlers {
  const handlers: RegisteredHandlers = {
    commands: {},
    events: {},
  };

  const pi = {
    cwd: process.cwd(),
    hasUI: false,
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn((type: string, state: any) => {
      branch.push({
        type: "custom",
        customType: type,
        data: cloneJson(state),
      });
    }),
    registerCommand: vi.fn((name: string, config: { handler: RegisteredHandlers["commands"][string] }) => {
      handlers.commands[name] = config.handler;
    }),
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn((event: string, handler: RegisteredHandlers["events"][string]) => {
      handlers.events[event] = handler;
    }),
  } as unknown as ExtensionAPI & RegisteredHandlers;

  return Object.assign(pi, handlers);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for workflow state");
}

describe("workflow clarification regression", () => {
  beforeEach(() => {
    rpcInstances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pauses on clarification during start and resumes after user input", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();

    registerWorkflowExtension(pi);
    pi.events.session_start?.({}, ctx);

    const workflowCommand = pi.commands.workflow;
    const inputHandler = pi.events.input;
    expect(workflowCommand).toBeTypeOf("function");
    expect(inputHandler).toBeTypeOf("function");

    await workflowCommand("start default \"Regression goal\"", ctx);

    await waitFor(() =>
      (pi.appendEntry as any).mock.calls.some(
        ([type, state]: [string, any]) =>
          type === "workflow-state" && state?.waitingForClarification === true,
      ),
    );

    const waitingStates: any[] = (pi.appendEntry as any).mock.calls
      .filter(([type]: [string, any]) => type === "workflow-state")
      .map(([, state]: [string, any]) => cloneJson(state));
    const firstWaitingState = waitingStates.find((state: any) => state.waitingForClarification);
    expect(firstWaitingState).toMatchObject({
      active: true,
      waitingForClarification: true,
      waveIndex: 0,
      tasks: [],
    });
    expect(firstWaitingState?.wave).toBeUndefined();

    await inputHandler(
      { source: "user", text: "Please proceed with the planned feature." },
      ctx,
    );

    await waitFor(() =>
      (pi.appendEntry as any).mock.calls.some(
        ([type, state]: [string, any]) =>
          type === "workflow-state" &&
          Array.isArray(state?.tasks) &&
          state.tasks.some((task: any) => task.status === "verified"),
      ),
    );

    const states: any[] = (pi.appendEntry as any).mock.calls
      .filter(([type]: [string, any]) => type === "workflow-state")
      .map(([, state]: [string, any]) => cloneJson(state));

    const clarificationIndex = states.findIndex(
      (state: any) => state.waitingForClarification === true,
    );
    expect(clarificationIndex).toBeGreaterThanOrEqual(0);
    const resumedWaveState = states
      .slice(clarificationIndex + 1)
      .find(
        (state: any) =>
          state.wave?.goal === "Wave 1" && state.tasks?.some((task: any) => task.id === "T1"),
      );
    expect(resumedWaveState).toBeDefined();
    expect(resumedWaveState?.waveIndex).toBe(0);
    expect(states.some((state) => state.active === false)).toBe(true);
  });

});
