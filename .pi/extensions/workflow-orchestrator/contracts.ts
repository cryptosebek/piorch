import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

export const IdentifierSchema = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
});

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

export const DeveloperReportSchema = Type.Object({
  status: Type.Union([Type.Literal("done"), Type.Literal("partial")]),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  filesChanged: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
    maxItems: 500,
  }),
  evidence: Type.Array(EvidenceSchema, { maxItems: 100 }),
  issues: Type.Array(IssueSchema, { maxItems: 100 }),
});

export const VerifierReportSchema = Type.Object({
  status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("partial")]),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  evidence: Type.Array(EvidenceSchema, { maxItems: 100 }),
  issues: Type.Array(IssueSchema, { maxItems: 100 }),
});

export const WaveTaskSchema = Type.Object({
  id: IdentifierSchema,
  title: Type.String({ minLength: 1, maxLength: 1000 }),
  description: Type.String({ minLength: 1, maxLength: 4000 }),
  requirements: Type.String({ minLength: 1, maxLength: 4000 }),
  assignee: Type.Optional(Type.Literal("developer")),
});

export const WaveSchema = Type.Object({
  goal: Type.String({ minLength: 1, maxLength: 4000 }),
  tasks: Type.Array(WaveTaskSchema, { maxItems: 100 }),
});

export const GenerateWaveSchema = Type.Object({
  done: Type.Boolean(),
  wave: Type.Optional(WaveSchema),
});

export const SemanticStageIdSchema = Type.Union([Type.Literal("develop"), Type.Literal("verify")]);

export type Identifier = Static<typeof IdentifierSchema>;
export type Evidence = Static<typeof EvidenceSchema>;
export type Issue = Static<typeof IssueSchema>;
export type DeveloperReport = Static<typeof DeveloperReportSchema>;
export type VerifierReport = Static<typeof VerifierReportSchema>;
export type WaveTask = Static<typeof WaveTaskSchema>;
export type WorkflowWave = Static<typeof WaveSchema>;
export type GenerateWaveParams = Static<typeof GenerateWaveSchema>;
export type SemanticStageId = Static<typeof SemanticStageIdSchema>;

export interface StageResultEnvelope<TReport> {
  runId: string;
  waveIndex: number;
  taskId: string;
  stageId: SemanticStageId;
  role: "developer" | "verifier";
  report: TReport;
  toolCallId: string;
  startedAt: number;
  completedAt: number;
}

export type DeveloperResultEnvelope = StageResultEnvelope<DeveloperReport>;
export type VerifierResultEnvelope = StageResultEnvelope<VerifierReport>;
export type StageOutput = DeveloperResultEnvelope | VerifierResultEnvelope;

const StageEnvelopeBaseSchema = Type.Object({
  runId: Type.String({ minLength: 1, maxLength: 128 }),
  waveIndex: Type.Integer({ minimum: 0 }),
  taskId: IdentifierSchema,
  toolCallId: Type.String({ minLength: 1, maxLength: 512 }),
  startedAt: Type.Integer({ minimum: 0 }),
  completedAt: Type.Integer({ minimum: 0 }),
});

export const DeveloperResultEnvelopeSchema = Type.Intersect([
  StageEnvelopeBaseSchema,
  Type.Object({
    stageId: Type.Literal("develop"),
    role: Type.Literal("developer"),
    report: DeveloperReportSchema,
  }),
]);

export const VerifierResultEnvelopeSchema = Type.Intersect([
  StageEnvelopeBaseSchema,
  Type.Object({
    stageId: Type.Literal("verify"),
    role: Type.Literal("verifier"),
    report: VerifierReportSchema,
  }),
]);

export const StageOutputSchema = Type.Union([
  DeveloperResultEnvelopeSchema,
  VerifierResultEnvelopeSchema,
]);

export interface PriorWaveSummaryTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "stopping" | "verified" | "failed" | "stopped";
  retries: number;
  developerSummary?: string;
  filesChanged: string[];
  verifierSummary?: string;
  evidence: Evidence[];
  issues: Issue[];
}

export interface PriorWaveSummary {
  waveIndex: number;
  goal: string;
  outcome: "verified" | "failed" | "partial" | "stopped";
  tasks: PriorWaveSummaryTask[];
}

export const PriorWaveSummaryTaskSchema = Type.Object({
  id: IdentifierSchema,
  title: Type.String({ minLength: 1, maxLength: 1000 }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("stopping"),
    Type.Literal("verified"),
    Type.Literal("failed"),
    Type.Literal("stopped"),
  ]),
  retries: Type.Integer({ minimum: 0 }),
  developerSummary: Type.Optional(Type.String({ maxLength: 4000 })),
  filesChanged: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 500 }),
  verifierSummary: Type.Optional(Type.String({ maxLength: 4000 })),
  evidence: Type.Array(EvidenceSchema, { maxItems: 100 }),
  issues: Type.Array(IssueSchema, { maxItems: 100 }),
});

