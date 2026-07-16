# Project Guide (Pi Workflow Orchestrator)

## Purpose

This repo contains a **pi extension** that orchestrates PM → Dev → Verifier workflows with waves of tasks, live UI status, and subagent runs. The extension lives under `.pi/extensions/workflow-orchestrator/`.

## How to run

From repo root:

```bash
pi
```

Then:

```
/workflow "Your goal"
```

First `/workflow` run copies editable agent and workflow files into `.pi/`. Edit them to customize, then `/reload`.

Reload extensions:

```
/reload
```

## Key files

- `.pi/extensions/workflow-orchestrator/` – Main orchestration (UI, commands, logic)
  - `index.ts` – Extension entry point, commands, PM chat routing
  - `runner.ts` – Subagent execution (RPC mode, tool call capture)
  - `render.ts` – UI widget rendering
  - `state.ts` – Workflow/task state persistence
  - `config.ts` – Workflow JSON schema
- `.pi/extensions/workflow-pm-tools/index.ts` – `generate_wave` tool for PM
- `.pi/extensions/workflow-task-tools/index.ts` – `report_task_result` tool for dev/verifier
- `.pi/workflows/default.workflow.json` – Default workflow config
- `.pi/agents/*.md` – Agent prompts with per-agent models

## Common behaviors

- Subagents run in **RPC mode** with per-task session files at:
  `.pi/workflows/sessions/<runId>/<taskId>-<stage>.jsonl`
- `/workflow stop-task <id>` aborts a task but keeps session context.
- `/workflow message <id> <text>` sends a steer message to the running task, or resumes a stopped task.
- `/workflow resume` restarts the workflow loop from the saved state without starting new agents automatically.
- While workflow is active, normal chat is routed to PM (commands still work).

## Session file format

Session files are JSONL (one JSON event per line):

```jsonl
{"type":"prompt","message":"Project goal: Build a bot\nTask: T1..."}
{"type":"message_end","message":{"role":"assistant","content":[...]}}
{"type":"tool_execution_start","toolName":"report_task_result","args":{"status":"done",...}}
{"type":"agent_end"}
```

**Key event types:**

- `prompt` - The prompt sent to the agent
- `message_end` - Agent's text response
- `tool_execution_start` - Tool call with arguments (this is captured for structured output)
- `agent_end` - Agent completed

**Locations:**

- PM sessions: `.pi/workflows/sessions/pm-<workflow>.jsonl`
- Task sessions: `.pi/workflows/sessions/<runId>/<taskId>-<stageId>.jsonl`

## UI notes

- Widget shows only a limited number of tasks.
- Use `/workflow expand` or `/workflow collapse` to change visibility.

## Extension reload caveat

If a workflow is running and you `/reload`, the running workflow keeps using the old runtime.
To apply changes safely:

```
/workflow stop
/reload
/workflow start ...
```

## Allowed extensions for subagents

Use `allowedExtensions` in workflow JSON to whitelist extensions for all subagents, or
use `allowedExtensionsByAgent` to set per-agent allowlists:

```json
"allowedExtensions": ["/absolute/path/to/ext.ts"]
```

```json
"allowedExtensionsByAgent": {
  "pm": ["./.pi/extensions/workflow-pm-tools/index.ts"],
  "developer": ["./.pi/extensions/workflow-task-tools/index.ts"],
  "verifier": ["./.pi/extensions/workflow-task-tools/index.ts"]
}
```

## Tool-based reporting architecture

Agents report via structured tools instead of JSON text:

| Agent     | Tool                 | Purpose                               |
| --------- | -------------------- | ------------------------------------- |
| PM        | `generate_wave`      | Report new wave or project completion |
| Developer | `report_task_result` | Report task done with files/summary   |
| Verifier  | `report_task_result` | Report pass/fail with issues          |

**Why tools?** Previously, agents output JSON text that was parsed with `extractJson()`. Malformed JSON caused silent failures where verifier reports were lost. Tools provide structured arguments that are captured directly from `tool_execution_start` events.

**Fallback:** If an agent doesn't call the tool, their text output is captured and stored in `stageOutputs[stageId]`. This ensures workflow continuity.

**Tool isolation:** Each extension provides specific tools, and `allowedExtensionsByAgent` ensures agents only see their relevant tools.

**PM wave validation:** If the PM returns a wave without a valid `tasks` array, the workflow automatically retries (up to `maxPmRetries` times from workflow config), passing the error message back to the PM so it can correct its output. This prevents crashes from malformed PM responses.

## Template variables

In workflow JSON `inputTemplate`, you can reference:

| Variable                          | Description                             |
| --------------------------------- | --------------------------------------- |
| `{{task.title}}`                  | Task title                              |
| `{{task.description}}`            | Task description                        |
| `{{task.requirements}}`           | Verification requirements               |
| `{{task.issues}}`                 | Current issues (from previous failures) |
| `{{task.stageOutputs.<stageId>}}` | Output from a previous stage            |
| `{{workflow.goal}}`               | Project goal                            |
| `{{wave.goal}}`                   | Current wave goal                       |
| `{{wave.index}}`                  | Wave number (0-based)                   |

**Example:**

```json
"inputTemplate": "Verify task {{task.title}}.\nDev summary: {{task.stageOutputs.develop.summary}}"
```
