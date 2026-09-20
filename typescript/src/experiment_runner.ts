import type { CaseSet } from "./case_set_schema.ts";
import type { CheckerProtocol, ExperimentFreeze } from "./checker_protocol.ts";
import type { ArmVariant, DecisionPolicy } from "./run_record_schema.ts";
import { prepareModelInput, type ModelInput } from "./input_preparation.ts";
import type { Roster } from "./roster.ts";
import { checkValuePresence } from "./value_presence.ts";
import { sha256Of } from "./hashing.ts";
import { attemptUsageFromGeneration, GatewayClient, type GenerationInfo } from "./gateway_client.ts";
import { evaluateCardWithJev, assertJevStateWithinCap } from "./jev_checker.ts";
import { evaluateCardWithLlm } from "./llm_checker.ts";
import { EvaluationRecorder, type CheckerCardResult } from "./evaluation_recorder.ts";
import { mapLlmOverall } from "./decision_mapping.ts";
import { labeledSha256Of } from "./hashing.ts";
import type { Card } from "./case_set_schema.ts";

export interface ArmDefinition {
  name: string;
  checker: string;
  modelId: string | null;
  variant: ArmVariant;
  decisionPolicy: DecisionPolicy;
  timingRun: boolean;
}

export function scoredArms(protocol: CheckerProtocol): ArmDefinition[] {
  const modelKeys = Object.keys(protocol.llm_checkers.models);
  return [
    {
      name: "rules",
      checker: "rules",
      modelId: null,
      variant: "rules" as const,
      decisionPolicy: "value-presence" as const,
      timingRun: false,
    },
    {
      name: "jev",
      checker: "jev",
      modelId: protocol.jev.model_id,
      variant: "decomposed" as const,
      decisionPolicy: "probability-gated" as const,
      timingRun: false,
    },
    ...modelKeys.flatMap((modelKey): ArmDefinition[] => {
      const modelId = protocol.llm_checkers.models[modelKey]!;
      return [
        {
          name: `${modelKey}-overall`,
          checker: modelKey,
          modelId,
          variant: "overall" as const,
          decisionPolicy: "categorical-verdict" as const,
          timingRun: false,
        },
        {
          name: `${modelKey}-three`,
          checker: modelKey,
          modelId,
          variant: "three-question" as const,
          decisionPolicy: "categorical-verdict" as const,
          timingRun: false,
        },
      ];
    }),
  ];
}

export function timingArms(protocol: CheckerProtocol): ArmDefinition[] {
  const scored = scoredArms(protocol).filter((arm) => arm.variant !== "rules");
  return scored.map((arm) => ({ ...arm, name: `${arm.name}-verdict-only`, timingRun: true }));
}

export function allArms(protocol: CheckerProtocol): ArmDefinition[] {
  return [...scoredArms(protocol), ...timingArms(protocol)];
}

export interface RunArmParams {
  arm: ArmDefinition;
  caseSet: CaseSet;
  roster: Roster;
  protocol: CheckerProtocol;
  freeze: ExperimentFreeze;
  commit: string;
  repeatCount: number;
  outputDir: string;
  client?: GatewayClient | undefined;
  now?: (() => Date) | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
  /** Wait before polling generation lookups; the gateway ingests usage events asynchronously. */
  generationIngestionDelayMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Cards evaluated concurrently within a repeat; the protocol freezes inputs and repeats, not scheduling. */
  concurrency?: number | undefined;
}

export interface RunArmResult {
  runId: string;
  recordCount: number;
  passed: number;
  reviewed: number;
  executionErrors: number;
  inputPreparationErrors: number;
}

interface PreparedCard {
  card: Card;
  sampleIndex: number;
  input: ModelInput | null;
  inputHash: string | null;
  preparationError: string | null;
}

function evaluateCardWithRules(valuePresent: boolean): CheckerCardResult {
  const verdict = valuePresent ? ("supported" as const) : ("unsupported" as const);
  return {
    model: null,
    rawAnswer: { value_present: valuePresent },
    attempts: [],
    firstAttemptInvalid: false,
    retried: false,
    decision: mapLlmOverall(verdict),
    error: null,
  };
}

