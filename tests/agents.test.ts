import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  discoverAgents,
  findAgentByName,
  type AgentConfig,
} from "../.pi/extensions/workflow-orchestrator/agents.js";

describe("agents.ts", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-agents-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    if (originalHome) {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createAgentFile(dir: string, name: string, content: string): string {
    const filePath = path.join(dir, `${name}.md`);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  function createProjectAgentsDir(cwd: string): string {
    const agentsDir = path.join(cwd, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    return agentsDir;
  }

  function createUserAgentsDir(): string {
    const userDir = path.join(tempDir, ".pi", "agents");
    fs.mkdirSync(userDir, { recursive: true });
    return userDir;
  }

  describe("loadAgentsFromDir (via discoverAgents)", () => {
    it("discovers agents from project .pi/agents directory", () => {
      const agentsDir = createProjectAgentsDir(tempDir);
      createAgentFile(
        agentsDir,
        "pm",
        `---
name: pm
description: Project manager
model: anthropic/claude-sonnet-4-5
tools: read,grep,find
---

You are a PM.
`,
      );

      const result = discoverAgents(tempDir);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]).toMatchObject({
        name: "pm",
        description: "Project manager",
        model: "anthropic/claude-sonnet-4-5",
        tools: ["read", "grep", "find"],
        source: "project",
      });
      expect(result.projectAgentsDir).toBe(agentsDir);
    });

    it("discovers agents from user directory", () => {
      const userDir = createUserAgentsDir();
      createAgentFile(
        userDir,
        "customagent",
        `---
name: customagent
description: Custom test agent
---

You are a custom agent.
`,
      );

      const result = discoverAgents(tempDir);

      // Custom agent from user directory should be found
      const customAgent = result.agents.find((a) => a.name === "customagent");
      expect(customAgent).toBeDefined();
      expect(customAgent?.name).toBe("customagent");
      expect(customAgent?.description).toBe("Custom test agent");
      // Note: source could be 'user' or 'project' depending on whether project
      // agents dir is found in parent directories
    });

    it("merges user and project agents, project takes precedence", () => {
      const userDir = createUserAgentsDir();
      const projectDir = createProjectAgentsDir(tempDir);

      // User agent
      createAgentFile(
        userDir,
        "pm",
        `---
name: pm
description: User PM
---

User PM prompt.
`,
      );

      // Project agent (overrides user)
      createAgentFile(
        projectDir,
        "pm",
        `---
name: pm
description: Project PM
---

Project PM prompt.
`,
      );

      // Project-only agent
      createAgentFile(
        projectDir,
        "verifier",
        `---
name: verifier
description: Verifier agent
---

You are a verifier.
`,
      );

      const result = discoverAgents(tempDir);

      expect(result.agents).toHaveLength(2);
      const pm = result.agents.find((a) => a.name === "pm");
      const verifier = result.agents.find((a) => a.name === "verifier");

      expect(pm?.description).toBe("Project PM"); // Project takes precedence
      expect(pm?.source).toBe("project");
      expect(verifier?.description).toBe("Verifier agent");
      expect(verifier?.source).toBe("project");
    });

    it("handles missing tools field", () => {
      const agentsDir = createProjectAgentsDir(tempDir);
      createAgentFile(
        agentsDir,
        "agent",
        `---
name: agent
description: Simple agent
---

Prompt.
`,
      );

      const result = discoverAgents(tempDir);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].tools).toBeUndefined();
    });

    it("handles empty tools field", () => {
      const agentsDir = createProjectAgentsDir(tempDir);
      createAgentFile(
        agentsDir,
        "agent",
        `---
name: agent
description: Simple agent
tools: 
---

Prompt.
`,
      );

      const result = discoverAgents(tempDir);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].tools).toBeUndefined();
    });

    it("parses tools with whitespace", () => {
      const agentsDir = createProjectAgentsDir(tempDir);
      createAgentFile(
        agentsDir,
        "agent",
        `---
name: agent
description: Agent with tools
tools: read, edit , write,  bash
---

Prompt.
`,
      );

      const result = discoverAgents(tempDir);

      expect(result.agents[0].tools).toEqual(["read", "edit", "write", "bash"]);
    });

    it("skips files without valid frontmatter", () => {
      const agentsDir = createProjectAgentsDir(tempDir);
      // Missing name
      createAgentFile(
        agentsDir,
        "invalid1",
        `---
description: Missing name
---

Prompt.
`,
      );

      // Missing description
      createAgentFile(
        agentsDir,
        "invalid2",
        `---
name: invalid2
---

Prompt.
`,
      );

      // Not markdown
      fs.writeFileSync(path.join(agentsDir, "readme.txt"), "Not markdown");

      const result = discoverAgents(tempDir);

      expect(result.agents).toHaveLength(0);
    });

    it("handles non-existent directory", () => {
      const result = discoverAgents("/non/existent/path");

      expect(result.agents).toHaveLength(0);
      expect(result.projectAgentsDir).toBeNull();
    });

    it("skips non-file entries", () => {
      const agentsDir = createProjectAgentsDir(tempDir);
      // Create subdirectory
      fs.mkdirSync(path.join(agentsDir, "subdir"));

      const result = discoverAgents(tempDir);

      expect(result.agents).toHaveLength(0);
    });

    it("handles model field", () => {
      const agentsDir = createProjectAgentsDir(tempDir);
      createAgentFile(
        agentsDir,
        "pm",
        `---
name: pm
description: PM with model
model: openrouter/stepfun/step-3.5-flash:free
---

Prompt.
`,
      );

      const result = discoverAgents(tempDir);

      expect(result.agents[0].model).toBe("openrouter/stepfun/step-3.5-flash:free");
    });
  });

  describe("findAgentByName", () => {
    const agents: AgentConfig[] = [
      {
        name: "pm",
        description: "Project manager",
        systemPrompt: "PM prompt",
        source: "project",
        filePath: "/test/pm.md",
      },
      {
        name: "developer",
        description: "Developer",
        tools: ["read", "write"],
        systemPrompt: "Dev prompt",
        source: "project",
        filePath: "/test/developer.md",
      },
      {
        name: "verifier",
        description: "Verifier",
        systemPrompt: "Verifier prompt",
        source: "project",
        filePath: "/test/verifier.md",
      },
    ];

    it("finds agent by exact name", () => {
      const result = findAgentByName(agents, "pm");

      expect(result).toBeDefined();
      expect(result?.name).toBe("pm");
      expect(result?.description).toBe("Project manager");
    });

    it("returns undefined for unknown agent", () => {
      const result = findAgentByName(agents, "unknown");

      expect(result).toBeUndefined();
    });

    it("returns first match when multiple agents have same name", () => {
      const agentsWithDupes = [
        ...agents,
        {
          name: "pm",
          description: "Duplicate PM",
          systemPrompt: "Dupe prompt",
          source: "user" as const,
          filePath: "/test/pm2.md",
        },
      ];

      const result = findAgentByName(agentsWithDupes, "pm");

      expect(result?.description).toBe("Project manager"); // First match
    });

    it("handles empty agents list", () => {
      const result = findAgentByName([], "pm");

      expect(result).toBeUndefined();
    });
  });

  describe("discoverAgents with real agent files", () => {
    it("discovers agents from the actual project", () => {
      // Use the actual project directory
      const projectDir = path.join(__dirname, "..");
      const result = discoverAgents(projectDir);

      // Should find pm, developer, verifier from .pi/agents
      expect(result.agents.length).toBeGreaterThanOrEqual(3);

      const pm = result.agents.find((a) => a.name === "pm");
      const developer = result.agents.find((a) => a.name === "developer");
      const verifier = result.agents.find((a) => a.name === "verifier");

      expect(pm).toBeDefined();
      expect(developer).toBeDefined();
      expect(verifier).toBeDefined();

      expect(pm?.tools).toEqual(["read", "grep", "find", "ls"]);
      expect(developer?.tools).toEqual(["read", "edit", "write", "bash", "grep", "find", "ls"]);
      expect(verifier?.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
    });
  });
});
