import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvaluationRecorder,
  evaluationUsageAggregate,
  type EvaluationRecordInput,
} from "../src/evaluation_recorder.ts";
import { runWithRetryPolicy, type AttemptOutcome } from "../src/retry_policy.ts";
import type { Claim } from "../src/case_set_schema.ts";
import type { ModelInput } from "../src/input_preparation.ts";
import type { CardDecision } from "../src/decision_mapping.ts";
import type { EvaluationManifestArm } from "../src/run_record_schema.ts";

const HEX_64 = "a".repeat(64);
const COMMIT = "f".repeat(40);

const CLAIM: Claim = {
  subject_id: "sub-t-plan",
  field: "pension.plan-value",
  value: 45250,
  unit: "GBP",
  period_or_basis: "plan value as at 1 April 2026",
  as_of: "2026-04-01",
};

const MODEL_INPUT: ModelInput = {
  whos_who: "People in this household: Alex Field; Bea Field.",
  claim: {
    subject: "Test plan",
    field: "pension.plan-value (…)",
    value: "45,250",
    unit: "GBP (…)",
    period_or_basis: "plan value as at 1 April 2026",
    as_of: "2026-04-01",
  },
  evidence: [{ artifact: "art-t-statement", lines: "1-1", quote: "Plan value as at 1 April 2026: £45,250" }],
};

const DECISION: CardDecision = {
  checks: { ownership: "pass", value_support: "pass", time_support: "pass" },
  outcome: "pass",
  verdict: "supported",
  review_reason: null,
};

const ARM: EvaluationManifestArm = {
  name: "jev",
  checker: "jev",
  model_id: "typesafe-ai/jev",
  variant: "decomposed",
  decision_policy: "probability-gated",
  timing_run: false,
};

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "faai-eval-recorder-"));
}

function makeRecorder(dir: string) {
  return new EvaluationRecorder({
    runId: "jev-20260920-abcdef1",
    caseSetVersion: "1.0.0",
    caseSetSha256: HEX_64,
    protocolVersion: "0.1.0",
    protocolSha256: HEX_64,
    rosterVersion: "1.0.0",
    rosterSha256: HEX_64,
    codeCommit: COMMIT,
    repeatCount: 3,
    inputSetSha256: "b".repeat(64),
    arm: ARM,
    outputDir: dir,
    now: () => new Date("2026-09-20T10:00:00.000Z"),
  });
}

function successInput(overrides: Partial<EvaluationRecordInput> = {}): EvaluationRecordInput {
  return {
    sampleIndex: 0,
    repeatIndex: 0,
    cardId: "card-t-01",
    originalClaim: CLAIM,
    modelInput: MODEL_INPUT,
    inputHash: `sha256:${HEX_64}`,
    model: { id: "typesafe-ai/jev", version: "jev-1.13.0", provider: "typesafe-ai", generation_id: "gen_1" },
    rawAnswer: null,
    attempts: [
      {
        index: 1,
        raw_response: { answers: {} },
        parsed_answer: { answers: {} },
        usage: { latency_ms: 180, input_tokens: 640, output_tokens: 20, cost: { amount: 0.0000123, currency: "USD" } },
        elapsed_ms: 240,
        error: null,
      },
    ],
    firstAttemptInvalid: false,
    retried: false,
    decision: DECISION,
    error: null,
    ...overrides,
  };
}

