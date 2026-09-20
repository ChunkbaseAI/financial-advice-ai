import type { Card } from "./case_set_schema.ts";
import type { CheckName, CheckerProtocol } from "./checker_protocol.ts";
import { householdSubjects, type ModelInput } from "./input_preparation.ts";
import type { Roster } from "./roster.ts";
import {
  combineChecks,
  mapNoul,
  mapOwnership,
  type CardDecision,
  type GateThresholds,
  type JevChoiceAnswer,
  type JevNoulAnswer,
} from "./decision_mapping.ts";
import { GatewayClient, type SystemOneRequest } from "./gateway_client.ts";
import { callWithBackoff } from "./gateway_backoff.ts";
import { runWithRetryPolicy, type AttemptOutcome } from "./retry_policy.ts";
import type { CheckerCardResult } from "./evaluation_recorder.ts";
import type { EvaluationAttempt } from "./run_record_schema.ts";

export interface ParsedJevAnswers {
  ownership: JevChoiceAnswer;
  value_support: JevNoulAnswer;
  time_support: JevNoulAnswer;
}

export interface JevDeps {
  client: GatewayClient;
  protocol: CheckerProtocol;
  roster: Roster;
}

export function ownershipOptions(roster: Roster, card: Card): string[] {
  const entry = roster.entries.find((e) => e.subject_id === card.claim.subject_id);
  if (entry === undefined) throw new Error(`subject ${card.claim.subject_id} is not on the roster`);
  const subjects = householdSubjects(entry.household_id, roster).map((e) => e.name);
  return [...subjects, "joint ownership", "unknown", "not stated"];
}

