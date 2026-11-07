import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { WorkflowState } from "../.pi/extensions/workflow-orchestrator/state.js";
import type { ToolCallCapture } from "../.pi/extensions/workflow-orchestrator/runner.js";

type Result = { text?: string; calls?: ToolCallCapture[] };
const instances: FakeRpcAgent[] = [];
let behavior: ((agent: FakeRpcAgent, prompt: string) => Result | Promise<Result>) | undefined;

function report(status: string): Result {
  return {
    calls: [{ name: "report_task_result", arguments: { status, summary: "Finished", issues: [] } }],
  };
}

class FakeRpcAgent {
  role: string;
  prompts: string[] = [];
  disposed = false;
  running = false;
  calls: ToolCallCapture[] = [];
  cancel?: () => void;
  constructor(readonly options: { systemPrompt: string; sessionFile: string }) {
    this.role = options.systemPrompt.includes("technical PM")
      ? "pm"
      : options.systemPrompt.includes("You are a developer")
        ? "developer"
        : "verifier";
    instances.push(this);
  }
  isRunning() {
    return this.running;
  }
  getLastToolCalls() {
    return this.calls;
  }
  sendSteer(message: string) {
    this.prompts.push(message);
  }
  abort() {
    this.cancel?.();
  }
  dispose() {
    this.disposed = true;
    this.abort();
  }
  runPrompt(prompt: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    this.prompts.push(prompt);
    this.running = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        this.running = false;
        this.cancel = undefined;
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (!settled) {
          cleanup();
          reject(new Error("Aborted"));
        }
      };
      this.cancel = onAbort;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      Promise.resolve()
        .then(
          () =>
            behavior?.(this, prompt) ??
            (this.role === "pm"
              ? { calls: [{ name: "generate_wave", arguments: { done: true } }] }
              : report(this.role === "developer" ? "done" : "pass")),
        )
        .then(
          (result) => {
            if (settled) return;
            this.calls = result.calls ?? [];
            cleanup();
            resolve(result.text ?? "");
          },
          (error) => {
            if (!settled) {
              cleanup();
              reject(error);
            }
          },
        );
    });
  }
}

vi.mock("../.pi/extensions/workflow-orchestrator/runner.js", () => ({ RpcAgent: FakeRpcAgent }));
const { default: register } = await import("../.pi/extensions/workflow-orchestrator/index.js");
const defaults = JSON.parse(fs.readFileSync(".pi/workflows/default.workflow.json", "utf8"));
const task = (id = "T1") => ({ id, title: `Task ${id}`, description: "Implement the task" });
const wave = (id = "T1") => ({ goal: `Wave ${id}`, tasks: [task(id)] });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const waitFor = (predicate: () => boolean) =>
  vi.waitFor(() => expect(predicate()).toBe(true), { interval: 5 });

