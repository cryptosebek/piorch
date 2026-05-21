import { describe, expect, it } from "vitest";
import {
  signalClarificationResolved,
  waitForClarification,
} from "../.pi/extensions/workflow-orchestrator/index.js";

describe("waitForClarification", () => {
  it("resolves when the clarification token is cleared", async () => {
    const controller = new AbortController();
    const token = "clarification-token";
    const promise = waitForClarification(controller.signal, token);
    let settled = false;
    promise.then(() => {
      settled = true;
    });

    expect(settled).toBe(false);

    signalClarificationResolved(token);
    await promise;

    expect(settled).toBe(true);
  });
});
