import { DEFAULT_WORKFLOW_NAME } from "./setup.js";
import { normalizeGoal } from "./utils.js";

export const WORKFLOW_COMMANDS = new Set([
  "start",
  "resume",
  "status",
  "stop",
  "stop-task",
  "message",
  "expand",
  "collapse",
  "help",
]);

export interface ParsedWorkflowStart {
  workflowName: string;
  goal?: string;
  model?: string;
}

/** Tokenize command arguments while preserving quoted phrases as one token. */
export function tokenizeWorkflowArgs(args: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  const pushToken = () => {
    if (token) tokens.push(token);
    token = "";
  };

  for (const char of args) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
      continue;
    }

    if (char === '"' || (char === "'" && token.length === 0)) {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) pushToken();
    else token += char;
  }

  if (escaped) token += "\\";
  pushToken();
  return tokens;
}

export function isValidWorkflowName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0 && name.length <= 50;
}

export function extractModelFlag(tokens: string[]): { tokens: string[]; model?: string } {
  const stripped: string[] = [];
  let model: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--model" && i + 1 < tokens.length) {
      model = normalizeGoal(tokens[++i]);
      continue;
    }
    if (token === "--model") continue;
    stripped.push(token);
  }

  return { tokens: stripped, model };
}

export function parseWorkflowStartArgs(tokens: string[]): ParsedWorkflowStart | null {
  const { tokens: rest, model } = extractModelFlag(tokens.slice(1));
  if (rest.length === 0) return null;

  if (rest.length === 1) {
    const token = rest[0];
    if (isValidWorkflowName(token)) {
      return { workflowName: token, goal: undefined, model };
    }
    return {
      workflowName: DEFAULT_WORKFLOW_NAME,
      goal: normalizeGoal(token),
      model,
    };
  }

  if (!isValidWorkflowName(rest[0])) {
    return {
      workflowName: DEFAULT_WORKFLOW_NAME,
      goal: normalizeGoal(rest.join(" ")),
      model,
    };
  }

  return {
    workflowName: rest[0],
    goal: normalizeGoal(rest.slice(1).join(" ")),
    model,
  };
}

export function parseWorkflowShorthandGoal(tokens: string[]): {
  goal?: string;
  model?: string;
} {
  const { tokens: stripped, model } = extractModelFlag(tokens);
  return {
    goal: normalizeGoal(stripped.join(" ")),
    model,
  };
}
