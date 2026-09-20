import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  DEFAULT_PROTOCOL_LOCK_PATH,
  DEFAULT_PROTOCOL_PATH,
  loadProtocol,
  verifyExperimentFreeze,
  type CheckerProtocol,
} from "./checker_protocol.ts";
import { DEFAULT_CASE_SET_LOCK_PATH, DEFAULT_CASE_SET_PATH, loadCaseSet } from "./case_set_schema.ts";
import { DEFAULT_ROSTER_LOCK_PATH, DEFAULT_ROSTER_PATH, loadRoster, type Roster } from "./roster.ts";
import { allArms } from "./experiment_runner.ts";
import { argValue } from "./gateway_client.ts";
import { prepareModelInput } from "./input_preparation.ts";
import { buildJevRequest } from "./jev_checker.ts";
import { buildLlmRequest } from "./llm_checker.ts";

const DEFAULT_OUTPUT = fileURLToPath(new URL("../../fixtures/experiment_v1/cost_estimate.json", import.meta.url));
const MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

const CHARS_PER_TOKEN = 4;
const OUTPUT_TOKENS_REASONED = 350;
const OUTPUT_TOKENS_VERDICT_ONLY = 15;
const OUTPUT_TOKENS_JEV = 0;

interface ModelPricing {
  input: number;
  inputCacheRead?: number;
  output: number;
}

interface GatewayModel {
  id: string;
  pricing?: Record<string, unknown>;
}

function pricingOf(models: GatewayModel[], modelId: string): ModelPricing {
  const model = models.find((m) => m.id === modelId);
  if (model?.pricing === undefined) {
    throw new Error(`the gateway models list has no pricing for ${modelId}; cannot estimate without a list price`);
  }
  const input = Number(model.pricing["input"] ?? model.pricing["prompt"]);
  const output = Number(model.pricing["output"] ?? model.pricing["completion"] ?? 0);
  if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
    throw new Error(`the gateway models list has unusable pricing for ${modelId}: ${JSON.stringify(model.pricing)}`);
  }
  return { input, output };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

