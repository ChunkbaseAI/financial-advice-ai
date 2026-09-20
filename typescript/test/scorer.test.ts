import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreArmRun, type ScoredRun } from "../src/scorer.ts";
import type { Category, Claim, ExpectedVerdict } from "../src/case_set_schema.ts";
import type { EvaluationManifest, EvaluationRecord } from "../src/run_record_schema.ts";
import { canonicalJson } from "../src/hashing.ts";

const HEX_64 = "a".repeat(64);
const COMMIT = "f".repeat(40);

const CARDS: { id: string; category: Category; expected: ExpectedVerdict; valuePresent: boolean }[] = [
  { id: "card-t-01", category: "correct", expected: "supported", valuePresent: true },
  { id: "card-t-02", category: "wrong-subject", expected: "unsupported", valuePresent: true },
  { id: "card-t-03", category: "unsupported", expected: "unsupported", valuePresent: false },
];

const CLAIM: Claim = {
  subject_id: "sub-t-plan",
  field: "pension.plan-value",
  value: 45250,
  unit: "GBP",
  period_or_basis: "plan value as at 1 April 2026",
  as_of: "2026-04-01",
};

const MODEL_INPUT = {
  whos_who: "People in this household: Alex Field; Bea Field.",
  claim: { subject: "Test plan", field: "pension.plan-value", value: "45,250", unit: "GBP", period_or_basis: "x", as_of: "2026-04-01" },
  evidence: [{ artifact: "art-t-statement", lines: "1-1", quote: "Plan value as at 1 April 2026: £45,250" }],
};

function manifest(timingRun = false): EvaluationManifest {
  return {
    format_version: 2,
    run_id: "test-arm-20260920-fffffff",
    created_at: "2026-09-20T10:00:00.000Z",
    case_set_version: "1.0.0",
    case_set_sha256: HEX_64,
    protocol_version: "0.1.0",
    protocol_sha256: HEX_64,
    roster_version: "1.0.0",
    roster_sha256: HEX_64,
    code_commit: COMMIT,
    repeat_count: 3,
    input_set_sha256: "b".repeat(64),
    checkers: [timingRun ? "test-arm-verdict-only" : "test-arm"],
    arm: {
      name: timingRun ? "test-arm-verdict-only" : "test-arm",
      checker: "claude-sonnet-5",
      model_id: "anthropic/claude-sonnet-5",
      variant: "overall",
      decision_policy: "categorical-verdict",
      timing_run: timingRun,
    },
  };
}

interface RecordSpec {
  cardId: string;
  repeat: number;
  outcome: "pass" | "review";
  reviewReason?: "unsupported" | "uncertain" | "mismatch" | null;
  latency: number;
  cost: number;
  firstAttemptInvalid?: boolean;
  retried?: boolean;
}

function record(spec: RecordSpec): EvaluationRecord {
  const built = buildRecord(spec);
  if (spec.firstAttemptInvalid) {
    const base = built.attempts[0]!;
    built.attempts = [
      { ...base, index: 1, parsed_answer: null, raw_response: "not json", error: { kind: "invalid-response", message: "unparseable" } },
      { ...base, index: 2 },
    ];
    built.retried = true;
  }
  return built;
}

function buildRecord(spec: RecordSpec): EvaluationRecord {
  const cardIndex = CARDS.findIndex((c) => c.id === spec.cardId)!;
  const decision =
    spec.outcome === "pass"
      ? { checks: null, outcome: "pass" as const, verdict: "supported" as const, review_reason: null }
      : {
          checks: null,
          outcome: "review" as const,
          verdict: spec.reviewReason ?? "unsupported",
          review_reason: spec.reviewReason ?? "unsupported",
        };
  return {
    format_version: 2,
    run_id: "test-arm-20260920-fffffff",
    arm: "test-arm",
    sample_index: cardIndex,
    repeat_index: spec.repeat,
    card_id: spec.cardId,
    timestamp: `2026-09-20T10:0${spec.repeat}:00.000Z`,
    protocol_version: "0.1.0",
    protocol_sha256: HEX_64,
    original_claim: CLAIM,
    model_input: MODEL_INPUT,
    input_hash: `sha256:${HEX_64}`,
    model: { id: "anthropic/claude-sonnet-5", version: "anthropic/claude-sonnet-5-20261001", provider: "anthropic" },
    raw_answer: { kind: "overall", verdict: decision.verdict, reason: "test reason" },
    attempts: [
      {
        index: 1,
        raw_response: { id: "gen_1" },
        parsed_answer: { kind: "overall", verdict: decision.verdict, reason: "test reason" },
        usage: { latency_ms: spec.latency, input_tokens: 600, output_tokens: 20, cost: { amount: spec.cost, currency: "USD" } },
        elapsed_ms: spec.latency + 40,
        error: null,
        generation_id: "gen_1",
        generation: { total_cost: spec.cost, market_cost: spec.cost * 2 },
      },
    ],
    first_attempt_invalid: spec.firstAttemptInvalid ?? false,
    retried: spec.retried ?? false,
    decision,
    usage: { latency_ms: spec.latency, input_tokens: 600, output_tokens: 20, cost: { amount: spec.cost, currency: "USD" } },
    error: null,
  };
}

