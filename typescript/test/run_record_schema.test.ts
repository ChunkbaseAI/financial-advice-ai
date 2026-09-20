import { describe, expect, test } from "bun:test";
import { RUN_RECORD_FORMAT_VERSION, validateRunManifest, validateRunRecord } from "../src/run_records.ts";

const HEX_64 = "a".repeat(64);

function modelSuccessRecord(): Record<string, any> {
  return {
    format_version: 1,
    run_id: "run-20260920-fab38d7",
    sample_index: 3,
    repeat_index: 0,
    timestamp: "2026-09-20T10:00:00.123Z",
    checker: "jev",
    card_id: "card-sp-04",
    prompt_hash: `sha256:${HEX_64}`,
    model: {
      id: "typesafe-ai/jev",
      version: "jev-1.0.0",
      provider: "vertex-ai",
      generation_id: "gen-9f2c",
    },
    verdict: "unsupported",
    raw_answer: {
      verdict: "unsupported",
      confidence: 0.82,
      probabilities: { supported: 0.18, unsupported: 0.82 },
    },
    usage: {
      latency_ms: 812,
      input_tokens: 640,
      output_tokens: 96,
      cost: { amount: 0.0012, currency: "USD" },
    },
    error: null,
  };
}

function rulesRecord(): Record<string, any> {
  return {
    format_version: 1,
    run_id: "run-20260920-fab38d7",
    sample_index: 0,
    repeat_index: 0,
    timestamp: "2026-09-20T10:00:00.123Z",
    checker: "rules",
    card_id: "card-t-01",
    prompt_hash: `sha256:${HEX_64}`,
    model: null,
    verdict: "supported",
    raw_answer: { value_present: true },
    usage: null,
    error: null,
  };
}

function rateLimitRecord(): Record<string, any> {
  return {
    format_version: 1,
    run_id: "run-20260920-fab38d7",
    sample_index: 7,
    repeat_index: 1,
    timestamp: "2026-09-20T10:00:03.456Z",
    checker: "jev",
    card_id: "card-sp-08",
    prompt_hash: `sha256:${HEX_64}`,
    model: null,
    verdict: null,
    raw_answer: null,
    usage: null,
    error: { kind: "rate-limit", message: "gateway returned 429 after 3 attempts", status: 429 },
  };
}

function validManifest(): Record<string, any> {
  return {
    format_version: 1,
    run_id: "run-20260920-fab38d7",
    created_at: "2026-09-20T09:59:59.000Z",
    case_set_version: "1.0.0",
    case_set_sha256: HEX_64,
    code_commit: "f".repeat(40),
    repeat_count: 3,
    prompt_set_sha256: "b".repeat(64),
    checkers: ["rules", "jev"],
  };
}