export function buildJevRequest(protocol: CheckerProtocol, roster: Roster, card: Card, modelInput: ModelInput): SystemOneRequest {
  const specific = ownershipOptions(roster, card);
  const fixed = protocol.jev.questions.ownership.fixed_options ?? {};
  const criteria: Record<string, string | null> = {};
  for (const name of specific) {
    criteria[name] = name in fixed ? fixed[name]! : null;
  }
  return {
    model: protocol.jev.model_id,
    state: modelInput,
    questions: {
      ownership: {
        type: "choice",
        instructions: protocol.jev.questions.ownership.instructions,
        criteria,
      },
      value_support: {
        type: "noul",
        instructions: protocol.jev.questions.value_support.instructions,
        criteria: {
          true: protocol.jev.questions.value_support.criteria?.true ?? "",
          false: protocol.jev.questions.value_support.criteria?.false ?? "",
        },
      },
      time_support: {
        type: "noul",
        instructions: protocol.jev.questions.time_support.instructions,
        criteria: {
          true: protocol.jev.questions.time_support.criteria?.true ?? "",
          false: protocol.jev.questions.time_support.criteria?.false ?? "",
        },
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJevAnswers(answers: unknown): ParsedJevAnswers | null {
  if (!isRecord(answers)) return null;
  const ownership = answers.ownership;
  const valueSupport = answers.value_support;
  const timeSupport = answers.time_support;
  if (!isRecord(ownership) || !isRecord(valueSupport) || !isRecord(timeSupport)) return null;

  if (typeof ownership.choice !== "string") return null;
  const probabilities: Record<string, number> = {};
  if (!isRecord(ownership.probabilities)) return null;
  for (const [option, probability] of Object.entries(ownership.probabilities)) {
    if (typeof probability !== "number" || !Number.isFinite(probability)) return null;
    probabilities[option] = probability;
  }

  const noulOf = (answer: Record<string, unknown>): number | null =>
    typeof answer.noul === "number" && Number.isFinite(answer.noul) ? answer.noul : null;
  const value = noulOf(valueSupport);
  const time = noulOf(timeSupport);
  if (value === null || time === null) return null;

  return {
    ownership: { choice: ownership.choice, probabilities },
    value_support: { noul: value },
    time_support: { noul: time },
  };
}

function thresholdsOf(protocol: CheckerProtocol): GateThresholds {
  return {
    noulPassAtOrAbove: protocol.decision_thresholds.noul_gate.pass_at_or_above,
    noulUnsupportedAtOrBelow: protocol.decision_thresholds.noul_gate.unsupported_at_or_below,
    ownershipPassAtOrAbove: protocol.decision_thresholds.ownership_gate.pass_at_or_above,
  };
}

function decisionFromJevAnswers(protocol: CheckerProtocol, roster: Roster, card: Card, answers: ParsedJevAnswers): CardDecision {
  const thresholds = thresholdsOf(protocol);
  const specific = ownershipOptions(roster, card).filter((name) => name !== "unknown" && name !== "not stated");
  return combineChecks({
    ownership: mapOwnership(answers.ownership, rosterNameOf(roster, card), specific, thresholds),
    value_support: mapNoul(answers.value_support.noul, thresholds),
    time_support: mapNoul(answers.time_support.noul, thresholds),
  });
}

function rosterNameOf(roster: Roster, card: Card): string {
  const entry = roster.entries.find((e) => e.subject_id === card.claim.subject_id);
  if (entry === undefined) throw new Error(`subject ${card.claim.subject_id} is not on the roster`);
  return entry.name;
}

export async function evaluateCardWithJev(deps: JevDeps, card: Card, modelInput: ModelInput): Promise<CheckerCardResult> {
  const request = buildJevRequest(deps.protocol, deps.roster, card, modelInput);

  const outcome = await runWithRetryPolicy({
    attempt: (attemptNumber) =>
      callWithBackoff(async (): Promise<AttemptOutcome> => {
        const startedAt = Date.now();
        const result = await deps.client.systemOne(request);
        const generation =
          result.generationId === null
            ? null
            : await deps.client.lookupGenerationWithPolling(result.generationId, { tries: 6, delayMs: 1_000 });
        const elapsedMs = Date.now() - startedAt;

        const usage =
          generation === null || generation.latency === null
            ? null
            : {
                latency_ms: generation.latency,
                input_tokens: generation.input_tokens ?? result.usage?.input_tokens ?? 0,
                output_tokens: generation.output_tokens ?? result.usage?.output_tokens ?? 0,
                cost:
                  result.gatewayCost !== null && result.gatewayCost !== undefined
                    ? { amount: result.gatewayCost, currency: "USD" }
                    : generation.cost !== null && generation.cost !== undefined
                      ? { amount: generation.cost, currency: "USD" }
                      : null,
              };

        const parsed = parseJevAnswers(result.answers);
        if (parsed === null) {
          return {
            status: "invalid-response",
            rawResponse: result.body,
            usage,
            elapsedMs,
            message:
              "the Jev response was missing or malformed answers for the three frozen questions; " +
              (attemptNumber === 1 ? "retrying once with the identical typed questions" : "two failed attempts"),
          };
        }
        if (usage === null) {
          return {
            status: "transport-error",
            rawResponse: result.body,
            usage: null,
            elapsedMs,
            error: {
              kind: "other" as const,
              message:
                "the generation lookup could not confirm gateway-reported usage; the answer is not recorded without it, never as a client-side estimate",
            },
          };
        }
        return { status: "parsed", answer: parsed, rawResponse: result.body, usage, elapsedMs };
      }),

  });

  const model = outcome.attempts.length > 0 ? modelFromLastAttempt(deps.protocol, outcome.attempts) : null;

  if (outcome.status === "answered" && outcome.answer !== undefined) {
    const answers = outcome.answer as ParsedJevAnswers;
    return {
      model,
      rawAnswer: rawAnswerFromAttempts(outcome.attempts),
      attempts: outcome.attempts,
      firstAttemptInvalid: outcome.firstAttemptInvalid,
      retried: outcome.retried,
      decision: decisionFromJevAnswers(deps.protocol, deps.roster, card, answers),
      error: null,
    };
  }

  return {
    model,
    rawAnswer: rawAnswerFromAttempts(outcome.attempts),
    attempts: outcome.attempts,
    firstAttemptInvalid: outcome.firstAttemptInvalid,
    retried: outcome.retried,
    decision: null,
    error: outcome.error ?? { kind: "other", message: "no usable Jev response" },
  };
}

export function rawAnswerFromAttempts(attempts: EvaluationAttempt[]): unknown {
  return attempts.length === 1 ? attempts[0]!.parsed_answer : attempts.map((attempt) => attempt.parsed_answer);
}

function modelFromLastAttempt(protocol: CheckerProtocol, attempts: EvaluationAttempt[]): CheckerCardResult["model"] {
  const last = attempts[attempts.length - 1];
  const body = last?.raw_response;
  if (!isRecord(body)) return null;
  const providerMetadata = isRecord(body.provider_metadata) ? body.provider_metadata : {};
  const gateway = isRecord(providerMetadata.gateway) ? providerMetadata.gateway : {};
  const routing = isRecord(gateway.routing) ? gateway.routing : {};
  const modelVersion = typeof body.model === "string" ? body.model : null;
  if (modelVersion === null) return null;
  const report: CheckerCardResult["model"] = {
    id: protocol.jev.model_id,
    version: modelVersion,
    provider: typeof routing.resolvedProvider === "string" ? routing.resolvedProvider : "",
  };
  if (typeof gateway.generationId === "string") report.generation_id = gateway.generationId;
  return report;
}

export function jevStateTokenEstimate(modelInput: ModelInput): number {
  return Math.ceil(JSON.stringify(modelInput).length / 4);
}

export function assertJevStateWithinCap(modelInput: ModelInput, protocol: CheckerProtocol): void {
  const estimate = jevStateTokenEstimate(modelInput);
  if (estimate > protocol.jev.state_token_cap) {
    throw new Error(
      `the model-visible input estimates at ${estimate} tokens, beyond Jev's ${protocol.jev.state_token_cap}-token state cap; ` +
        "the run fails loudly rather than truncating evidence",
    );
  }
}
