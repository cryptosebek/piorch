# piorch Implementation Brief

Status: ready for implementation  
Prepared: 2026-07-17  
Audience: the agent implementing the next correctness milestone in `piorch`

## 1. Objective

Make `piorch` a trustworthy workflow orchestrator on the Pi runtime that it
actually launches. The immediate goal is not to add more orchestration features.
It is to ensure that a PM wave, a developer result, and a verifier result can be
accepted only when the corresponding Pi process really ran, the required custom
tool really succeeded, and the run really settled.

This document is the implementation handoff. It consolidates the runtime analysis, the applicable Claude Code design lessons in `CLAUDE_CODE_INSPIRATIONS.md`, and direct inspection of both repositories and Pi itself.

The implementing agent should be able to begin with Milestone 1 below without performing another architecture investigation.

## 2. Repository and runtime baseline

### Local repositories

- `piorch`: `.`
- Claude Code reference source:
  `../claude-code-main`

### Pi baseline used for this analysis

- Upstream: <https://github.com/earendil-works/pi>
- Documentation: <https://pi.dev/docs/latest/>
- Inspected upstream revision:
  `3da591ab74ab9ab407e72ed882600b2c851fae21`
- Installed executable: `pi` (resolved from `PATH`)
- Installed executable version: `0.80.10`
- Current `piorch` TypeScript dependencies: `@mariozechner/pi-*` at `^0.57.1`

The repository therefore compiles against Pi 0.57-era types but launches Pi
0.80.10 from `PATH`. The child executable, not the local TypeScript package, owns
the behavior of every PM, developer, and verifier run.

### Verified baseline

Before this handoff was written:

- `npm run typecheck` passed.
- All 188 existing tests passed.

## 3. Current architecture in one page

`piorch` is a Pi extension that is itself loaded into a parent Pi session. It
implements a deterministic workflow state machine and starts separate child Pi
processes for the roles:

```text
parent Pi session
  workflow-orchestrator extension
    PM RpcAgent       -> pi --mode rpc --session ...
    developer RpcAgent -> pi --mode rpc --session ...
    verifier RpcAgent  -> pi --mode rpc --session ...
```

Each child is started in the project working directory with approximately:

```text
pi --mode rpc
   --session <stage-session.jsonl>
   --no-extensions
   --no-skills
   --no-prompt-templates
   -e <explicit-role-tool-extension>
   --model <role-model>
   --tools <role-tool-list>
   --append-system-prompt <temporary-role-prompt>
```

Important consequences:

- The parent owns workflow state, scheduling, transitions, retries between
  semantic stages, and persisted custom state entries.
- Each child Pi owns model interaction, coding tools, explicitly loaded role
  tools, context-file discovery, its session tree, provider retry, and RPC
  events.
- Child processes inherit the host filesystem, process, environment, and network
  authority. `piorch` does not add a security boundary.
- Project context files still load because the child does not pass
  `--no-context-files`.
- Discovered extensions, skills, and prompt templates are disabled. Only paths
  supplied with `-e` load as extensions.
- Every task currently uses the same `ctx.cwd`. `parallelism` limits count; it
  does not isolate writes.

### Current control flow

1. The PM must call `generate_wave`.
2. The orchestrator creates task state for the wave.
3. Each developer must call `report_task_result({status: "done", ...})`.
4. Each verifier must call `report_task_result({status: "pass"|"fail", ...})`.
5. The deterministic engine follows configured transitions.
6. A failed verification returns the task to development until the workflow
   retry limit is exhausted.
7. The next PM turn receives a compact wave summary.

The architecture is sound in principle: Pi performs agent work and `piorch`
controls the workflow. The current protocol handling makes the reported outcomes
untrustworthy, however.

## 4. Non-negotiable design decisions

These decisions define Milestone 1. An implementation that changes one of them
must update this brief and explain why.

### 4.1 Support modern Pi explicitly

Target Pi `>=0.80.10 <0.81.0` for the first implementation. Pin the compile-time
packages to exactly `0.80.10` and fail fast if the executable does not satisfy the
supported range.

Do not attempt a dual 0.57/0.80 compatibility layer in the same change. The
`--tools` contract differs in a way that makes a single role declaration unsafe:

- Pi 0.57.1 treats `--tools` as a built-in-tool selection and then adds explicit
  extension tools.
- Pi 0.80.10 treats it as an allowlist for built-in and extension tools.

Consequently, the current role files hide `generate_wave` and
`report_task_result` under Pi 0.80.10. Adding those names fixes 0.80.10 but is not
a safe 0.57-era declaration.

### 4.2 Keep child processes for this milestone

