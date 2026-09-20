import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CASE_SET_LOCK_PATH,
  DEFAULT_CASE_SET_PATH,
  checkValuePresence,
  formatClaimValue,
  loadCaseSet,
  validateCaseSet,
  valuePresent,
  verifyCaseSetLock,
} from "../src/case_set.ts";

function minimalCaseSet(): Record<string, any> {
  return {
    format_version: 1,
    case_set_version: "1.0.0",
    description: "Minimal synthetic case set used to test the schema.",
    provenance: {
      synthetic: true,
      jurisdiction: "GB",
      statement: "All people, households and figures are fictional.",
    },
    households: [{ id: "hh-t", name: "Test household" }],
    subjects: [
      { id: "sub-t-alex", household_id: "hh-t", kind: "person", name: "Alex Field" },
      { id: "sub-t-bea", household_id: "hh-t", kind: "person", name: "Bea Field" },
      { id: "sub-t-plan", household_id: "hh-t", kind: "policy", name: "Test plan", owner_subject_id: "sub-t-alex" },
    ],
    fields: [
      { code: "pension.plan-value", description: "Current market value of the subject's defined-contribution pension plan." },
      { code: "salary.annual-gross", description: "The subject's gross annual salary before tax." },
    ],
    units: [
      { code: "GBP", description: "Pounds sterling, whole amount." },
      { code: "GBP/year", description: "Pounds sterling per year." },
    ],
    source_artifacts: [
      {
        id: "art-t-transcript",
        household_id: "hh-t",
        revision: "r1",
        kind: "meeting-transcript",
        title: "Test review meeting",
        date: "2026-04-17",
        lines: [
          "Adviser: Alex, your basic salary is £52,000.",
          "Bea: And the plan was worth £40,000 two years ago.",
          "Adviser: We'll confirm the plan against the statement.",
        ],
      },
      {
        id: "art-t-statement",
        household_id: "hh-t",
        revision: "r1",
        kind: "provider-document",
        title: "Test plan statement",
        date: "2026-04-02",
        lines: ["Plan value as at 1 April 2026: £45,250", "Plan holder: Mr Alex Field"],
      },
    ],
    category_distribution: {
      correct: 1,
      "wrong-subject": 1,
      "stale-value": 0,
      hypothetical: 0,
      unsupported: 0,
      "wrong-basis": 0,
      conflict: 1,
    },
    cards: [
      {
        id: "card-t-01",
        category: "correct",
        expected_verdict: "supported",
        rationale: "The statement states the plan value as at 1 April 2026, matching the claim.",
        claim: {
          subject_id: "sub-t-plan",
          field: "pension.plan-value",
          value: 45250,
          unit: "GBP",
          period_or_basis: "plan value as at 1 April 2026",
          as_of: "2026-04-01",
        },
        evidence_spans: [{ artifact_id: "art-t-statement", line_start: 1, line_end: 1, quote: "Plan value as at 1 April 2026: £45,250" }],
      },
      {
        id: "card-t-02",
        category: "wrong-subject",
        expected_verdict: "unsupported",
        rationale: "The salary figure belongs to Alex, not Bea.",
        claim: {
          subject_id: "sub-t-bea",
          field: "salary.annual-gross",
          value: 52000,
          unit: "GBP/year",
          period_or_basis: "current basic gross annual salary",
          as_of: "2026-04-17",
        },
        evidence_spans: [{ artifact_id: "art-t-transcript", line_start: 1, line_end: 1, quote: "Adviser: Alex, your basic salary is £52,000." }],
      },
      {
        id: "card-t-03",
        category: "conflict",
        expected_verdict: "unsupported",
        rationale: "The transcript and the statement disagree, and the claimed value matches neither.",
        claim: {
          subject_id: "sub-t-plan",
          field: "pension.plan-value",
          value: 43000,
          unit: "GBP",
          period_or_basis: "current plan value",
          as_of: "2026-04-17",
        },
        evidence_spans: [
          { artifact_id: "art-t-transcript", line_start: 2, line_end: 2, quote: "Bea: And the plan was worth £40,000 two years ago." },
          { artifact_id: "art-t-statement", line_start: 1, line_end: 1, quote: "Plan value as at 1 April 2026: £45,250" },
        ],
      },
    ],
  };
}

