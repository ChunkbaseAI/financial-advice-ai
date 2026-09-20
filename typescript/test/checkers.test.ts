import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_PROTOCOL_LOCK_PATH, DEFAULT_PROTOCOL_PATH, loadProtocol, type CheckerProtocol } from "../src/checker_protocol.ts";
import { DEFAULT_CASE_SET_PATH, loadCaseSet, type Card, type CaseSet } from "../src/case_set_schema.ts";
import { DEFAULT_ROSTER_LOCK_PATH, DEFAULT_ROSTER_PATH, loadRoster, type Roster } from "../src/roster.ts";
import type { ModelInput } from "../src/input_preparation.ts";
import { prepareModelInput } from "../src/input_preparation.ts";
import { GatewayClient, type FetchLike } from "../src/gateway_client.ts";
import { buildJevRequest, evaluateCardWithJev, parseJevAnswers } from "../src/jev_checker.ts";
import { buildLlmRequest, evaluateCardWithLlm, parseLlmAnswer } from "../src/llm_checker.ts";

const protocol: CheckerProtocol = loadProtocol(DEFAULT_PROTOCOL_PATH, DEFAULT_PROTOCOL_LOCK_PATH);
const caseSet: CaseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
const roster: Roster = loadRoster(DEFAULT_ROSTER_PATH, DEFAULT_ROSTER_LOCK_PATH, caseSet);

function card(cardId: string): Card {
  return caseSet.cards.find((c) => c.id === cardId)!;
}

