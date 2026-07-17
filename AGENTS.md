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
- The PM session is also scoped to the run at:
  `.pi/workflows/sessions/<runId>/pm.jsonl`
- `/workflow stop-task <id>` aborts a task but keeps session context.
- `/workflow message <id> <text>` sends a steer message to the running task, or resumes a stopped task.
- `/workflow resume` restarts the workflow loop from the saved state without starting new agents automatically.
- While workflow is active, normal chat is routed to PM (commands still work).

Pi `0.80.10` is the supported child runtime (`>=0.80.10 <0.81.0`); workflow
startup performs a version preflight and refuses unsupported executables.
Persisted workflow status is authoritative: `running`,
`waiting_for_clarification`, `stopping`, `completed`, `exhausted`, `failed`,
`stopped`, and `partial` distinguish active and terminal outcomes.

## Session file format

Session files are Pi session trees stored as JSONL (one JSON entry per line):

```jsonl
{"type":"prompt","message":"Project goal: Build a bot\nTask: T1..."}
{"type":"message_end","message":{"role":"assistant","content":[...]}}
{"type":"tool_execution_start","toolCallId":"call-1","toolName":"report_task_result","args":{"status":"done",...}}
{"type":"tool_execution_end","toolCallId":"call-1","toolName":"report_task_result","isError":false,"result":{"details":{"params":{...}}}}
{"type":"agent_settled"}
```

**Key event types:**

- `prompt` - The prompt sent to the agent
- `message_end` - Agent's text response
- `tool_execution_start` - Tool call with arguments (this is captured for structured output)
- `tool_execution_start` / `tool_execution_end` - Correlated custom-tool lifecycle
- `agent_end` - One low-level agent turn ended; it is not the accepted terminal event
- `agent_settled` - Pi finished the accepted prompt, including retry/continuation handling

**Locations:**

- PM sessions: `.pi/workflows/sessions/<runId>/pm.jsonl`
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

There is no prose/JSON fallback for stage results. If the required tool does not
successfully execute exactly once before `agent_settled`, the stage fails with a
diagnostic rather than being accepted.

**Tool isolation:** Each extension provides specific tools, and `allowedExtensionsByAgent` ensures agents only see their relevant tools.

**PM wave validation:** If the PM makes an invalid tool attempt or returns a
wave that fails semantic validation, the workflow retries up to `maxPmRetries`
times and passes the error back to the PM. Assistant prose alone pauses for
clarification; it never becomes a wave result.

Pi owns transient provider retry through its settings (`retry.enabled`,
`retry.maxRetries`, and `retry.baseDelayMs`). Workflow retries remain semantic
retries between PM/developer/verifier stages.

## Template variables

In workflow JSON `inputTemplate`, you can reference:

| Variable                                 | Description                             |
| ---------------------------------------- | --------------------------------------- |
| `{{task.title}}`                         | Task title                              |
| `{{task.description}}`                   | Task description                        |
| `{{task.requirements}}`                  | Verification requirements               |
| `{{task.issues}}`                        | Current issues (from previous failures) |
| `{{task.stageOutputs.<stageId>.report}}` | Validated report from a previous stage  |
| `{{workflow.goal}}`                      | Project goal                            |
| `{{wave.goal}}`                          | Current wave goal                       |
| `{{wave.index}}`                         | Wave number (0-based)                   |

**Example:**

```json
"inputTemplate": "Verify task {{task.title}}.\nDev summary: {{task.stageOutputs.develop.report.summary}}"
```
