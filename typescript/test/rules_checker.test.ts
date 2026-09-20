import { describe, expect, test } from "bun:test";
import { DEFAULT_CASE_SET_PATH, checkValuePresence, loadCaseSet, validateCaseSet } from "../src/case_set.ts";
import { buildPromptSet, promptHash, promptSetSha256, runRulesChecker } from "../src/run_records.ts";
import { minimalCaseSet } from "./case_set_fixture.ts";

function validatedCaseSet(): ReturnType<typeof loadCaseSet> {
  const data = minimalCaseSet();
  const violations = validateCaseSet(data);
  if (violations.length > 0) throw new Error(violations.join("\n"));
  return data as ReturnType<typeof loadCaseSet>;
}

describe("buildPromptSet", () => {
  test("builds one prompt per card, ordered by card id", () => {
    const prompts = buildPromptSet(validatedCaseSet());
    expect(prompts.map((p) => p.card_id)).toEqual(["card-t-01", "card-t-02", "card-t-03"]);
  });

  test("shows a checker only the claim and evidence spans, never the ground truth", () => {
    const prompts = buildPromptSet(validatedCaseSet());
    const serialized = JSON.stringify(prompts);
    expect(serialized).not.toContain("category");
    expect(serialized).not.toContain("expected_verdict");
    expect(serialized).not.toContain("rationale");
    for (const prompt of prompts) {
      expect(Object.keys(prompt).sort()).toEqual(["card_id", "claim", "evidence_spans"]);
    }
  });
});

describe("prompt hashing", () => {
  test("labels each card prompt with a stable sha256", () => {
    const [first, second] = buildPromptSet(validatedCaseSet());
    expect(promptHash(first!)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(promptHash(first!)).toBe(promptHash(first!));
    expect(promptHash(first!)).not.toBe(promptHash(second!));
  });

  test("hashes the whole frozen prompt set stably", () => {
    const prompts = buildPromptSet(validatedCaseSet());
    expect(promptSetSha256(prompts)).toMatch(/^[0-9a-f]{64}$/);
    expect(promptSetSha256(prompts)).toBe(promptSetSha256(buildPromptSet(validatedCaseSet())));
  });

  test("changes when a card's claim changes", () => {
    const before = promptSetSha256(buildPromptSet(validatedCaseSet()));
    const mutated: Record<string, any> = minimalCaseSet();
    mutated.cards[0].claim.value = 45251;
    const violations = validateCaseSet(mutated);
    expect(violations).toEqual([]);
    const after = promptSetSha256(buildPromptSet(mutated as ReturnType<typeof loadCaseSet>));
    expect(after).not.toBe(before);
  });
});

describe("runRulesChecker", () => {
  test("supports a card whose value appears in the span, even when the subject is wrong", () => {
    const results = runRulesChecker(validatedCaseSet());
    const byCard = new Map(results.map((r) => [r.cardId, r]));
    expect(byCard.get("card-t-01")?.verdict).toBe("supported");
    expect(byCard.get("card-t-02")?.verdict).toBe("supported");
    expect(byCard.get("card-t-03")?.verdict).toBe("unsupported");
  });

  test("reports the value-presence evidence as its raw answer", () => {
    const results = runRulesChecker(validatedCaseSet());
    const first = results.find((r) => r.cardId === "card-t-01")!;
    expect(first.rawAnswer).toEqual({ value_present: true });
  });

  test("numbers samples by the prompt-set order and carries each prompt hash", () => {
    const caseSet = validatedCaseSet();
    const prompts = buildPromptSet(caseSet);
    const results = runRulesChecker(caseSet);
    expect(results.map((r) => r.sampleIndex)).toEqual([0, 1, 2]);
    expect(results[0]!.promptHash).toBe(promptHash(prompts[0]!));
  });

  test("matches the naive value-presence expectation for every frozen card", () => {
    const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
    const presence = checkValuePresence(caseSet);
    const results = runRulesChecker(caseSet);
    expect(results).toHaveLength(50);
    for (const result of results) {
      expect(result.verdict).toBe(presence.get(result.cardId)?.present ? "supported" : "unsupported");
    }
    const supported = results.filter((r) => r.verdict === "supported").length;
    expect(supported).toBe(42);
    expect(results.length - supported).toBe(8);
  });
});