Pi recommends direct `AgentSession` use for Node integrations, but changing from
subprocesses to in-process sessions would combine a runtime migration with a
protocol rewrite. Keep subprocess isolation and make the RPC client correct.

Do not instantiate upstream `RpcClient` directly in Milestone 1. Its public
constructor launches `node <cliPath>`; `piorch` deliberately launches the
`PATH`-resolved `pi` executable. A small local client is easier to test against a
fake executable and preserves that deployment contract. Reuse Pi's exported
types where practical, not its process-launch assumption.

### 4.3 A successful tool execution is the only structured result

Assistant prose is progress information, never a stage result. An attempted
tool call is not a result. Only a `tool_execution_start` correlated with a
`tool_execution_end` having `isError === false` may produce a PM wave or task
outcome.

### 4.4 Wait for `agent_settled`

`agent_end` means one low-level agent run ended. Pi can still retry, compact and
retry, or process a queued continuation. `agent_settled` is the terminal event
for an accepted prompt. The client must not resolve a run on `agent_end`.

See Pi's current RPC contract:
<https://pi.dev/docs/latest/rpc#agent_settled>.

### 4.5 Pi owns transient provider retry

There must be one retry owner. Remove `RpcAgent.runPrompt()`'s outer provider
retry loop and rely on Pi's agent-level retry. Settlement makes that behavior
observable. Keep workflow semantic retries (`maxTaskRetries`) in `piorch`.

The existing `agentRetry` object is misleading because the RPC API only toggles
Pi auto-retry; it cannot apply all of `piorch`'s delay and attempt fields. Remove
`agentRetry` from the workflow schema and sample configuration in this milestone.
Document that Pi retry behavior comes from Pi settings (`retry.enabled`,
`retry.maxRetries`, and `retry.baseDelayMs`). Reject old `agentRetry` input with a
specific migration error rather than silently ignoring it.

### 4.6 Preserve the deterministic orchestrator

Do not turn the PM into a free-form scheduler. The PM proposes one wave through a
typed tool. The orchestrator validates IDs, schedules work, applies results,
enforces verification, and determines terminal state.

### 4.7 Keep internal state typed

Claude Code uses XML-like messages when injecting task notifications into an LLM
conversation. That is useful at an LLM boundary, not for `piorch`'s internal
state. Use TypeScript objects and runtime schemas internally.

## 5. Why Milestone 1 is required

The following are confirmed correctness defects, not speculative improvements.

### P0 — role tools are filtered out

The three role frontmatter files list only built-ins. Under Pi 0.80.10 the
custom role tools are not active even though their extensions load with `-e`.
The agents are asked to call tools they cannot see.

### P0 — rejected RPC commands can hang

`runner.ts` sends commands without IDs and ignores `type: "response"`. If Pi
rejects a prompt, for example because the child is already streaming, no agent
run starts and `agent_end` never arrives. The promise can remain unresolved.

### P0 — attempted or duplicated calls can be accepted

The client records `tool_execution_start` before schema validation and execution.
It then records the same assistant `toolCall` again from `message_end`. The
orchestrator searches for the first matching name. A malformed first report can
therefore override a later corrected report, and a failed tool execution can be
accepted as success.

### P0 — the wrong completion event is used

The client resolves on `agent_end`, before Pi's retry, compaction-retry, or queued
continuation paths are necessarily complete.

### P1 — JSONL parsing is not protocol-safe

Calling `data.toString()` per chunk can corrupt a multibyte UTF-8 character split
across chunks. Invalid JSON is silently discarded. A corrupt structured result
can thus become a missing-result retry with no useful diagnosis.

Pi requires strict LF-delimited JSONL and recommends `StringDecoder`:
<https://pi.dev/docs/latest/rpc#framing>.

### P1 — result semantics are not enforced

`outputSchema` is parsed but unused. A developer can report `pass`; a verifier can
report `done`; a verifier can pass without evidence. The extension validates only
the broad tool shape, not the role-specific contract.

### P1 — stop/resume has two prompt owners

`stopTask()` aborts a runner but leaves lifecycle cleanup to the original
promise. `messageTask()` can then steer it or start a fire-and-forget prompt that
is not owned by the task-flow state machine. Output from that prompt is not
reliably applied, and a task can remain stopped.

### P1 — task and stage IDs can collide or escape paths

PM-produced task IDs and configured stage IDs are used in filenames and map keys
without validation. Duplicate IDs collide. Path-like IDs can escape the intended
session directory.

### P1 — PM memory leaks across workflow runs

Task sessions are scoped by `runId`; the PM session is scoped only by workflow
name. Independent goals can inherit unrelated PM history.