describe("EvaluationRecorder", () => {
  test("writes a valid v2 manifest and JSONL evaluation records", () => {
    const dir = makeDir();
    const recorder = makeRecorder(dir);
    recorder.recordEvaluation(successInput());
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.arm.name).toBe("jev");
    const lines = readFileSync(join(dir, "records.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.format_version).toBe(2);
    expect(record.run_id).toBe("jev-20260920-abcdef1");
    expect(record.original_claim).toEqual(CLAIM);
    expect(record.model_input).toEqual(MODEL_INPUT);
  });

  test("refuses to overwrite an earlier run", () => {
    const dir = makeDir();
    makeRecorder(dir);
    expect(() => makeRecorder(dir)).toThrow(/already exists/);
  });

  test("fails loudly before writing a malformed evaluation record", () => {
    const dir = makeDir();
    const recorder = makeRecorder(dir);
    expect(() =>
      recorder.recordEvaluation(
        successInput({ decision: { ...DECISION, outcome: "pass" }, error: { kind: "other", message: "boom" } }),
      ),
    ).toThrow(/validation/);
    expect(existsSync(join(dir, "records.jsonl"))).toBe(false);
  });

  test("records an input-preparation error evaluation with no attempts, model, decision or usage", () => {
    const dir = makeDir();
    const recorder = makeRecorder(dir);
    recorder.recordEvaluation({
      sampleIndex: 0,
      repeatIndex: 0,
      cardId: "card-t-01",
      originalClaim: CLAIM,
      modelInput: null,
      inputHash: null,
      model: null,
      attempts: [],
      firstAttemptInvalid: false,
      retried: false,
      decision: null,
      error: { kind: "input-preparation", message: "input preparation: subject id cannot be resolved" },
    });
    const record = JSON.parse(readFileSync(join(dir, "records.jsonl"), "utf8").trim());
    expect(record.error.kind).toBe("input-preparation");
    expect(record.attempts).toEqual([]);
  });
});

describe("evaluationUsageAggregate", () => {
  test("sums gateway-reported usage across attempts, including billed failed attempts", () => {
    const aggregate = evaluationUsageAggregate([
      {
        index: 1,
        raw_response: "{",
        parsed_answer: null,
        usage: { latency_ms: 100, input_tokens: 500, output_tokens: 10, cost: { amount: 0.00001, currency: "USD" } },
        elapsed_ms: 150,
        error: { kind: "invalid-response", message: "unparseable" },
      },
      {
        index: 2,
        raw_response: {},
        parsed_answer: {},
        usage: { latency_ms: 200, input_tokens: 700, output_tokens: 30, cost: { amount: 0.00002, currency: "USD" } },
        elapsed_ms: 260,
        error: null,
      },
    ]);
    expect(aggregate).toEqual({
      latency_ms: 300,
      input_tokens: 1200,
      output_tokens: 40,
      cost: { amount: 0.00003, currency: "USD" },
    });
  });

  test("returns null when no attempt reported usage, and null cost when any cost is missing", () => {
    const noUsage = evaluationUsageAggregate([
      {
        index: 1,
        raw_response: "",
        parsed_answer: null,
        usage: null,
        elapsed_ms: 50,
        error: { kind: "timeout", message: "timed out" },
      },
    ]);
    expect(noUsage).toBeNull();

    const missingCost = evaluationUsageAggregate([
      {
        index: 1,
        raw_response: {},
        parsed_answer: {},
        usage: { latency_ms: 10, input_tokens: 1, output_tokens: 1, cost: null },
        elapsed_ms: 12,
        error: null,
      },
    ]);
    expect(missingCost?.cost).toBeNull();
  });
});

describe("runWithRetryPolicy", () => {
  interface Probe {
    kind: "parsed" | "invalid";
    answer?: unknown;
  }

  function outcome(probe: Probe): AttemptOutcome {
    return probe.kind === "parsed"
      ? { status: "parsed", answer: probe.answer, rawResponse: { ok: true }, usage: null, elapsedMs: 10 }
      : { status: "invalid-response", rawResponse: "not json", usage: null, elapsedMs: 10, message: "unparseable" };
  }

  test("returns the first answer without retrying when it is valid", async () => {
    const calls: number[] = [];
    const result = await runWithRetryPolicy({
      attempt: async () => {
        calls.push(1);
        return outcome({ kind: "parsed", answer: { verdict: "supported" } });
      },
    });
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("answered");
    if (result.status === "answered") expect(result.attempts).toHaveLength(1);
  });

  test("retries exactly once on invalid output, preserving both responses", async () => {
    let call = 0;
    const result = await runWithRetryPolicy({
      attempt: async () => {
        call += 1;
        return call === 1 ? outcome({ kind: "invalid" }) : outcome({ kind: "parsed", answer: { verdict: "uncertain" } });
      },
    });
    expect(call).toBe(2);
    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.attempts).toHaveLength(2);
    expect(result.firstAttemptInvalid).toBe(true);
    expect(result.retried).toBe(true);
  });

  test("two failed attempts are an execution error, never a pass or a caught mistake", async () => {
    const result = await runWithRetryPolicy({
      attempt: async () => outcome({ kind: "invalid" }),
    });
    expect(result.status).toBe("execution-error");
    if (result.status === "execution-error" && result.error) {
      expect(result.error.kind).toBe("invalid-response");
      expect(result.attempts).toHaveLength(2);
    }
  });

  test("never retries a valid answer, even when it disagrees with the answer key", async () => {
    const calls: number[] = [];
    const result = await runWithRetryPolicy({
      attempt: async () => {
        calls.push(1);
        return outcome({ kind: "parsed", answer: { verdict: "supported" } });
      },
    });
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("answered");
    if (result.status === "answered") expect(result.answer).toEqual({ verdict: "supported" });
  });

  test("propagates transport errors immediately without consuming the retry", async () => {
    const calls: number[] = [];
    const result = await runWithRetryPolicy({
      attempt: async () => {
        calls.push(1);
        return { status: "transport-error", error: { kind: "http-error", message: "bad gateway", status: 502 }, rawResponse: null, usage: null, elapsedMs: 5 };
      },
    });
    expect(calls).toHaveLength(1);
    expect(result.status).toBe("execution-error");
  });
});
