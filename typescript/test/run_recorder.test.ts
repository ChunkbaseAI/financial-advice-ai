import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunRecordValidationError,
  RunRecorder,
  labeledSha256Of,
  validateRunManifest,
  validateRunRecord,
  type RunRecord,
} from "../src/run_records.ts";

const HEX_64 = "a".repeat(64);
const COMMIT = "f".repeat(40);

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "faai-recorder-"));
}

function makeRecorder(dir: string, options?: { repeatCount?: number; now?: () => Date }) {
  return new RunRecorder({
    runId: "run-test",
    caseSetVersion: "1.0.0",
    caseSetSha256: HEX_64,
    codeCommit: COMMIT,
    promptSetSha256: "b".repeat(64),
    repeatCount: options?.repeatCount ?? 2,
    checkers: ["rules", "jev"],
    outputDir: dir,
    now: options?.now ?? (() => new Date("2026-09-20T10:00:00.000Z")),
  });
}

function readRecords(dir: string): RunRecord[] {
  const raw = readFileSync(join(dir, "records.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RunRecord);
}

describe("RunRecorder", () => {
  test("writes a valid manifest at construction", () => {
    const dir = makeDir();
    makeRecorder(dir);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(validateRunManifest(manifest)).toEqual([]);
    expect(manifest.run_id).toBe("run-test");
    expect(manifest.repeat_count).toBe(2);
  });

  test("writes a valid, self-describing JSONL record for a successful model call", () => {
    const dir = makeDir();
    const recorder = makeRecorder(dir);
    recorder.recordModelSuccess({
      sampleIndex: 3,
      cardId: "card-sp-04",
      promptHash: `sha256:${HEX_64}`,
      checker: "jev",
      model: { id: "typesafe-ai/jev", version: "jev-1.0.0", provider: "vertex-ai", generation_id: "gen-1" },
      verdict: "unsupported",
      rawAnswer: { verdict: "unsupported", confidence: 0.9 },
      usage: { latency_ms: 812, input_tokens: 640, output_tokens: 96, cost: { amount: 0.0012, currency: "USD" } },
    });
    const records = readRecords(dir);
    expect(records).toHaveLength(1);
    expect(validateRunRecord(records[0])).toEqual([]);
    expect(records[0]).toMatchObject({
      run_id: "run-test",
      sample_index: 3,
      repeat_index: 0,
      timestamp: "2026-09-20T10:00:00.000Z",
      checker: "jev",
      card_id: "card-sp-04",
      error: null,
    });
  });

  test("records a deterministic rules result with no model and no usage", () => {
    const dir = makeDir();
    const recorder = makeRecorder(dir);
    recorder.recordDeterministicResult({
      sampleIndex: 0,
      cardId: "card-t-01",
      promptHash: `sha256:${HEX_64}`,
      checker: "rules",
      verdict: "supported",
      rawAnswer: { value_present: true },
    });
    const record = readRecords(dir)[0]!;
    expect(validateRunRecord(record)).toEqual([]);
    expect(record.model).toBeNull();
    expect(record.usage).toBeNull();
    expect(record.verdict).toBe("supported");
  });

  test("preserves a 429 error record with no verdict instead of discarding it", () => {
    const dir = makeDir();
    const recorder = makeRecorder(dir);
    recorder.recordModelError({
      sampleIndex: 7,
      cardId: "card-sp-08",
      promptHash: `sha256:${HEX_64}`,
      checker: "jev",
      error: { kind: "rate-limit", message: "gateway returned 429", status: 429 },
    });
    const record = readRecords(dir)[0]!;
    expect(validateRunRecord(record)).toEqual([]);
    expect(record.verdict).toBeNull();
    expect(record.error).toEqual({ kind: "rate-limit", message: "gateway returned 429", status: 429 });
  });

  test("preserves the partial raw answer on an invalid-response error record", () => {
    const dir = makeDir();
    const recorder = makeRecorder(dir);
    recorder.recordModelError({
      sampleIndex: 7,
      cardId: "card-sp-08",
      promptHash: `sha256:${HEX_64}`,
      checker: "jev",
      model: { id: "typesafe-ai/jev", version: "jev-1.0.0", provider: "vertex-ai" },
      error: { kind: "invalid-response", message: "answer was not valid JSON" },
      rawAnswer: { unparsed: "maybe supported? {verdict: ..." },
    });
    const record = readRecords(dir)[0]!;
    expect(validateRunRecord(record)).toEqual([]);
    expect(record.verdict).toBeNull();
    expect(record.raw_answer).toEqual({ unparsed: "maybe supported? {verdict: ..." });
    expect(record.error?.kind).toBe("invalid-response");
  });

  test("fails loudly when a model call is recorded without the gateway-reported version", () => {
    const dir = makeDir();
    const recorder = makeRecorder(dir);
    expect(() =>
      recorder.recordModelSuccess({
        sampleIndex: 0,
        cardId: "card-sp-01",
        promptHash: `sha256:${HEX_64}`,
        checker: "jev",
        model: { id: "typesafe-ai/jev", provider: "vertex-ai" } as any,
        verdict: "supported",
        usage: { latency_ms: 1, input_tokens: 1, output_tokens: 1, cost: null },
      }),
    ).toThrow(RunRecordValidationError);
    expect(existsSync(join(dir, "records.jsonl"))).toBe(false);
  });

  test("fails loudly before writing a malformed record", () => {
    const dir = makeDir();
    const recorder = makeRecorder(dir);
    expect(() =>
      recorder.recordDeterministicResult({
        sampleIndex: -1,
        cardId: "card-t-01",
        promptHash: "not-a-hash",
        checker: "rules",
        verdict: "supported",
      }),
    ).toThrow(RunRecordValidationError);
    expect(existsSync(join(dir, "records.jsonl"))).toBe(false);
  });

  test("refuses a repeat index beyond the manifest repeat count", () => {
    const dir = makeDir();
    const recorder = makeRecorder(dir, { repeatCount: 1 });
    expect(() =>
      recorder.recordDeterministicResult({
        sampleIndex: 0,
        repeatIndex: 1,
        cardId: "card-t-01",
        promptHash: `sha256:${HEX_64}`,
        checker: "rules",
        verdict: "supported",
      }),
    ).toThrow(/repeat_index/);
  });

  test("timestamps come from the injected clock, one per record", () => {
    const dir = makeDir();
    let tick = 0;
    const recorder = makeRecorder(dir, {
      now: () => new Date(Date.UTC(2026, 8, 20, 10, 0, tick++)),
    });
    recorder.recordDeterministicResult({ sampleIndex: 0, cardId: "card-a", promptHash: `sha256:${HEX_64}`, checker: "rules", verdict: "supported" });
    recorder.recordDeterministicResult({ sampleIndex: 1, cardId: "card-b", promptHash: `sha256:${HEX_64}`, checker: "rules", verdict: "unsupported" });
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const records = readRecords(dir);
    expect(manifest.created_at).toBe("2026-09-20T10:00:00.000Z");
    expect(records.map((r) => r.timestamp)).toEqual(["2026-09-20T10:00:01.000Z", "2026-09-20T10:00:02.000Z"]);
  });

  test("produces byte-identical record lines for identical inputs", () => {
    const dirA = makeDir();
    const dirB = makeDir();
    const inputs = {
      sampleIndex: 0,
      cardId: "card-t-01",
      promptHash: `sha256:${HEX_64}`,
      checker: "rules",
      verdict: "supported" as const,
      rawAnswer: { value_present: true },
    };
    makeRecorder(dirA).recordDeterministicResult(inputs);
    makeRecorder(dirB).recordDeterministicResult(inputs);
    expect(readFileSync(join(dirA, "records.jsonl"))).toEqual(readFileSync(join(dirB, "records.jsonl")));
  });

  test("rejects invalid manifest inputs at construction", () => {
    const dir = makeDir();
    expect(() =>
      new RunRecorder({
        runId: "run-bad",
        caseSetVersion: "v1",
        caseSetSha256: HEX_64,
        codeCommit: "fab38d7",
        promptSetSha256: "b".repeat(64),
        repeatCount: 1,
        checkers: ["rules"],
        outputDir: dir,
      }),
    ).toThrow(RunRecordValidationError);
  });

  test("counts the records it has written", () => {
    const dir = makeDir();
    const recorder = makeRecorder(dir);
    expect(recorder.recordCount).toBe(0);
    recorder.recordDeterministicResult({ sampleIndex: 0, cardId: "card-a", promptHash: `sha256:${HEX_64}`, checker: "rules", verdict: "supported" });
    recorder.recordDeterministicResult({ sampleIndex: 1, cardId: "card-b", promptHash: `sha256:${HEX_64}`, checker: "rules", verdict: "unsupported" });
    expect(recorder.recordCount).toBe(2);
  });

  test("record prompt hashes come from the shared canonical hashing", () => {
    const dir = makeDir();
    const recorder = makeRecorder(dir);
    const prompt = { card_id: "card-t-01", claim: { value: 45250 }, evidence_spans: [] };
    recorder.recordDeterministicResult({
      sampleIndex: 0,
      cardId: "card-t-01",
      promptHash: labeledSha256Of(prompt),
      checker: "rules",
      verdict: "supported",
    });
    const record = readRecords(dir)[0]!;
    expect(record.prompt_hash).toBe(labeledSha256Of(prompt));
  });
});
