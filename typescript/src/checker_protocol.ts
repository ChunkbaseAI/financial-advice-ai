import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isNonEmptyString, isRecord } from "./case_set_schema.ts";

export const PROTOCOL_FORMAT_VERSION = 1;

export const DEFAULT_PROTOCOL_PATH = new URL("../../fixtures/checker_protocol_v0_1.json", import.meta.url);
export const DEFAULT_PROTOCOL_LOCK_PATH = new URL("../../fixtures/checker_protocol_v0_1.lock.json", import.meta.url);

export const LLM_VERDICTS = ["supported", "unsupported", "uncertain"] as const;
export type LlmVerdict = (typeof LLM_VERDICTS)[number];

export const CHECK_ORDER = ["ownership", "value_support", "time_support"] as const;
export type CheckName = (typeof CHECK_ORDER)[number];

export const REVIEW_REASON_SEVERITY = ["unsupported", "mismatch", "uncertain"] as const;
export type ReviewReason = (typeof REVIEW_REASON_SEVERITY)[number];

export interface NoulGate {
  pass_at_or_above: number;
  unsupported_at_or_below: number;
  between: string;
}

export interface DecisionThresholds {
  note: string;
  noul_gate: NoulGate;
  ownership_gate: { pass_at_or_above: number; rules: string };
  card_outcome: Record<string, unknown>;
  llm_categorical: string;
}

export interface JevQuestionSpec {
  type: string;
  instructions: string;
  fixed_options?: Record<string, string>;
  specific_options?: string;
  option_order?: string;
  criteria?: Record<string, string>;
}

export interface JevSpec {
  arm: string;
  model_id: string;
  state: string;
  state_token_cap: number;
  questions: Record<CheckName, JevQuestionSpec>;
}

export interface OutputSchemas {
  overall: Record<string, unknown>;
  overall_verdict_only: Record<string, unknown>;
  three_question: Record<string, unknown>;
  three_question_verdict_only: Record<string, unknown>;
}

export interface CheckerProtocol {
  format_version: number;
  protocol_version: string;
  description: string;
  case_set: { file: string; version: string; cards: number };
  roster: { file: string; version: string; identity_only_rule: string };
  gateway: Record<string, string>;
  repeats: { scored: number; timing: number; note: string };
  input_rendering: Record<string, unknown>;
  decision_thresholds: DecisionThresholds;
  jev: JevSpec;
  llm_checkers: {
    models: Record<string, string>;
    structured_output: string;
    max_output_tokens_reasoned: number;
    max_output_tokens_verdict_only: number;
    verdicts: string[];
    prompts: { input_placeholder: string; overall: string; three_question: string; retry: string };
    output_schemas: OutputSchemas;
  };
  retry_policy: { max_retries: number } & Record<string, unknown>;
  outcomes: Record<string, string>;
  limitations: string[];
}

export class ProtocolValidationError extends Error {
  readonly violations: string[];

