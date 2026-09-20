import { readFileSync } from "node:fs";

export const FORMAT_VERSION = 1;

export const CATEGORIES = [
  "correct",
  "wrong-subject",
  "stale-value",
  "hypothetical",
  "unsupported",
  "wrong-basis",
  "conflict",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const VERDICTS = ["supported", "unsupported"] as const;
export type ExpectedVerdict = (typeof VERDICTS)[number];

const SUBJECT_KINDS = ["person", "policy"] as const;
const ARTIFACT_KINDS = ["meeting-transcript", "provider-document"] as const;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const VERSION = /^\d+\.\d+\.\d+$/;

export const DEFAULT_CASE_SET_PATH = new URL("../../fixtures/case_set_v1.json", import.meta.url);
export const DEFAULT_CASE_SET_LOCK_PATH = new URL("../../fixtures/case_set_v1.lock.json", import.meta.url);

export interface Household {
  id: string;
  name: string;
}

export interface PersonSubject {
  id: string;
  household_id: string;
  kind: "person";
  name: string;
}

export interface PolicySubject {
  id: string;
  household_id: string;
  kind: "policy";
  name: string;
  owner_subject_id?: string;
}

export type Subject = PersonSubject | PolicySubject;

export interface CodeDefinition {
  code: string;
  description: string;
}

export interface SourceArtifact {
  id: string;
  household_id: string;
  revision: string;
  kind: "meeting-transcript" | "provider-document";
  title: string;
  date: string;
  lines: string[];
}

export interface EvidenceSpan {
  artifact_id: string;
  line_start: number;
  line_end: number;
  quote: string;
}

export interface Claim {
  subject_id: string;
  field: string;
  value: number;
  unit: string;
  period_or_basis: string;
  as_of: string;
}

export interface Card {
  id: string;
  category: Category;
  expected_verdict: ExpectedVerdict;
  rationale: string;
  claim: Claim;
  evidence_spans: EvidenceSpan[];
}

export type CategoryDistribution = Record<Category, number>;

export interface CaseSet {
  format_version: number;
  case_set_version: string;
  description: string;
  provenance: { synthetic: boolean; jurisdiction: string; statement: string };
  households: Household[];
  subjects: Subject[];
  fields: CodeDefinition[];
  units: CodeDefinition[];
  source_artifacts: SourceArtifact[];
  category_distribution: CategoryDistribution;
  cards: Card[];
}

export class CaseSetValidationError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(`case set failed validation with ${violations.length} violation(s):\n- ${violations.join("\n- ")}`);
    this.name = "CaseSetValidationError";
    this.violations = violations;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function validateCaseSet(data: unknown): string[] {
  const violations: string[] = [];
  const add = (path: string, message: string) => violations.push(`${path}: ${message}`);

  if (!isRecord(data)) return ["case set: expected a JSON object"];

  if (data.format_version !== FORMAT_VERSION) {
    add("format_version", `must be ${FORMAT_VERSION} so a later page can render this file without this repository's code`);
  }
  if (!isNonEmptyString(data.case_set_version) || !VERSION.test(data.case_set_version)) {
    add("case_set_version", 'must be a version string like "1.0.0"');
  }
  if (!isNonEmptyString(data.description)) add("description", "must be a non-empty string");

  if (!isRecord(data.provenance)) {
    add("provenance", "must be an object");
  } else {
    if (data.provenance.synthetic !== true) add("provenance.synthetic", "must be true: this repository publishes synthetic data only");
    if (!isNonEmptyString(data.provenance.jurisdiction)) add("provenance.jurisdiction", "must be a non-empty string");
    if (!isNonEmptyString(data.provenance.statement)) add("provenance.statement", "must state the fictional provenance of the data");
  }

  const householdIds = new Set<string>();
  if (!Array.isArray(data.households) || data.households.length === 0) {
    add("households", "must be a non-empty array");
  } else {
    for (const [i, household] of data.households.entries()) {
      const path = `households[${i}]`;
      if (!isRecord(household)) {
        add(path, "must be an object");
        continue;
      }
      if (!isNonEmptyString(household.id)) add(`${path}.id`, "must be a non-empty string");
      else if (householdIds.has(household.id)) add(`${path}.id`, `duplicates household id "${household.id}"`);
      else householdIds.add(household.id);
      if (!isNonEmptyString(household.name)) add(`${path}.name`, "must be a non-empty string");
    }
  }

  const subjectIds = new Set<string>();
  const personIds = new Set<string>();
  if (!Array.isArray(data.subjects) || data.subjects.length === 0) {
    add("subjects", "must be a non-empty array");
  } else {
    for (const [i, subject] of data.subjects.entries()) {
      const path = `subjects[${i}]`;
      if (!isRecord(subject)) {
        add(path, "must be an object");
        continue;
      }
      if (!isNonEmptyString(subject.id)) add(`${path}.id`, "must be a non-empty string");
      else if (subjectIds.has(subject.id)) add(`${path}.id`, `duplicates subject id "${subject.id}"`);
      else subjectIds.add(subject.id);
      if (typeof subject.household_id !== "string" || !householdIds.has(subject.household_id)) {
        add(`${path}.household_id`, "must reference a known household");
      }
      if (!SUBJECT_KINDS.includes(subject.kind as (typeof SUBJECT_KINDS)[number])) {
        add(`${path}.kind`, `must be one of ${SUBJECT_KINDS.join(", ")}`);
      }
      if (!isNonEmptyString(subject.name)) add(`${path}.name`, "must be a non-empty string");
      if (subject.kind === "person" && isNonEmptyString(subject.id)) personIds.add(subject.id);
      if (subject.kind === "policy" && subject.owner_subject_id !== undefined) {
        if (typeof subject.owner_subject_id !== "string" || !personIds.has(subject.owner_subject_id)) {
          add(`${path}.owner_subject_id`, "when present, must reference a known person subject declared earlier");
        }
      }
    }
  }

  const validateCodes = (key: "fields" | "units", label: string): Set<string> => {
    const codes = new Set<string>();
    const list = data[key];
    if (!Array.isArray(list) || list.length === 0) {
      add(key, "must be a non-empty array");
      return codes;
    }
    for (const [i, entry] of list.entries()) {
      const path = `${key}[${i}]`;
      if (!isRecord(entry)) {
        add(path, "must be an object");
        continue;
      }
      if (!isNonEmptyString(entry.code)) add(`${path}.code`, "must be a non-empty string");
      else if (codes.has(entry.code)) add(`${path}.code`, `duplicates ${label} code "${entry.code}"`);
      else codes.add(entry.code);
      if (!isNonEmptyString(entry.description)) add(`${path}.description`, "must be a non-empty string");
    }
    return codes;
  };

  const fieldCodes = validateCodes("fields", "field");
  const unitCodes = validateCodes("units", "unit");

  const artifacts = new Map<string, string[]>();
  if (!Array.isArray(data.source_artifacts) || data.source_artifacts.length === 0) {
    add("source_artifacts", "must be a non-empty array");
  } else {
    for (const [i, artifact] of data.source_artifacts.entries()) {
      const path = `source_artifacts[${i}]`;
      if (!isRecord(artifact)) {
        add(path, "must be an object");
        continue;
      }
      if (!isNonEmptyString(artifact.id)) add(`${path}.id`, "must be a non-empty string");
      else if (artifacts.has(artifact.id)) add(`${path}.id`, `duplicates artifact id "${artifact.id}"`);
      if (typeof artifact.household_id !== "string" || !householdIds.has(artifact.household_id)) {
        add(`${path}.household_id`, "must reference a known household");
      }
      if (!isNonEmptyString(artifact.revision)) add(`${path}.revision`, 'must be a non-empty revision label such as "r1"');
      if (!ARTIFACT_KINDS.includes(artifact.kind as (typeof ARTIFACT_KINDS)[number])) {
        add(`${path}.kind`, `must be one of ${ARTIFACT_KINDS.join(", ")}`);
      }
      if (!isNonEmptyString(artifact.title)) add(`${path}.title`, "must be a non-empty string");
      if (typeof artifact.date !== "string" || !ISO_DATE.test(artifact.date)) add(`${path}.date`, "must be an ISO date, YYYY-MM-DD");
      if (!Array.isArray(artifact.lines) || artifact.lines.length === 0 || !artifact.lines.every(isNonEmptyString)) {
        add(`${path}.lines`, "must be a non-empty array of non-empty strings");
      } else if (isNonEmptyString(artifact.id)) {
        artifacts.set(artifact.id, artifact.lines);
      }
    }
  }

  const actualCounts = new Map<string, number>();
  for (const category of CATEGORIES) actualCounts.set(category, 0);
  if (!isRecord(data.category_distribution)) {
    add("category_distribution", "must be an object");
  } else {
    for (const category of CATEGORIES) {
      if (!(category in data.category_distribution)) {
        add("category_distribution", `missing key "${category}"`);
        continue;
      }
      if (!isNonNegativeInteger(data.category_distribution[category])) {
        add("category_distribution", `"${category}" must be a non-negative integer`);
      }
    }
  }

  if (!Array.isArray(data.cards) || data.cards.length === 0) {
    add("cards", "must be a non-empty array");
  } else {
    const cardIds = new Set<string>();
    for (const [i, card] of data.cards.entries()) {
      const path = `cards[${i}]`;
      if (!isRecord(card)) {
        add(path, "must be an object");
        continue;
      }
      if (!isNonEmptyString(card.id)) add(`${path}.id`, "must be a non-empty string");
      else if (cardIds.has(card.id)) add(`${path}.id`, `duplicates card id "${card.id}"`);
      else cardIds.add(card.id);

      const category = card.category;
      let knownCategory: Category | undefined;
      if (typeof category === "string" && (CATEGORIES as readonly string[]).includes(category)) {
        knownCategory = category as Category;
      }
      if (knownCategory === undefined) {
        add(`${path}.category`, `must be one of ${CATEGORIES.join(", ")}`);
      } else {
        actualCounts.set(knownCategory, (actualCounts.get(knownCategory) ?? 0) + 1);
      }

      const verdict = card.expected_verdict;
      if (!VERDICTS.includes(verdict as ExpectedVerdict)) {
        add(`${path}.expected_verdict`, `must be one of ${VERDICTS.join(", ")}`);
      } else if ((verdict === "supported") !== (knownCategory === "correct")) {
        add(`${path}.expected_verdict`, 'must be "supported" for correct cards and "unsupported" for every corrupted category');
      }

      if (!isNonEmptyString(card.rationale)) add(`${path}.rationale`, "must be a non-empty string a person can check against the card");

      if (!isRecord(card.claim)) {
        add(`${path}.claim`, "must be an object");
      } else {
        const claim = card.claim;
        if (typeof claim.subject_id !== "string" || !subjectIds.has(claim.subject_id)) {
          add(`${path}.claim.subject_id`, "must reference a known subject");
        }
        if (typeof claim.field !== "string" || !fieldCodes.has(claim.field)) {
          add(`${path}.claim.field`, "must reference a known field code");
        }
        if (typeof claim.unit !== "string" || !unitCodes.has(claim.unit)) {
          add(`${path}.claim.unit`, "must reference a known unit code");
        }
        const value = claim.value;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || Math.round(value * 100) / 100 !== value) {
          add(`${path}.claim.value`, "must be a number of at least 0 with at most two decimal places");
        }
        if (!isNonEmptyString(claim.period_or_basis)) {
          add(`${path}.claim.period_or_basis`, "must be a non-empty string stating the period or basis asserted");
        }
        if (typeof claim.as_of !== "string" || !ISO_DATE.test(claim.as_of)) {
          add(`${path}.claim.as_of`, "must be an ISO date, YYYY-MM-DD");
        }
      }

      if (!Array.isArray(card.evidence_spans) || card.evidence_spans.length === 0) {
        add(`${path}.evidence_spans`, "must be a non-empty array");
      } else {
        const distinctArtifacts = new Set<string>();
        for (const [j, span] of card.evidence_spans.entries()) {
          const spanPath = `${path}.evidence_spans[${j}]`;
          if (!isRecord(span)) {
            add(spanPath, "must be an object");
            continue;
          }
          const lines = typeof span.artifact_id === "string" ? artifacts.get(span.artifact_id) : undefined;
          if (lines === undefined) {
            add(`${spanPath}.artifact_id`, "must reference a known source artifact");
          } else {
            const lineStart = span.line_start;
            const lineEnd = span.line_end;
            if (isNonNegativeInteger(lineStart) && isNonNegativeInteger(lineEnd) && lineStart >= 1 && lineEnd >= 1) {
              if (lineStart > lineEnd) add(`${spanPath}.line_start`, `must not exceed line_end (${lineEnd})`);
              if (lineEnd > lines.length) add(`${spanPath}.line_end`, `must not exceed the artifact's ${lines.length} line(s)`);
              if (lineStart <= lineEnd && lineEnd <= lines.length) {
                const expectedQuote = lines.slice(lineStart - 1, lineEnd).join("\n");
                if (span.quote !== expectedQuote) {
                  add(`${spanPath}.quote`, "must quote the artifact lines exactly, joined with newlines");
                }
              }
            } else {
              add(`${spanPath}.line_start`, "line_start and line_end must be integers of at least 1");
            }
          }
          if (typeof span.artifact_id === "string") distinctArtifacts.add(span.artifact_id);
        }
        if (knownCategory === "conflict" && distinctArtifacts.size < 2) {
          add(`${path}.evidence_spans`, "a conflict card must cite at least two distinct source artifacts");
        }
      }
    }
  }

  if (isRecord(data.category_distribution)) {
    let recordedTotal = 0;
    let countsAreNumbers = true;
    for (const category of CATEGORIES) {
      if (!(category in data.category_distribution)) countsAreNumbers = false;
      const recorded = data.category_distribution[category];
      if (!isNonNegativeInteger(recorded)) {
        countsAreNumbers = false;
        continue;
      }
      recordedTotal += recorded;
      if (Array.isArray(data.cards) && recorded !== actualCounts.get(category)) {
        add("category_distribution", `recorded ${recorded} "${category}" cards but found ${actualCounts.get(category)}`);
      }
    }
    if (countsAreNumbers && Array.isArray(data.cards) && recordedTotal !== data.cards.length) {
      add("category_distribution", `records ${recordedTotal} cards in total but the cards array has ${data.cards.length}`);
    }
  }

  return violations;
}

export function loadCaseSet(path: string | URL): CaseSet {
  const raw = readFileSync(path, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new CaseSetValidationError([`file is not valid JSON: ${(error as Error).message}`]);
  }
  const violations = validateCaseSet(data);
  if (violations.length > 0) throw new CaseSetValidationError(violations);
  return data as CaseSet;
}
