import { describe, expect, it } from "vitest";
import {
  signalWorkflowEvent,
  waitForWorkflowEvent,
} from "../.pi/extensions/workflow-orchestrator/index.js";

describe("waitForWorkflowEvent", () => {
  it("resolves when the clarification token is cleared", async () => {
    const controller = new AbortController();
    const token = "clarification-token";
    const promise = waitForWorkflowEvent(controller.signal, token);
    let settled = false;
    promise.then(() => {
      settled = true;
    });

    expect(settled).toBe(false);

    signalWorkflowEvent(token);
    await promise;

    expect(settled).toBe(true);
  });
});