describe("validateCaseSet", () => {
  test("accepts a minimal well-formed case set", () => {
    expect(validateCaseSet(minimalCaseSet())).toEqual([]);
  });

  const mutations: Array<[string, (cs: Record<string, any>) => void, string]> = [
    ["a missing format_version", (cs) => delete cs.format_version, "format_version"],
    ["an unsupported format_version", (cs) => cs.format_version = 2, "format_version"],
    ["a non-semver case_set_version", (cs) => cs.case_set_version = "v1", "case_set_version"],
    ["an unknown category", (cs) => cs.cards[0].category = "mistake", "category"],
    ["a correct card with an unsupported verdict", (cs) => cs.cards[0].expected_verdict = "unsupported", "expected_verdict"],
    ["a wrong-subject card with a supported verdict", (cs) => cs.cards[1].expected_verdict = "supported", "expected_verdict"],
    ["an unknown verdict", (cs) => cs.cards[0].expected_verdict = "maybe", "expected_verdict"],
    ["an unknown claim subject", (cs) => cs.cards[0].claim.subject_id = "sub-t-nobody", "subject_id"],
    ["an unknown claim field", (cs) => cs.cards[0].claim.field = "pension.mystery", "field"],
    ["an unknown claim unit", (cs) => cs.cards[0].claim.unit = "EUR", "unit"],
    ["a value with three decimal places", (cs) => cs.cards[0].claim.value = 45250.125, "value"],
    ["a negative value", (cs) => cs.cards[0].claim.value = -5, "value"],
    ["a boolean value", (cs) => cs.cards[0].claim.value = true, "value"],
    ["a non-ISO as_of date", (cs) => cs.cards[0].claim.as_of = "17 April 2026", "as_of"],
    ["an empty period_or_basis", (cs) => cs.cards[0].claim.period_or_basis = " ", "period_or_basis"],
    ["an unknown artifact in a span", (cs) => cs.cards[0].evidence_spans[0].artifact_id = "art-t-ghost", "artifact_id"],
    ["a zero line_start", (cs) => cs.cards[0].evidence_spans[0].line_start = 0, "line_start"],
    ["a line_end beyond the artifact", (cs) => cs.cards[0].evidence_spans[0].line_end = 9, "line_end"],
    ["a quote that does not match the artifact lines", (cs) => cs.cards[0].evidence_spans[0].quote = "Plan value: £99,999", "quote"],
    ["a conflict card citing one artifact", (cs) => cs.cards[2].evidence_spans = [cs.cards[2].evidence_spans[0]], "conflict"],
    ["an empty evidence_spans list", (cs) => cs.cards[0].evidence_spans = [], "evidence_spans"],
    ["a missing rationale", (cs) => delete cs.cards[0].rationale, "rationale"],
    ["duplicate card ids", (cs) => cs.cards[1].id = "card-t-01", "id"],
    ["a recorded distribution that disagrees with the cards", (cs) => cs.cards[1].category = "unsupported", "category_distribution"],
    ["a missing distribution key", (cs) => delete cs.category_distribution.conflict, "category_distribution"],
    ["an unknown policy owner", (cs) => cs.subjects[2].owner_subject_id = "sub-t-ghost", "owner_subject_id"],
    ["a subject pointing at an unknown household", (cs) => cs.subjects[0].household_id = "hh-ghost", "household_id"],
    ["an artifact with an empty lines list", (cs) => cs.source_artifacts[1].lines = [], "lines"],
    ["an artifact with an unknown kind", (cs) => cs.source_artifacts[1].kind = "email", "kind"],
  ];

  for (const [name, mutate, needle] of mutations) {
    test(`rejects ${name} with a violation naming it`, () => {
      const cs = minimalCaseSet();
      mutate(cs);
      const violations = validateCaseSet(cs);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.includes(needle))).toBe(true);
    });
  }

  test("collects every violation rather than stopping at the first", () => {
    const cs = minimalCaseSet();
    cs.format_version = 2;
    cs.cards[0].claim.unit = "EUR";
    const violations = validateCaseSet(cs);
    expect(violations.some((v) => v.includes("format_version"))).toBe(true);
    expect(violations.some((v) => v.includes("unit"))).toBe(true);
  });
});