export async function runArm(params: RunArmParams): Promise<RunArmResult> {
  const { arm } = params;
  const networked = arm.variant !== "rules";
  if (networked) {
    if (params.client === undefined) {
      throw new Error(`arm ${arm.name} is networked and requires a gateway client`);
    }
    params.client.ensureAuthenticated();
  }

  const cards = [...params.caseSet.cards].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const prepared: PreparedCard[] = cards.map((card, sampleIndex) => {
    const result = prepareModelInput(card, params.caseSet, params.roster);
    if (result.ok) {
      if (arm.variant === "decomposed") assertJevStateWithinCap(result.input, params.protocol);
      return { card, sampleIndex, input: result.input, inputHash: labeledSha256Of(result.input), preparationError: null };
    }
    return { card, sampleIndex, input: null, inputHash: null, preparationError: result.error };
  });

  const inputSetSha256 = sha256Of(prepared.map((p) => ({ card_id: p.card.id, input: p.input })));
  const runDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const runId = `${arm.name}-${runDate}-${params.commit.slice(0, 7)}`;

  const recorder = new EvaluationRecorder({
    runId,
    caseSetVersion: params.freeze.caseSetVersion,
    caseSetSha256: params.freeze.caseSetSha256,
    protocolVersion: params.freeze.protocolVersion,
    protocolSha256: params.freeze.protocolSha256,
    rosterVersion: params.freeze.rosterVersion,
    rosterSha256: params.freeze.rosterSha256,
    codeCommit: params.commit,
    repeatCount: params.repeatCount,
    inputSetSha256,
    arm: {
      name: arm.name,
      checker: arm.checker,
      model_id: arm.modelId,
      variant: arm.variant,
      decision_policy: arm.decisionPolicy,
      timing_run: arm.timingRun,
    },
    outputDir: params.outputDir,
    ...(params.now !== undefined ? { now: params.now } : {}),
  });

  const valuePresence = arm.variant === "rules" ? checkValuePresence(params.caseSet) : null;
  const total = prepared.length * params.repeatCount;
  let done = 0;
  let passed = 0;
  let reviewed = 0;
  let executionErrors = 0;
  let inputPreparationErrors = 0;

  interface PendingRecord {
    sampleIndex: number;
    repeatIndex: number;
    cardId: string;
    originalClaim: (typeof prepared)[number]["card"]["claim"];
    modelInput: ModelInput | null;
    inputHash: string | null;
    result: CheckerCardResult;
  }
  const pending: PendingRecord[] = [];

  const concurrency = params.concurrency ?? 4;

  for (let repeatIndex = 0; repeatIndex < params.repeatCount; repeatIndex += 1) {
    const pendingThisRepeat: PendingRecord[] = new Array(prepared.length);

    const worker = async (p: PreparedCard, sampleIndex: number): Promise<void> => {
      let result: CheckerCardResult;
      if (p.preparationError !== null) {
        result = {
          model: null,
          attempts: [],
          firstAttemptInvalid: false,
          retried: false,
          decision: null,
          error: { kind: "input-preparation", message: p.preparationError },
        };
        inputPreparationErrors += 1;
      } else if (arm.variant === "rules") {
        result = evaluateCardWithRules(valuePresence!.get(p.card.id)?.present ?? false);
      } else if (arm.variant === "decomposed") {
        result = await evaluateCardWithJev(
          { client: params.client!, protocol: params.protocol, roster: params.roster },
          p.card,
          p.input!,
        );
      } else {
        result = await evaluateCardWithLlm(
          {
            client: params.client!,
            protocol: params.protocol,
            spec: {
              modelId: arm.modelId!,
              variant: arm.variant === "overall" ? "overall" : "three-question",
              timingRun: arm.timingRun,
            },
          },
          p.input!,
        );
      }

      pendingThisRepeat[sampleIndex] = {
        sampleIndex: p.sampleIndex,
        repeatIndex,
        cardId: p.card.id,
        originalClaim: p.card.claim,
        modelInput: p.input,
        inputHash: p.inputHash,
        result,
      };
      done += 1;
      params.onProgress?.(done, total);
    };

    let next = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(concurrency, prepared.length)) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= prepared.length) break;
        await worker(prepared[index]!, index);
      }
    });
    await Promise.all(runners);
    pending.push(...pendingThisRepeat);
  }

  if (networked) {
    const completed = await completeGenerations(pending, params.client!, {
      ingestionDelayMs: params.generationIngestionDelayMs ?? 25_000,
      sleep: params.sleep ?? ((ms) => Bun.sleep(ms)),
      onLookup: (doneLookups, totalLookups) => params.onProgress?.(done + doneLookups, totalLookups),
    });
    passed = completed.passed;
    reviewed = completed.reviewed;
    executionErrors = completed.executionErrors;
  } else {
    for (const p of pending) {
      if (p.result.error !== null && p.result.error.kind !== "input-preparation") executionErrors += 1;
      if (p.result.decision?.outcome === "pass") passed += 1;
      if (p.result.decision?.outcome === "review") reviewed += 1;
    }
  }

  for (const p of pending) {
    recorder.recordEvaluation({
      sampleIndex: p.sampleIndex,
      repeatIndex: p.repeatIndex,
      cardId: p.cardId,
      originalClaim: p.originalClaim,
      modelInput: p.modelInput,
      inputHash: p.inputHash,
      model: p.result.model,
      rawAnswer: p.result.rawAnswer,
      attempts: p.result.attempts,
      firstAttemptInvalid: p.result.firstAttemptInvalid,
      retried: p.result.retried,
      decision: p.result.decision,
      error: p.result.error,
    });
  }

  return {
    runId,
    recordCount: recorder.recordCount,
    passed,
    reviewed,
    executionErrors,
    inputPreparationErrors,
  };
}