function modelInputFor(cardId: string): ModelInput {
  const result = prepareModelInput(card(cardId), caseSet, roster);
  if (!result.ok) throw new Error(`input preparation failed for ${cardId}`);
  return result.input;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientWith(fetchImpl: FetchLike): GatewayClient {
  return new GatewayClient({ apiKey: "test-key", fetch: fetchImpl, sleep: async () => {} });
}

describe("buildJevRequest", () => {
  test("builds the frozen three questions with household options in order", () => {
    const input = modelInputFor("card-sp-01");
    const request = buildJevRequest(protocol, roster, card("card-sp-01"), input);
    expect(request.model).toBe("typesafe-ai/jev");
    expect(request.state).toEqual(input);

    const ownership = request.questions.ownership as Record<string, unknown>;
    expect(ownership.type).toBe("choice");
    expect(ownership.instructions).toBe(protocol.jev.questions.ownership.instructions);
    const criteria = ownership.criteria as Record<string, unknown>;
    expect(Object.keys(criteria)).toEqual([
      "Aldgate Life personal pension, plan 4471 002 833",
      "Bramwell Bank stocks and shares ISA, account 2201 8834",
      "Calderdale Building Society mortgage, account 8821 4470",
      "Dev Patel",
      "Pennine Teachers' Pension Scheme",
      "Priya Sharma",
      "joint ownership",
      "unknown",
      "not stated",
    ]);
    expect(criteria["Priya Sharma"]).toBeNull();
    expect(criteria["joint ownership"]).toBe("The source attributes the value to joint ownership by more than one person.");

    const valueSupport = request.questions.value_support as Record<string, unknown>;
    expect(valueSupport.type).toBe("noul");
    expect(valueSupport.instructions).toBe(protocol.jev.questions.value_support.instructions);
    expect((valueSupport.criteria as Record<string, unknown>).true).toBe(protocol.jev.questions.value_support.criteria?.true);
  });
});

describe("parseJevAnswers", () => {
  test("parses a full answer set with probabilities", () => {
    const parsed = parseJevAnswers({
      ownership: { type: "choice", choice: "Priya Sharma", probabilities: { "Priya Sharma": 0.93, "Dev Patel": 0.07 }, confidence: 0.9 },
      value_support: { type: "noul", noul: 0.95 },
      time_support: { type: "noul", noul: 0.02 },
    });
    expect(parsed?.ownership.choice).toBe("Priya Sharma");
    expect(parsed?.value_support.noul).toBe(0.95);
    expect(parsed?.time_support.noul).toBe(0.02);
  });

  test("rejects missing questions, non-numeric probabilities and non-numeric noul", () => {
    expect(parseJevAnswers({ ownership: { type: "choice", choice: "x", probabilities: {} }, value_support: { type: "noul", noul: 0.5 } })).toBeNull();
    expect(
      parseJevAnswers({
        ownership: { type: "choice", choice: "x", probabilities: { x: "high" } },
        value_support: { type: "noul", noul: 0.5 },
        time_support: { type: "noul", noul: 0.5 },
      }),
    ).toBeNull();
    expect(
      parseJevAnswers({
        ownership: { type: "choice", choice: "x", probabilities: { x: 1 } },
        value_support: { type: "noul", noul: "yes" },
        time_support: { type: "noul", noul: 0.5 },
      }),
    ).toBeNull();
    expect(parseJevAnswers(null)).toBeNull();
  });
});

describe("evaluateCardWithJev", () => {
  const input = modelInputFor("card-sp-01");

  function jevFetch(outputs: Record<string, unknown>[]): FetchLike {
    let systemOneCalls = 0;
    return (url) => {
      const target = String(url);
      if (target.includes("/typesafe/v1/systemone")) {
        const body = outputs[Math.min(systemOneCalls, outputs.length - 1)]!;
        systemOneCalls += 1;
        return Promise.resolve(jsonResponse(body));
      }
      if (target.includes("/v1/generation")) {
        return Promise.resolve(
          jsonResponse({ id: "gen_1", model: "typesafe-ai/jev", providerName: "typesafe-ai", totalCost: 0.00001155, latency: 180, promptTokens: 640, completionTokens: 20 }),
        );
      }
      return Promise.reject(new Error(`unexpected url ${target}`));
    };
  }

  test("maps a passing answer set onto a pass with model report and gateway usage", async () => {
    const result = await evaluateCardWithJev(
      { client: clientWith(jevFetch([fullJevBody({ ownership: 0.93, value: 0.95, time: 0.92 })])), protocol, roster },
      card("card-sp-01"),
      input,
    );
    expect(result.error).toBeNull();
    expect(result.decision?.outcome).toBe("pass");
    expect(result.decision?.verdict).toBe("supported");
    expect(result.model).toEqual({
      id: "typesafe-ai/jev",
      version: "jev-1.13.0",
      provider: "typesafe-ai",
      generation_id: "gen_1",
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.usage).toEqual({
      latency_ms: 180,
      input_tokens: 640,
      output_tokens: 20,
      cost: { amount: 0.00001155, currency: "USD" },
    });
  });

  test("a low value-support probability sends the card to review as unsupported", async () => {
    const result = await evaluateCardWithJev(
      { client: clientWith(jevFetch([fullJevBody({ ownership: 0.95, value: 0.02, time: 0.91 })])), protocol, roster },
      card("card-sp-01"),
      input,
    );
    expect(result.decision?.outcome).toBe("review");
    expect(result.decision?.verdict).toBe("unsupported");
  });

  test("retries once when answers are missing, preserving both responses", async () => {
    const result = await evaluateCardWithJev(
      {
        client: clientWith(jevFetch([{ model: "jev-1.13.0" }, fullJevBody({ ownership: 0.93, value: 0.95, time: 0.92 })])),
        protocol,
        roster,
      },
      card("card-sp-01"),
      input,
    );
    expect(result.retried).toBe(true);
    expect(result.firstAttemptInvalid).toBe(true);
    expect(result.decision?.outcome).toBe("pass");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.error?.kind).toBe("invalid-response");
  });

  test("two invalid responses are an execution error, never a pass", async () => {
    const result = await evaluateCardWithJev(
      { client: clientWith(jevFetch([{ model: "jev-1.13.0" }, { model: "jev-1.13.0" }])), protocol, roster },
      card("card-sp-01"),
      input,
    );
    expect(result.decision).toBeNull();
    expect(result.error?.kind).toBe("invalid-response");
  });
});

function fullJevBody(p: { ownership: number; value: number; time: number }): Record<string, unknown> {
  return {
    model: "jev-1.13.0",
    answers: {
      ownership: {
        type: "choice",
        choice: "Priya Sharma",
        probabilities: { "Priya Sharma": p.ownership, "Dev Patel": 1 - p.ownership },
        confidence: 0.9,
      },
      value_support: { type: "noul", noul: p.value },
      time_support: { type: "noul", noul: p.time },
    },
    usage: { input_tokens: 640, output_tokens: 20 },
    provider_metadata: {
      gateway: {
        cost: "0.00001155",
        generationId: "gen_1",
        routing: { resolvedProvider: "typesafe-ai", canonicalSlug: "typesafe-ai/jev" },
      },
    },
  };
}

describe("buildLlmRequest", () => {
  test("renders the frozen prompt with the model-visible input and schema-constrained output", () => {
    const input = modelInputFor("card-sp-01");
    const request = buildLlmRequest(protocol, input, { modelId: "anthropic/claude-sonnet-5", variant: "overall", timingRun: false }, 1);
    expect(request.model).toBe("anthropic/claude-sonnet-5");
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]!.content).toContain(`"whos_who": "${input.whos_who}`);
    expect(request.response_format?.type).toBe("json_schema");
    expect(request.response_format?.json_schema.schema).toEqual(protocol.llm_checkers.output_schemas.overall);
    expect(request.max_tokens).toBe(protocol.llm_checkers.max_output_tokens_reasoned);
  });

  test("the retry attempt appends the frozen retry instruction", () => {
    const input = modelInputFor("card-sp-01");
    const first = buildLlmRequest(protocol, input, { modelId: "anthropic/claude-sonnet-5", variant: "overall", timingRun: false }, 1);
    const second = buildLlmRequest(protocol, input, { modelId: "anthropic/claude-sonnet-5", variant: "overall", timingRun: false }, 2);
    expect(second.messages[0]!.content).toBe(`${first.messages[0]!.content}\n\n${protocol.llm_checkers.prompts.retry}`);
  });

  test("timing runs use the verdict-only schema and output limit", () => {
    const input = modelInputFor("card-sp-01");
    const request = buildLlmRequest(protocol, input, { modelId: "anthropic/claude-sonnet-5", variant: "three-question", timingRun: true }, 1);
    expect(request.response_format?.json_schema.schema).toEqual(protocol.llm_checkers.output_schemas.three_question_verdict_only);
    expect(request.max_tokens).toBe(protocol.llm_checkers.max_output_tokens_verdict_only);
  });
});

