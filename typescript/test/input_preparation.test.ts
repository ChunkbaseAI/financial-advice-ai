import { describe, expect, test } from "bun:test";
import { minimalCaseSet } from "./case_set_fixture.ts";
import type { Card, CaseSet } from "../src/case_set_schema.ts";
import { prepareModelInput, whosWhoLine, householdSubjects } from "../src/input_preparation.ts";
import type { Roster } from "../src/roster.ts";

function minimalRoster(): Roster {
  return {
    format_version: 1,
    roster_version: "1.0.0",
    description: "Minimal roster used to test input preparation.",
    case_set_version: "1.0.0",
    identity_only_rule: "Policy names omit person-attribution parentheticals; nothing else is changed.",
    entries: [
      { subject_id: "sub-t-alex", household_id: "hh-t", kind: "person", name: "Alex Field" },
      { subject_id: "sub-t-bea", household_id: "hh-t", kind: "person", name: "Bea Field" },
      { subject_id: "sub-t-plan", household_id: "hh-t", kind: "policy", name: "Test plan" },
    ],
  };
}

function preparedCard(caseSet: CaseSet, cardId: string): Card {
  return caseSet.cards.find((c) => c.id === cardId)!;
}

describe("whosWhoLine", () => {
  test("names the household's people only, in subject-id order, with no ownership hints", () => {
    expect(whosWhoLine("hh-t", minimalRoster())).toBe("People in this household: Alex Field; Bea Field.");
  });

  test("never names policies", () => {
    expect(whosWhoLine("hh-t", minimalRoster())).not.toContain("Test plan");
  });
});

describe("householdSubjects", () => {
  test("returns every subject of the household in subject-id order, persons and policies", () => {
    expect(householdSubjects("hh-t", minimalRoster()).map((e) => e.subject_id)).toEqual([
      "sub-t-alex",
      "sub-t-bea",
      "sub-t-plan",
    ]);
  });
});

describe("prepareModelInput", () => {
  const caseSet = minimalCaseSet() as unknown as CaseSet;
  const roster = minimalRoster();

  test("translates the claim via the roster and renders field, unit and value", () => {
    const result = prepareModelInput(preparedCard(caseSet, "card-t-01"), caseSet, roster);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.whos_who).toBe("People in this household: Alex Field; Bea Field.");
    expect(result.input.claim).toEqual({
      subject: "Test plan",
      field: "pension.plan-value (Current market value of the subject's defined-contribution pension plan.)",
      value: "45,250",
      unit: "GBP (Pounds sterling, whole amount.)",
      period_or_basis: "plan value as at 1 April 2026",
      as_of: "2026-04-01",
    });
    expect(result.input.evidence).toEqual([
      { artifact: "art-t-statement", lines: "1-1", quote: "Plan value as at 1 April 2026: £45,250" },
    ]);
  });

  test("a wrongly-attributed card keeps the wrong name", () => {
    const result = prepareModelInput(preparedCard(caseSet, "card-t-02"), caseSet, roster);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.claim.subject).toBe("Bea Field");
  });

  test("formats values the way the artifacts write figures", () => {
    const card = structuredClone(preparedCard(caseSet, "card-t-01"));
    card.claim.value = 230.25;
    const result = prepareModelInput(card, caseSet, roster);
    expect(result.ok && result.input.claim.value).toBe("230.25");
  });

  test("renders multi-line spans as start-end", () => {
    const card = structuredClone(preparedCard(caseSet, "card-t-01"));
    card.evidence_spans[0]!.line_end = 2;
    card.evidence_spans[0]!.quote = "Plan value as at 1 April 2026: £45,250\nPlan holder: Mr Alex Field";
    const result = prepareModelInput(card, caseSet, roster);
    expect(result.ok && result.input.evidence[0]!.lines).toBe("1-2");
  });

  test("records an input-preparation error when the subject ID cannot be resolved to exactly one name", () => {
    const card = structuredClone(preparedCard(caseSet, "card-t-01"));
    card.claim.subject_id = "sub-t-nobody";
    const result = prepareModelInput(card, caseSet, roster);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("sub-t-nobody");
    expect(result.error).toContain("input preparation");
  });

  test("is deterministic: the same card always yields the identical model-visible input", () => {
    const a = prepareModelInput(preparedCard(caseSet, "card-t-03"), caseSet, roster);
    const b = prepareModelInput(preparedCard(caseSet, "card-t-03"), caseSet, roster);
    expect(a).toEqual(b);
  });
});