interface CompleteGenerationsOptions {
  ingestionDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  onLookup?: (done: number, total: number) => void;
}

async function completeGenerations(
  pending: { result: CheckerCardResult }[],
  client: GatewayClient,
  options: CompleteGenerationsOptions,
): Promise<{ passed: number; reviewed: number; executionErrors: number }> {
  const ids = new Set<string>();
  for (const { result } of pending) {
    for (const attempt of result.attempts) {
      if (attempt.generation_id !== undefined && attempt.generation_id !== null) ids.add(attempt.generation_id);
    }
  }

  const lookups = new Map<string, GenerationInfo | null>();
  if (ids.size > 0) {
    await options.sleep(options.ingestionDelayMs);
    let doneLookups = 0;
    for (const id of ids) {
      lookups.set(id, await client.lookupGenerationWithPolling(id, { tries: 10, delayMs: 2_500 }));
      doneLookups += 1;
      options.onLookup?.(doneLookups, ids.size);
    }
  }

  let passed = 0;
  let reviewed = 0;
  let executionErrors = 0;

  for (const { result } of pending) {
    const lastAttempt = result.attempts[result.attempts.length - 1];
    let lastUsageMissing = false;
    for (const attempt of result.attempts) {
      const id = attempt.generation_id;
      if (id === undefined || id === null) continue;
      const info = lookups.get(id) ?? null;
      if (info === null) {
        if (attempt.error === null) {
          attempt.error = {
            kind: "other",
            message: "the generation lookup never reported usage for this call; the response is preserved but not recorded as a success",
          };
          lastUsageMissing = true;
        }
        continue;
      }
      attempt.generation = info.raw;
      const usage = attemptUsageFromGeneration(info, attempt.body_usage ?? null);
      if (usage !== null) attempt.usage = usage;
      else if (attempt.error === null) {
        attempt.error = {
          kind: "other",
          message: "the generation lookup reported no usable usage for this call; the response is preserved but not recorded as a success",
        };
        lastUsageMissing = true;
      }
    }

    if (lastUsageMissing && result.decision !== null) {
      // A successful answer without gateway-reported usage is not recorded as a pass: the schema forbids it.
      result.decision = null;
      result.error = {
        kind: "other",
        message:
          "the generation lookup never reported usage for this call; the answer is not recorded without gateway-reported usage, never as a client-side estimate",
      };
    }

    if (result.model !== null && lastAttempt?.generation !== undefined && lastAttempt?.generation !== null) {
      const model = typeof lastAttempt.generation["model"] === "string" ? lastAttempt.generation["model"] : null;
      const provider = typeof lastAttempt.generation["provider_name"] === "string" ? lastAttempt.generation["provider_name"] : null;
      if (model !== null && model.length > 0) result.model.version = model;
      if (provider !== null && provider.length > 0) result.model.provider = provider;
    } else if (
      result.model !== null &&
      (lastAttempt?.generation === undefined || lastAttempt?.generation === null) &&
      result.model.provider.length === 0
    ) {
      // No response metadata and no confirmed lookup: an incomplete model identity is not recorded.
      result.model = null;
    }

    if (result.error !== null && result.error.kind !== "input-preparation") executionErrors += 1;
    if (result.decision?.outcome === "pass") passed += 1;
    if (result.decision?.outcome === "review") reviewed += 1;
  }

  return { passed, reviewed, executionErrors };
}