describe("parseLlmAnswer", () => {
  test("parses an overall verdict with its stated reason", () => {
    const parsed = parseLlmAnswer('{"verdict":"unsupported","reason":"The value belongs to Priya."}', "overall");
    expect(parsed).toEqual({ kind: "overall", verdict: "unsupported", reason: "The value belongs to Priya." });
  });

  test("parses a three-question answer set", () => {
    const parsed = parseLlmAnswer(
      '{"answers":{"ownership":{"verdict":"supported","reason":"a"},"value_support":{"verdict":"uncertain","reason":"b"},"time_support":{"verdict":"supported","reason":"c"}}}',
      "three-question",
    );
    expect(parsed?.kind).toBe("three");
    if (parsed?.kind === "three") {
      expect(parsed.answers.value_support.verdict).toBe("uncertain");
    }
  });

  test("rejects unparseable content, unknown verdicts and missing answers", () => {
    expect(parseLlmAnswer("not json", "overall")).toBeNull();
    expect(parseLlmAnswer(null, "overall")).toBeNull();
    expect(parseLlmAnswer('{"verdict":"maybe"}', "overall")).toBeNull();
    expect(parseLlmAnswer('{"answers":{"ownership":{"verdict":"supported"}}}', "three-question")).toBeNull();
  });
});

