import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateEvaluationManifest,
  validateEvaluationRecord,
  type EvaluationManifest,
  type EvaluationRecord,
} from "./run_record_schema.ts";
import { CATEGORIES, isRecord, type Category, type CaseSet, type ExpectedVerdict } from "./case_set_schema.ts";
import { VALUE_PRESENCE_PASS_CATEGORIES } from "./value_presence.ts";

export interface ScoredCard {
  id: string;
  category: Category;
  expected: ExpectedVerdict;
  valuePresent: boolean;
}

export function scoredCardsFromCaseSet(caseSet: CaseSet): ScoredCard[] {
  return caseSet.cards.map((card) => ({
    id: card.id,
    category: card.category,
    expected: card.expected_verdict,
    valuePresent: VALUE_PRESENCE_PASS_CATEGORIES.has(card.category),
  }));
}

export interface CategoryCount {
  total: number;
  caught?: number;
  passed?: number;
  flagged?: number;
}

export interface RepeatScore {
  index: number;
  evaluated: number;
  executionErrors: number;
  inputPreparationErrors: number;
  dangerousPasses: number;
  nuisanceFlags: number;
  byCategory: Record<Category, CategoryCount>;
}

export interface RangeStat {
  median: number;
  min: number;
  max: number;
}

export interface CountWithCards {
  count: number;
  denominator: number;
  cards: string[];
}

export interface ArmSummary {
  dangerousPasses: RangeStat;
  nuisanceFlags: RangeStat;
  actionFlips: CountWithCards;
  verdictChanges: CountWithCards;
  cardsWithAllRepeats: number;
  incompleteCards: string[];
  executionErrors: number;
  inputPreparationErrors: number;
  structuredOutputFirstAttemptFailures: number;
  structuredOutputRemainingAfterRetry: number;
  totalCost: number;
  costPerCardEvaluation: number;
  costPerRun: number;
  /** Gateway-reported list-price cost (market_cost) summed from generation lookups; what the calls would cost at list price. */
  marketCostTotal: number;
  marketCostPerCardEvaluation: number;
  latencyMedianMs: number | null;
  latencyP95Ms: number | null;
  latencySamples: number;
}

export interface FailureEntry {
  kind: "dangerous-pass" | "nuisance-flag" | "execution-error";
  cardId: string;
  repeat: number;
  category: Category;
  expected: ExpectedVerdict;
  claim: string;
  quote: string;
}

export interface CalibrationBand {
  label: string;
  count: number;
  observedTrueRate: number | null;
  meanProbability: number | null;
}

export interface Calibration {
  question: "value_support";
  groundTruth: "value-presence property of the frozen case set";
  bands: CalibrationBand[];
}

export interface ScoredRun {
  armName: string;
  checker: string;
  scored: boolean;
  timingRun: boolean;
  manifest: EvaluationManifest;
  records: EvaluationRecord[];
  repeats: RepeatScore[];
  summary: ArmSummary;
  failures: FailureEntry[];
  calibration: Calibration | null;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(0.95 * sorted.length));
  return sorted[rank - 1]!;
}

function rangeStat(values: number[]): RangeStat {
  if (values.length === 0) return { median: 0, min: 0, max: 0 };
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

function roundCost(amount: number): number {
  return Math.round(amount * 1e12) / 1e12;
}

function quoteOf(record: EvaluationRecord): string {
  const parsed = record.attempts[record.attempts.length - 1]?.parsed_answer;
  const reasons: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") return;
    if (!isRecord(value) && !Array.isArray(value)) return;
    if (isRecord(value) && typeof value.reason === "string") reasons.push(value.reason);
    for (const child of Object.values(value)) walk(child);
  };
  walk(parsed);
  if (reasons.length > 0) return reasons.join(" | ");
  return parsed === null || parsed === undefined ? "(no parsed answer)" : JSON.stringify(parsed);
}

