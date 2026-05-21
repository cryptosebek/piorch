# Pi Workflow Orchestrator

Customizable PM → Dev → Verifier workflow for **pi** using an extension and subagents. Tasks run in waves, verifiers loop failures back to developers, and the PM can generate the next wave. The workflow is fully configurable via JSON and agent prompt files.

<img width="881" height="593" alt="Screenshot 2026-03-13 at 10 35 01 AM" src="https://github.com/user-attachments/assets/2cae9b36-3ffd-438d-afdd-ccd172baf5c8" />

## Features

- PM‑driven or static task waves
- Dev/Verifier loop with retries
- Live per‑task ticker status (compact two-line per active task)
- PM chat in the main pi conversation
- Per‑agent model selection
- Persistent workflow state in the session

## Repository Layout

```text
.pi/
  extensions/
    workflow-orchestrator/    # Main orchestration (UI, commands, logic)
      index.ts
      agents.ts
      runner.ts
      config.ts
      state.ts
      render.ts
    workflow-pm-tools/        # generate_wave tool for PM
      index.ts
    workflow-task-tools/      # report_task_result for dev/verifier
      index.ts
  workflows/
    default.workflow.json
  agents/
    pm.md
    developer.md
    verifier.md
```

## Installation

### Option 1: Install as Pi Package (Easiest)

```bash
pi install git:github.com/hlibr/piorch
```

This automatically installs the extension and agents to your project.

### Configure Models (Optional)

Agents come with pre-configured models. To change them:

```bash
# Edit agent files to set your preferred models
nano .pi/agents/pm.md        # Change model: line
nano .pi/agents/developer.md # Change model: line
nano .pi/agents/verifier.md  # Change model: line
```

Or remove the `model:` line to use Pi's default model.

Then run:

```bash
pi
/workflow start default "Your goal"
```

### Option 2: Manual Copy

Copy the extensions and agents into your project:

```bash
# From your project directory
mkdir -p .pi/extensions
cp -r /path/to/piorch/.pi/extensions/workflow-orchestrator .pi/extensions/
cp -r /path/to/piorch/.pi/extensions/workflow-pm-tools .pi/extensions/
cp -r /path/to/piorch/.pi/extensions/workflow-task-tools .pi/extensions/
cp -r /path/to/piorch/.pi/workflows .pi/
cp -r /path/to/piorch/.pi/agents .pi/
```

Then run pi from your project:

```bash
cd /path/to/your-project
pi
```

### Option 3: Develop/Test the Extension

Clone this repo and run pi from the repo root:

```bash
git clone https://github.com/hlibr/piorch.git
cd piorch
pi
```

Note: When working from the repo root, the agent will see test files and development artifacts. For production use, install via Option 1 or 2.

## Quick Start

```text
/workflow start default "Build a Telegram bot that replies pong to /ping"
```

You’ll see:

- A widget above the editor with live per‑task status and a PM line
- Active tasks show an indented ticker line with recent tool/text updates
- PM responses in the main chat (summarized wave output, not raw JSON)

Stop with:

```text
/workflow stop
```

## PM Chat Mode

When a workflow is active, normal chat input is routed to the PM (commands still work).
PM replies are shown in the main chat as plain messages.

## Configuration

### Model Configuration

Agents have pre-configured models. Customize in `.pi/agents/*.md`:

```yaml
# .pi/agents/developer.md
---
name: developer
model: anthropic/claude-sonnet-4-5 # Your preferred model
tools: read,edit,write,bash
---
```

**Options:**

1. **Use Pi's default model** - Remove the `model:` line
2. **Use a specific model** - `anthropic/claude-sonnet-4-5`, `openai/gpt-4o`, `openrouter/deepseek-r1`, etc.
3. **Use different models per agent** - Set different models for PM, developer, verifier

Run `/reload` after changes.

### Workflow Configuration

Edit `.pi/workflows/default.workflow.json` to customize:

- **agent names** - Which agent files to use (pm, developer, verifier)
- **stages and transitions** - Customize the dev/verify loop
- **wave source** - PM-driven or static task waves
- **parallelism** - How many tasks to run concurrently (default: 4)
- **maxWaves** - Maximum number of waves (default: 10)
- **maxTaskRetries** - Retry limit per task (default: 6)
- **maxPmRetries** - Retry limit for PM wave generation (default: 3)
- **allowedExtensions** - Whitelist extensions for all subagents
- **allowedExtensionsByAgent** - Per-agent extension allowlists
- **taskFlow.memory.keepDeveloperMemory** - Preserve developer session memory across retries (default: `true`)
- **taskFlow.memory.keepVerifierMemoryOnDeveloperFailure** - Preserve verifier memory after it returns `fail` and flow goes back to developer (default: `true`)
- **taskFlow.memory.verifierSelfFailureMemory** - Verifier memory policy when verifier fails **without** transitioning to developer (for example malformed/unmatched output, or verifier runtime errors):
  - `keep` (default)
  - `reset`
  - `reset_on_malformed_output`

Example:

```json
{
  "name": "default",
  "goal": "Implement the requested features",
  "parallelism": 2,
  "maxWaves": 10,
  "maxTaskRetries": 3,
  "maxPmRetries": 3,
  "agents": {
    "pm": "pm",
    "developer": "developer",
    "verifier": "verifier"
  }
}
```

### Agent Configuration

Edit `.pi/agents/*.md` to customize agent behavior:

**Frontmatter options:**

```yaml
---
name: developer
description: Implements assigned tasks
model: anthropic/claude-sonnet-4-5 # Your preferred model (or remove to use Pi default)
tools: read,edit,write,bash # Built-in tools to enable
---
```

**System prompt:**
The markdown body becomes the agent's system prompt. Customize it to change behavior.

### Custom Model Providers (Optional)

To use models not built into Pi, create `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "REPLACE_WITH_OPENROUTER_KEY",
      "api": "openai-completions",
      "models": [{ "id": "openrouter/hunter-alpha", "name": "OpenRouter Hunter Alpha" }]
    },
    "local-llm": {
      "baseUrl": "http://127.0.0.1:1234/v1",
      "apiKey": "local",
      "api": "openai-completions",
      "models": [{ "id": "local-model", "name": "Local LLM" }]
    }
  }
}
```

Then reference these models in agent frontmatter:

```yaml
# .pi/agents/pm.md
model: openrouter/hunter-alpha

# .pi/agents/developer.md
model: local-model
```

Run `/reload` after changing configuration files.

## Commands

- `/workflow start <name> [goal]`
- `/workflow resume` (continue from saved state)
- `/workflow stop`
- `/workflow stop-task <id>`
- `/workflow message <id> <message>`
- `/workflow expand`
- `/workflow collapse`
- `/workflow help`

## License

MIT
