import type { CaseSet, Category } from "./case_set_schema.ts";

const VALUE_PRESENCE_PASS_CATEGORIES = new Set<Category>([
  "correct",
  "wrong-subject",
  "stale-value",
  "hypothetical",
  "wrong-basis",
]);

export function formatClaimValue(value: number): string {
  const text = String(value);
  const dot = text.indexOf(".");
  const integerPart = dot === -1 ? text : text.slice(0, dot);
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dot === -1 ? grouped : `${grouped}${text.slice(dot)}`;
}

export function valuePresent(text: string, formattedValue: string): boolean {
  const escaped = formattedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d.,])${escaped}(?!\\d|,\\d|\\.\\d)`).test(text);
}

export interface ValuePresenceResult {
  present: boolean;
  expectedPresent: boolean;
}

export function checkValuePresence(caseSet: CaseSet): Map<string, ValuePresenceResult> {
  const results = new Map<string, ValuePresenceResult>();
  for (const card of caseSet.cards) {
    const evidence = card.evidence_spans.map((span) => span.quote).join("\n");
    const present = valuePresent(evidence, formatClaimValue(card.claim.value));
    results.set(card.id, {
      present,
      expectedPresent: VALUE_PRESENCE_PASS_CATEGORIES.has(card.category),
    });
  }
  return results;
}