### P1 — completion is overstated

The UI can announce completion after maximum waves are exhausted or tasks have
failed. Terminal workflow outcomes need distinct states.

## 6. Milestone 1 scope

Name this milestone **Runtime and Result Correctness**.

It includes:

1. Align package namespace and types with Pi 0.80.10.
2. Verify the launched Pi executable version before starting a workflow.
3. Add each custom role tool to its role's `tools` allowlist.
4. Replace ad hoc RPC parsing with a request/response-aware client.
5. Resolve accepted runs only on `agent_settled`.
6. Correlate tool start/end events by `toolCallId`.
7. Accept only successful terminal structured reports.
8. Enforce role-specific result schemas and evidence rules.
9. Validate workflow, task, and stage identifiers and uniqueness.
10. Scope all session files by `runId`.
11. Give every active task prompt one lifecycle owner.
12. Persist accurate workflow terminal outcomes.
13. Give the PM a bounded, typed summary of the previous wave.
14. Add deterministic RPC and workflow tests that do not require a paid model.

### Explicitly out of scope

- Git worktree creation, integration, or cleanup.
- A dependency graph or general DAG scheduler.
- Fully generic stage semantics.
- MCP support.
- Background daemons or remote workers.
- A rewrite around in-process `AgentSession`.
- Major TUI redesign.
- Automated commit, push, PR, or merge behavior.

Those belong to later milestones after result correctness is established.

## 7. Required data contracts

Put shared contracts in a new
`.pi/extensions/workflow-orchestrator/contracts.ts`. Use TypeBox schemas for every
object that crosses an LLM, RPC, configuration, or persisted-state boundary, and
derive TypeScript types with `Static<typeof Schema>`.

### 7.1 Identifier

```ts
export const IdentifierSchema = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
});
```

Apply it to workflow names, task IDs, and stage IDs. After schema validation,
perform cross-field validation:

- task IDs must be unique within a wave;
- stage IDs must be unique within a workflow;
- every transition target must be another stage ID or `complete`;
- every configured agent reference must resolve;
- Milestone 1 supports the semantic stage IDs `develop` and `verify`; reject a
  configuration that omits them or uses another semantic shape.

The last restriction makes the actual implementation honest. Generic stage kinds
can replace it in a later version.

### 7.2 Evidence and issues

```ts
export const EvidenceSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("command"),
    Type.Literal("test"),
    Type.Literal("inspection"),
    Type.Literal("manual"),
  ]),
  description: Type.String({ minLength: 1, maxLength: 2000 }),
  command: Type.Optional(Type.String({ maxLength: 2000 })),
  outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked")]),
});

export const IssueSchema = Type.Object({
  severity: Type.Union([Type.Literal("blocking"), Type.Literal("non_blocking")]),
  description: Type.String({ minLength: 1, maxLength: 4000 }),
  reproduction: Type.Optional(Type.String({ maxLength: 4000 })),
});
```

### 7.3 Developer report

```ts
export const DeveloperReportSchema = Type.Object({
  status: Type.Union([Type.Literal("done"), Type.Literal("partial")]),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  filesChanged: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
    maxItems: 500,
  }),
  evidence: Type.Array(EvidenceSchema, { maxItems: 100 }),
  issues: Type.Array(IssueSchema, { maxItems: 100 }),
});
```

Rules beyond the schema:

- `done` means the requested implementation is complete.
- `partial` requires at least one blocking issue explaining why it is incomplete.
- `filesChanged` paths must be relative to `ctx.cwd`, normalized, must not contain
  `..`, and should be de-duplicated.
- The orchestrator should compare declared changed files with `git diff --name-only`
  when Git is available. In Milestone 1, mismatch is recorded as an issue and
  supplied to the verifier; it does not automatically rewrite Git state.

### 7.4 Verifier report

```ts
export const VerifierReportSchema = Type.Object({
  status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("partial")]),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  evidence: Type.Array(EvidenceSchema, { maxItems: 100 }),
  issues: Type.Array(IssueSchema, { maxItems: 100 }),
});
```

Rules beyond the schema:

- `pass` requires at least one evidence item with `outcome: "pass"` and no
  blocking issue.
- `fail` requires at least one actionable blocking issue.
- `partial` is reserved for an environmental block and requires both blocked
  evidence and a blocking issue.
- A failed command cannot be represented as passing evidence.
- The verifier remains structurally read-only: `read`, `grep`, `find`, `ls`, and
  `bash`; it must not receive `edit` or `write`.

### 7.5 Orchestrator-owned result envelope

Do not ask the model to echo identifiers already known by the orchestrator.
Attach them after report validation:

```ts
export interface StageResultEnvelope<TReport> {
  runId: string;
  waveIndex: number;
  taskId: string;
  stageId: "develop" | "verify";
  role: "developer" | "verifier";
  report: TReport;
  toolCallId: string;
  startedAt: number;
  completedAt: number;
}
```

Persist envelopes in `TaskState.stageOutputs`. Do not persist an unvalidated
`Record<string, unknown>` as a successful output.

### 7.6 RPC tool execution

```ts
export interface RpcToolExecution {
  toolCallId: string;
  name: string;
  attemptedArgs: unknown;
  startedAt: number;
  endedAt?: number;
  isError?: boolean;
  result?: unknown;
}
```

Maintain these in a `Map<string, RpcToolExecution>` for one prompt. A duplicate
start ID, end without start, or second end is a protocol error. On successful
completion, use the validated tool result's `details.params` when available;
otherwise use the correlated attempted arguments. The two values should match;
a mismatch is a protocol error.

## 8. RPC client specification

Replace the protocol portion of `RpcAgent` with a focused local class, for
example `PiRpcProcess`. Keep workflow-specific report interpretation outside it.

### 8.1 Process startup

1. Resolve the executable from a configurable `piCommand`, defaulting to `pi`.
2. Run `pi --version` once per parent workflow start.
3. Parse numeric `major.minor.patch`; reject nonmatching output.
4. Require `>=0.80.10 <0.81.0` and show the resolved command and version on
   failure.
5. Spawn without `shell`.
6. Register `error`, `exit`, `close`, stdin `error`, stdout `error`, and stderr
   `error` handlers before sending commands.
7. Bound captured stderr to the last 64 KiB.
8. Start a startup timeout. Readiness is established by a successful correlated
   `get_state` response, not by sleeping for 100 ms.

Keep prompt files at mode `0600`, and clean them up on normal completion, failed
startup, process exit, and disposal.

### 8.2 JSONL framing

- Decode stdout and stderr with `StringDecoder("utf8")`.
- Split stdout only on LF (`\n`).
- Strip one trailing CR from a record.
- Parse every nonempty stdout record as JSON.
- Treat malformed JSON, an over-limit record, or a partial final record as a
  protocol error. Do not silently continue.
- Use a bounded record buffer, recommended maximum 4 MiB.
- Never write logs to child stdout; stdout is protocol-only.

### 8.3 Commands

Every command gets a monotonically increasing ID such as `piorch-1`. Maintain a
pending command map and enforce a command response timeout.

```ts
interface PendingCommand {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
```

For a prompt:

1. Create the run state before writing.
2. Send `{id, type: "prompt", message}`.
3. Wait for the matching response.
4. If `success: false`, reject immediately with Pi's error and clear run state.
5. If `success: true`, wait for events.
6. Resolve only on `agent_settled`.

Unknown response IDs, duplicate responses, events that violate lifecycle order,
and process exit with pending commands are protocol errors.

### 8.4 Run lifecycle

Use an explicit state machine:

```text
idle
  -> prompt_pending
  -> running
  -> settling
  -> settled
  -> idle

any active state -> abort_pending -> settled/terminated -> idle
any state -> failed -> disposed
```

Required invariants:

- One accepted prompt at a time per process.
- A run has exactly one owner promise.
- `agent_start` is valid only after prompt acceptance.
- `agent_end` updates state and diagnostics but does not resolve.
- `agent_settled` resolves only if the prompt was accepted.
- A run-level assistant error is retained; settlement rejects with that error
  unless a later Pi retry succeeded.
- `auto_retry_start` and `auto_retry_end` update progress and metrics.
- Abort has its own correlated response and grace timeout.
- After the grace timeout, send `SIGTERM`; after another bounded grace period,
  send `SIGKILL`.
- All pending commands and the active run reject exactly once on termination.

Do not harvest `toolCall` parts from `message_end`. Tool execution events are the
single source of truth for execution.

### 8.5 Timeouts

Use constants in Milestone 1, with dependency injection for tests:

```ts
startupTimeoutMs = 10_000;
commandTimeoutMs = 10_000;
runTimeoutMs = 30 * 60_000;
abortGraceMs = 5_000;
killGraceMs = 2_000;
```

A run timeout is an orchestrator failure, not a verifier failure. Include task,
stage, session path, last lifecycle event, and bounded stderr in the error.

## 9. Structured-result selection algorithm

Use the same selection rules for `generate_wave` and `report_task_result`.

