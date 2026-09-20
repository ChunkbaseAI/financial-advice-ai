import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderResultsDocument } from "../src/render_results.ts";
import { scoreArmRun, type ScoredRun } from "../src/scorer.ts";
import { DEFAULT_PROTOCOL_LOCK_PATH, DEFAULT_PROTOCOL_PATH, loadProtocol, type CheckerProtocol } from "../src/checker_protocol.ts";
import { canonicalJson } from "../src/hashing.ts";
import type { EvaluationManifest, EvaluationRecord } from "../src/run_record_schema.ts";
import type { Category, Claim, ExpectedVerdict } from "../src/case_set_schema.ts";

const HEX_64 = "a".repeat(64);
const protocol: CheckerProtocol = loadProtocol(DEFAULT_PROTOCOL_PATH, DEFAULT_PROTOCOL_LOCK_PATH);

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

function manifest(armName: string, variant: "overall" | "decomposed", timingRun: boolean): EvaluationManifest {
  return {
    format_version: 2,
    run_id: `${armName}-20260920-fffffff`,
    created_at: "2026-09-20T10:00:00.000Z",
    case_set_version: "1.0.0",
    case_set_sha256: HEX_64,
    protocol_version: "0.1.0",
    protocol_sha256: HEX_64,
    roster_version: "1.0.0",
    roster_sha256: HEX_64,
    code_commit: "f".repeat(40),
    repeat_count: 3,
    input_set_sha256: "b".repeat(64),
    checkers: [armName],
    arm: {
      name: armName,
      checker: variant === "decomposed" ? "jev" : "claude-sonnet-5",
      model_id: variant === "decomposed" ? "typesafe-ai/jev" : "anthropic/claude-sonnet-5",
      variant,
      decision_policy: variant === "decomposed" ? "probability-gated" : "categorical-verdict",
      timing_run: timingRun,
    },
  };
}

function record(armName: string, cardId: string, repeat: number, outcome: "pass" | "review", reason: string): EvaluationRecord {
  const cardIndex = CARDS.findIndex((c) => c.id === cardId)!;
  return {
    format_version: 2,
    run_id: `${armName}-20260920-fffffff`,
    arm: armName,
    sample_index: cardIndex,
    repeat_index: repeat,
    card_id: cardId,
    timestamp: `2026-09-20T10:0${repeat}:00.000Z`,
    protocol_version: "0.1.0",
    protocol_sha256: HEX_64,
    original_claim: CLAIM,
    model_input: MODEL_INPUT,
    input_hash: `sha256:${HEX_64}`,
    model: { id: "anthropic/claude-sonnet-5", version: "anthropic/claude-sonnet-5-20261001", provider: "anthropic" },
    raw_answer: { kind: "overall", verdict: outcome === "pass" ? "supported" : "unsupported", reason },
    attempts: [
      {
        index: 1,
        raw_response: { id: "gen_1" },
        parsed_answer: { kind: "overall", verdict: outcome === "pass" ? "supported" : "unsupported", reason },
        usage: { latency_ms: 100 + repeat * 50, input_tokens: 600, output_tokens: 20, cost: { amount: 0.001, currency: "USD" } },
        elapsed_ms: 200,
        error: null,
      },
    ],
    first_attempt_invalid: false,
    retried: false,
    decision:
      outcome === "pass"
        ? { checks: null, outcome: "pass", verdict: "supported", review_reason: null }
        : { checks: null, outcome: "review", verdict: "unsupported", review_reason: "unsupported" },
    usage: { latency_ms: 100 + repeat * 50, input_tokens: 600, output_tokens: 20, cost: { amount: 0.001, currency: "USD" } },
    error: null,
  };
}

function writeRun(dir: string, armName: string, variant: "overall" | "decomposed", timingRun: boolean, records: EvaluationRecord[]): string {
  const runDir = join(dir, armName);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(manifest(armName, variant, timingRun), null, 2)}\n`);
  writeFileSync(join(runDir, "records.jsonl"), records.map((r) => `${canonicalJson(r)}\n`).join(""));
  return runDir;
}

describe("renderResultsDocument", () => {
  test("renders limitations before any performance statement, with honest outcome naming and denominators", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-render-"));
    const scoredRecords = [
      record("claude-sonnet-5-overall", "card-t-01", 0, "pass", "matches the span"),
      record("claude-sonnet-5-overall", "card-t-01", 1, "pass", "matches the span"),
      record("claude-sonnet-5-overall", "card-t-01", 2, "pass", "matches the span"),
      record("claude-sonnet-5-overall", "card-t-02", 0, "pass", "the number appears in the span"),
      record("claude-sonnet-5-overall", "card-t-02", 1, "review", "attributed to another person"),
      record("claude-sonnet-5-overall", "card-t-02", 2, "pass", "the number appears in the span"),
      record("claude-sonnet-5-overall", "card-t-03", 0, "review", "value appears nowhere"),
      record("claude-sonnet-5-overall", "card-t-03", 1, "review", "value appears nowhere"),
      record("claude-sonnet-5-overall", "card-t-03", 2, "review", "value appears nowhere"),
    ];
    const timingRecords = [record("claude-sonnet-5-overall-verdict-only", "card-t-01", 0, "pass", "matches the span")];

    const scoredRun: ScoredRun = scoreArmRun(writeRun(dir, "claude-sonnet-5-overall", "overall", false, scoredRecords), CARDS);
    const timingRun: ScoredRun = scoreArmRun(
      writeRun(dir, "claude-sonnet-5-overall-verdict-only", "overall", true, timingRecords),
      CARDS,
    );

    const document = renderResultsDocument({
      scoredRuns: [scoredRun],
      timingRuns: [timingRun],
      protocol,
      scorerCommit: "f".repeat(40),
      caseSetCards: 3,
    });

    const limitationsIndex = document.indexOf("## Limitations");
    const headlineIndex = document.indexOf("## Headline results");
    expect(limitationsIndex).toBeGreaterThan(-1);
    expect(limitationsIndex).toBeLessThan(headlineIndex);
    expect(document).toContain(protocol.limitations[0]!);

    expect(document).toContain("3 cards");
    expect(document).toContain("3 repeat");
    expect(document).toContain("claude-sonnet-5-overall");
    expect(document).toContain("dangerous passes");
    expect(document).toContain("nuisance flags");
    expect(document).toContain("never means fully verified");
    expect(document).toContain("never that the card is proven wrong");
    expect(document).toContain("passed these three checks");
    expect(document).toContain("cards with three valid evaluations");
    expect(document.toLowerCase()).toContain("consistent does not mean correct");
    expect(document).toContain("categorical-verdict");
    expect(document).toContain("verdict-only timing run");
    expect(document).toContain("the number appears in the span");
    expect(document).toContain("wrong cards passed");
    expect(document).toContain("correct cards sent to review");
  });
});
