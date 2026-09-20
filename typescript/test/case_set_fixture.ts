export function minimalCaseSet(): Record<string, any> {
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