```text
on tool_execution_start:
  validate event fields
  create execution keyed by toolCallId

on tool_execution_end:
  find the matching start
  record result, end time, and isError

on agent_settled:
  select executions with the expected tool name and isError === false
  reject if zero exist
  reject if more than one successful terminal report exists
  derive candidate params from result.details.params
  compare with attempted args
  validate candidate against the role-specific runtime schema
  apply cross-field semantic rules
  attach the orchestrator-owned envelope
```

Multiple failed attempts followed by one successful report are valid. Multiple
successful reports are ambiguous and must fail the stage rather than choosing
the first or last silently.

For `generate_wave`:

- `done: true` must not include a wave.
- `done: false` must include a nonempty wave.
- task IDs must pass `IdentifierSchema` and be unique.
- every task needs a nonempty title, description, and verification requirements.
- `assignee`, if retained in Milestone 1, must equal `developer`; otherwise remove
  it from the schema because the engine does not honor arbitrary assignees.

Update both role-tool extensions so semantic invalidity throws an error. Returning
text beginning with `Error:` while reporting a successful tool execution is not
acceptable.

## 10. Task lifecycle, stop, message, and resume

Represent prompt ownership explicitly in the task runner:

```ts
interface TaskRunner {
  key: string;
  agent: PiRpcProcess;
  stageId: "develop" | "verify";
  lifecycle: "idle" | "running" | "aborting" | "stopped" | "disposed";
  activePrompt?: Promise<StageResultEnvelope<unknown>>;
}
```

Required behavior:

### Stop

1. Mark the task `stopping`, not immediately `stopped`.
2. Abort the active prompt.
3. Await the original prompt owner's settlement or termination.
4. Persist `stopped` only after cleanup completes.
5. Keep the stage session file for an intentional resume.

### Message while running

If the original prompt is active, send a correlated `steer` command. The original
prompt promise remains the only result owner. Do not create a second
fire-and-forget `runPrompt()`.

### Resume after stopped

1. Ensure the previous prompt has settled and no task lock is held.
2. Set `resumeMessage`.
3. Set the task back to `pending` at the same stage.
4. Re-enter `processTask()` through the normal scheduler.
5. Reopen the same Pi stage session unless the configured memory policy requires
   a reset.
6. Apply the eventual report through the same validation and transition path as
   an uninterrupted run.

There must be no direct path from a UI command to an unowned prompt.

## 11. Sessions and memory

Use this layout:

```text
.pi/workflows/sessions/<runId>/
  pm.jsonl
  <taskId>-develop.jsonl
  <taskId>-verify.jsonl
  <taskId>-<stageId>-r<N>.jsonl
```

All path components must already satisfy `IdentifierSchema`. Resolve each final
path and assert that it remains beneath the run session directory.

The files are Pi session trees, not RPC event logs. Resume by reopening the
session file and issuing a new prompt. Do not replay RPC events as conversation
messages.

Memory policy remains:

- developer memory can survive verifier failure;
- verifier memory can survive developer correction when configured;
- malformed verifier output may trigger verifier memory reset;
- independent workflow runs never share PM memory.

## 12. PM synthesis contract

The current wave summary drops most useful output. Replace the string-building
shortcut with a typed summary and serialize a bounded human-readable form into
the next PM prompt.

```ts
interface PriorWaveSummary {
  waveIndex: number;
  goal: string;
  outcome: "verified" | "failed" | "partial" | "stopped";
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    retries: number;
    developerSummary?: string;
    filesChanged: string[];
    verifierSummary?: string;
    evidence: Evidence[];
    issues: Issue[];
  }>;
}
```

Bound the prompt representation, for example:

- maximum 100 tasks;
- maximum 20 evidence items and 20 issues per task;
- maximum 2,000 characters per summary or issue;
- explicit truncation markers.

The PM prompt should require it to synthesize conclusions, unresolved risks, and
the reason for either finishing or producing the next wave. Do not tell it merely
that files changed.

The PM's session path must be `<runId>/pm.jsonl`, so its conversational continuity
is useful within one workflow run and cannot leak into another goal.

## 13. Terminal workflow outcomes

Replace `active: boolean` as the sole terminal signal with:

```ts
type WorkflowStatus =
  | "idle"
  | "running"
  | "waiting_for_clarification"
  | "stopping"
  | "completed"
  | "exhausted"
  | "failed"
  | "stopped"
  | "partial";
```

Rules:

- `completed`: PM reported done and every required task is verified.
- `exhausted`: `maxWaves` was reached before PM reported valid completion.
- `failed`: an unrecoverable runtime, protocol, configuration, or workflow error
  ended the run.