function writeRun(dir: string, specs: RecordSpec[], timingRun = false): string {
  const runDir = join(dir, timingRun ? "test-arm-verdict-only" : "test-arm");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(manifest(timingRun), null, 2)}\n`);
  writeFileSync(
    join(runDir, "records.jsonl"),
    specs.map((spec) => `${canonicalJson(record(spec))}\n`).join(""),
  );
  return runDir;
}

function baseSpecs(): RecordSpec[] {
  return [
    // card-t-01 (correct): pass, pass, review -> one nuisance flag in repeat 2, one action flip
    { cardId: "card-t-01", repeat: 0, outcome: "pass", reviewReason: null, latency: 100, cost: 0.001 },
    { cardId: "card-t-01", repeat: 1, outcome: "pass", reviewReason: null, latency: 200, cost: 0.001 },
    { cardId: "card-t-01", repeat: 2, outcome: "review", reviewReason: "uncertain", latency: 300, cost: 0.001 },
    // card-t-02 (wrong-subject): pass, review, pass -> dangerous passes in repeats 1 and 3, one action flip
    { cardId: "card-t-02", repeat: 0, outcome: "pass", reviewReason: null, latency: 100, cost: 0.001 },
    { cardId: "card-t-02", repeat: 1, outcome: "review", reviewReason: "unsupported", latency: 200, cost: 0.001 },
    { cardId: "card-t-02", repeat: 2, outcome: "pass", reviewReason: null, latency: 300, cost: 0.001 },
    // card-t-03 (unsupported): review x3 with a verdict change unsupported -> uncertain
    { cardId: "card-t-03", repeat: 0, outcome: "review", reviewReason: "unsupported", latency: 100, cost: 0.001 },
    { cardId: "card-t-03", repeat: 1, outcome: "review", reviewReason: "unsupported", latency: 200, cost: 0.001 },
    { cardId: "card-t-03", repeat: 2, outcome: "review", reviewReason: "uncertain", latency: 300, cost: 0.001 },
  ];
}

describe("scoreArmRun", () => {
  test("scores every repeat independently with median and min-max", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-scorer-"));
    const runDir = writeRun(dir, baseSpecs());
    const scored = scoreArmRun(runDir, CARDS);

    expect(scored.armName).toBe("test-arm");
    expect(scored.timingRun).toBe(false);
    expect(scored.repeats).toHaveLength(3);

    const dangerous = scored.repeats.map((r) => r.dangerousPasses);
    expect(dangerous).toEqual([1, 0, 1]);
    expect(scored.summary.dangerousPasses.median).toBe(1);
    expect(scored.summary.dangerousPasses.min).toBe(0);
    expect(scored.summary.dangerousPasses.max).toBe(1);

    const nuisance = scored.repeats.map((r) => r.nuisanceFlags);
    expect(nuisance).toEqual([0, 0, 1]);
    expect(scored.summary.nuisanceFlags.median).toBe(0);

    // per-category catch rates for repeat 0: wrong-subject passed (0 caught of 1), unsupported caught (1 of 1), correct passed (1 of 1)
    expect(scored.repeats[0]!.byCategory["wrong-subject"]).toEqual({ total: 1, caught: 0 });
    expect(scored.repeats[0]!.byCategory["unsupported"]).toEqual({ total: 1, caught: 1 });
    expect(scored.repeats[0]!.byCategory["correct"]).toEqual({ total: 1, passed: 1, flagged: 0 });
  });

  test("counts action flips as cards that switch between pass and review, with the denominator shown", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-scorer-flip-"));
    const scored = scoreArmRun(writeRun(dir, baseSpecs()), CARDS);
    expect(scored.summary.actionFlips.count).toBe(2);
    expect(scored.summary.actionFlips.denominator).toBe(3);
    expect(scored.summary.actionFlips.cards).toEqual(["card-t-01", "card-t-02"]);
  });

  test("counts verdict changes separately from action flips", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-scorer-verdict-"));
    const scored = scoreArmRun(writeRun(dir, baseSpecs()), CARDS);
    expect(scored.summary.verdictChanges.count).toBe(1);
    expect(scored.summary.verdictChanges.cards).toEqual(["card-t-03"]);
    expect(scored.summary.verdictChanges.denominator).toBe(3);
  });

  test("reports cards without three valid evaluations separately, never as passes or catches", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-scorer-invalid-"));
    const specs = baseSpecs().filter((s) => !(s.cardId === "card-t-03" && s.repeat === 2));
    const scored = scoreArmRun(writeRun(dir, specs), CARDS);
    expect(scored.summary.cardsWithAllRepeats).toBe(2);
    expect(scored.summary.incompleteCards).toEqual(["card-t-03"]);
    expect(scored.summary.actionFlips.denominator).toBe(2);
  });

  test("cost per card evaluation is total cost across all repeats over cards x repeats", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-scorer-cost-"));
    const scored = scoreArmRun(writeRun(dir, baseSpecs()), CARDS);
    expect(scored.summary.totalCost).toBeCloseTo(0.009, 12);
    expect(scored.summary.costPerCardEvaluation).toBeCloseTo(0.001, 12);
    expect(scored.summary.costPerRun).toBeCloseTo(0.003, 12);
    expect(scored.summary.marketCostTotal).toBeCloseTo(0.018, 12);
    expect(scored.summary.marketCostPerCardEvaluation).toBeCloseTo(0.002, 12);
  });

  test("latency statistics come from gateway-reported values, median and p95", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-scorer-latency-"));
    const scored = scoreArmRun(writeRun(dir, baseSpecs()), CARDS);
    expect(scored.summary.latencyMedianMs).toBe(200);
    expect(scored.summary.latencyP95Ms).toBeGreaterThanOrEqual(290);
    expect(scored.summary.latencySamples).toBe(9);
  });

  test("structured-output failures report first-attempt and remaining-after-retry separately", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-scorer-so-"));
    const specs = baseSpecs();
    specs[0]!.firstAttemptInvalid = true;
    const scored = scoreArmRun(writeRun(dir, specs), CARDS);
    expect(scored.summary.structuredOutputFirstAttemptFailures).toBe(1);
    expect(scored.summary.structuredOutputRemainingAfterRetry).toBe(0);
  });

  test("execution errors are counted with denominators and never counted as passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-scorer-exec-"));
    const specs = baseSpecs();
    const runDir = writeRun(dir, specs);
    const lines = baseSpecs()
      .map((spec) => {
        let built = record(spec);
        if (spec.cardId === "card-t-03" && spec.repeat === 1) {
          built = {
            ...built,
            attempts: [
              { ...built.attempts[0]!, index: 1, parsed_answer: null, raw_response: "not json", error: { kind: "invalid-response", message: "unparseable" } },
              { ...built.attempts[0]!, index: 2, parsed_answer: null, raw_response: "still not json", error: { kind: "invalid-response", message: "unparseable" } },
            ],
            first_attempt_invalid: true,
            retried: true,
            decision: null,
            error: { kind: "invalid-response", message: "two failed attempts; execution error, never a pass or a caught mistake" },
          };
        }
        return canonicalJson(built);
      })
      .map((line) => `${line}\n`)
      .join("");
    writeFileSync(join(runDir, "records.jsonl"), lines);

    const scored = scoreArmRun(runDir, CARDS);
    expect(scored.summary.executionErrors).toBe(1);
    expect(scored.repeats[1]!.dangerousPasses).toBe(0);
    expect(scored.repeats[1]!.evaluated).toBe(2);
    expect(scored.summary.cardsWithAllRepeats).toBe(2);
  });

  test("collects representative failures for the gallery, dangerous passes first", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-scorer-gallery-"));
    const scored = scoreArmRun(writeRun(dir, baseSpecs()), CARDS);
    expect(scored.failures[0]!.kind).toBe("dangerous-pass");
    expect(scored.failures[0]!.cardId).toBe("card-t-02");
    expect(scored.failures.find((f) => f.kind === "nuisance-flag")?.cardId).toBe("card-t-01");
    expect(scored.failures.every((f) => f.kind === "dangerous-pass" || f.kind === "nuisance-flag")).toBe(true);
    expect(scored.failures[0]!.quote).toContain("test reason");
  });

  test("timing runs are labelled and not scored", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-scorer-timing-"));
    const scored = scoreArmRun(writeRun(dir, baseSpecs(), true), CARDS);
    expect(scored.timingRun).toBe(true);
    expect(scored.scored).toBe(false);
  });

  test("a deterministic run dir type carries the manifest for the results document", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-scorer-type-"));
    const scored: ScoredRun = scoreArmRun(writeRun(dir, baseSpecs()), CARDS);
    expect(scored.manifest.arm.model_id).toBe("anthropic/claude-sonnet-5");
    expect(scored.manifest.protocol_version).toBe("0.1.0");
  });
});
