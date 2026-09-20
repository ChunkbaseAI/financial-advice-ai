import { isNonEmptyString, isRecord, type Claim } from "./case_set_schema.ts";
import { CHECK_ORDER, REVIEW_REASON_SEVERITY, type CheckName, type ReviewReason } from "./checker_protocol.ts";
import type { CardDecision } from "./decision_mapping.ts";
import type { ModelInput } from "./input_preparation.ts";

export const RUN_RECORD_FORMAT_VERSION = 1;
export const EVALUATION_RECORD_FORMAT_VERSION = 2;

export const RECORDED_VERDICTS = ["supported", "unsupported"] as const;
export type RecordedVerdict = (typeof RECORDED_VERDICTS)[number];

export const ERROR_KINDS = ["rate-limit", "timeout", "http-error", "invalid-response", "other"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export const EVALUATION_ERROR_KINDS = [...ERROR_KINDS, "input-preparation"] as const;
export type EvaluationErrorKind = (typeof EVALUATION_ERROR_KINDS)[number];

export const ARM_VARIANTS = ["rules", "decomposed", "overall", "three-question"] as const;
export type ArmVariant = (typeof ARM_VARIANTS)[number];

export const DECISION_POLICIES = ["value-presence", "probability-gated", "categorical-verdict"] as const;
export type DecisionPolicy = (typeof DECISION_POLICIES)[number];

export const CHECK_OUTCOMES = ["pass", "mismatch", "uncertain", "unsupported"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export const CARD_OUTCOMES = ["pass", "review"] as const;
export type CardOutcome = (typeof CARD_OUTCOMES)[number];

export const CARD_VERDICTS = ["supported", ...REVIEW_REASON_SEVERITY] as const;
export type CardVerdict = (typeof CARD_VERDICTS)[number];

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
  if (isRecord(data) && data.format_version === EVALUATION_RECORD_FORMAT_VERSION) {
    return validateEvaluationRecord(data);
  }
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
  if (isRecord(data) && data.format_version === EVALUATION_RECORD_FORMAT_VERSION) {
    return validateEvaluationManifest(data);
  }
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

export interface EvaluationAttempt {
  index: number;
  raw_response: unknown;
  parsed_answer: unknown;
  usage: GatewayUsage | null;
  elapsed_ms: number;
  error: RunRecordError | null;
}

export interface EvaluationRecordError {
  kind: EvaluationErrorKind;
  message: string;
  status?: number;
}

export interface EvaluationDecision extends CardDecision {}

export interface EvaluationRecord {
  format_version: number;
  run_id: string;
  arm: string;
  sample_index: number;
  repeat_index: number;
  card_id: string;
  timestamp: string;
  protocol_version: string;
  protocol_sha256: string;
  original_claim: Claim;
  model_input: ModelInput;
  input_hash: string;
  model: ModelReport | null;
  attempts: EvaluationAttempt[];
  first_attempt_invalid: boolean;
  retried: boolean;
  decision: EvaluationDecision | null;
  usage: GatewayUsage | null;
  error: EvaluationRecordError | null;
}

export interface EvaluationManifestArm {
  name: string;
  checker: string;
  model_id: string | null;
  variant: ArmVariant;
  decision_policy: DecisionPolicy;
  timing_run: boolean;
}

export interface EvaluationManifest {
  format_version: number;
  run_id: string;
  created_at: string;
  case_set_version: string;
  case_set_sha256: string;
  protocol_version: string;
  protocol_sha256: string;
  roster_version: string;
  roster_sha256: string;
  code_commit: string;
  repeat_count: number;
  input_set_sha256: string;
  checkers: string[];
  arm: EvaluationManifestArm;
}

const CLAIM_KEYS = ["subject_id", "field", "value", "unit", "period_or_basis", "as_of"] as const;

function validateOriginalClaim(claim: unknown, violations: string[], path: string): void {
  if (!isRecord(claim)) {
    violations.push(`${path}: must be the original claim as written on the card`);
    return;
  }
  for (const key of CLAIM_KEYS) {
    if (!(key in claim) || claim[key] === null || claim[key] === undefined) {
      violations.push(`${path}.${key}: must be present as written on the card`);
    }
  }
}

function validateDecision(decision: unknown, violations: string[], path: string): void {
  if (decision === null || decision === undefined) return;
  if (!isRecord(decision)) {
    violations.push(`${path}: must be the mapped decision, or null when the evaluation failed`);
    return;
  }
  const { outcome, verdict, review_reason: reviewReason, checks } = decision;
  if (!(typeof outcome === "string" && (CARD_OUTCOMES as readonly string[]).includes(outcome))) {
    violations.push(`${path}.outcome: must be one of ${CARD_OUTCOMES.join(", ")}`);
  }
  if (!(typeof verdict === "string" && (CARD_VERDICTS as readonly string[]).includes(verdict))) {
    violations.push(`${path}.verdict: must be one of ${CARD_VERDICTS.join(", ")}`);
  }
  if (reviewReason !== null && !(typeof reviewReason === "string" && (REVIEW_REASON_SEVERITY as readonly string[]).includes(reviewReason))) {
    violations.push(`${path}.review_reason: must be null or one of ${REVIEW_REASON_SEVERITY.join(", ")}`);
  }
  if (outcome === "pass") {
    if (verdict !== "supported" || reviewReason !== null) {
      violations.push(`${path}: a pass must be verdict "supported" with no review reason; the pass means "passed these three checks", never "fully verified"`);
    }
  } else if (outcome === "review") {
    if (reviewReason === null || verdict !== reviewReason) {
      violations.push(`${path}: a review must carry a review reason and the verdict must match it`);
    }
  }
  if (checks !== null && checks !== undefined) {
    if (!isRecord(checks)) {
      violations.push(`${path}.checks: must be null for single-question arms, or all three check outcomes`);
    } else {
      let allPass = true;
      for (const name of CHECK_ORDER) {
        const checkOutcome = checks[name];
        if (!(typeof checkOutcome === "string" && (CHECK_OUTCOMES as readonly string[]).includes(checkOutcome))) {
          violations.push(`${path}.checks.${name}: must be one of ${CHECK_OUTCOMES.join(", ")}`);
          allPass = false;
        } else if (checkOutcome !== "pass") {
          allPass = false;
        }
      }
      if (isRecord(checks) && allPass !== (outcome === "pass")) {
        violations.push(`${path}.checks: a card passes only when all three checks pass`);
      }
    }
  }
}

function validateEvaluationError(error: unknown, violations: string[], path: string): void {
  if (!isRecord(error)) {
    violations.push(`${path}: must be an object describing the failure`);
    return;
  }
  if (
    !(typeof error.kind === "string" && (EVALUATION_ERROR_KINDS as readonly string[]).includes(error.kind))
  ) {
    violations.push(`${path}.kind: must be one of ${EVALUATION_ERROR_KINDS.join(", ")}`);
  }
  if (!isNonEmptyString(error.message)) violations.push(`${path}.message: must be a non-empty description of the failure`);
  if (error.kind === "input-preparation") return;
  validateError(error, violations, path);
}

export function validateEvaluationRecord(data: unknown): string[] {
  const violations: string[] = [];
  if (!isRecord(data)) return ["evaluation record: expected a JSON object"];

  if (data.format_version !== EVALUATION_RECORD_FORMAT_VERSION) {
    violations.push(`format_version: must be ${EVALUATION_RECORD_FORMAT_VERSION}`);
  }
  if (!isNonEmptyString(data.run_id)) violations.push("run_id: must be a non-empty string");
  if (!isNonEmptyString(data.arm)) violations.push("arm: must name the checker configuration");
  if (!isNonNegativeInteger(data.sample_index)) violations.push("sample_index: must be a non-negative integer");
  if (!isNonNegativeInteger(data.repeat_index)) violations.push("repeat_index: must be a non-negative integer");
  if (typeof data.timestamp !== "string" || !ISO_DATETIME.test(data.timestamp)) {
    violations.push("timestamp: must be an ISO 8601 datetime with a timezone");
  }
  if (!isNonEmptyString(data.card_id)) violations.push("card_id: must be a non-empty card ID");
  if (!isNonEmptyString(data.protocol_version)) violations.push("protocol_version: must name the frozen protocol version");
  if (typeof data.protocol_sha256 !== "string" || !SHA256_HEX.test(data.protocol_sha256)) {
    violations.push("protocol_sha256: must be 64 lowercase hex characters");
  }
  validateOriginalClaim(data.original_claim, violations, "original_claim");
  if (!isRecord(data.model_input)) violations.push("model_input: must be the exact model-visible input");
  if (typeof data.input_hash !== "string" || !PROMPT_HASH.test(data.input_hash)) {
    violations.push('input_hash: must be "sha256:" followed by 64 lowercase hex characters over the model-visible input');
  }

  if (!("model" in data)) {
    violations.push("model: must be present, using null when no model call was made");
  } else if (data.model !== null) {
    validateModel(data.model, violations, "model");
  }

  const attempts = data.attempts;
  if (!Array.isArray(attempts)) {
    violations.push("attempts: must be the array of preserved attempts, empty when no model call was made");
  } else {
    if (attempts.length > 2) {
      violations.push("attempts: the recorded policy allows at most one retry, so at most two attempts");
    }
    attempts.forEach((attempt, i) => {
      const path = `attempts[${i}]`;
      if (!isRecord(attempt)) {
        violations.push(`${path}: must be an object`);
        return;
      }
      if (attempt.index !== i + 1) violations.push(`${path}.index: attempts are numbered from 1 in order`);
      if (typeof attempt.elapsed_ms !== "number" || !Number.isFinite(attempt.elapsed_ms) || attempt.elapsed_ms < 0) {
        violations.push(`${path}.elapsed_ms: must be the client-measured wall time of the attempt`);
      }
      if (!("raw_response" in attempt)) violations.push(`${path}.raw_response: must be present, preserved verbatim`);
      if (!("parsed_answer" in attempt)) violations.push(`${path}.parsed_answer: must be present, null when unparseable`);
      if (!("usage" in attempt)) {
        violations.push(`${path}.usage: must be present, using null when the gateway reported nothing`);
      } else if (attempt.usage !== null) {
        validateUsage(attempt.usage, violations, `${path}.usage`);
      }
      if (attempt.error === null || attempt.error === undefined) {
        if (attempt.usage === null || attempt.usage === undefined) {
          violations.push(`${path}.usage: a successful model attempt must record the gateway-reported usage`);
        }
      }
      if (attempt.error !== null && attempt.error !== undefined) {
        validateError(attempt.error, violations, `${path}.error`);
      }
    });
    const retried = data.retried;
    if (typeof retried !== "boolean") violations.push("retried: must record whether the retry policy ran");
    else if (retried !== (attempts.length === 2)) {
      violations.push("retried: must be true exactly when a second attempt was made");
    }
    const firstInvalid = data.first_attempt_invalid;
    if (typeof firstInvalid !== "boolean") {
      violations.push("first_attempt_invalid: must record whether the first response failed the schema");
    } else {
      const firstError = attempts.length > 0 && isRecord(attempts[0]) ? attempts[0].error : null;
      const firstWasInvalid = isRecord(firstError) && firstError.kind === "invalid-response";
      if (firstInvalid !== firstWasInvalid) {
        violations.push("first_attempt_invalid: must be true exactly when the first attempt failed as invalid-response");
      }
    }
  }

  validateDecision(data.decision, violations, "decision");

  if (!("error" in data)) {
    violations.push("error: must be present, using null for a successful evaluation");
  } else if (data.error !== null) {
    validateEvaluationError(data.error, violations, "error");
  }

  const hasError = data.error !== null && data.error !== undefined;
  if (hasError && data.decision !== null && data.decision !== undefined) {
    violations.push("decision: an evaluation with an error has no decision; an execution error is never a pass or a caught mistake");
  }
  if (!hasError && (data.decision === null || data.decision === undefined)) {
    violations.push("decision: a successful evaluation must record its mapped decision");
  }
  if (hasError && isRecord(data.error) && data.error.kind === "input-preparation") {
    if (Array.isArray(attempts) && attempts.length > 0) {
      violations.push("attempts: an input-preparation error happens before any checker call");
    }
    if (data.model !== null && data.model !== undefined) {
      violations.push("model: an input-preparation error record makes no model call");
    }
    if (data.usage !== null && data.usage !== undefined) {
      violations.push("usage: an input-preparation error record has no gateway usage");
    }
  }

  if (!("usage" in data)) {
    violations.push("usage: must be present, the aggregate gateway-reported usage across attempts");
  } else if (data.usage !== null) {
    validateUsage(data.usage, violations, "usage");
    if (Array.isArray(attempts) && !attempts.some((a) => isRecord(a) && a.usage !== null && a.usage !== undefined)) {
      violations.push("usage: aggregate usage requires at least one attempt with gateway-reported usage");
    }
  } else if (Array.isArray(attempts) && attempts.some((a) => isRecord(a) && a.usage !== null && a.usage !== undefined)) {
    violations.push("usage: attempts with gateway-reported usage must be summed into the record's usage");
  }

  return violations;
}

export function validateEvaluationManifest(data: unknown): string[] {
  const violations: string[] = [];
  if (!isRecord(data)) return ["evaluation manifest: expected a JSON object"];

  if (data.format_version !== EVALUATION_RECORD_FORMAT_VERSION) {
    violations.push(`format_version: must be ${EVALUATION_RECORD_FORMAT_VERSION}`);
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
  if (!isNonEmptyString(data.protocol_version)) violations.push("protocol_version: must name the frozen protocol version");
  if (typeof data.protocol_sha256 !== "string" || !SHA256_HEX.test(data.protocol_sha256)) {
    violations.push("protocol_sha256: must be 64 lowercase hex characters");
  }
  if (!isNonEmptyString(data.roster_version)) violations.push("roster_version: must name the frozen roster version");
  if (typeof data.roster_sha256 !== "string" || !SHA256_HEX.test(data.roster_sha256)) {
    violations.push("roster_sha256: must be 64 lowercase hex characters");
  }
  if (typeof data.code_commit !== "string" || !GIT_COMMIT.test(data.code_commit)) {
    violations.push("code_commit: must be the full git commit sha that produced the run");
  }
  if (typeof data.repeat_count !== "number" || !Number.isInteger(data.repeat_count) || data.repeat_count < 1) {
    violations.push("repeat_count: must be an integer of at least 1");
  }
  if (typeof data.input_set_sha256 !== "string" || !SHA256_HEX.test(data.input_set_sha256)) {
    violations.push("input_set_sha256: must be the sha256 of the frozen model-visible input set");
  }
  if (!Array.isArray(data.checkers) || data.checkers.length === 0 || !data.checkers.every(isNonEmptyString)) {
    violations.push("checkers: must be a non-empty array holding the arm name");
  }

  const arm = data.arm;
  if (!isRecord(arm)) {
    violations.push("arm: must describe the checker configuration that produced this run");
  } else {
    if (!isNonEmptyString(arm.name)) violations.push("arm.name: must name the arm");
    if (!isNonEmptyString(arm.checker)) violations.push("arm.checker: must name the checker");
    if (!(typeof arm.variant === "string" && (ARM_VARIANTS as readonly string[]).includes(arm.variant))) {
      violations.push(`arm.variant: must be one of ${ARM_VARIANTS.join(", ")}`);
    }
    if (!(typeof arm.decision_policy === "string" && (DECISION_POLICIES as readonly string[]).includes(arm.decision_policy))) {
      violations.push(`arm.decision_policy: must be one of ${DECISION_POLICIES.join(", ")}`);
    }
    if (typeof arm.timing_run !== "boolean") violations.push("arm.timing_run: must label whether this is a verdict-only timing run");
    if (arm.variant === "rules") {
      if (arm.model_id !== null) violations.push("arm.model_id: the rules checker is deterministic and offline; no model ID");
    } else if (!isNonEmptyString(arm.model_id)) {
      violations.push("arm.model_id: must pin the exact model ID for a networked arm");
    }
    if (isNonEmptyString(arm.name) && Array.isArray(data.checkers) && !data.checkers.includes(arm.name)) {
      violations.push("checkers: must include the arm name");
    }
  }

  return violations;
}