describe("workflow lifecycle", () => {
  let cwd: string;
  let harness: ReturnType<typeof createHarness> | undefined;
  beforeEach(() => {
    instances.length = 0;
    behavior = undefined;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piorch-lifecycle-"));
    fs.mkdirSync(path.join(cwd, ".pi/workflows"), { recursive: true });
    fs.cpSync(path.resolve(".pi/agents"), path.join(cwd, ".pi/agents"), { recursive: true });
    writeConfig();
  });
  afterEach(async () => {
    await harness?.events.session_shutdown({}, harness.ctx);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  function writeConfig(overrides: Record<string, unknown> = {}) {
    fs.writeFileSync(
      path.join(cwd, ".pi/workflows/default.workflow.json"),
      JSON.stringify({
        ...defaults,
        maxTaskRetries: 0,
        parallelism: 2,
        waveSource: { type: "static", staticWaves: [wave()] },
        ...overrides,
      }),
    );
  }
  function createHarness(saved?: WorkflowState) {
    let branch: any[] = saved
      ? [{ type: "custom", customType: "workflow-state", data: clone(saved) }]
      : [];
    const events: Record<string, (...args: any[]) => any> = {};
    const commands: Record<string, (...args: any[]) => any> = {};
    const tools: Record<string, any> = {};
    const notices: string[] = [];
    const pi = {
      on: (name: string, handler: any) => (events[name] = handler),
      registerCommand: (name: string, definition: any) => (commands[name] = definition.handler),
      registerTool: (tool: any) => (tools[tool.name] = tool),
      registerMessageRenderer() {},
      sendUserMessage: vi.fn(),
      sendMessage: (message: any) => notices.push(message.content),
      appendEntry: (type: string, state: WorkflowState) =>
        branch.push({ type: "custom", customType: type, data: clone(state) }),
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      sessionManager: { getBranch: () => branch },
    } as unknown as ExtensionCommandContext;
    register(pi);
    events.session_start({}, ctx);
    const result = {
      pi,
      ctx,
      events,
      tools,
      notices,
      command: (args: string) => commands.workflow(args, ctx),
      switchBranch: (next: any[]) => {
        branch = next;
      },
      get state(): WorkflowState | undefined {
        return branch.at(-1)?.data;
      },
    };
    harness = result;
    return result;
  }

  it("starts from the workflow_run tool and permits a new start after completion", async () => {
    const h = createHarness();
    await h.tools.workflow_run.execute(
      "start",
      { name: "default", goal: "User's exact goal" },
      undefined,
      undefined,
      h.ctx,
    );
    await waitFor(() => h.notices.includes("Workflow completed."));
    expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(instances[0].prompts[0]).toContain("User's exact goal");
    const firstId = h.state!.runId;
    await h.command("start default Another project");
    await waitFor(() => h.state!.runId !== firstId && h.state!.active === false);
    expect(h.state!.tasks[0].status).toBe("verified");
  });

  it("holds a stopped wave open and processes the resumed result before advancing", async () => {
    writeConfig({
      waveSource: {
        type: "static",
        staticWaves: [{ goal: "First", tasks: [task("T1"), task("T2")] }, wave("T3")],
      },
    });
    let blocked = true;
    behavior = (agent) =>
      agent.role === "developer" && agent.options.sessionFile.includes("T1-") && blocked
        ? new Promise(() => {})
        : report(agent.role === "developer" ? "done" : "pass");
    const h = createHarness();
    await h.command("start default Saved project goal");
    await waitFor(() =>
      instances.some((agent) => agent.running && agent.options.sessionFile.includes("T1-")),
    );
    await h.command("stop-task T1");
    await waitFor(() => h.state!.tasks.find((task) => task.id === "T2")?.status === "verified");
    expect(h.state).toMatchObject({ active: true, waveIndex: 0 });
    expect(h.notices).not.toContain("Workflow completed.");
    blocked = false;
    await h.command("message T1 Continue with the correction");
    await waitFor(() => h.notices.includes("Workflow completed."));
    const t1Runs = instances.filter(
      (agent) => agent.role === "developer" && agent.options.sessionFile.includes("T1-"),
    );
    expect(t1Runs).toHaveLength(2);
    expect(t1Runs[1].prompts[0]).toContain("Saved project goal");
    expect(t1Runs[1].prompts[0]).toContain("Continue with the correction");
    expect(t1Runs[1].options.sessionFile).toBe(t1Runs[0].options.sessionFile);
    expect(h.state).toMatchObject({ waveIndex: 1, tasks: [{ id: "T3", status: "verified" }] });
  });

  it("keeps exhausted failures in their wave until an explicit retry succeeds", async () => {
    writeConfig({
      maxTaskRetries: 1,
      waveSource: { type: "static", staticWaves: [wave(), wave("T2")] },
    });
    let failing = true;
    behavior = (agent) => report(agent.role === "developer" ? "done" : failing ? "fail" : "pass");
    const h = createHarness();
    await h.command("start default");
    await waitFor(() => h.state!.tasks[0]?.status === "failed");
    expect(instances.filter((agent) => agent.role === "verifier")).toHaveLength(2);
    expect(h.state!.waveIndex).toBe(0);
    expect(h.notices.some((notice) => notice.includes("exhausting retries"))).toBe(true);
    expect(h.notices).not.toContain("Workflow completed.");
    failing = false;
    await h.command("message T1 Recheck the manual fix");
    await waitFor(() => h.notices.includes("Workflow completed."));
    expect(h.state!.waveIndex).toBe(1);
  });

  it("resumes saved stopped tasks only after a message", async () => {
    const h = createHarness({
      runId: "saved-run",
      workflowName: "default",
      goal: "Saved goal",
      active: false,
      waveIndex: 0,
      wave: wave(),
      tasks: [{ ...task(), status: "stopped", retries: 0, stageId: "develop" }],
      updatedAt: 0,
    });
    await h.command("resume");
    await waitFor(() => h.state?.active === true);
    expect(instances).toHaveLength(0);
    expect(h.notices).not.toContain("Workflow completed.");
    await h.command("message T1 Continue");
    await waitFor(() => h.notices.includes("Workflow completed."));
    expect(h.state!.tasks[0].status).toBe("verified");
  });

  it("lets any stopped task resume without waiting for earlier stopped tasks", async () => {
    writeConfig({ parallelism: 1 });
    const savedTasks = [task(), task("T2")];
    const h = createHarness({
      runId: "saved-run",
      workflowName: "default",
      goal: "Saved goal",
      active: false,
      waveIndex: 0,
      wave: { goal: "g", tasks: savedTasks },
      tasks: savedTasks.map((task) => ({
        ...task,
        status: "stopped",
        retries: 0,
        stageId: "develop",
      })),
      updatedAt: 0,
    });
    await h.command("resume");
    await h.command("message T2 Work on this one first");
    await waitFor(() => h.state?.tasks[1]?.status === "verified");
    expect(h.state!.tasks[0].status).toBe("stopped");
    expect(instances.filter((agent) => agent.role === "developer")).toHaveLength(1);
    await h.command("message T1 Continue");
    await waitFor(() => h.notices.includes("Workflow completed."));
  });

  it("stops queued and running tasks and allows a fresh workflow", async () => {
    writeConfig({
      parallelism: 1,
      waveSource: { type: "static", staticWaves: [{ goal: "g", tasks: [task(), task("T2")] }] },
    });
    behavior = () => new Promise(() => {});
    const h = createHarness();
    await h.command("start default");
    await waitFor(() => instances.length === 1);
    await h.command("stop");
    expect(h.state!.tasks.map((task) => task.status)).toEqual(["stopped", "stopped"]);
    expect(instances[0].disposed).toBe(true);
    expect(h.notices).not.toContain("Workflow completed.");
    behavior = undefined;
    await h.command("start default Fresh goal");
    await waitFor(() => h.notices.includes("Workflow completed."));
    expect(h.state!.goal).toBe("Fresh goal");
  });

  it.each(["switch", "fork", "tree"])(
    "drains the old workflow before a session %s",
    async (event) => {
      behavior = () => new Promise(() => {});
      const h = createHarness();
      await h.command("start default");
      await waitFor(() => instances.length === 1);
      await h.events[`session_before_${event}`]({}, h.ctx);
      expect(instances[0].disposed).toBe(true);
      h.switchBranch([]);
      await h.events[`session_${event}`]({}, h.ctx);
      expect(await h.events.input({ source: "user", text: "New chat" }, h.ctx)).toEqual({
        action: "continue",
      });
      expect(h.state).toBeUndefined();
      behavior = undefined;
      await h.command("start default New session goal");
      await waitFor(() => h.notices.includes("Workflow completed."));
      expect(h.state!.goal).toBe("New session goal");
    },
  );

  it("cancels PM chat before switching sessions and drops any late reply", async () => {
    let finishChat: ((result: Result) => void) | undefined;
    behavior = (agent) =>
      agent.role === "pm"
        ? new Promise((resolve) => {
            finishChat = resolve;
          })
        : new Promise(() => {});
    const h = createHarness();
    await h.command("start default");
    await waitFor(() => instances.some((agent) => agent.role === "developer" && agent.running));
    const chat = h.events.input({ source: "user", text: "Explain the plan" }, h.ctx);
    await waitFor(() => finishChat !== undefined);
    await h.events.session_before_switch({}, h.ctx);
    await chat;
    h.switchBranch([]);
    await h.events.session_switch({}, h.ctx);
    finishChat!({ text: "Old PM reply" });
    await Promise.resolve();
    expect(h.notices).not.toContain("Old PM reply");
    expect(h.state).toBeUndefined();
    expect(instances.every((agent) => agent.disposed)).toBe(true);
  });

  it.each(["tool", "json"])(
    "rejects malformed %s reports before verification can pass",
    async (source) => {
      behavior = (agent) =>
        agent.role === "developer"
          ? report("done")
          : source === "tool"
            ? {
                calls: [
                  {
                    name: "report_task_result",
                    arguments: { status: "pass", issues: "wrong type" },
                  },
                ],
              }
            : { text: JSON.stringify({ status: "pass", issues: "wrong type" }) };
      const h = createHarness();
      await h.command("start default");
      await waitFor(() => h.state!.tasks[0]?.status === "failed");
      expect(h.notices).not.toContain("Workflow completed.");
    },
  );

  it("uses the latest successful task report", async () => {
    behavior = (agent) =>
      agent.role === "developer"
        ? report("done")
        : {
            calls: [...report("pass").calls!, ...report("fail").calls!],
          };
    const h = createHarness();
    await h.command("start default");
    await waitFor(() => h.state!.tasks[0]?.status === "failed");
    expect(h.state!.tasks[0].stageOutputs?.verify.status).toBe("fail");
  });

  it.each(["../escape", "duplicate"])(
    "retries unsafe PM waves (%s) and uses the latest corrected report",
    async (invalid) => {
      writeConfig({ waveSource: { type: "pm" }, maxPmRetries: 2 });
      let plans = 0;
      behavior = (agent) => {
        if (agent.role !== "pm") return report(agent.role === "developer" ? "done" : "pass");
        plans++;
        if (plans === 1)
          return {
            calls: [
              {
                name: "generate_wave",
                arguments: {
                  done: false,
                  wave:
                    invalid === "duplicate"
                      ? { goal: "g", tasks: [task(), task()] }
                      : wave(invalid),
                },
              },
            ],
          };
        if (plans === 2)
          return {
            calls: [
              { name: "generate_wave", arguments: { done: true } },
              { name: "generate_wave", arguments: { done: false, wave: wave() } },
            ],
          };
        return { calls: [{ name: "generate_wave", arguments: { done: true } }] };
      };
      const h = createHarness();
      await h.command("start default");
      await waitFor(() => h.notices.includes("Workflow completed."));
      expect(plans).toBe(3);
      expect(instances[0].prompts[1]).toContain("Error from previous attempt");
      expect(h.state!.tasks[0].status).toBe("verified");
      expect(instances.filter((agent) => agent.role === "developer")).toHaveLength(1);
    },
  );

  it("keeps repeated task IDs in different wave session directories", async () => {
    writeConfig({ waveSource: { type: "static", staticWaves: [wave(), wave()] } });
    const h = createHarness();
    await h.command("start default");
    await waitFor(() => h.notices.includes("Workflow completed."));
    const files = instances
      .filter((agent) => agent.role === "developer")
      .map((agent) => agent.options.sessionFile);
    expect(files[0]).toContain(`${cwd}${path.sep}.pi${path.sep}workflows${path.sep}sessions`);
    expect(files[0]).toContain("wave-0");
    expect(files[1]).toContain("wave-1");
    expect(files[0]).not.toBe(files[1]);
  });

  it("keeps legacy task sessions when resuming and rejects paths outside the saved run", async () => {
    const legacyFile = path.join(".pi", "workflows", "sessions", "saved-run", "T1-develop.jsonl");
    const h = createHarness({
      runId: "saved-run",
      workflowName: "default",
      goal: "Saved goal",
      active: false,
      waveIndex: 0,
      wave: wave(),
      tasks: [
        {
          ...task(),
          status: "stopped",
          retries: 0,
          stageId: "develop",
          sessionFiles: { develop: legacyFile, verify: path.join(cwd, "escape.jsonl") },
        },
      ],
      updatedAt: 0,
    });
    await h.command("message T1 Continue");
    await waitFor(() => h.state?.tasks[0]?.status === "failed");
    expect(instances[0].options.sessionFile).toBe(path.join(cwd, legacyFile));
    expect(instances).toHaveLength(1);
    expect(fs.existsSync(path.join(cwd, "escape.jsonl"))).toBe(false);
  });

  it("accepts configured custom statuses in legacy JSON reports", async () => {
    writeConfig({
      taskFlow: {
        stages: [
          {
            id: "review",
            agent: "verifier",
            inputTemplate: "Review this task",
            outputSchema: { status: "ready" },
            transitions: [{ when: { field: "status", equals: "ready" }, next: "complete" }],
          },
        ],
      },
    });
    behavior = () => ({ text: JSON.stringify({ status: "ready" }) });
    const h = createHarness();
    await h.command("start default");
    await waitFor(() => h.notices.includes("Workflow completed."));
    expect(h.state!.tasks[0].status).toBe("verified");
  });

  it("resumes after a wave limit without repeating finished waves", async () => {
    const config = { waveSource: { type: "static", staticWaves: [wave(), wave("T2")] } };
    writeConfig({ ...config, maxWaves: 1 });
    const h = createHarness();
    await h.command("start default");
    await waitFor(() => h.notices.some((notice) => notice.includes("reached maxWaves")));
    expect(h.notices).not.toContain("Workflow completed.");
    writeConfig({ ...config, maxWaves: 2 });
    await h.command("resume");
    await waitFor(() => h.notices.includes("Workflow completed."));
    expect(instances.filter((agent) => agent.role === "developer")).toHaveLength(2);
    expect(h.state!.waveSummaries).toHaveLength(2);
  });
});
