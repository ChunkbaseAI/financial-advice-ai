import { CHECK_ORDER, type CheckName, type LlmVerdict, type ReviewReason } from "./checker_protocol.ts";

export type CheckOutcome = "pass" | "mismatch" | "uncertain" | "unsupported";

export interface GateThresholds {
  noulPassAtOrAbove: number;
  noulUnsupportedAtOrBelow: number;
  ownershipPassAtOrAbove: number;
}

export interface JevNoulAnswer {
  noul: number;
}

export interface JevChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence?: number;
}

export interface CardDecision {
  checks: Record<CheckName, CheckOutcome> | null;
  outcome: "pass" | "review";
  verdict: "supported" | ReviewReason;
  review_reason: ReviewReason | null;
}

export function mapNoul(probability: number, thresholds: GateThresholds): CheckOutcome {
  if (probability >= thresholds.noulPassAtOrAbove) return "pass";
  if (probability <= thresholds.noulUnsupportedAtOrBelow) return "unsupported";
  return "uncertain";
}

export function mapOwnership(
  answer: JevChoiceAnswer,
  claimedSubject: string,
  specificOptions: string[],
  thresholds: GateThresholds,
): CheckOutcome {
  if (answer.choice === "unknown" || answer.choice === "not stated") return "uncertain";
  const probabilities = answer.probabilities ?? {};
  if ((probabilities[claimedSubject] ?? 0) >= thresholds.ownershipPassAtOrAbove) return "pass";
  const someoneElseClaimsIt = specificOptions.some(
    (option) => option !== claimedSubject && (probabilities[option] ?? 0) >= thresholds.ownershipPassAtOrAbove,
  );
  return someoneElseClaimsIt ? "mismatch" : "uncertain";
}

const SEVERITY: Record<CheckOutcome, number> = { unsupported: 3, mismatch: 2, uncertain: 1, pass: 0 };

export function combineChecks(checks: Record<CheckName, CheckOutcome>): CardDecision {
  const allPass = CHECK_ORDER.every((name) => checks[name] === "pass");
  if (allPass) return { checks, outcome: "pass", verdict: "supported", review_reason: null };

  let worst: { name: CheckName; outcome: CheckOutcome } | undefined;
  for (const name of CHECK_ORDER) {
    const outcome = checks[name];
    if (outcome === "pass") continue;
    if (worst === undefined || SEVERITY[outcome] > SEVERITY[worst.outcome]) {
      worst = { name, outcome };
    }
  }
  const reviewReason = (worst?.outcome ?? "uncertain") as ReviewReason;
  return { checks, outcome: "review", verdict: reviewReason, review_reason: reviewReason };
}

const LLM_TO_OUTCOME: Record<LlmVerdict, CheckOutcome> = {
  supported: "pass",
  unsupported: "unsupported",
  uncertain: "uncertain",
};

export function mapLlmThree(answers: Record<CheckName, LlmVerdict>): CardDecision {
  return combineChecks({
    ownership: LLM_TO_OUTCOME[answers.ownership],
    value_support: LLM_TO_OUTCOME[answers.value_support],
    time_support: LLM_TO_OUTCOME[answers.time_support],
  });
}

export function mapCategoricalVerdict(verdict: LlmVerdict): CardDecision {
  if (verdict === "supported") return { checks: null, outcome: "pass", verdict: "supported", review_reason: null };
  return { checks: null, outcome: "review", verdict, review_reason: verdict };
}