  constructor(subject: string, violations: string[]) {
    super(`${subject} failed validation with ${violations.length} violation(s):\n- ${violations.join("\n- ")}`);
    this.name = "ProtocolValidationError";
    this.violations = violations;
  }
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export function validateCheckerProtocol(data: unknown): string[] {
  const violations: string[] = [];
  const add = (message: string) => violations.push(message);

  if (!isRecord(data)) return ["protocol: expected a JSON object"];
  if (data.format_version !== PROTOCOL_FORMAT_VERSION) add(`format_version: must be ${PROTOCOL_FORMAT_VERSION}`);
  if (!isNonEmptyString(data.protocol_version)) add('protocol_version: must be a version string like "0.1.0"');
  if (!isNonEmptyString(data.description)) add("description: must be a non-empty string");

  if (!isRecord(data.case_set) || !isNonEmptyString(data.case_set.version)) {
    add("case_set.version: must name the frozen case-set version");
  }
  if (!isRecord(data.roster) || !isNonEmptyString(data.roster.version)) {
    add("roster.version: must name the frozen roster version");
  }

  if (!isRecord(data.gateway) || !isNonEmptyString(data.gateway.base_url) || !data.gateway.base_url.startsWith("https://")) {
    add("gateway.base_url: must be an https gateway base URL");
  }

  if (!isRecord(data.repeats) || typeof data.repeats.scored !== "number" || data.repeats.scored < 1) {
    add("repeats.scored: must be an integer of at least 1");
  }
  if (isRecord(data.repeats) && (typeof data.repeats.timing !== "number" || data.repeats.timing < 1)) {
    add("repeats.timing: must be an integer of at least 1");
  }

  const whosWho = isRecord(data.input_rendering) ? data.input_rendering.whos_who : undefined;
  if (!isRecord(whosWho) || !isNonEmptyString(whosWho.template) || !whosWho.template.includes("{names}")) {
    add("input_rendering.whos_who.template: must contain a {names} placeholder");
  }

  const thresholds = data.decision_thresholds;
  if (!isRecord(thresholds) || !isRecord(thresholds.noul_gate) || !isRecord(thresholds.ownership_gate)) {
    add("decision_thresholds: must define noul_gate and ownership_gate");
  } else {
    const { pass_at_or_above: pass, unsupported_at_or_below: fail } = thresholds.noul_gate;
    if (!isProbability(pass) || !isProbability(fail) || pass <= fail) {
      add("decision_thresholds.noul_gate: pass_at_or_above and unsupported_at_or_below must be probabilities with pass above unsupported");
    }
    if (!isProbability(thresholds.ownership_gate.pass_at_or_above)) {
      add("decision_thresholds.ownership_gate.pass_at_or_above: must be a probability");
    }
    const severity = isRecord(thresholds.card_outcome) ? thresholds.card_outcome.review_reason_severity : undefined;
    if (
      !Array.isArray(severity) ||
      severity.length !== REVIEW_REASON_SEVERITY.length ||
      !REVIEW_REASON_SEVERITY.every((reason, i) => severity[i] === reason)
    ) {
      add(`decision_thresholds.card_outcome.review_reason_severity: must be ${REVIEW_REASON_SEVERITY.join(", ")} in that order`);
    }
  }

  const jev = data.jev;
  if (!isRecord(jev) || !isNonEmptyString(jev.model_id) || !isRecord(jev.questions)) {
    add("jev: must define a model_id and its three questions");
  } else {
    if (typeof jev.state_token_cap !== "number" || jev.state_token_cap < 1) {
      add("jev.state_token_cap: must record the gateway state token cap");
    }
    const ownership = jev.questions.ownership;
    if (!isRecord(ownership) || ownership.type !== "choice" || !isNonEmptyString(ownership.instructions)) {
      add("jev.questions.ownership: must be a choice question with instructions");
    } else if (!isRecord(ownership.fixed_options)) {
      add("jev.questions.ownership.fixed_options: must define the fixed options");
    } else {
      for (const option of ["joint ownership", "unknown", "not stated"]) {
        if (!isNonEmptyString(ownership.fixed_options[option])) {
          add(`jev.questions.ownership.fixed_options: must define the "${option}" option`);
        }
      }
    }
    for (const name of ["value_support", "time_support"]) {
      const question = jev.questions[name as CheckName];
      if (
        !isRecord(question) ||
        question.type !== "noul" ||
        !isNonEmptyString(question.instructions) ||
        !isRecord(question.criteria) ||
        !isNonEmptyString(question.criteria.true) ||
        !isNonEmptyString(question.criteria.false)
      ) {
        add(`jev.questions.${name}: must be a noul question with instructions and true/false criteria`);
      }
    }
  }

  const llm = data.llm_checkers;
  if (!isRecord(llm) || !isRecord(llm.models) || Object.keys(llm.models).length === 0) {
    add("llm_checkers.models: must pin at least one exact model ID");
  } else {
    for (const [name, modelId] of Object.entries(llm.models)) {
      if (!isNonEmptyString(modelId)) add(`llm_checkers.models.${name}: must be a non-empty model ID`);
    }
    const verdicts: unknown = llm.verdicts;
    if (!Array.isArray(verdicts) || !LLM_VERDICTS.every((v, i) => verdicts[i] === v)) {
      add(`llm_checkers.verdicts: must be exactly ${LLM_VERDICTS.join(", ")}`);
    }
    const prompts = llm.prompts;
    if (!isRecord(prompts) || !isNonEmptyString(prompts.input_placeholder)) {
      add("llm_checkers.prompts.input_placeholder: must name the input placeholder");
    } else {
      for (const key of ["overall", "three_question"] as const) {
        const prompt = isRecord(prompts) ? prompts[key] : undefined;
        if (!isNonEmptyString(prompt)) {
          add(`llm_checkers.prompts.${key}: must be a non-empty frozen prompt`);
        } else if (countOccurrences(prompt, prompts.input_placeholder) !== 1) {
          add(`llm_checkers.prompts.${key}: must contain the ${prompts.input_placeholder} placeholder exactly once`);
        }
      }
      if (!isRecord(prompts) || !isNonEmptyString(prompts.retry)) {
        add("llm_checkers.prompts.retry: must be the frozen retry instruction");
      }
    }
    const schemas = llm.output_schemas;
    if (
      !isRecord(schemas) ||
      !(["overall", "overall_verdict_only", "three_question", "three_question_verdict_only"] as const).every((key) =>
        isRecord(schemas[key]),
      )
    ) {
      add("llm_checkers.output_schemas: must define schemas for both configurations, reasoned and verdict-only");
    }
    if (typeof llm.max_output_tokens_reasoned !== "number" || llm.max_output_tokens_reasoned < 1) {
      add("llm_checkers.max_output_tokens_reasoned: must record the output limit for reasoned runs");
    }
    if (typeof llm.max_output_tokens_verdict_only !== "number" || llm.max_output_tokens_verdict_only < 1) {
      add("llm_checkers.max_output_tokens_verdict_only: must record the output limit for verdict-only runs");
    }
  }

  if (!isRecord(data.retry_policy) || data.retry_policy.max_retries !== 1) {
    add("retry_policy.max_retries: the recorded policy is exactly 1 retry for invalid output");
  }

  if (
    !Array.isArray(data.limitations) ||
    data.limitations.length === 0 ||
    !data.limitations.every(isNonEmptyString)
  ) {
    add("limitations: must state at least one limitation, written before any performance claim");
  }

  return violations;
}

export interface ProtocolLockResult {
  sha256: string;
  protocolVersion: string;
}

export function verifyProtocolLock(protocolPath: string | URL, lockPath: string | URL): ProtocolLockResult {
  const sha256 = createHash("sha256").update(readFileSync(protocolPath)).digest("hex");
  let lock: unknown;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    throw new Error(`protocol lock is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(lock) || !isNonEmptyString(lock.sha256)) {
    throw new Error("protocol lock is missing its sha256 field");
  }
  if (lock.sha256 !== sha256) {
    throw new Error(
      `protocol no longer matches its frozen lock: lock records ${lock.sha256} but the file hashes to ${sha256}; ` +
        "any protocol change requires a new version, a new lock, and a rerun",
    );
  }
  return { sha256, protocolVersion: isNonEmptyString(lock.protocol_version) ? lock.protocol_version : "" };
}

export function loadProtocol(protocolPath: string | URL, lockPath: string | URL): CheckerProtocol {
  verifyProtocolLock(protocolPath, lockPath);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(protocolPath, "utf8"));
  } catch (error) {
    throw new ProtocolValidationError("protocol", [`file is not valid JSON: ${(error as Error).message}`]);
  }
  const violations = validateCheckerProtocol(data);
  if (violations.length > 0) throw new ProtocolValidationError("protocol", violations);
  return data as CheckerProtocol;
}

export interface ExperimentFreezePaths {
  caseSetPath: string | URL;
  caseSetLockPath: string | URL;
  rosterPath: string | URL;
  rosterLockPath: string | URL;
  protocolPath: string | URL;
  protocolLockPath: string | URL;
}

export interface ExperimentFreeze {
  caseSetVersion: string;
  caseSetSha256: string;
  rosterVersion: string;
  rosterSha256: string;
  protocolVersion: string;
  protocolSha256: string;
}

function sha256OfFile(path: string | URL): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyExperimentFreeze(paths: ExperimentFreezePaths): ExperimentFreeze {
  const caseSetSha256 = sha256OfFile(paths.caseSetPath);
  const rosterSha256 = sha256OfFile(paths.rosterPath);

  const caseSetLock = JSON.parse(readFileSync(paths.caseSetLockPath, "utf8")) as Record<string, unknown>;
  if (caseSetLock.sha256 !== caseSetSha256) {
    throw new Error(
      `case set no longer matches its frozen lock: lock records ${caseSetLock.sha256} but the file hashes to ${caseSetSha256}; ` +
        "if the change is intended, re-freeze with `bun run freeze:case-set` and record the reason",
    );
  }
  const rosterLock = JSON.parse(readFileSync(paths.rosterLockPath, "utf8")) as Record<string, unknown>;
  if (rosterLock.sha256 !== rosterSha256) {
    throw new Error(
      `roster no longer matches its frozen lock: lock records ${rosterLock.sha256} but the file hashes to ${rosterSha256}; ` +
        "if the change is intended, re-freeze with `bun run freeze:roster` and record the reason",
    );
  }

  const protocolLockRaw = JSON.parse(readFileSync(paths.protocolLockPath, "utf8")) as Record<string, unknown>;
  if (protocolLockRaw.case_set_sha256 !== caseSetSha256) {
    throw new Error(
      `the protocol lock binds case-set sha256 ${protocolLockRaw.case_set_sha256} but the frozen case set hashes to ${caseSetSha256}; ` +
        "the protocol must be re-frozen against the current case set before any run",
    );
  }
  if (protocolLockRaw.roster_sha256 !== rosterSha256) {
    throw new Error(
      `the protocol lock binds roster sha256 ${protocolLockRaw.roster_sha256} but the roster hashes to ${rosterSha256}; ` +
        "the roster must be re-frozen and the protocol re-versioned before any run",
    );
  }

  const protocolLock = verifyProtocolLock(paths.protocolPath, paths.protocolLockPath);
  const caseSet = JSON.parse(readFileSync(paths.caseSetPath, "utf8")) as { case_set_version: string };
  const roster = JSON.parse(readFileSync(paths.rosterPath, "utf8")) as { roster_version: string };

  return {
    caseSetVersion: caseSet.case_set_version,
    caseSetSha256,
    rosterVersion: roster.roster_version,
    rosterSha256,
    protocolVersion: protocolLock.protocolVersion,
    protocolSha256: protocolLock.sha256,
  };
}
