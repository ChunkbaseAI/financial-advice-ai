import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  EVALUATION_RECORD_FORMAT_VERSION,
  ERROR_KINDS,
  RunRecordValidationError,
  validateEvaluationManifest,
  validateEvaluationRecord,
  validateRunManifest,
  validateRunRecord,
  type EvaluationAttempt,
  type EvaluationManifest,
  type EvaluationRecord,
} from "../src/run_record_schema.ts";

const HEX_64 = "a".repeat(64);
const COMMIT = "f".repeat(40);

const CLAIM = {
  subject_id: "sub-t-plan",
  field: "pension.plan-value",
  value: 45250,
  unit: "GBP",
  period_or_basis: "plan value as at 1 April 2026",
  as_of: "2026-04-01",
};

const MODEL_INPUT = {
  whos_who: "People in this household: Alex Field; Bea Field.",
  claim: { subject: "Test plan", field: "pension.plan-value (…)", value: "45,250", unit: "GBP (…)", period_or_basis: "…", as_of: "2026-04-01" },
  evidence: [{ artifact: "art-t-statement", lines: "1-1", quote: "Plan value as at 1 April 2026: £45,250" }],
};

const MODEL = { id: "typesafe-ai/jev", version: "jev-1.13.0", provider: "typesafe-ai", generation_id: "gen_1" };

function attempt(overrides: Partial<EvaluationAttempt> = {}): EvaluationAttempt {
  return {
    index: 1,
    raw_response: { answers: { value_support: { type: "noul", noul: 0.95 } } },
    parsed_answer: { answers: { value_support: { type: "noul", noul: 0.95 } } },
    usage: { latency_ms: 180, input_tokens: 640, output_tokens: 20, cost: { amount: 0.0000123, currency: "USD" } },
    elapsed_ms: 240,
    error: null,
    ...overrides,
  };
}

function evaluation(overrides: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    format_version: EVALUATION_RECORD_FORMAT_VERSION,
    run_id: "jev-20260920-abcdef1",
    arm: "jev",
    sample_index: 0,
    repeat_index: 0,
    card_id: "card-t-01",
    timestamp: "2026-09-20T10:00:00.000Z",
    protocol_version: "0.1.0",
    protocol_sha256: HEX_64,
    original_claim: CLAIM,
    model_input: MODEL_INPUT,
    input_hash: `sha256:${HEX_64}`,
    model: MODEL,
    raw_answer: null,
    attempts: [attempt()],
    first_attempt_invalid: false,
    retried: false,
    decision: {
      checks: { ownership: "pass", value_support: "pass", time_support: "pass" },
      outcome: "pass",
      verdict: "supported",
      review_reason: null,
    },
    usage: { latency_ms: 180, input_tokens: 640, output_tokens: 20, cost: { amount: 0.0000123, currency: "USD" } },
    error: null,
    ...overrides,
  };
}

describe("validateEvaluationRecord", () => {
  test("accepts a successful single-attempt evaluation record", () => {
    expect(validateEvaluationRecord(evaluation())).toEqual([]);
  });

  test("accepts a retried record that succeeded on the second attempt, preserving both responses", () => {
    const record = evaluation({
      attempts: [
        attempt({ index: 1, parsed_answer: null, raw_response: "not json", error: { kind: "invalid-response", message: "unparseable" } }),
        attempt({ index: 2 }),
      ],
      first_attempt_invalid: true,
      retried: true,
    });
    expect(validateEvaluationRecord(record)).toEqual([]);
  });

  test("accepts a retry-exhausted execution-error record with no decision, both billed attempts summed", () => {
    const record = evaluation({
      attempts: [
        attempt({ index: 1, parsed_answer: null, raw_response: "{", error: { kind: "invalid-response", message: "unparseable" } }),
        attempt({ index: 2, parsed_answer: null, raw_response: "still not json", error: { kind: "invalid-response", message: "unparseable" } }),
      ],
      first_attempt_invalid: true,
      retried: true,
      decision: null,
      usage: { latency_ms: 360, input_tokens: 1280, output_tokens: 40, cost: { amount: 0.0000246, currency: "USD" } },
      error: { kind: "invalid-response", message: "two failed attempts; execution error, never a pass or a caught mistake" },
    });
    expect(validateEvaluationRecord(record)).toEqual([]);
  });

  test("accepts an input-preparation error record with no attempts, model or usage", () => {
    const record = evaluation({
      model: null,
      attempts: [],
      first_attempt_invalid: false,
      retried: false,
      decision: null,
      usage: null,
      error: { kind: "input-preparation", message: 'input preparation: subject id "sub-t-nobody" cannot be resolved' },
    });
    expect(validateEvaluationRecord(record)).toEqual([]);
  });

  test("accepts a deterministic rules record with no model, attempts or usage", () => {
    const record = evaluation({
      arm: "rules",
      model: null,
      attempts: [],
      decision: {
        checks: null,
        outcome: "supported" === "supported" ? "pass" : "review",
        verdict: "supported",
        review_reason: null,
      },
      usage: null,
    });
    expect(validateEvaluationRecord(record)).toEqual([]);
  });

  test("rejects a record whose outcome and verdict disagree", () => {
    const record = evaluation({
      decision: {
        checks: { ownership: "pass", value_support: "unsupported", time_support: "pass" },
        outcome: "pass",
        verdict: "supported",
        review_reason: null,
      },
    });
    expect(validateEvaluationRecord(record).some((v) => v.includes("decision"))).toBe(true);
  });

  test("rejects a decision on an error record", () => {
    const record = evaluation({ usage: null, error: { kind: "other", message: "boom" }, attempts: [] });
    expect(validateEvaluationRecord(record).some((v) => v.includes("decision"))).toBe(true);
  });

  test("rejects more than one retry, and retried flags that disagree with the attempt count", () => {
    const three = evaluation({
      attempts: [attempt({ index: 1 }), attempt({ index: 2 }), attempt({ index: 3 })],
      retried: true,
    });
    expect(validateEvaluationRecord(three).some((v) => v.includes("attempts"))).toBe(true);

    const flagLie = evaluation({ attempts: [attempt()], retried: true, first_attempt_invalid: false });
    expect(validateEvaluationRecord(flagLie).some((v) => v.includes("retried"))).toBe(true);
  });

  test("rejects missing aggregate usage when attempts report gateway usage", () => {
    const record = evaluation({ usage: null });
    expect(validateEvaluationRecord(record).some((v) => v.includes("usage"))).toBe(true);
  });

  test("rejects an input-preparation error that still made model attempts", () => {
    const record = evaluation({
      error: { kind: "input-preparation", message: "unresolvable" },
      decision: null,
    });
    expect(validateEvaluationRecord(record).some((v) => v.includes("input-preparation"))).toBe(true);
  });

  test("rejects a malformed input hash and a missing original claim", () => {
    expect(validateEvaluationRecord(evaluation({ input_hash: HEX_64 })).length).toBeGreaterThan(0);
    expect(validateEvaluationRecord(evaluation({ original_claim: null as unknown as EvaluationRecord["original_claim"] })).length).toBeGreaterThan(
      0,
    );
  });
});