describe("validateRunRecord", () => {
  test("accepts a successful model-call record with gateway-reported usage", () => {
    expect(validateRunRecord(modelSuccessRecord())).toEqual([]);
  });

  test("accepts a deterministic rules-checker record with no model and no usage", () => {
    expect(validateRunRecord(rulesRecord())).toEqual([]);
  });

  test("accepts a preserved 429 error record with no verdict", () => {
    expect(validateRunRecord(rateLimitRecord())).toEqual([]);
  });

  test("exposes the run record format version so records are self-describing", () => {
    expect(RUN_RECORD_FORMAT_VERSION).toBe(1);
  });

  const mutations: Array<[string, (record: Record<string, any>) => void, string]> = [
    ["a missing format_version", (r) => delete r.format_version, "format_version"],
    ["an unsupported format_version", (r) => r.format_version = 3, "format_version"],
    ["an empty run_id", (r) => r.run_id = " ", "run_id"],
    ["a negative sample_index", (r) => r.sample_index = -1, "sample_index"],
    ["a fractional sample_index", (r) => r.sample_index = 1.5, "sample_index"],
    ["a missing repeat_index", (r) => delete r.repeat_index, "repeat_index"],
    ["a timestamp without a timezone", (r) => r.timestamp = "2026-09-20 10:00:00", "timestamp"],
    ["a date-only timestamp", (r) => r.timestamp = "2026-09-20", "timestamp"],
    ["an empty checker name", (r) => r.checker = "", "checker"],
    ["a missing card_id", (r) => delete r.card_id, "card_id"],
    ["an unprefixed prompt_hash", (r) => r.prompt_hash = HEX_64, "prompt_hash"],
    ["an uppercase prompt_hash", (r) => r.prompt_hash = `sha256:${"A".repeat(64)}`, "prompt_hash"],
    ["a missing model key", (r) => delete r.model, "model"],
    ["a model without the exact reported version", (r) => delete r.model.version, "version"],
    ["an empty model version, as an alias would be", (r) => r.model.version = "", "version"],
    ["a model without the serving provider", (r) => delete r.model.provider, "provider"],
    ["an empty model provider", (r) => r.model.provider = " ", "provider"],
    ["an empty generation_id", (r) => r.model.generation_id = "", "generation_id"],
    ["an unknown verdict", (r) => r.verdict = "maybe", "verdict"],
    ["a successful record without a verdict", (r) => r.verdict = null, "verdict"],
    ["an error record that also carries a verdict", (r) => { r.error = { kind: "timeout", message: "gave up" }; }, "verdict"],
    ["a successful model call without gateway-reported usage", (r) => r.usage = null, "usage"],
    ["a rules record with invented usage", (r) => { r.model = null; r.usage = { latency_ms: 1, input_tokens: 0, output_tokens: 0, cost: null }; }, "usage"],
    ["a missing usage key", (r) => delete r.usage, "usage"],
    ["a negative latency", (r) => r.usage.latency_ms = -1, "latency_ms"],
    ["a negative input token count", (r) => r.usage.input_tokens = -5, "input_tokens"],
    ["a fractional output token count", (r) => r.usage.output_tokens = 2.5, "output_tokens"],
    ["a negative cost amount", (r) => r.usage.cost.amount = -0.01, "amount"],
    ["a lowercase cost currency", (r) => r.usage.cost.currency = "usd", "currency"],
    ["a raw answer key that is missing entirely", (r) => delete r.raw_answer, "raw_answer"],
    ["a missing error key", (r) => delete r.error, "error"],
    ["an error without a message", (r) => { r.verdict = null; r.raw_answer = null; r.error = { kind: "timeout" }; }, "message"],
    ["an unknown error kind", (r) => { r.verdict = null; r.raw_answer = null; r.error = { kind: "crash", message: "boom" }; }, "kind"],
    ["a rate-limit error that is not a 429", (r) => { r.verdict = null; r.raw_answer = null; r.error = { kind: "rate-limit", message: "slow down", status: 500 }; }, "429"],
    ["a rate-limit error without a status", (r) => { r.verdict = null; r.raw_answer = null; r.error = { kind: "rate-limit", message: "slow down" }; }, "429"],
    ["an http-error without a status", (r) => { r.verdict = null; r.raw_answer = null; r.error = { kind: "http-error", message: "bad gateway" }; }, "status"],
  ];

  for (const [name, mutate, needle] of mutations) {
    test(`rejects ${name} with a violation naming it`, () => {
      const record = modelSuccessRecord();
      mutate(record);
      const violations = validateRunRecord(record);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.includes(needle))).toBe(true);
    });
  }

  test("collects every violation rather than stopping at the first", () => {
    const record = modelSuccessRecord();
    record.format_version = 3;
    record.usage.input_tokens = -5;
    const violations = validateRunRecord(record);
    expect(violations.some((v) => v.includes("format_version"))).toBe(true);
    expect(violations.some((v) => v.includes("input_tokens"))).toBe(true);
  });

  test("rejects a non-object record", () => {
    expect(validateRunRecord("nope")).toEqual(["run record: expected a JSON object"]);
  });
});

describe("validateRunManifest", () => {
  test("accepts a complete run manifest", () => {
    expect(validateRunManifest(validManifest())).toEqual([]);
  });

  const mutations: Array<[string, (manifest: Record<string, any>) => void, string]> = [
    ["an unsupported format_version", (m) => m.format_version = 3, "format_version"],
    ["a missing run_id", (m) => delete m.run_id, "run_id"],
    ["a date-only created_at", (m) => m.created_at = "2026-09-20", "created_at"],
    ["a non-semver case_set_version", (m) => m.case_set_version = "v1", "case_set_version"],
    ["a case_set_sha256 that is not 64 hex characters", (m) => m.case_set_sha256 = "abc", "case_set_sha256"],
    ["an uppercase case_set_sha256", (m) => m.case_set_sha256 = "F".repeat(64), "case_set_sha256"],
    ["a code_commit that is not a full git sha", (m) => m.code_commit = "fab38d7", "code_commit"],
    ["a zero repeat_count", (m) => m.repeat_count = 0, "repeat_count"],
    ["a fractional repeat_count", (m) => m.repeat_count = 1.5, "repeat_count"],
    ["a missing prompt_set_sha256", (m) => delete m.prompt_set_sha256, "prompt_set_sha256"],
    ["an empty checkers list", (m) => m.checkers = [], "checkers"],
    ["an empty checker name in the list", (m) => m.checkers = ["rules", ""], "checkers"],
    ["a missing checkers list", (m) => delete m.checkers, "checkers"],
  ];

  for (const [name, mutate, needle] of mutations) {
    test(`rejects ${name} with a violation naming it`, () => {
      const manifest = validManifest();
      mutate(manifest);
      const violations = validateRunManifest(manifest);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.includes(needle))).toBe(true);
    });
  }

  test("rejects a non-object manifest", () => {
    expect(validateRunManifest(42)).toEqual(["run manifest: expected a JSON object"]);
  });
});
