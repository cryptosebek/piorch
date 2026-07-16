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
  let trimmed = goal.trim();
  if (!trimmed) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  } else {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && !trimmed.slice(1).includes(first)) {
      trimmed = trimmed.slice(1).trim();
    }
    if ((last === '"' || last === "'") && !trimmed.slice(0, -1).includes(last)) {
      trimmed = trimmed.slice(0, -1).trim();
    }
  }
  return trimmed || undefined;
}

export function formatSubagentError(message: string): string {
  const trimmed = message.trim();
  if (/model is unavailable|model not found|404/i.test(trimmed)) {
    return `${trimmed}\nHint: pick a model in Pi (/model) or set model: in .pi/agents/*.md.`;
  }
  return trimmed;
}