describe("validateEvaluationManifest", () => {
  function manifest(overrides: Partial<EvaluationManifest> = {}): EvaluationManifest {
    return {
      format_version: EVALUATION_RECORD_FORMAT_VERSION,
      run_id: "jev-20260920-abcdef1",
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
      checkers: ["jev"],
      arm: {
        name: "jev",
        checker: "jev",
        model_id: "typesafe-ai/jev",
        variant: "decomposed",
        decision_policy: "probability-gated",
        timing_run: false,
      },
      ...overrides,
    };
  }

  test("accepts a valid evaluation manifest", () => {
    expect(validateEvaluationManifest(manifest())).toEqual([]);
  });

  test("rejects a missing protocol binding", () => {
    const violations = validateEvaluationManifest(manifest({ protocol_sha256: "nope" }));
    expect(violations.some((v) => v.includes("protocol_sha256"))).toBe(true);
  });

  test("rejects an unknown arm variant or decision policy", () => {
    expect(
      validateEvaluationManifest(manifest({ arm: { ...manifest().arm, variant: "vibes" as EvaluationManifest["arm"]["variant"] } })).length,
    ).toBeGreaterThan(0);
    expect(
      validateEvaluationManifest(
        manifest({ arm: { ...manifest().arm, decision_policy: "gut-feel" as EvaluationManifest["arm"]["decision_policy"] } }),
      ).length,
    ).toBeGreaterThan(0);
  });

  test("rejects a rules arm that claims a model id", () => {
    const rules = manifest({
      checkers: ["rules"],
      arm: { name: "rules", checker: "rules", model_id: "typesafe-ai/jev", variant: "rules", decision_policy: "value-presence", timing_run: false },
    });
    expect(validateEvaluationManifest(rules).some((v) => v.includes("model_id"))).toBe(true);
  });
});

describe("version dispatch keeps the v1 formats intact", () => {
  test("v1 run records and manifests still validate through the same entry points", () => {
    const v1Record = {
      format_version: 1,
      run_id: "rules-20260901-737c2d4",
      sample_index: 0,
      repeat_index: 0,
      timestamp: "2026-09-01T10:00:00.000Z",
      checker: "rules",
      card_id: "card-mw-01",
      prompt_hash: `sha256:${HEX_64}`,
      model: null,
      verdict: "supported",
      raw_answer: { value_present: true },
      usage: null,
      error: null,
    };
    expect(validateRunRecord(v1Record)).toEqual([]);

    const v1Manifest = JSON.parse(
      readFileSync(new URL("../../fixtures/rules_run_v1/manifest.json", import.meta.url), "utf8"),
    );
    expect(validateRunManifest(v1Manifest)).toEqual([]);
  });

  test("v1 error kinds stay closed and v2 adds input-preparation for evaluation records only", () => {
    expect(ERROR_KINDS).not.toContain("input-preparation");
    const v2Error = evaluation({ error: { kind: "input-preparation", message: "x" }, decision: null, model: null, attempts: [], usage: null });
    expect(validateEvaluationRecord(v2Error)).toEqual([]);
    expect(() => {
      throw new RunRecordValidationError("record", ["x"]);
    }).toThrow(RunRecordValidationError);
  });
});