function executionQuoteOf(record: EvaluationRecord): string {
  for (const attempt of [...record.attempts].reverse()) {
    const raw = attempt.raw_response;
    if (!isRecord(raw)) continue;
    const choices = Array.isArray(raw.choices) ? raw.choices : [];
    const first = isRecord(choices[0]) ? choices[0] : {};
    const message = isRecord(first.message) ? first.message : {};
    if (typeof message.content === "string" && message.content.length > 0) {
      const finish = typeof first.finish_reason === "string" ? ` (finish_reason: ${first.finish_reason})` : "";
      return `${record.error?.message ?? "execution error"}${finish}; last preserved response began: ${message.content.slice(0, 160)}`;
    }
  }
  return record.error?.message ?? "execution error";
}

function claimOf(record: EvaluationRecord): string {
  const input = record.model_input;
  if (!isRecord(input) || !isRecord(input.claim)) return JSON.stringify(record.original_claim);
  return [
    `subject: ${String(input.claim.subject)}`,
    `field: ${String(input.claim.field)}`,
    `value: ${String(input.claim.value)} ${String(input.claim.unit)}`,
    `basis: ${String(input.claim.period_or_basis)}`,
    `as of: ${String(input.claim.as_of)}`,
  ].join("; ");
}

export function scoreArmRun(runDir: string, cards: ScoredCard[]): ScoredRun {
  const manifestRaw: unknown = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  const manifestViolations = validateEvaluationManifest(manifestRaw);
  if (manifestViolations.length > 0) {
    throw new Error(`manifest in ${runDir} failed validation:\n- ${manifestViolations.join("\n- ")}`);
  }
  const manifest = manifestRaw as EvaluationManifest;

  const records = readFileSync(join(runDir, "records.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      const violations = validateEvaluationRecord(parsed);
      if (violations.length > 0) {
        throw new Error(`record in ${runDir} failed validation:\n- ${violations.join("\n- ")}`);
      }
      return parsed as EvaluationRecord;
    });

  const cardById = new Map(cards.map((card) => [card.id, card]));
  const repeatCount = manifest.repeat_count;
  const timingRun = manifest.arm.timing_run;

  const repeats: RepeatScore[] = [];
  for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
    const byCategory: Record<Category, CategoryCount> = {} as Record<Category, CategoryCount>;
    for (const category of CATEGORIES) {
      const total = cards.filter((card) => card.category === category).length;
      byCategory[category] = category === "correct" ? { total, passed: 0, flagged: 0 } : { total, caught: 0 };
    }
    let evaluated = 0;
    let executionErrors = 0;
    let inputPreparationErrors = 0;
    let dangerousPasses = 0;
    let nuisanceFlags = 0;

    for (const record of records.filter((r) => r.repeat_index === repeatIndex)) {
      const card = cardById.get(record.card_id);
      if (card === undefined) throw new Error(`record references unknown card ${record.card_id} in ${runDir}`);
      if (record.error !== null) {
        if (record.error.kind === "input-preparation") inputPreparationErrors += 1;
        else executionErrors += 1;
        continue;
      }
      evaluated += 1;
      const outcome = record.decision?.outcome;
      if (card.category === "correct") {
        if (outcome === "pass") byCategory[card.category].passed! += 1;
        else {
          byCategory[card.category].flagged! += 1;
          nuisanceFlags += 1;
        }
      } else if (outcome === "pass") {
        dangerousPasses += 1;
      } else {
        byCategory[card.category].caught! += 1;
      }
    }

    repeats.push({ index: repeatIndex, evaluated, executionErrors, inputPreparationErrors, dangerousPasses, nuisanceFlags, byCategory });
  }

  const validByCard = new Map<string, EvaluationRecord[]>();
  for (const card of cards) {
    validByCard.set(
      card.id,
      records.filter((r) => r.card_id === card.id && r.error === null && r.decision !== null),
    );
  }
  const cardsWithAllRepeats = cards.filter((card) => (validByCard.get(card.id)?.length ?? 0) >= repeatCount).length;
  const incompleteCards = cards.filter((card) => (validByCard.get(card.id)?.length ?? 0) < repeatCount).map((card) => card.id);

  const flipCards: string[] = [];
  const verdictChangeCards: string[] = [];
  for (const card of cards) {
    const valid = validByCard.get(card.id) ?? [];
    if (valid.length < repeatCount) continue;
    const outcomes = new Set(valid.map((r) => r.decision!.outcome));
    if (outcomes.size > 1) {
      flipCards.push(card.id);
      continue;
    }
    const reviewReasons = new Set(valid.filter((r) => r.decision!.outcome === "review").map((r) => r.decision!.review_reason));
    if (reviewReasons.size > 1) verdictChangeCards.push(card.id);
  }

  const structuredOutputFirstAttemptFailures = records.filter((r) => r.first_attempt_invalid).length;
  const structuredOutputRemainingAfterRetry = records.filter(
    (r) => r.first_attempt_invalid && r.retried && (r.error === null || r.error === undefined ? false : r.error.kind === "invalid-response"),
  ).length;

  const costs = records.flatMap((r) => (r.usage?.cost !== null && r.usage?.cost !== undefined ? [r.usage.cost.amount] : []));
  const totalCost = roundCost(costs.reduce((sum, amount) => sum + amount, 0));
  const cardSlots = cards.length * repeatCount;
  const costPerCardEvaluation = cardSlots === 0 ? 0 : roundCost(totalCost / cardSlots);
  const costPerRun = repeatCount === 0 ? 0 : roundCost(totalCost / repeatCount);

  const marketCosts = records.map((r) => {
    const attemptCosts = r.attempts
      .map((attempt) => {
        const market = attempt.generation?.["market_cost"];
        return typeof market === "number" && Number.isFinite(market) ? market : null;
      })
      .filter((market): market is number => market !== null);
    return attemptCosts.length === 0 ? null : attemptCosts.reduce((sum, market) => sum + market, 0);
  }).filter((market): market is number => market !== null);
  const marketCostTotal = roundCost(marketCosts.reduce((sum, market) => sum + market, 0));
  const marketCostPerCardEvaluation = cardSlots === 0 ? 0 : roundCost(marketCostTotal / cardSlots);

  const latencies = records.flatMap((r) => (r.usage !== null ? [r.usage.latency_ms] : []));

  const dangerousValues = repeats.map((r) => r.dangerousPasses);
  const nuisanceValues = repeats.map((r) => r.nuisanceFlags);

  const failures: FailureEntry[] = [];
  const dangerousPassCards = cards
    .filter((card) => card.expected === "unsupported")
    .flatMap((card) =>
      (validByCard.get(card.id) ?? [])
        .filter((r) => r.decision!.outcome === "pass")
        .map((r) => ({ card, record: r })),
    )
    .sort((a, b) => (a.card.id === b.card.id ? a.record.repeat_index - b.record.repeat_index : a.card.id < b.card.id ? -1 : 1));
  const seenDangerous = new Set<string>();
  for (const { card, record } of dangerousPassCards) {
    if (seenDangerous.has(card.id)) continue;
    seenDangerous.add(card.id);
    failures.push({
      kind: "dangerous-pass",
      cardId: card.id,
      repeat: record.repeat_index,
      category: card.category,
      expected: card.expected,
      claim: claimOf(record),
      quote: quoteOf(record),
    });
  }
  const executionErrors = records
    .filter((r) => r.error !== null && r.error.kind !== "input-preparation")
    .sort((a, b) => (a.card_id === b.card_id ? a.repeat_index - b.repeat_index : a.card_id < b.card_id ? -1 : 1));
  const seenExecution = new Set<string>();
  for (const record of executionErrors) {
    if (seenExecution.has(record.card_id)) continue;
    seenExecution.add(record.card_id);
    failures.push({
      kind: "execution-error",
      cardId: record.card_id,
      repeat: record.repeat_index,
      category: cardById.get(record.card_id)?.category ?? "correct",
      expected: cardById.get(record.card_id)?.expected ?? "supported",
      claim: claimOf(record),
      quote: executionQuoteOf(record),
    });
  }
  const nuisanceCards = cards
    .filter((card) => card.expected === "supported")
    .flatMap((card) =>
      (validByCard.get(card.id) ?? [])
        .filter((r) => r.decision!.outcome === "review")
        .map((r) => ({ card, record: r })),
    )
    .sort((a, b) => (a.card.id === b.card.id ? a.record.repeat_index - b.record.repeat_index : a.card.id < b.card.id ? -1 : 1));
  const seenNuisance = new Set<string>();
  for (const { card, record } of nuisanceCards) {
    if (seenNuisance.has(card.id)) continue;
    seenNuisance.add(card.id);
    failures.push({
      kind: "nuisance-flag",
      cardId: card.id,
      repeat: record.repeat_index,
      category: card.category,
      expected: card.expected,
      claim: claimOf(record),
      quote: quoteOf(record),
    });
  }

  const summary: ArmSummary = {
    dangerousPasses: rangeStat(dangerousValues),
    nuisanceFlags: rangeStat(nuisanceValues),
    actionFlips: { count: flipCards.length, denominator: cardsWithAllRepeats, cards: flipCards },
    verdictChanges: { count: verdictChangeCards.length, denominator: cardsWithAllRepeats, cards: verdictChangeCards },
    cardsWithAllRepeats,
    incompleteCards,
    executionErrors: repeats.reduce((sum, r) => sum + r.executionErrors, 0),
    inputPreparationErrors: repeats.reduce((sum, r) => sum + r.inputPreparationErrors, 0),
    structuredOutputFirstAttemptFailures,
    structuredOutputRemainingAfterRetry,
    totalCost,
    costPerCardEvaluation,
    costPerRun,
    marketCostTotal,
    marketCostPerCardEvaluation,
    latencyMedianMs: latencies.length === 0 ? null : median(latencies),
    latencyP95Ms: percentile95(latencies),
    latencySamples: latencies.length,
  };

  return {
    armName: manifest.arm.name,
    checker: manifest.arm.checker,
    scored: !timingRun,
    timingRun,
    manifest,
    records,
    repeats,
    summary,
    failures,
    calibration: manifest.arm.variant === "decomposed" ? calibrationFor(records, cards) : null,
  };
}

