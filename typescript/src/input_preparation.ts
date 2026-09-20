import type { Card, CaseSet, Claim, CodeDefinition } from "./case_set_schema.ts";
import { formatClaimValue } from "./value_presence.ts";
import type { Roster, RosterEntry } from "./roster.ts";

export interface ModelInput {
  whos_who: string;
  claim: {
    subject: string;
    field: string;
    value: string;
    unit: string;
    period_or_basis: string;
    as_of: string;
  };
  evidence: { artifact: string; lines: string; quote: string }[];
}

export type InputPreparationResult = { ok: true; input: ModelInput } | { ok: false; error: string };

export function householdSubjects(householdId: string, roster: Roster): RosterEntry[] {
  return roster.entries
    .filter((entry) => entry.household_id === householdId)
    .sort((a, b) => (a.subject_id < b.subject_id ? -1 : a.subject_id > b.subject_id ? 1 : 0));
}

export function whosWhoLine(householdId: string, roster: Roster): string {
  const people = householdSubjects(householdId, roster)
    .filter((entry) => entry.kind === "person")
    .map((entry) => entry.name);
  return `People in this household: ${people.join("; ")}.`;
}

function codeDescription(codes: CodeDefinition[], code: string): string | undefined {
  return codes.find((entry) => entry.code === code)?.description;
}

function translateClaim(claim: Claim, caseSet: CaseSet, roster: Roster): { claim: ModelInput["claim"] } | { error: string } {
  const entry = roster.entries.find((e) => e.subject_id === claim.subject_id);
  if (entry === undefined) {
    return {
      error:
        `input preparation: subject id "${claim.subject_id}" cannot be resolved to exactly one roster name; ` +
        "the card is never guessed, silently dropped, or counted as a factual catch",
    };
  }
  const fieldDescription = codeDescription(caseSet.fields, claim.field);
  if (fieldDescription === undefined) {
    return { error: `input preparation: field code "${claim.field}" is not in the case-set field vocabulary` };
  }
  const unitDescription = codeDescription(caseSet.units, claim.unit);
  if (unitDescription === undefined) {
    return { error: `input preparation: unit code "${claim.unit}" is not in the case-set unit vocabulary` };
  }
  return {
    claim: {
      subject: entry.name,
      field: `${claim.field} (${fieldDescription})`,
      value: formatClaimValue(claim.value),
      unit: `${claim.unit} (${unitDescription})`,
      period_or_basis: claim.period_or_basis,
      as_of: claim.as_of,
    },
  };
}

export function prepareModelInput(card: Card, caseSet: CaseSet, roster: Roster): InputPreparationResult {
  const claim = translateClaim(card.claim, caseSet, roster);
  if ("error" in claim) return { ok: false, error: claim.error };

  const entry = roster.entries.find((e) => e.subject_id === card.claim.subject_id)!;
  return {
    ok: true,
    input: {
      whos_who: whosWhoLine(entry.household_id, roster),
      claim: claim.claim,
      evidence: card.evidence_spans.map((span) => ({
        artifact: span.artifact_id,
        lines: `${span.line_start}-${span.line_end}`,
        quote: span.quote,
      })),
    },
  };
}
