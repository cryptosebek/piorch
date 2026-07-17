import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflowPmTools from "../.pi/extensions/workflow-pm-tools/index.js";

describe("workflow-pm-tools extension", () => {
  let mockPi: ExtensionAPI;
  let registeredTool: any;

  const task = (id = "T1") => ({
    id,
    title: "Task",
    description: "Implement the feature",
    requirements: "Run the verifier",
    assignee: "developer",
  });

  beforeEach(() => {
    registeredTool = undefined;
    mockPi = {
      registerTool: vi.fn((definition) => {
        registeredTool = definition;
      }),
      sendMessage: vi.fn(),
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI;
    workflowPmTools(mockPi);
  });

  it("registers generate_wave with a TypeBox schema", () => {
    expect(mockPi.registerTool).toHaveBeenCalled();
    expect(registeredTool.name).toBe("generate_wave");
    expect(registeredTool.parameters).toBeDefined();
  });

  it("accepts project completion with no wave", async () => {
    const result = await registeredTool.execute(
      "call",
      { done: true },
      vi.fn(),
      {},
      new AbortController().signal,
    );
    expect(result.content[0].text).toContain("Project completion");
    expect(result.details.params).toEqual({ done: true });
  });

  it("accepts a nonempty valid wave and returns exact params", async () => {
    const params = { done: false, wave: { goal: "Implement", tasks: [task()] } };
    const result = await registeredTool.execute(
      "call",
      params,
      vi.fn(),
      {},
      new AbortController().signal,
    );
    expect(result.content[0].text).toContain("(1 tasks)");
    expect(result.details.params).toEqual(params);
  });

  it("accepts tasks without an explicit assignee", async () => {
    const params = {
      done: false,
      wave: { goal: "Implement", tasks: [{ ...task(), assignee: undefined }] },
    };
    const result = await registeredTool.execute(
      "call",
      params,
      vi.fn(),
      {},
      new AbortController().signal,
    );
    expect(result.details.params).toEqual(params);
  });

  it("rejects done=false without a wave", async () => {
    await expect(
      registeredTool.execute("call", { done: false }, vi.fn(), {}, new AbortController().signal),
    ).rejects.toThrow("requires a wave");
  });

  it("rejects done=false with an empty wave", async () => {
    await expect(
      registeredTool.execute(
        "call",
        { done: false, wave: { goal: "Empty", tasks: [] } },
        vi.fn(),
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("nonempty wave");
  });

  it("rejects done=true with a wave", async () => {
    await expect(
      registeredTool.execute(
        "call",
        { done: true, wave: { goal: "No", tasks: [task()] } },
        vi.fn(),
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("done=true");
  });

  it("rejects duplicate, unsafe, and unsupported task IDs", async () => {
    for (const tasks of [
      [task("T1"), task("T1")],
      [{ ...task(), id: "../escape" }],
      [{ ...task(), id: "bad id" }],
      [{ ...task(), assignee: "verifier" }],
    ]) {
      await expect(
        registeredTool.execute(
          "call",
          { done: false, wave: { goal: "Bad", tasks } },
          vi.fn(),
          {},
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects missing task requirements", async () => {
    await expect(
      registeredTool.execute(
        "call",
        { done: false, wave: { goal: "Bad", tasks: [{ id: "T1", title: "T", description: "D" }] } },
        vi.fn(),
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("requirements");
  });

  it("does not mutate Pi state", async () => {
    await registeredTool.execute("call", { done: true }, vi.fn(), {}, new AbortController().signal);
    expect(mockPi.sendMessage).not.toHaveBeenCalled();
    expect(mockPi.appendEntry).not.toHaveBeenCalled();
  });
});
