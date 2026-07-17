import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { preflightPiExecutable } from "../.pi/extensions/workflow-orchestrator/runner.js";

type RpcRecord = Record<string, any>;

const enabled = process.env.PIORCH_REAL_PI_TEST === "1";
const piCommand = process.env.PIORCH_PI_COMMAND ?? "pi";
const probeExtension = path.resolve("tests/fixtures/active-tools-probe.ts");
const roleExtensions = {
  pm: path.resolve(".pi/extensions/workflow-pm-tools/index.ts"),
  developer: path.resolve(".pi/extensions/workflow-task-tools/index.ts"),
  verifier: path.resolve(".pi/extensions/workflow-task-tools/index.ts"),
} as const;
const roleTools = {
  pm: ["read", "grep", "find", "ls", "generate_wave"],
  developer: ["read", "edit", "write", "bash", "grep", "find", "ls", "report_task_result"],
  verifier: ["read", "grep", "find", "ls", "bash", "report_task_result"],
} as const;

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

function waitForRecord(
  child: ChildProcessWithoutNullStreams,
  predicate: (record: RpcRecord) => boolean,
  timeoutMs = 10_000,
): Promise<RpcRecord> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const records: RpcRecord[] = [];
  let stderr = "";
  let settled = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onStderr);
      child.off("close", onClose);
      child.off("error", onError);
      clearTimeout(timeout);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onData = (chunk: Buffer | string) => {
      buffer += decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          try {
            const record = JSON.parse(line) as RpcRecord;
            records.push(record);
            if (predicate(record)) finish(() => resolve(record));
          } catch (error) {
            finish(() => reject(new Error(`Real Pi emitted malformed JSON: ${String(error)}`)));
            return;
          }
        }
        newline = buffer.indexOf("\n");
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr = `${stderr}${typeof chunk === "string" ? chunk : chunk.toString("utf8")}`.slice(
        -4000,
      );
    };
    const onError = (error: Error) => {
      finish(() => reject(new Error(`Real Pi process error: ${error.message}`)));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() =>
        reject(
          new Error(`Real Pi exited before the probe completed (code=${code}, signal=${signal})`),
        ),
      );
    };
    const timeout = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Timed out waiting for real Pi RPC record: ${JSON.stringify(records.slice(-3))}; stderr=${stderr}`,
          ),
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.on("close", onClose);
    child.on("error", onError);
  });
}

async function startProbe(role: keyof typeof roleExtensions): Promise<string[]> {
  await preflightPiExecutable(piCommand, process.cwd());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piorch-real-pi-"));
  const sessionFile = path.join(directory, "session.jsonl");
  const child = spawn(
    piCommand,
    [
      "--mode",
      "rpc",
      "--session",
      sessionFile,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "-e",
      roleExtensions[role],
      "-e",
      probeExtension,
      "--tools",
      roleTools[role].join(","),
    ],
    {
      cwd: process.cwd(),
      shell: false,
      env: { ...process.env, PIORCH_PROBE_ROLE: role },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(child);

  let counter = 0;
  const send = (body: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify({ id: `probe-${++counter}`, ...body })}\n`);
  };

  const ready = waitForRecord(
    child,
    (record) => record.type === "response" && record.command === "get_state",
  );
  send({ type: "get_state" });
  await ready;

  const probePromise = waitForRecord(
    child,
    (record) =>
      record.type === "entry_appended" && record.entry?.customType === "piorch-active-tools",
  );
  send({ type: "prompt", message: "/piorch-active-tools-probe" });
  const probe = await probePromise;
  child.kill("SIGTERM");
  fs.rmSync(directory, { recursive: true, force: true });
  return probe.entry.data.tools as string[];
}

describe.skipIf(!enabled)("real Pi role-tool compatibility", () => {
  it("activates the PM custom tool", async () => {
    const tools = await startProbe("pm");
    expect(tools).toContain("generate_wave");
  }, 15_000);

  it("activates the developer custom tool", async () => {
    const tools = await startProbe("developer");
    expect(tools).toContain("report_task_result");
  }, 15_000);

  it("activates verifier reporting without write tools", async () => {
    const tools = await startProbe("verifier");
    expect(tools).toContain("report_task_result");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
  }, 15_000);
});
