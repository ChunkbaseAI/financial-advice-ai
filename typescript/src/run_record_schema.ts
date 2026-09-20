import { isNonEmptyString, isRecord } from "./case_set_schema.ts";

export const RUN_RECORD_FORMAT_VERSION = 1;

export const RECORDED_VERDICTS = ["supported", "unsupported"] as const;
export type RecordedVerdict = (typeof RECORDED_VERDICTS)[number];

export const ERROR_KINDS = ["rate-limit", "timeout", "http-error", "invalid-response", "other"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PROMPT_HASH = /^sha256:[0-9a-f]{64}$/;
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const CURRENCY = /^[A-Z]{3}$/;

export interface ModelReport {
  id: string;
  version: string;
  provider: string;
  generation_id?: string;
}

export interface GatewayCost {
  amount: number;
  currency: string;
}

export interface GatewayUsage {
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost: GatewayCost | null;
}

export interface RunRecordError {
  kind: ErrorKind;
  message: string;
  status?: number;
}

export interface RunRecord {
  format_version: number;
  run_id: string;
  sample_index: number;
  repeat_index: number;
  timestamp: string;
  checker: string;
  card_id: string;
  prompt_hash: string;
  model: ModelReport | null;
  verdict: RecordedVerdict | null;
  raw_answer: unknown;
  usage: GatewayUsage | null;
  error: RunRecordError | null;
}

export interface RunManifest {
  format_version: number;
  run_id: string;
  created_at: string;
  case_set_version: string;
  case_set_sha256: string;
  code_commit: string;
  repeat_count: number;
  prompt_set_sha256: string;
  checkers: string[];
}

export class RunRecordValidationError extends Error {
  readonly violations: string[];

  constructor(subject: string, violations: string[]) {
    super(`${subject} failed validation with ${violations.length} violation(s):\n- ${violations.join("\n- ")}`);
    this.name = "RunRecordValidationError";
    this.violations = violations;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateModel(model: unknown, violations: string[], path: string): void {
  if (!isRecord(model)) {
    violations.push(`${path}: must be an object reported back by the gateway, or null for a deterministic checker`);
    return;
  }
  if (!isNonEmptyString(model.id)) violations.push(`${path}.id: must be the model ID the gateway served`);
  if (!isNonEmptyString(model.version)) {
    violations.push(`${path}.version: must be the exact version reported back by the gateway, never an alias`);
  }
  if (!isNonEmptyString(model.provider)) {
    violations.push(`${path}.provider: must record which provider served the call, from response metadata`);
  }
  if (model.generation_id !== undefined && !isNonEmptyString(model.generation_id)) {
    violations.push(`${path}.generation_id: when present, must be a non-empty gateway generation ID`);
  }
}

function validateUsage(usage: unknown, violations: string[], path: string): void {
  if (!isRecord(usage)) {
    violations.push(`${path}: must be gateway-reported usage, or null when the gateway reported nothing`);
    return;
  }
  if (!isNonNegativeNumber(usage.latency_ms)) violations.push(`${path}.latency_ms: must be the gateway-reported latency`);
  if (!isNonNegativeInteger(usage.input_tokens)) violations.push(`${path}.input_tokens: must be a non-negative integer from gateway usage`);
  if (!isNonNegativeInteger(usage.output_tokens)) violations.push(`${path}.output_tokens: must be a non-negative integer from gateway usage`);
  const cost = usage.cost;
  if (cost === null) return;
  if (!isRecord(cost)) {
    violations.push(`${path}.cost: must be gateway-reported cost, or null when the gateway reported none`);
  } else {
    if (!isNonNegativeNumber(cost.amount)) violations.push(`${path}.cost.amount: must be a non-negative gateway-reported amount`);
    if (typeof cost.currency !== "string" || !CURRENCY.test(cost.currency)) {
      violations.push(`${path}.cost.currency: must be a three-letter currency code such as "USD"`);
    }
  }
}

function validateError(error: unknown, violations: string[], path: string): void {
  if (!isRecord(error)) {
    violations.push(`${path}: must be an object describing the failure, or null for a successful call`);
    return;
  }
  if (!(typeof error.kind === "string" && (ERROR_KINDS as readonly string[]).includes(error.kind))) {
    violations.push(`${path}.kind: must be one of ${ERROR_KINDS.join(", ")}`);
  }
  if (!isNonEmptyString(error.message)) violations.push(`${path}.message: must be a non-empty description of the failure`);
  if (error.status !== undefined) {
    if (typeof error.status !== "number" || !Number.isInteger(error.status) || error.status < 100 || error.status > 599) {
      violations.push(`${path}.status: when present, must be an HTTP status code`);
    }
  }
  if (error.kind === "rate-limit" && error.status !== 429) {
    violations.push(`${path}.status: a "rate-limit" error must record status 429`);
  }
  if (error.kind === "http-error" && typeof error.status !== "number") {
    violations.push(`${path}.status: an "http-error" must record its HTTP status`);
  }
}

export function validateRunRecord(data: unknown): string[] {
  const violations: string[] = [];

  if (!isRecord(data)) return ["run record: expected a JSON object"];

  if (data.format_version !== RUN_RECORD_FORMAT_VERSION) {
    violations.push(`format_version: must be ${RUN_RECORD_FORMAT_VERSION} so a later page can render this record without this repository's code`);
  }
  if (!isNonEmptyString(data.run_id)) violations.push("run_id: must be a non-empty string");
  if (!isNonNegativeInteger(data.sample_index)) violations.push("sample_index: must be a non-negative integer");
  if (!isNonNegativeInteger(data.repeat_index)) violations.push("repeat_index: must be a non-negative integer");
  if (typeof data.timestamp !== "string" || !ISO_DATETIME.test(data.timestamp)) {
    violations.push("timestamp: must be an ISO 8601 datetime with a timezone, e.g. 2026-09-20T10:00:00.123Z");
  }
  if (!isNonEmptyString(data.checker)) violations.push("checker: must be a non-empty checker name");
  if (!isNonEmptyString(data.card_id)) violations.push("card_id: must be a non-empty card ID");
  if (typeof data.prompt_hash !== "string" || !PROMPT_HASH.test(data.prompt_hash)) {
    violations.push('prompt_hash: must be the sha256 of the prompt, written as "sha256:" followed by 64 lowercase hex characters');
  }

  if (!("model" in data)) {
    violations.push("model: must be present, using null for a deterministic checker");
  } else if (data.model !== null) {
    validateModel(data.model, violations, "model");
  }

  const hasError = data.error !== null && data.error !== undefined;
  if (!("verdict" in data)) {
    violations.push("verdict: must be present, using null when the call failed");
  } else if (hasError) {
    if (data.verdict !== null) violations.push("verdict: must be null on an error record; a failed call has no verdict");
  } else if (!(typeof data.verdict === "string" && (RECORDED_VERDICTS as readonly string[]).includes(data.verdict))) {
    violations.push(`verdict: must be one of ${RECORDED_VERDICTS.join(", ")} on a successful record`);
  }

  if (!("raw_answer" in data)) violations.push("raw_answer: must be present, using null when the call failed");

  if (!("usage" in data)) {
    violations.push("usage: must be present, using null when the gateway reported nothing");
  } else if (data.usage !== null) {
    validateUsage(data.usage, violations, "usage");
  }

  if (!("error" in data)) {
    violations.push("error: must be present, using null for a successful call");
  } else if (data.error !== null) {
    validateError(data.error, violations, "error");
  }

  if (!hasError && data.model !== null && data.usage === null) {
    violations.push("usage: a successful model call must record the gateway-reported usage, never a client-side estimate");
  }
  if (data.model === null && data.usage !== null) {
    violations.push("usage: a deterministic checker has no gateway usage to report, and must not record an estimate");
  }

  return violations;
}

export function validateRunManifest(data: unknown): string[] {
  const violations: string[] = [];

  if (!isRecord(data)) return ["run manifest: expected a JSON object"];

  if (data.format_version !== RUN_RECORD_FORMAT_VERSION) {
    violations.push(`format_version: must be ${RUN_RECORD_FORMAT_VERSION} so a later page can render this manifest without this repository's code`);
  }
  if (!isNonEmptyString(data.run_id)) violations.push("run_id: must be a non-empty string");
  if (typeof data.created_at !== "string" || !ISO_DATETIME.test(data.created_at)) {
    violations.push("created_at: must be an ISO 8601 datetime with a timezone");
  }
  if (typeof data.case_set_version !== "string" || !SEMVER.test(data.case_set_version)) {
    violations.push('case_set_version: must be a version string like "1.0.0"');
  }
  if (typeof data.case_set_sha256 !== "string" || !SHA256_HEX.test(data.case_set_sha256)) {
    violations.push("case_set_sha256: must be 64 lowercase hex characters");
  }
  if (typeof data.code_commit !== "string" || !GIT_COMMIT.test(data.code_commit)) {
    violations.push("code_commit: must be the full git commit sha that produced the run");
  }
  if (typeof data.repeat_count !== "number" || !Number.isInteger(data.repeat_count) || data.repeat_count < 1) {
    violations.push("repeat_count: must be an integer of at least 1");
  }
  if (typeof data.prompt_set_sha256 !== "string" || !SHA256_HEX.test(data.prompt_set_sha256)) {
    violations.push("prompt_set_sha256: must be the sha256 of the frozen prompt set, 64 lowercase hex characters");
  }
  if (!Array.isArray(data.checkers) || data.checkers.length === 0 || !data.checkers.every(isNonEmptyString)) {
    violations.push("checkers: must be a non-empty array of checker names");
  }

  return violations;
}