describe("loadCaseSet", () => {
  test("loads and validates a case-set file", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-"));
    const path = join(dir, "case_set.json");
    writeFileSync(path, JSON.stringify(minimalCaseSet()));
    const loaded = loadCaseSet(path);
    expect(loaded.case_set_version).toBe("1.0.0");
    expect(loaded.cards).toHaveLength(3);
  });

  test("throws a validation error listing violations for a malformed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-"));
    const path = join(dir, "case_set.json");
    const cs: Record<string, any> = minimalCaseSet();
    cs.cards[0].claim.value = -5;
    writeFileSync(path, JSON.stringify(cs));
    expect(() => loadCaseSet(path)).toThrow(/value/);
  });

  test("throws a useful error for a file that is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-"));
    const path = join(dir, "case_set.json");
    writeFileSync(path, "{not json");
    expect(() => loadCaseSet(path)).toThrow(/JSON/);
  });
});

describe("value presence", () => {
  const examples: Array<[string, number, boolean]> = [
    ["Current plan value: £207,432", 207432, true],
    ["It was about £185,000 two years ago.", 185000, true],
    ["a fixed rate of 2.84% until November", 2.84, true],
    ["the State Pension is £230.25 a week", 230.25, true],
    ["The mortgage is down to about £186,000.", 186400, false],
    ["Fund A: £5,000", 5, false],
    ["a pot of £1,207,432", 207432, false],
    ["could be worth around £350,000 by your 60th", 350000, true],
    ["contributing 8% of basic salary", 8, true],
    ["interest paid: £3,412.68", 3412.68, true],
    ["remaining term of 18 years", 18, true],
    ["your basic salary is £52,000.", 52000, true],
    ["the fund might support around £9,750 a year.", 9750, true],
    ["a rate of 230.255 applied", 230.25, false],
    ["a pot of £52,000,000", 52000, false],
    ["Still £78,600, though the car allowance sits on top.", 78600, true],
    ["around £91,600, and the rest would buy less income", 91600, true],
  ];

  for (const [text, value, expected] of examples) {
    test(`"${text}" ${expected ? "contains" : "does not contain"} ${value}`, () => {
      expect(valuePresent(text, formatClaimValue(value))).toBe(expected);
    });
  }

  test("formats claim values the way the artifacts write them", () => {
    expect(formatClaimValue(207432)).toBe("207,432");
    expect(formatClaimValue(230.25)).toBe("230.25");
    expect(formatClaimValue(5)).toBe("5");
    expect(formatClaimValue(3412.68)).toBe("3,412.68");
  });

  test("reports presence per card with the naive expectation for its category", () => {
    const results = checkValuePresence(validatedCaseSet(minimalCaseSet()));
    expect(results.get("card-t-01")).toEqual({ present: true, expectedPresent: true });
    expect(results.get("card-t-02")).toEqual({ present: true, expectedPresent: true });
    expect(results.get("card-t-03")).toEqual({ present: false, expectedPresent: false });
  });

  test("detects cards that break the required property", () => {
    const valueInEvidence: Record<string, any> = minimalCaseSet();
    valueInEvidence.cards[2].claim.value = 40000;
    const conflictsWithValue = checkValuePresence(validatedCaseSet(valueInEvidence));
    expect(conflictsWithValue.get("card-t-03")).toEqual({ present: true, expectedPresent: false });

    const absentValue: Record<string, any> = minimalCaseSet();
    absentValue.cards[1].claim.value = 999;
    const wrongSubjectWithoutValue = checkValuePresence(validatedCaseSet(absentValue));
    expect(wrongSubjectWithoutValue.get("card-t-02")).toEqual({ present: false, expectedPresent: true });
  });
});

