import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./hashing.ts";
import {
  RUN_RECORD_FORMAT_VERSION,
  RunRecordValidationError,
  validateRunManifest,
  validateRunRecord,
  type ErrorKind,
  type GatewayUsage,
  type ModelReport,
  type RecordedVerdict,
  type RunManifest,
  type RunRecord,
} from "./run_record_schema.ts";

export interface RunRecorderParams {
  runId: string;
  caseSetVersion: string;
  caseSetSha256: string;
  codeCommit: string;
  promptSetSha256: string;
  repeatCount: number;
  checkers: string[];
  outputDir: string;
  now?: () => Date;
}

interface RecordInput {
  sampleIndex: number;
  repeatIndex?: number;
  cardId: string;
  promptHash: string;
  checker: string;
}

export interface ModelSuccessInput extends RecordInput {
  model: ModelReport;
  verdict: RecordedVerdict;
  rawAnswer?: unknown;
  usage: GatewayUsage;
}

export interface ModelErrorInput extends RecordInput {
  model?: ModelReport | null;
  error: { kind: ErrorKind; message: string; status?: number };
}

export interface DeterministicResultInput extends RecordInput {
  verdict: RecordedVerdict;
  rawAnswer?: unknown;
}

export class RunRecorder {
  readonly runId: string;
  readonly manifestPath: string;
  readonly recordsPath: string;
  private readonly repeatCount: number;
  private readonly now: () => Date;
  private written = 0;

  constructor(params: RunRecorderParams) {
    this.runId = params.runId;
    this.repeatCount = params.repeatCount;
    this.now = params.now ?? (() => new Date());
    this.manifestPath = join(params.outputDir, "manifest.json");
    this.recordsPath = join(params.outputDir, "records.jsonl");

    const manifest: RunManifest = {
      format_version: RUN_RECORD_FORMAT_VERSION,
      run_id: params.runId,
      created_at: this.now().toISOString(),
      case_set_version: params.caseSetVersion,
      case_set_sha256: params.caseSetSha256,
      code_commit: params.codeCommit,
      repeat_count: params.repeatCount,
      prompt_set_sha256: params.promptSetSha256,
      checkers: params.checkers,
    };
    const violations = validateRunManifest(manifest);
    if (violations.length > 0) throw new RunRecordValidationError("run manifest", violations);

    mkdirSync(params.outputDir, { recursive: true });
    writeFileSync(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  get recordCount(): number {
    return this.written;
  }

  recordModelSuccess(input: ModelSuccessInput): RunRecord {
    return this.write({
      format_version: RUN_RECORD_FORMAT_VERSION,
      run_id: this.runId,
      sample_index: input.sampleIndex,
      repeat_index: this.resolveRepeatIndex(input),
      timestamp: this.now().toISOString(),
      checker: input.checker,
      card_id: input.cardId,
      prompt_hash: input.promptHash,
      model: input.model,
      verdict: input.verdict,
      raw_answer: input.rawAnswer ?? null,
      usage: input.usage,
      error: null,
    });
  }

  recordModelError(input: ModelErrorInput): RunRecord {
    const error =
      input.error.status === undefined
        ? { kind: input.error.kind, message: input.error.message }
        : { kind: input.error.kind, message: input.error.message, status: input.error.status };
    return this.write({
      format_version: RUN_RECORD_FORMAT_VERSION,
      run_id: this.runId,
      sample_index: input.sampleIndex,
      repeat_index: this.resolveRepeatIndex(input),
      timestamp: this.now().toISOString(),
      checker: input.checker,
      card_id: input.cardId,
      prompt_hash: input.promptHash,
      model: input.model ?? null,
      verdict: null,
      raw_answer: null,
      usage: null,
      error,
    });
  }

  recordDeterministicResult(input: DeterministicResultInput): RunRecord {
    return this.write({
      format_version: RUN_RECORD_FORMAT_VERSION,
      run_id: this.runId,
      sample_index: input.sampleIndex,
      repeat_index: this.resolveRepeatIndex(input),
      timestamp: this.now().toISOString(),
      checker: input.checker,
      card_id: input.cardId,
      prompt_hash: input.promptHash,
      model: null,
      verdict: input.verdict,
      raw_answer: input.rawAnswer ?? null,
      usage: null,
      error: null,
    });
  }

  private resolveRepeatIndex(input: RecordInput): number {
    const repeatIndex = input.repeatIndex ?? 0;
    if (repeatIndex >= this.repeatCount) {
      throw new Error(`repeat_index ${repeatIndex} is beyond this run's repeat_count of ${this.repeatCount}`);
    }
    return repeatIndex;
  }

  private write(record: RunRecord): RunRecord {
    const violations = validateRunRecord(record);
    if (violations.length > 0) throw new RunRecordValidationError("run record", violations);
    appendFileSync(this.recordsPath, `${canonicalJson(record)}\n`);
    this.written += 1;
    return record;
  }
}
