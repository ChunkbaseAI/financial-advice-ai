import type { CaseSet, Claim, EvidenceSpan } from "./case_set_schema.ts";
import { checkValuePresence } from "./value_presence.ts";
import { labeledSha256Of, sha256Of } from "./hashing.ts";
import type { RecordedVerdict } from "./run_record_schema.ts";

export interface CardPrompt {
  card_id: string;
  claim: Claim;
  evidence_spans: EvidenceSpan[];
}

export function buildPromptSet(caseSet: CaseSet): CardPrompt[] {
  return [...caseSet.cards]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((card) => ({
      card_id: card.id,
      claim: card.claim,
      evidence_spans: card.evidence_spans,
    }));
}

export function promptHash(prompt: CardPrompt): string {
  return labeledSha256Of(prompt);
}

export function promptSetSha256(prompts: CardPrompt[]): string {
  return sha256Of(prompts);
}

export interface RulesCheckResult {
  cardId: string;
  sampleIndex: number;
  promptHash: string;
  verdict: RecordedVerdict;
  rawAnswer: { value_present: boolean };
}

export function runRulesChecker(caseSet: CaseSet): RulesCheckResult[] {
  const prompts = buildPromptSet(caseSet);
  const presence = checkValuePresence(caseSet);
  return prompts.map((prompt, sampleIndex) => {
    const valuePresent = presence.get(prompt.card_id)?.present ?? false;
    return {
      cardId: prompt.card_id,
      sampleIndex,
      promptHash: promptHash(prompt),
      verdict: valuePresent ? ("supported" as const) : ("unsupported" as const),
      rawAnswer: { value_present: valuePresent },
    };
  });
}