describe("verifyCaseSetLock", () => {
  test("passes when the lock records the file's sha256", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-"));
    const caseSetPath = join(dir, "case_set.json");
    const lockPath = join(dir, "case_set.lock.json");
    const raw = JSON.stringify(minimalCaseSet());
    writeFileSync(caseSetPath, raw);
    writeFileSync(
      lockPath,
      JSON.stringify({ case_set_file: "case_set.json", case_set_version: "1.0.0", sha256: createHash("sha256").update(raw).digest("hex") }),
    );
    const result = verifyCaseSetLock(caseSetPath, lockPath);
    expect(result.caseSetVersion).toBe("1.0.0");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("throws when the file no longer matches the frozen hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-"));
    const caseSetPath = join(dir, "case_set.json");
    const lockPath = join(dir, "case_set.lock.json");
    writeFileSync(caseSetPath, JSON.stringify(minimalCaseSet()));
    writeFileSync(lockPath, JSON.stringify({ case_set_file: "case_set.json", case_set_version: "1.0.0", sha256: "0".repeat(64) }));
    expect(() => verifyCaseSetLock(caseSetPath, lockPath)).toThrow(/frozen|sha256/i);
  });

  test("throws when the lock version disagrees with the case set", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-"));
    const caseSetPath = join(dir, "case_set.json");
    const lockPath = join(dir, "case_set.lock.json");
    const raw = JSON.stringify(minimalCaseSet());
    writeFileSync(caseSetPath, raw);
    writeFileSync(
      lockPath,
      JSON.stringify({ case_set_file: "case_set.json", case_set_version: "9.9.9", sha256: createHash("sha256").update(raw).digest("hex") }),
    );
    expect(() => verifyCaseSetLock(caseSetPath, lockPath)).toThrow(/version/i);
  });
});

describe("frozen case set v1", () => {
  test("loads from the shared fixtures directory", () => {
    const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
    expect(caseSet.format_version).toBe(1);
    expect(caseSet.case_set_version).toBe("1.0.0");
  });

  test("contains between 40 and 50 cards", () => {
    const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
    expect(caseSet.cards.length).toBeGreaterThanOrEqual(40);
    expect(caseSet.cards.length).toBeLessThanOrEqual(50);
  });

  test("matches the recorded category distribution with roughly half correct", () => {
    const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
    const actual: Record<string, number> = {};
    for (const category of Object.keys(caseSet.category_distribution)) actual[category] = 0;
    for (const card of caseSet.cards) actual[card.category]! += 1;
    expect(actual).toEqual(caseSet.category_distribution);
    expect(actual).toEqual({
      correct: 25,
      "wrong-subject": 5,
      "stale-value": 4,
      hypothetical: 4,
      unsupported: 4,
      "wrong-basis": 4,
      conflict: 4,
    });
    const correctShare = actual["correct"]! / caseSet.cards.length;
    expect(correctShare).toBeGreaterThanOrEqual(0.45);
    expect(correctShare).toBeLessThanOrEqual(0.55);
  });

  test("satisfies the naive value-presence property for every card", () => {
    const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
    const results = checkValuePresence(caseSet);
    const broken = [...results.entries()].filter(([, r]) => r.present !== r.expectedPresent);
    expect(broken).toEqual([]);

    const mustPassNaively = ["correct", "wrong-subject", "stale-value", "hypothetical", "wrong-basis"];
    for (const [cardId, result] of results) {
      const card = caseSet.cards.find((c) => c.id === cardId)!;
      expect(result.present).toBe(mustPassNaively.includes(card.category));
    }
  });

  test("conflict cards cite at least two distinct source artifacts", () => {
    const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
    for (const card of caseSet.cards.filter((c) => c.category === "conflict")) {
      const distinctArtifacts = new Set(card.evidence_spans.map((s) => s.artifact_id));
      expect(distinctArtifacts.size).toBeGreaterThanOrEqual(2);
    }
  });

  test("verifies against the frozen lock", () => {
    const result = verifyCaseSetLock(DEFAULT_CASE_SET_PATH, DEFAULT_CASE_SET_LOCK_PATH);
    expect(result.caseSetVersion).toBe("1.0.0");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

function validatedCaseSet(data: Record<string, any>): ReturnType<typeof loadCaseSet> {
  const violations = validateCaseSet(data);
  if (violations.length > 0) throw new Error(violations.join("\n"));
  return data as ReturnType<typeof loadCaseSet>;
}