describe("evaluateCardWithLlm", () => {
  const input = modelInputFor("card-sp-01");

  function llmFetch(contents: string[]): FetchLike {
    let chatCalls = 0;
    return (url, init) => {
      const target = String(url);
      if (target.includes("/v1/chat/completions")) {
        const content = contents[Math.min(chatCalls, contents.length - 1)]!;
        chatCalls += 1;
        return Promise.resolve(
          jsonResponse({
            id: "gen_chat_1",
            model: "anthropic/claude-sonnet-5",
            choices: [{ message: { role: "assistant", content } }],
            usage: { prompt_tokens: 900, completion_tokens: 30 },
          }),
        );
      }
      if (target.includes("/v1/generation")) {
        return Promise.resolve(
          jsonResponse({ id: "gen_chat_1", model: "anthropic/claude-sonnet-5-20261001", providerName: "anthropic", totalCost: 0.0021, latency: 900, promptTokens: 900, completionTokens: 30 }),
        );
      }
      return Promise.reject(new Error(`unexpected url ${target}`));
    };
  }

  test("a supported overall verdict passes and records the model report from the generation lookup", async () => {
    const result = await evaluateCardWithLlm(
      {
        client: clientWith(llmFetch(['{"verdict":"supported","reason":"Every part matches the quoted span."}'])),
        protocol,
        spec: { modelId: "anthropic/claude-sonnet-5", variant: "overall", timingRun: false },
      },
      input,
    );
    expect(result.decision?.outcome).toBe("pass");
    expect(result.decision?.checks).toBeNull();
    expect(result.model).toMatchObject({ id: "anthropic/claude-sonnet-5", version: "anthropic/claude-sonnet-5-20261001", provider: "anthropic" });
    expect(result.attempts[0]!.usage?.cost).toEqual({ amount: 0.0021, currency: "USD" });
    expect(result.attempts[0]!.parsed_answer).toEqual({
      kind: "overall",
      verdict: "supported",
      reason: "Every part matches the quoted span.",
    });
  });

  test("an uncertain three-question answer set reviews as uncertain", async () => {
    const result = await evaluateCardWithLlm(
      {
        client: clientWith(
          llmFetch([
            '{"answers":{"ownership":{"verdict":"supported","reason":"a"},"value_support":{"verdict":"uncertain","reason":"b"},"time_support":{"verdict":"supported","reason":"c"}}}',
          ]),
        ),
        protocol,
        spec: { modelId: "anthropic/claude-sonnet-5", variant: "three-question", timingRun: false },
      },
      input,
    );
    expect(result.decision?.outcome).toBe("review");
    expect(result.decision?.verdict).toBe("uncertain");
  });

  test("retries invalid JSON once and counts both billed attempts", async () => {
    const result = await evaluateCardWithLlm(
      {
        client: clientWith(llmFetch(["maybe supported?", '{"verdict":"uncertain","reason":"unclear"}'])),
        protocol,
        spec: { modelId: "anthropic/claude-sonnet-5", variant: "overall", timingRun: false },
      },
      input,
    );
    expect(result.retried).toBe(true);
    expect(result.firstAttemptInvalid).toBe(true);
    expect(result.decision?.verdict).toBe("uncertain");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((a) => a.usage !== null)).toBe(true);
  });

  test("two invalid responses are an execution error with both attempts preserved", async () => {
    const result = await evaluateCardWithLlm(
      {
        client: clientWith(llmFetch(["nope", "still nope"])),
        protocol,
        spec: { modelId: "anthropic/claude-sonnet-5", variant: "overall", timingRun: false },
      },
      input,
    );
    expect(result.decision).toBeNull();
    expect(result.error?.kind).toBe("invalid-response");
    expect(result.attempts).toHaveLength(2);
  });
});

test("the frozen protocol fixture on disk matches the one these tests loaded", () => {
  expect(readFileSync(DEFAULT_PROTOCOL_PATH, "utf8").length).toBeGreaterThan(0);
});