async function main(): Promise<void> {
  const output = argValue("--out") ?? DEFAULT_OUTPUT;

  const freeze = verifyExperimentFreeze({
    caseSetPath: DEFAULT_CASE_SET_PATH,
    caseSetLockPath: DEFAULT_CASE_SET_LOCK_PATH,
    rosterPath: DEFAULT_ROSTER_PATH,
    rosterLockPath: DEFAULT_ROSTER_LOCK_PATH,
    protocolPath: DEFAULT_PROTOCOL_PATH,
    protocolLockPath: DEFAULT_PROTOCOL_LOCK_PATH,
  });
  const protocol: CheckerProtocol = loadProtocol(DEFAULT_PROTOCOL_PATH, DEFAULT_PROTOCOL_LOCK_PATH);
  const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
  const roster: Roster = loadRoster(DEFAULT_ROSTER_PATH, DEFAULT_ROSTER_LOCK_PATH, caseSet);

  const cards = [...caseSet.cards].sort((a, b) => (a.id < b.id ? -1 : 1));
  const inputs = cards.map((card) => {
    const result = prepareModelInput(card, caseSet, roster);
    if (!result.ok) throw new Error(result.error);
    return { card, input: result.input };
  });

  console.log(`Fetching public list pricing from ${MODELS_URL} (no credentials required)...`);
  const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    console.error(`could not fetch the gateway models list (HTTP ${response.status}); the estimate needs public list prices`);
    process.exit(1);
  }
  const body = (await response.json()) as { data?: GatewayModel[] };
  const models = body.data ?? [];

  const arms = allArms(protocol);
  const armEstimates = arms.map((arm) => {
    const scored = !arm.timingRun;
    const repeats = arm.timingRun ? protocol.repeats.timing : protocol.repeats.scored;

    let inputTokensPerCall = 0;
    let outputTokensPerCall = 0;
    const pricing = arm.modelId === null ? null : pricingOf(models, arm.modelId);

    if (arm.variant === "rules") {
      inputTokensPerCall = 0;
      outputTokensPerCall = 0;
    } else if (arm.variant === "decomposed") {
      const requests = inputs.map(({ card, input }) => buildJevRequest(protocol, roster, card, input));
      inputTokensPerCall = Math.max(...requests.map((request) => estimateTokens(JSON.stringify(request))));
      outputTokensPerCall = OUTPUT_TOKENS_JEV;
    } else {
      const requests = inputs.map(({ input }) =>
        buildLlmRequest(
          protocol,
          input,
          { modelId: arm.modelId!, variant: arm.variant === "overall" ? "overall" : "three-question", timingRun: arm.timingRun },
          1,
        ),
      );
      inputTokensPerCall = Math.max(...requests.map((request) => estimateTokens(JSON.stringify(request.messages))));
      outputTokensPerCall = arm.timingRun ? OUTPUT_TOKENS_VERDICT_ONLY : OUTPUT_TOKENS_REASONED;
    }

    const calls = cards.length * repeats;
    const expectedCost =
      pricing === null
        ? 0
        : calls * (inputTokensPerCall * pricing.input + outputTokensPerCall * pricing.output);
    // Worst case: every call fails validation once and is retried (the recorded policy allows exactly one retry).
    const worstCaseCost = pricing === null ? 0 : expectedCost * 2;

    return {
      arm: arm.name,
      model_id: arm.modelId,
      timing_run: arm.timingRun,
      repeats,
      calls,
      max_input_tokens_per_call: inputTokensPerCall,
      assumed_output_tokens_per_call: outputTokensPerCall,
      pricing_per_token_usd: pricing,
      expected_cost_usd: round(expectedCost),
      worst_case_cost_usd: round(worstCaseCost),
    };
  });

  const networkedEstimates = armEstimates.filter((estimate) => estimate.model_id !== null);
  const totalExpected = round(networkedEstimates.reduce((sum, estimate) => sum + estimate.expected_cost_usd, 0));
  const totalWorstCase = round(networkedEstimates.reduce((sum, estimate) => sum + estimate.worst_case_cost_usd, 0));

  const estimate = {
    format_version: 1,
    generated_at: new Date().toISOString(),
    protocol_version: freeze.protocolVersion,
    protocol_sha256: freeze.protocolSha256,
    case_set_version: freeze.caseSetVersion,
    method: {
      input_tokens: `characters / ${CHARS_PER_TOKEN} over the largest actual request per arm, built from the frozen inputs`,
      output_tokens: `assumed ${OUTPUT_TOKENS_REASONED} for reasoned answers, ${OUTPUT_TOKENS_VERDICT_ONLY} for verdict-only, 0 for Jev (output is free)`,
      pricing: `public list prices fetched live from ${MODELS_URL} on the generation date`,
      retry_allowance: "worst case doubles every networked call: one retry per call is the recorded policy maximum",
      not_a_promise: "an estimate for sign-off, not a spend guarantee; actual costs come back gateway-reported per call",
    },
    arms: armEstimates,
    totals: {
      networked_calls: networkedEstimates.reduce((sum, estimate) => sum + estimate.calls, 0),
      expected_cost_usd: totalExpected,
      worst_case_cost_usd: totalWorstCase,
    },
  };

  mkdirSync(join(output, ".."), { recursive: true });
  if (existsSync(output)) {
    console.error(`refusing to overwrite an earlier estimate at ${output}; estimates are frozen for sign-off`);
    process.exit(1);
  }
  writeFileSync(output, `${JSON.stringify(estimate, null, 2)}\n`);

  console.log(`Cost estimate for the checker experiment (protocol ${freeze.protocolVersion}):`);
  for (const arm of armEstimates) {
    console.log(
      `  ${arm.arm.padEnd(44)} ${String(arm.calls).padStart(4)} calls  expected $${arm.expected_cost_usd.toFixed(4)}  worst case $${arm.worst_case_cost_usd.toFixed(4)}`,
    );
  }
  console.log(`Total networked calls: ${estimate.totals.networked_calls}`);
  console.log(`Total expected: $${totalExpected.toFixed(4)}   worst case (every call retried once): $${totalWorstCase.toFixed(4)}`);
  console.log(`Estimate written to ${output}`);
}

function round(amount: number): number {
  return Math.round(amount * 1e6) / 1e6;
}

await main();