const CALIBRATION_BANDS: { label: string; contains: (p: number) => boolean }[] = [
  { label: "0.90 - 1.00", contains: (p) => p >= 0.9 },
  { label: "0.50 - 0.90", contains: (p) => p < 0.9 && p > 0.5 },
  { label: "0.10 - 0.50", contains: (p) => p <= 0.5 && p > 0.1 },
  { label: "0.00 - 0.10", contains: (p) => p <= 0.1 },
];

function calibrationFor(records: EvaluationRecord[], cards: ScoredCard[]): Calibration | null {
  const truthById = new Map(cards.map((card) => [card.id, card.valuePresent]));
  const samples: { probability: number; truth: boolean }[] = [];
  for (const record of records) {
    if (record.decision === null || record.decision.checks === null) continue;
    const parsed = record.attempts[record.attempts.length - 1]?.parsed_answer;
    if (!isRecord(parsed)) continue;
    const valueSupport = parsed.value_support;
    if (!isRecord(valueSupport) || typeof valueSupport.noul !== "number") continue;
    const truth = truthById.get(record.card_id);
    if (truth === undefined) continue;
    samples.push({ probability: valueSupport.noul, truth });
  }
  if (samples.length === 0) return null;
  const bands = CALIBRATION_BANDS.map((band) => {
    const inBand = samples.filter((s) => band.contains(s.probability));
    return {
      label: band.label,
      count: inBand.length,
      observedTrueRate: inBand.length === 0 ? null : roundCost(inBand.filter((s) => s.truth).length / inBand.length),
      meanProbability: inBand.length === 0 ? null : roundCost(inBand.reduce((sum, s) => sum + s.probability, 0) / inBand.length),
    };
  });
  return {
    question: "value_support",
    groundTruth: "value-presence property of the frozen case set",
    bands,
  };
}
