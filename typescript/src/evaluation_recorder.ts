import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./hashing.ts";
import {
  EVALUATION_RECORD_FORMAT_VERSION,
  RunRecordValidationError,
  validateEvaluationManifest,
  validateEvaluationRecord,
  type EvaluationAttempt,
  type EvaluationDecision,
  type EvaluationManifest,
  type EvaluationManifestArm,
  type EvaluationRecord,
  type EvaluationRecordError,
  type GatewayUsage,
  type ModelReport,
} from "./run_record_schema.ts";
import type { Claim } from "./case_set_schema.ts";
import type { ModelInput } from "./input_preparation.ts";

export interface EvaluationRecorderParams {
  runId: string;
  caseSetVersion: string;
  caseSetSha256: string;
  protocolVersion: string;
  protocolSha256: string;
  rosterVersion: string;
  rosterSha256: string;
  codeCommit: string;
  repeatCount: number;
  inputSetSha256: string;
  arm: EvaluationManifestArm;
  outputDir: string;
  now?: () => Date;
}

export interface CheckerCardResult {
  model: ModelReport | null;
  rawAnswer?: unknown;
  attempts: EvaluationAttempt[];
  firstAttemptInvalid: boolean;
  retried: boolean;
  decision: EvaluationDecision | null;
  error: EvaluationRecordError | null;
}

export interface EvaluationRecordInput extends CheckerCardResult {
  sampleIndex: number;
  repeatIndex: number;
  cardId: string;
  originalClaim: Claim;
  modelInput: ModelInput | null;
  inputHash: string | null;
}

export function evaluationUsageAggregate(attempts: EvaluationAttempt[]): GatewayUsage | null {
  const withUsage = attempts.filter((attempt) => attempt.usage !== null);
  if (withUsage.length === 0) return null;
  const costs = withUsage.map((attempt) => attempt.usage!.cost);
  const cost =
    costs.length === withUsage.length && costs.every((cost) => cost !== null)
      ? {
          amount: Math.round(costs.reduce((sum, cost) => sum + cost!.amount, 0) * 1e12) / 1e12,
          currency: costs[0]!.currency,
        }
      : null;
  return {
    latency_ms: withUsage.reduce((sum, attempt) => sum + attempt.usage!.latency_ms, 0),
    input_tokens: withUsage.reduce((sum, attempt) => sum + attempt.usage!.input_tokens, 0),
    output_tokens: withUsage.reduce((sum, attempt) => sum + attempt.usage!.output_tokens, 0),
    cost,
  };
}

export class EvaluationRecorder {
  readonly runId: string;
  readonly manifestPath: string;
  readonly recordsPath: string;
  private readonly arm: EvaluationManifestArm;
  private readonly protocolVersion: string;
  private readonly protocolSha256: string;
  private readonly repeatCount: number;
  private readonly now: () => Date;
  private written = 0;

  constructor(params: EvaluationRecorderParams) {
    this.runId = params.runId;
    this.arm = params.arm;
    this.protocolVersion = params.protocolVersion;
    this.protocolSha256 = params.protocolSha256;
    this.repeatCount = params.repeatCount;
    this.now = params.now ?? (() => new Date());
    this.manifestPath = join(params.outputDir, "manifest.json");
    this.recordsPath = join(params.outputDir, "records.jsonl");

    mkdirSync(params.outputDir, { recursive: true });
    if (existsSync(this.manifestPath) || existsSync(this.recordsPath)) {
      throw new Error(
        `refuses to overwrite an earlier run: ${this.manifestPath} or ${this.recordsPath} already exists; ` +
          "runs are immutable, write a new run directory instead",
      );
    }

    const manifest: EvaluationManifest = {
      format_version: EVALUATION_RECORD_FORMAT_VERSION,
      run_id: params.runId,
      created_at: this.now().toISOString(),
      case_set_version: params.caseSetVersion,
      case_set_sha256: params.caseSetSha256,
      protocol_version: params.protocolVersion,
      protocol_sha256: params.protocolSha256,
      roster_version: params.rosterVersion,
      roster_sha256: params.rosterSha256,
      code_commit: params.codeCommit,
      repeat_count: params.repeatCount,
      input_set_sha256: params.inputSetSha256,
      checkers: [params.arm.name],
      arm: params.arm,
    };
    const violations = validateEvaluationManifest(manifest);
    if (violations.length > 0) throw new RunRecordValidationError("evaluation manifest", violations);
    writeFileSync(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  get recordCount(): number {
    return this.written;
  }

  recordEvaluation(input: EvaluationRecordInput): EvaluationRecord {
    if (input.repeatIndex >= this.repeatCount) {
      throw new Error(`repeat_index ${input.repeatIndex} is beyond this run's repeat_count of ${this.repeatCount}`);
    }
    const record: EvaluationRecord = {
      format_version: EVALUATION_RECORD_FORMAT_VERSION,
      run_id: this.runId,
      arm: this.arm.name,
      sample_index: input.sampleIndex,
      repeat_index: input.repeatIndex,
      card_id: input.cardId,
      timestamp: this.now().toISOString(),
      protocol_version: this.protocolVersion,
      protocol_sha256: this.protocolSha256,
      original_claim: input.originalClaim,
      model_input: input.modelInput,
      input_hash: input.inputHash,
      model: input.model,
      raw_answer: input.rawAnswer ?? null,
      attempts: input.attempts,
      first_attempt_invalid: input.firstAttemptInvalid,
      retried: input.retried,
      decision: input.decision,
      usage: evaluationUsageAggregate(input.attempts),
      error: input.error,
    };
    const violations = validateEvaluationRecord(record);
    if (violations.length > 0) throw new RunRecordValidationError("evaluation record", violations);
    appendFileSync(this.recordsPath, `${canonicalJson(record)}\n`);
    this.written += 1;
    return record;
  }
}
