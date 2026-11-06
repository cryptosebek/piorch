/**
 * Extract JSON object from text that may contain markdown or other content.
 */
export function extractJson(text: string): any {
  const cleaned = text.replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""));
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found");
  const jsonText = cleaned.slice(start, end + 1);
  return JSON.parse(jsonText);
}

/**
 * Normalize a goal string by removing surrounding quotes.
 */
export function normalizeGoal(goal?: string): string | undefined {
  if (!goal) return undefined;
  const trimmed = goal.trim();
  if (!trimmed) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
