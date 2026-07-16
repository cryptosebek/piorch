import { describe, expect, it } from "vitest";
import { pickModel } from "../.pi/extensions/workflow-orchestrator/models.js";
import { formatSubagentError } from "../.pi/extensions/workflow-orchestrator/utils.js";

describe("pickModel", () => {
  it("returns the first non-empty candidate", () => {
    expect(pickModel(undefined, "google/gemini-2.0-flash")).toBe("google/gemini-2.0-flash");
    expect(pickModel("openrouter/custom", "google/gemini-2.0-flash")).toBe("openrouter/custom");
    expect(pickModel(undefined, undefined)).toBeUndefined();
  });
});

describe("formatSubagentError", () => {
  it("adds a short hint for model errors", () => {
    const message = formatSubagentError("404: model is unavailable");
    expect(message).toContain("/model");
  });
});
