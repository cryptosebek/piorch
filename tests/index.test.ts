import { describe, expect, it } from "vitest";
import { extractJson, normalizeGoal } from "../.pi/extensions/workflow-orchestrator/utils.js";

describe("extractJson", () => {
  it("extracts JSON object from plain text", () => {
    const text = 'Here is the result: {"status": "done", "summary": "completed"}';
    const result = extractJson(text);
    expect(result).toEqual({ status: "done", summary: "completed" });
  });

  it("extracts JSON from markdown code block", () => {
    const text = '```json\n{"wave": {"goal": "test", "tasks": []}}\n```';
    const result = extractJson(text);
    expect(result).toEqual({ wave: { goal: "test", tasks: [] } });
  });

  it("extracts JSON with nested arrays", () => {
    const text = `
      Some text before
      {"done": false, "wave": {"goal": "test", "tasks": [{"id": "T1", "title": "Task 1"}]}}
      Some text after
    `;
    const result = extractJson(text);
    expect(result).toEqual({
      done: false,
      wave: { goal: "test", tasks: [{ id: "T1", title: "Task 1" }] },
    });
  });

  it("throws when no JSON found", () => {
    const text = "This is just plain text with no JSON";
    expect(() => extractJson(text)).toThrow("No JSON object found");
  });

  it("handles JSON with special characters", () => {
    const text = '{"summary": "Created file with \\n newline and \\"quotes\\""}';
    const result = extractJson(text);
    expect(result).toEqual({
      summary: 'Created file with \n newline and "quotes"',
    });
  });

  it("extracts JSON spanning full text from first { to last }", () => {
    const text = 'First: {"a": 1}. Second: {"b": 2}';
    // extractJson finds first { and last }, so it extracts {"a": 1}. Second: {"b": 2}
    // which is not valid JSON - this is expected behavior
    expect(() => extractJson(text)).toThrow();
  });
});

describe("normalizeGoal", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeGoal(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeGoal("")).toBeUndefined();
  });

  it("returns undefined for whitespace only", () => {
    expect(normalizeGoal("   ")).toBeUndefined();
  });

  it("removes double quotes", () => {
    expect(normalizeGoal('"Build a bot"')).toBe("Build a bot");
  });

  it("removes single quotes", () => {
    expect(normalizeGoal("'Build a bot'")).toBe("Build a bot");
  });

  it("trims whitespace", () => {
    expect(normalizeGoal("  Build a bot  ")).toBe("Build a bot");
  });

  it("handles quoted and trimmed", () => {
    expect(normalizeGoal('  "Build a bot"  ')).toBe("Build a bot");
  });

  it("returns unquoted text as-is", () => {
    expect(normalizeGoal("Build a bot")).toBe("Build a bot");
  });
});
