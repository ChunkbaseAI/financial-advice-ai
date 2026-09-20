import { describe, expect, test } from "bun:test";
import { combineChecks, mapCategoricalVerdict, mapLlmThree, mapNoul, mapOwnership, type CheckOutcome, type GateThresholds } from "../src/decision_mapping.ts";

const thresholds: GateThresholds = {
  noulPassAtOrAbove: 0.9,
  noulUnsupportedAtOrBelow: 0.1,
  ownershipPassAtOrAbove: 0.9,
};

describe("mapNoul", () => {
  test("passes at or above the pass threshold", () => {
    expect(mapNoul(0.9, thresholds)).toBe<CheckOutcome>("pass");
    expect(mapNoul(0.97, thresholds)).toBe<CheckOutcome>("pass");
    expect(mapNoul(1, thresholds)).toBe<CheckOutcome>("pass");
  });

  test("is unsupported at or below the unsupported threshold", () => {
    expect(mapNoul(0.1, thresholds)).toBe<CheckOutcome>("unsupported");
    expect(mapNoul(0.03, thresholds)).toBe<CheckOutcome>("unsupported");
    expect(mapNoul(0, thresholds)).toBe<CheckOutcome>("unsupported");
  });

  test("is uncertain strictly between the thresholds", () => {
    expect(mapNoul(0.89, thresholds)).toBe<CheckOutcome>("uncertain");
    expect(mapNoul(0.11, thresholds)).toBe<CheckOutcome>("uncertain");
    expect(mapNoul(0.5, thresholds)).toBe<CheckOutcome>("uncertain");
  });
});

describe("mapOwnership", () => {
  const specific = ["Alex Field", "Bea Field", "Test plan", "joint ownership"];

  test("passes when the claimed subject's probability reaches the threshold", () => {
    expect(
      mapOwnership({ choice: "Alex Field", probabilities: { "Alex Field": 0.92, "Bea Field": 0.08 } }, "Alex Field", specific, thresholds),
    ).toBe<CheckOutcome>("pass");
  });

  test("is a mismatch when a different specific option reaches the threshold", () => {
    expect(
      mapOwnership({ choice: "Bea Field", probabilities: { "Alex Field": 0.05, "Bea Field": 0.93 } }, "Alex Field", specific, thresholds),
    ).toBe<CheckOutcome>("mismatch");
    expect(
      mapOwnership(
        { choice: "joint ownership", probabilities: { "Alex Field": 0.04, "joint ownership": 0.94 } },
        "Test plan",
        specific,
        thresholds,
      ),
    ).toBe<CheckOutcome>("mismatch");
  });

  test("is uncertain when no option reaches the threshold", () => {
    expect(
      mapOwnership({ choice: "Bea Field", probabilities: { "Alex Field": 0.5, "Bea Field": 0.45 } }, "Alex Field", specific, thresholds),
    ).toBe<CheckOutcome>("uncertain");
  });

  test("is uncertain regardless of probability when the selected answer is unknown or not stated", () => {
    expect(
      mapOwnership(
        { choice: "unknown", probabilities: { "Alex Field": 0.91, unknown: 0.09 } },
        "Alex Field",
        specific,
        thresholds,
      ),
    ).toBe<CheckOutcome>("uncertain");
    expect(
      mapOwnership(
        { choice: "not stated", probabilities: { "Alex Field": 0.95, "not stated": 0.05 } },
        "Alex Field",
        specific,
        thresholds,
      ),
    ).toBe<CheckOutcome>("uncertain");
  });

  test("treats a missing probability for the claimed subject as no support", () => {
    expect(
      mapOwnership({ choice: "Bea Field", probabilities: { "Bea Field": 0.91 } }, "Alex Field", specific, thresholds),
    ).toBe<CheckOutcome>("mismatch");
  });
});

describe("combineChecks", () => {
  test("a card passes only when all three checks pass, and the outcome is named honestly", () => {
    const decision = combineChecks({ ownership: "pass", value_support: "pass", time_support: "pass" });
    expect(decision.outcome).toBe("pass");
    expect(decision.verdict).toBe("supported");
    expect(decision.review_reason).toBeNull();
  });

  test("any failing check sends the card to review", () => {
    expect(combineChecks({ ownership: "pass", value_support: "uncertain", time_support: "pass" }).outcome).toBe("review");
    expect(combineChecks({ ownership: "mismatch", value_support: "pass", time_support: "pass" }).outcome).toBe("review");
    expect(combineChecks({ ownership: "pass", value_support: "pass", time_support: "unsupported" }).outcome).toBe("review");
  });

  test("the review reason is the most severe failing check: unsupported over mismatch over uncertain", () => {
    expect(
      combineChecks({ ownership: "mismatch", value_support: "unsupported", time_support: "uncertain" }).review_reason,
    ).toBe("unsupported");
    expect(combineChecks({ ownership: "mismatch", value_support: "uncertain", time_support: "uncertain" }).review_reason).toBe(
      "mismatch",
    );
    expect(combineChecks({ ownership: "pass", value_support: "uncertain", time_support: "uncertain" }).review_reason).toBe(
      "uncertain",
    );
  });

  test("ties break by check order: ownership, value_support, time_support", () => {
    expect(combineChecks({ ownership: "unsupported", value_support: "unsupported", time_support: "pass" }).review_reason).toBe(
      "unsupported",
    );
    expect(combineChecks({ ownership: "pass", value_support: "uncertain", time_support: "mismatch" }).review_reason).toBe(
      "mismatch",
    );
  });
});

describe("mapLlmThree", () => {
  test("maps categorical verdicts onto the same all-three-pass policy", () => {
    const decision = mapLlmThree({ ownership: "supported", value_support: "supported", time_support: "supported" });
    expect(decision.outcome).toBe("pass");
    expect(decision.verdict).toBe("supported");
  });

  test("a single unsupported question sends the card to review with that reason", () => {
    const decision = mapLlmThree({ ownership: "supported", value_support: "unsupported", time_support: "uncertain" });
    expect(decision.outcome).toBe("review");
    expect(decision.review_reason).toBe("unsupported");
  });

  test("uncertain questions review as uncertain when nothing is unsupported", () => {
    const decision = mapLlmThree({ ownership: "uncertain", value_support: "supported", time_support: "uncertain" });
    expect(decision.outcome).toBe("review");
    expect(decision.review_reason).toBe("uncertain");
  });
});

describe("mapCategoricalVerdict", () => {
  test("only a supported verdict passes", () => {
    expect(mapCategoricalVerdict("supported")).toMatchObject({ outcome: "pass", verdict: "supported", review_reason: null });
    expect(mapCategoricalVerdict("unsupported")).toMatchObject({ outcome: "review", verdict: "unsupported", review_reason: "unsupported" });
    expect(mapCategoricalVerdict("uncertain")).toMatchObject({ outcome: "review", verdict: "uncertain", review_reason: "uncertain" });
  });
});
