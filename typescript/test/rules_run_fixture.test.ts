import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_CASE_SET_LOCK_PATH,
  DEFAULT_CASE_SET_PATH,
  loadCaseSet,
  verifyCaseSetLock,
} from "../src/case_set.ts";
import {
  buildPromptSet,
  promptHash,
  promptSetSha256,
  runRulesChecker,
  validateRunManifest,
  validateRunRecord,
  type RunManifest,
  type RunRecord,
} from "../src/run_records.ts";

const FIXTURE_DIR = new URL("../../fixtures/rules_run_v1/", import.meta.url);

function loadFixtureManifest(): RunManifest {
  return JSON.parse(readFileSync(new URL("manifest.json", FIXTURE_DIR), "utf8")) as RunManifest;
}

function loadFixtureRecords(): RunRecord[] {
  return readFileSync(new URL("records.jsonl", FIXTURE_DIR), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RunRecord);
}

describe("frozen rules run fixture", () => {
  test("manifest validates and pins the frozen case set", () => {
    const manifest = loadFixtureManifest();
    expect(validateRunManifest(manifest)).toEqual([]);
    const lock = verifyCaseSetLock(DEFAULT_CASE_SET_PATH, DEFAULT_CASE_SET_LOCK_PATH);
    expect(manifest.case_set_version).toBe(lock.caseSetVersion);
    expect(manifest.case_set_sha256).toBe(lock.sha256);
    expect(manifest.checkers).toEqual(["rules"]);
    expect(manifest.repeat_count).toBe(1);
    expect(manifest.run_id.startsWith("rules-")).toBe(true);
  });

  test("manifest pins the prompt set derived from the frozen case set", () => {
    const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
    const manifest = loadFixtureManifest();
    expect(manifest.prompt_set_sha256).toBe(promptSetSha256(buildPromptSet(caseSet)));
  });

  test("every record validates against the run record schema", () => {
    const records = loadFixtureRecords();
    expect(records).toHaveLength(50);
    for (const record of records) {
      expect(validateRunRecord(record)).toEqual([]);
    }
  });

  test("record count equals the card count times the repeat count", () => {
    const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
    const manifest = loadFixtureManifest();
    expect(loadFixtureRecords()).toHaveLength(caseSet.cards.length * manifest.repeat_count);
  });

  test("every record is re-derivable from the frozen case set", () => {
    const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
    const prompts = buildPromptSet(caseSet);
    const expected = new Map(runRulesChecker(caseSet).map((r) => [r.cardId, r]));
    const manifest = loadFixtureManifest();
    const records = loadFixtureRecords();
    for (const record of records) {
      const result = expected.get(record.card_id);
      expect(result).toBeDefined();
      expect(record.run_id).toBe(manifest.run_id);
      expect(record.checker).toBe("rules");
      expect(record.sample_index).toBe(result!.sampleIndex);
      expect(record.repeat_index).toBe(0);
      expect(record.prompt_hash).toBe(promptHash(prompts[result!.sampleIndex]!));
      expect(record.verdict).toBe(result!.verdict);
      expect(record.raw_answer).toEqual({ value_present: result!.rawAnswer.value_present });
      expect(record.model).toBeNull();
      expect(record.usage).toBeNull();
      expect(record.error).toBeNull();
    }
  });

  test("records never leak the ground-truth card fields", () => {
    const serialized = readFileSync(new URL("records.jsonl", FIXTURE_DIR), "utf8");
    expect(serialized).not.toContain("category");
    expect(serialized).not.toContain("expected_verdict");
    expect(serialized).not.toContain("rationale");
  });
});
