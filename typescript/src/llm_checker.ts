import type { CheckName, CheckerProtocol, LlmVerdict } from "./checker_protocol.ts";
import type { ModelInput } from "./input_preparation.ts";
import { mapCategoricalVerdict, mapLlmThree, type CardDecision } from "./decision_mapping.ts";
import { GatewayClient, gatewayRoutingOf, isRecord, type ChatCompletionRequest } from "./gateway_client.ts";
import { callWithBackoff } from "./gateway_backoff.ts";
import { runWithRetryPolicy, type AttemptOutcome } from "./retry_policy.ts";
import type { CheckerCardResult } from "./evaluation_recorder.ts";
import type { ModelReport } from "./run_record_schema.ts";

export type LlmVariant = "overall" | "three-question";

export interface LlmArmSpec {
  modelId: string;
  variant: LlmVariant;
  timingRun: boolean;
}

export interface LlmDeps {
  client: GatewayClient;
  protocol: CheckerProtocol;
  spec: LlmArmSpec;
}

export type ParsedLlmAnswer =
  | { kind: "overall"; verdict: LlmVerdict; reason: string | null }
  | { kind: "three"; answers: Record<CheckName, { verdict: LlmVerdict; reason: string | null }> };

const VERDICTS: readonly string[] = ["supported", "unsupported", "uncertain"];

function verdictOf(value: unknown): LlmVerdict | null {
  return typeof value === "string" && VERDICTS.includes(value) ? (value as LlmVerdict) : null;
}

export function parseLlmAnswer(content: string | null, variant: LlmVariant): ParsedLlmAnswer | null {
  if (content === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  if (variant === "overall") {
    const verdict = verdictOf(parsed.verdict);
    if (verdict === null) return null;
    const reason = typeof parsed.reason === "string" ? parsed.reason : null;
    return { kind: "overall", verdict, reason };
  }

  const answers = parsed.answers;
  if (!isRecord(answers)) return null;
  const mapped: Partial<Record<CheckName, { verdict: LlmVerdict; reason: string | null }>> = {};
  for (const name of ["ownership", "value_support", "time_support"] as const) {
    const answer = answers[name];
    if (!isRecord(answer)) return null;
    const verdict = verdictOf(answer.verdict);
    if (verdict === null) return null;
    mapped[name] = { verdict, reason: typeof answer.reason === "string" ? answer.reason : null };
  }
  return { kind: "three", answers: mapped as Record<CheckName, { verdict: LlmVerdict; reason: string | null }> };
}

export function buildLlmRequest(
  protocol: CheckerProtocol,
  modelInput: ModelInput,
  spec: LlmArmSpec,
  attemptNumber: number,
): ChatCompletionRequest {
  const prompts = protocol.llm_checkers.prompts;
  const template = spec.variant === "overall" ? prompts.overall : prompts.three_question;
  const inputJson = JSON.stringify(modelInput, null, 2);
  let content = template.split(prompts.input_placeholder).join(inputJson);
  if (attemptNumber > 1) {
    content = `${content}\n\n${prompts.retry}`;
  }

  const schemas = protocol.llm_checkers.output_schemas;
  const schemaKey =
    spec.variant === "overall"
      ? spec.timingRun
        ? "overall_verdict_only"
        : "overall"
      : spec.timingRun
        ? "three_question_verdict_only"
        : "three_question";
  const name = spec.variant === "overall" ? "checker_verdict" : "checker_three_answers";

  return {
    model: spec.modelId,
    messages: [{ role: "user", content }],
    response_format: {
      type: "json_schema",
      json_schema: { name, schema: schemas[schemaKey], strict: true },
    },
    max_tokens: spec.timingRun
      ? protocol.llm_checkers.max_output_tokens_verdict_only
      : protocol.llm_checkers.max_output_tokens_reasoned,
  };
}

function decisionFromParsedAnswer(parsed: ParsedLlmAnswer): CardDecision {
  if (parsed.kind === "overall") return mapCategoricalVerdict(parsed.verdict);
  return mapLlmThree({
    ownership: parsed.answers.ownership.verdict,
    value_support: parsed.answers.value_support.verdict,
    time_support: parsed.answers.time_support.verdict,
  });
}

function modelReportFromResponse(spec: LlmArmSpec, attempts: CheckerCardResult["attempts"]): ModelReport | null {
  const last = attempts[attempts.length - 1];
  const body = last?.raw_response;
  if (!isRecord(body) || typeof body.model !== "string" || body.model.length === 0) return null;
  const provider = providerFromAttempt(last);
  if (provider.length > 0) return { id: spec.modelId, version: body.model, provider };
  // Some providers' response bodies carry no gateway routing metadata; the model id's
  // creator prefix is the fallback until the generation lookup reports the provider.
  const creator = spec.modelId.split("/")[0] ?? "";
  if (creator.length === 0) return null;
  return { id: spec.modelId, version: body.model, provider: creator };
}

function providerFromAttempt(attempt: { raw_response: unknown } | undefined): string {
  if (!attempt) return "";
  const routing = gatewayRoutingOf(attempt.raw_response);
  return typeof routing.resolvedProvider === "string" ? routing.resolvedProvider : "";
}

export async function evaluateCardWithLlm(deps: LlmDeps, modelInput: ModelInput): Promise<CheckerCardResult> {
  const outcome = await runWithRetryPolicy({
    attempt: (attemptNumber) =>
      callWithBackoff(async (): Promise<AttemptOutcome> => {
        const request = buildLlmRequest(deps.protocol, modelInput, deps.spec, attemptNumber);
        const startedAt = Date.now();
        const result = await deps.client.chatCompletion(request);
        const elapsedMs = Date.now() - startedAt;

        const evidence = {
          generationId: result.generationId,
          bodyUsage: result.usage,
        };

        const parsed = parseLlmAnswer(result.content, deps.spec.variant);
        if (parsed === null) {
          return {
            status: "invalid-response",
            rawResponse: result.body,
            usage: null,
            elapsedMs,
            message:
              "the model's response was not valid JSON matching the required schema; " +
              (attemptNumber === 1 ? "retrying once with the frozen retry instruction" : "two failed attempts"),
            ...evidence,
          };
        }
        return { status: "parsed", answer: parsed, rawResponse: result.body, usage: null, elapsedMs, ...evidence };
      }),
  });

  if (outcome.status === "answered" && outcome.answer !== undefined) {
    const parsed = outcome.answer as ParsedLlmAnswer;
    return {
      model: modelReportFromResponse(deps.spec, outcome.attempts),
      rawAnswer: outcome.attempts.length === 1 ? parsed : outcome.attempts.map((a) => a.parsed_answer),
      attempts: outcome.attempts,
      firstAttemptInvalid: outcome.firstAttemptInvalid,
      retried: outcome.retried,
      decision: decisionFromParsedAnswer(parsed),
      error: null,
    };
  }

  return {
    model: modelReportFromResponse(deps.spec, outcome.attempts),
    rawAnswer: outcome.attempts.map((a) => a.parsed_answer),
    attempts: outcome.attempts,
    firstAttemptInvalid: outcome.firstAttemptInvalid,
    retried: outcome.retried,
    decision: null,
    error: outcome.error ?? { kind: "other", message: "no usable model response" },
  };
}