- `stopped`: the user stopped the workflow and active children were cleaned up.
- `partial`: PM reported done while unresolved nonverified tasks remain; this is
  visible as incomplete, never announced as success.

Keep a compatibility `active` getter or derived field only if rendering code
needs it temporarily. Persist `status` as the source of truth.

## 14. File-by-file implementation plan

### `package.json` and lockfile

- Replace `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, and
  `@mariozechner/pi-tui` with `@earendil-works/*` at exact `0.80.10`.
- Update all imports in the extension and tests.
- Add a `test:integration` script only if real-Pi smoke tests are separated from
  default unit tests.
- Regenerate `package-lock.json`; do not hand-edit it.

### `.pi/agents/pm.md`

- Add `generate_wave` to `tools`.
- Require nonempty verification requirements and valid unique IDs.
- State that one successful `generate_wave` call is allowed per turn.

### `.pi/agents/developer.md`

- Add `report_task_result` to `tools`.
- Update the example to the developer report contract.
- Require concrete evidence and truthful relative changed-file paths.

### `.pi/agents/verifier.md`

- Add `report_task_result` to `tools`.
- Update the example to the verifier report contract.
- Require verification against task requirements, adversarial checks where
  appropriate, and evidence. Keep the toolset read-only except for `bash`.

### `.pi/extensions/workflow-pm-tools/index.ts`

- Import the shared wave/report schema.
- Throw on conditional invalidity (`done=false` without a wave, duplicates,
  invalid IDs).
- Return validated params in `details.params`.

### `.pi/extensions/workflow-task-tools/index.ts`

- Replace the weak shared shape with the report union or register separate
  developer/verifier tools if role-specific extension paths are preferable.
- Keep the external tool name `report_task_result` for this milestone.
- Throw on invalid semantics.
- Return validated params in `details.params`.

### `.pi/extensions/workflow-orchestrator/contracts.ts` (new)

- Define identifier, evidence, issue, report, wave, envelope, and persisted
  summary schemas and derived types.
- Export focused validation helpers with actionable errors.

### `.pi/extensions/workflow-orchestrator/runner.ts`

- Migrate imports to `@earendil-works/*`.
- Add executable-version preflight.
- Implement strict JSONL decoding and correlated command responses.
- Correlate tool events by `toolCallId`.
- Resolve on `agent_settled`.
- Remove duplicate message-content harvesting.
- Remove the outer provider retry loop and its regex-based error classifier.
- Add startup, command, run, abort, and kill timeouts.
- Add complete process and stream error handling.
- Expose a typed `RpcRunResult` containing output text, successful and failed tool
  executions, usage/metrics, lifecycle diagnostics, and bounded stderr.
- Preserve `runAgent()` only if it has a tested caller; otherwise remove it after
  confirming with `rg`.

### `.pi/extensions/workflow-orchestrator/config.ts`

- Apply `IdentifierSchema` to workflow/task/stage IDs.
- Remove misleading `agentRetry` configuration with a migration error.
- Validate uniqueness, transition targets, resolved agents, and the supported
  develop/verify semantic shape after TypeBox validation.
- Validate positive integer limits, not just `number` values.
- Either remove `outputSchema` in Milestone 1 or enforce it. The recommended
  choice is to remove it because role-specific shared schemas replace it.
- Either remove `assignee` or restrict it to `developer` until scheduling honors
  other assignees.

### `.pi/extensions/workflow-orchestrator/state.ts`

- Add `WorkflowStatus`.
- Add typed stage envelopes, evidence, issues, and metrics.
- Add `stopping` to task status.
- Replace broad `Record<string, Record<string, unknown>>` successful outputs.
- Keep restore compatibility for existing state entries by migrating absent
  `status` from `active`; test the migration.

### `.pi/extensions/workflow-orchestrator/engine.ts`

- Accept a typed stage outcome rather than arbitrary output.
- Remove hidden semantic acceptance: only validated developer/verifier envelopes
  reach the transition engine.
- Keep semantic workflow retries here; do not mix them with provider retries.
- Return an explicit task terminal outcome instead of relying entirely on
  mutation callbacks.
- In Milestone 1, make the `develop`/`verify` special case explicit and tested.

### `.pi/extensions/workflow-orchestrator/index.ts`

- Preflight Pi before marking a workflow running.
- Select and validate exactly one successful role report.
- Scope PM sessions by `runId`.
- Use one owner promise for every active task prompt.
- Rework stop, steer, and resume according to Section 10.
- Persist typed previous-wave summaries.
- Emit accurate terminal notices.
- Dispose every PM/task child on terminal workflow state and extension shutdown.

### `.pi/extensions/workflow-orchestrator/render.ts`

- Render `stopping`, `exhausted`, `partial`, and protocol/runtime failure states.
- Keep this change narrow; do not redesign the UI.

### Tests

- Extend current tests rather than replacing them wholesale.
- Add `tests/fixtures/fake-pi.mjs` as a deterministic executable controlled by an
  environment scenario name or fixture argument.
- Add focused contract, RPC protocol, result-selection, lifecycle, config, and
  state-migration tests.

## 15. Test plan

No default test may call a paid or remote model.

### 15.1 Fake Pi process scenarios

The fake executable should support `--version` and RPC JSONL. Cover at least:

1. Successful readiness handshake and prompt response.
2. Rejected prompt response with matching ID.
3. Response with unknown ID.
4. Process exits before readiness.
5. Spawn error / nonexistent executable.
6. UTF-8 character split across chunks.
7. Two JSON records in one chunk.
8. CRLF input accepted by stripping CR.
9. Malformed JSON is fatal.
10. Oversized record is fatal.
11. Partial final record is fatal.
12. `agent_end` followed later by `agent_settled`; promise resolves only on the
    latter.
13. `agent_end {willRetry:true}`, retry events, second run, then settlement.
14. Tool start and successful matching end.
15. Tool start and failed matching end.
16. Failed report followed by one successful corrected report.
17. Two successful reports rejected as ambiguous.
18. Tool end without start rejected.
19. Duplicate tool-call ID rejected.
20. Abort response and normal settlement.
21. Abort timeout escalates through TERM and KILL.
22. Run timeout includes diagnostics and disposes the child.

Inject clocks/timeouts where needed; do not make unit tests wait real seconds.

### 15.2 Role and result tests

- PM `done=false` without a wave fails the tool execution.
- PM `done=true` with a wave is rejected.
- Duplicate or unsafe task IDs are rejected.
- Developer `pass` is rejected.
- Developer `partial` without a blocking issue is rejected.
- Verifier `done` is rejected.
- Verifier `pass` without passing evidence is rejected.
- Verifier `fail` without a blocking issue is rejected.
- Verifier `partial` without blocked evidence is rejected.
- Changed file paths cannot be absolute or traverse upward.
- Only one successful terminal result is accepted.

### 15.3 Workflow lifecycle tests

- PM session path differs for two run IDs of the same workflow.
- Task and stage session paths remain under the run directory.
- A running task message steers the owned prompt.
- A stopped task resumes through `processTask()` and applies its result.
- No fire-and-forget prompt is created on resume.
- Workflow stop waits for child cleanup.
- Max waves produces `exhausted`, not `completed`.
- PM done with failed/unverified tasks produces `partial`.
- Runtime/protocol failure produces `failed` with a useful notice.
- Restoring old persisted state derives the correct new status.

### 15.4 Real Pi compatibility smoke test

Add an opt-in test gated by an environment variable, for example
`PIORCH_REAL_PI_TEST=1`. It must not invoke a model.

Use a test-only explicit extension that registers an extension command. The
command can call `pi.getActiveTools()` and send a hidden custom message. Start a
real Pi RPC process with the production role extension plus the test extension,
invoke the command, and assert:

- PM active tools include `generate_wave`.
- Developer and verifier active tools include `report_task_result`.
- Verifier active tools exclude `edit` and `write`.
- The actual executable passes the version preflight.

This directly catches the 0.57/0.80 tool-allowlist regression without spending
tokens.

### 15.5 Required commands before handoff

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run markdownlint
npm test
PIORCH_REAL_PI_TEST=1 npm run test:integration  # if the opt-in script exists
```

Report exact counts and any skipped opt-in tests.

## 16. Milestone 1 acceptance criteria

Milestone 1 is complete only when all of the following are true:

- The code compiles against `@earendil-works/pi-*` 0.80.10.
- A workflow refuses to start on an unsupported Pi executable version.
- The real-Pi no-model smoke test proves each role's custom report tool is active.
- Every RPC command is correlated with a response or a bounded timeout.
- A rejected prompt cannot hang a task.
- Runs resolve on `agent_settled`, never merely on `agent_end`.
- Tool executions are correlated by ID and failed executions are never accepted.
- Exactly one successful terminal report is required per PM/stage turn.
- Developer and verifier reports satisfy distinct schemas and semantic rules.
- Stop, steer, and resume retain exactly one owner for the active prompt.
- PM and task sessions are scoped beneath the current `runId`.
- Unsafe or duplicate identifiers are rejected before filesystem use.
- PM receives developer summary, changed files, verifier evidence, issues, and
  retry state from the previous wave.
- Terminal workflow notices distinguish success, exhaustion, failure, stop, and
  partial completion.
- All unit, integration, lint, formatting, markdown, and type checks pass.

## 17. Later milestones

Do not implement these as opportunistic additions to Milestone 1.

### Milestone 2 — safe concurrency

Before worktrees, add explicit task resources:

```ts
interface TaskResources {
  mode: "read" | "write";
  declaredPaths: string[];
}
```

Scheduling rules:

- read-only tasks may run together;
- overlapping declared writers serialize;
- an unknown write set is globally exclusive;
- actual changed files are recorded and undeclared writes are flagged.

Then add one Git worktree per task, retained across developer and verifier stages.
Persist base SHA, worktree path, branch, task commit, and integration status.
Serialize integration into the target branch and run integration verification.
Never copy changed files blindly or delete a failed worktree automatically.

### Milestone 3 — generic workflow semantics

- Add explicit stage kinds instead of hard-coded IDs.
- Honor arbitrary assignees through a role registry.
- Define dependency-aware scheduling.
- Validate transition exhaustiveness.
- Make memory policy role/stage generic.

### Milestone 4 — observability

- Aggregate Pi usage, cost, and timing events by run/wave/task/stage.
- Show human-readable tool activity derived from arguments.
- Persist bounded lifecycle diagnostics.
- Add explicit progress and pending-message display inspired by Claude Code's
  background task lifecycle.

## 18. Boundaries learned from Claude Code

Use these patterns, not a direct port:

- Explicit task lifecycle: running, pending message, stopping, resumed, terminal.
- Independent role tool pools, especially a structurally constrained verifier.
- Research/synthesis before implementation and verification after it.
- Resume through owned transcript/session state, not an untracked prompt.
- Worktree lifecycle that preserves failed work for inspection.

Do not port:

- Claude Code's in-process `AgentTool` infrastructure;
- its XML task envelopes as internal state;
- its coordinator as a replacement for deterministic transitions;
- team/mailbox concepts without a demonstrated need;
- assumptions about built-in MCP, permissions UI, or background tasks that Pi
  intentionally does not provide.

## 19. Implementation order

Keep commits or review units aligned to this order:

1. **Runtime contract:** package namespace, version preflight, role tool lists,
   real-Pi no-model smoke test.
2. **RPC correctness:** strict framing, command IDs/responses, settlement,
   process errors, timeouts, fake-Pi tests.
3. **Report correctness:** correlated executions, shared schemas, role validation,
   PM wave validation.
4. **Lifecycle correctness:** one prompt owner, stop/steer/resume, session scope,
   terminal workflow status.
5. **Synthesis:** typed prior-wave summary and verifier evidence in PM context.
6. **Final verification:** full test/check suite and manual review against the
   acceptance criteria.

Avoid mixing safe-concurrency/worktree work into these commits.

## 20. Instructions to the implementing agent

1. Read this document first.
2. Inspect the current implementation before editing; line numbers may have
   shifted since this brief was prepared.
3. Preserve unrelated user changes and the three documentation files.
4. Use the installed Pi only for no-model compatibility tests unless explicitly
   authorized to spend model tokens.
5. Do not silently broaden compatibility below Pi 0.80.10.
6. Do not accept prose, attempted calls, or failed tool executions as structured
   workflow state.
7. Do not add an unowned background prompt as a resume shortcut.
8. Keep Milestone 1 focused. Record later opportunities instead of implementing
   them opportunistically.
9. When finished, report changed files, exact test results, opt-in tests skipped,
   and any acceptance criterion not met.

## 21. Primary references

- Pi RPC documentation: <https://pi.dev/docs/latest/rpc>
- Pi extension lifecycle: <https://pi.dev/docs/latest/extensions>
- Pi settings and retry ownership: <https://pi.dev/docs/latest/settings>
- Pi SDK guidance: <https://pi.dev/docs/latest/sdk>
- Pi upstream repository: <https://github.com/earendil-works/pi>
- Pi 0.80.10 RPC client source:
  <https://github.com/earendil-works/pi/blob/v0.80.10/packages/coding-agent/src/modes/rpc/rpc-client.ts>
- Pi 0.80.10 RPC mode source:
  <https://github.com/earendil-works/pi/blob/v0.80.10/packages/coding-agent/src/modes/rpc/rpc-mode.ts>
- Pi 0.80.10 tool filtering source:
  <https://github.com/earendil-works/pi/blob/v0.80.10/packages/coding-agent/src/main.ts>
- Pi 0.57.1 main source for historical comparison:
  <https://github.com/earendil-works/pi/blob/v0.57.1/packages/coding-agent/src/main.ts>
