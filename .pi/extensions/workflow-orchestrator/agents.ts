import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function parseFrontmatter<T extends Record<string, unknown>>(
  content: string,
): { frontmatter: T; body: string } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: {} as T, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {} as T, body: normalized };
  const frontmatter: Record<string, unknown> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) frontmatter[key] = value;
  }
  return { frontmatter: frontmatter as T, body: normalized.slice(end + 4).trim() };
}

export type AgentSource = "user" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!fs.existsSync(dir)) return agents;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function discoverAgents(cwd: string): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const userAgents = loadAgentsFromDir(userDir, "user");
  const projectAgents = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];

  const agentMap = new Map<string, AgentConfig>();
  for (const agent of userAgents) agentMap.set(agent.name, agent);
  for (const agent of projectAgents) agentMap.set(agent.name, agent);

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function findAgentByName(agents: AgentConfig[], name: string): AgentConfig | undefined {
  return agents.find((agent) => agent.name === name);
}