export const PriorWaveSummarySchema = Type.Object({
  waveIndex: Type.Integer({ minimum: 0 }),
  goal: Type.String({ maxLength: 4000 }),
  outcome: Type.Union([
    Type.Literal("verified"),
    Type.Literal("failed"),
    Type.Literal("partial"),
    Type.Literal("stopped"),
  ]),
  tasks: Type.Array(PriorWaveSummaryTaskSchema, { maxItems: 100 }),
});

export function validationError(label: string, schema: TSchema, value: unknown): Error {
  const errors = [...Errors(schema, value)].map((error) => {
    const location = "path" in error && error.path ? error.path : "value";
    return `${location} ${error.message}`;
  });
  return new Error(`${label} validation failed${errors.length ? `: ${errors.join("; ")}` : ""}`);
}

export function validateSchema<TSchemaType extends TSchema>(
  schema: TSchemaType,
  value: unknown,
  label: string,
): Static<TSchemaType> {
  if (!Check(schema, value)) throw validationError(label, schema, value);
  return value as Static<TSchemaType>;
}

function hasBlockingIssue(issues: Issue[]): boolean {
  return issues.some((issue) => issue.severity === "blocking");
}

function hasEvidenceOutcome(evidence: Evidence[], outcome: Evidence["outcome"]): boolean {
  return evidence.some((item) => item.outcome === outcome);
}

function validateRelativeChangedFiles(report: DeveloperReport): void {
  const seen = new Set<string>();
  for (const declaredPath of report.filesChanged) {
    const normalized = declaredPath.replaceAll("\\", "/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split("/").includes("..") ||
      normalized.split("/").some((part) => part.length === 0)
    ) {
      throw new Error(
        `Developer report validation failed: filesChanged path must be relative and safe: ${declaredPath}`,
      );
    }
    const canonical = normalized
      .split("/")
      .filter((part) => part !== ".")
      .join("/");
    if (!canonical || seen.has(canonical)) {
      throw new Error(
        `Developer report validation failed: filesChanged contains duplicate or empty path: ${declaredPath}`,
      );
    }
    seen.add(canonical);
  }
}

export function validateDeveloperReport(value: unknown): DeveloperReport {
  const report = validateSchema(DeveloperReportSchema, value, "Developer report");
  validateRelativeChangedFiles(report);
  if (report.status === "partial" && !hasBlockingIssue(report.issues)) {
    throw new Error("Developer report validation failed: partial requires a blocking issue");
  }
  if (report.status === "done" && report.issues.some((issue) => issue.severity === "blocking")) {
    throw new Error("Developer report validation failed: done cannot contain a blocking issue");
  }
  return report;
}

export function validateVerifierReport(value: unknown): VerifierReport {
  const report = validateSchema(VerifierReportSchema, value, "Verifier report");
  if (report.status === "pass") {
    if (!hasEvidenceOutcome(report.evidence, "pass")) {
      throw new Error("Verifier report validation failed: pass requires passing evidence");
    }
    if (hasBlockingIssue(report.issues)) {
      throw new Error("Verifier report validation failed: pass cannot contain a blocking issue");
    }
    if (hasEvidenceOutcome(report.evidence, "fail")) {
      throw new Error("Verifier report validation failed: pass cannot contain failed evidence");
    }
  }
  if (report.status === "fail" && !hasBlockingIssue(report.issues)) {
    throw new Error("Verifier report validation failed: fail requires a blocking issue");
  }
  if (report.status === "partial") {
    if (!hasEvidenceOutcome(report.evidence, "blocked")) {
      throw new Error("Verifier report validation failed: partial requires blocked evidence");
    }
    if (!hasBlockingIssue(report.issues)) {
      throw new Error("Verifier report validation failed: partial requires a blocking issue");
    }
  }
  return report;
}

export function validateGenerateWave(value: unknown): GenerateWaveParams {
  const params = validateSchema(GenerateWaveSchema, value, "generate_wave parameters");
  if (params.done && params.wave) {
    throw new Error("generate_wave validation failed: done=true cannot include a wave");
  }
  if (!params.done && !params.wave) {
    throw new Error("generate_wave validation failed: done=false requires a wave");
  }
  if (!params.wave) return params;
  if (params.wave.tasks.length === 0) {
    throw new Error("generate_wave validation failed: done=false requires a nonempty wave");
  }

  const ids = new Set<string>();
  for (const task of params.wave.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`generate_wave validation failed: duplicate task id: ${task.id}`);
    }
    ids.add(task.id);
    if (task.assignee && task.assignee !== "developer") {
      throw new Error(
        `generate_wave validation failed: task ${task.id} must be assigned to developer`,
      );
    }
  }
  return params;
}

export function validateReportForStage(
  stageId: SemanticStageId,
  value: unknown,
): DeveloperReport | VerifierReport {
  return stageId === "develop" ? validateDeveloperReport(value) : validateVerifierReport(value);
}
