import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isNonEmptyString, isRecord, type CaseSet, type Subject } from "./case_set_schema.ts";

export const ROSTER_FORMAT_VERSION = 1;

export const DEFAULT_ROSTER_PATH = new URL("../../fixtures/roster_v1.json", import.meta.url);
export const DEFAULT_ROSTER_LOCK_PATH = new URL("../../fixtures/roster_v1.lock.json", import.meta.url);

export const IDENTITY_ONLY_RULE =
  "Policy names omit person-attribution parentheticals present in the case set (for example \"(Dev Patel's service)\"); nothing else is changed.";

const PERSON_ATTRIBUTION = /\s*\([^)]*'s (?:service|membership)\)$/;

export interface RosterEntry {
  subject_id: string;
  household_id: string;
  kind: "person" | "policy";
  name: string;
}

export interface Roster {
  format_version: number;
  roster_version: string;
  description: string;
  case_set_version: string;
  identity_only_rule: string;
  entries: RosterEntry[];
}

export class RosterValidationError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(`roster failed validation with ${violations.length} violation(s):\n- ${violations.join("\n- ")}`);
    this.name = "RosterValidationError";
    this.violations = violations;
  }
}

export function identityOnlyName(subject: Subject): string {
  return subject.name.replace(PERSON_ATTRIBUTION, "");
}

export function deriveRoster(caseSet: CaseSet): Roster {
  return {
    format_version: ROSTER_FORMAT_VERSION,
    roster_version: "1.0.0",
    description:
      "Frozen identity-only ID-to-name roster for the checker experiment. Names are the case-set names with person-attribution parentheticals removed.",
    case_set_version: caseSet.case_set_version,
    identity_only_rule: IDENTITY_ONLY_RULE,
    entries: caseSet.subjects.map((subject) => ({
      subject_id: subject.id,
      household_id: subject.household_id,
      kind: subject.kind,
      name: identityOnlyName(subject),
    })),
  };
}

export function validateRoster(data: unknown, caseSet: unknown): string[] {
  const violations: string[] = [];
  const add = (message: string) => violations.push(message);

  if (!isRecord(data)) return ["roster: expected a JSON object"];
  if (data.format_version !== ROSTER_FORMAT_VERSION) add(`format_version: must be ${ROSTER_FORMAT_VERSION}`);
  if (!isNonEmptyString(data.roster_version)) add('roster_version: must be a version string like "1.0.0"');
  if (!isNonEmptyString(data.description)) add("description: must be a non-empty string");
  if (!isNonEmptyString(data.identity_only_rule)) {
    add("identity_only_rule: must state how roster names differ from the case-set names");
  }
  if (!isRecord(caseSet)) return [...violations, "case set: expected a JSON object"];
  if (isNonEmptyString(data.case_set_version) && data.case_set_version !== caseSet.case_set_version) {
    add(`case_set_version: roster records ${data.case_set_version} but the case set is ${caseSet.case_set_version}`);
  }

  const caseSubjects = new Map<string, Subject>();
  if (Array.isArray(caseSet.subjects)) {
    for (const subject of caseSet.subjects) {
      if (isRecord(subject) && isNonEmptyString(subject.id)) caseSubjects.set(subject.id, subject as unknown as Subject);
    }
  }

  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const entries = data.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    add("entries: must be a non-empty array");
  } else {
    for (const [i, entry] of entries.entries()) {
      const path = `entries[${i}]`;
      if (!isRecord(entry)) {
        add(`${path}: must be an object`);
        continue;
      }
      if (!isNonEmptyString(entry.subject_id)) {
        add(`${path}.subject_id: must be a non-empty string`);
        continue;
      }
      if (seenIds.has(entry.subject_id)) add(`entries: duplicates subject id "${entry.subject_id}"`);
      else seenIds.add(entry.subject_id);

      const subject = caseSubjects.get(entry.subject_id);
      if (subject === undefined) {
        add(`${path}.subject_id: "${entry.subject_id}" is not a subject of case set ${caseSet.case_set_version}`);
        continue;
      }
      if (entry.household_id !== subject.household_id) {
        add(`${path}.household_id: "${entry.subject_id}" belongs to household ${subject.household_id} in the case set`);
      }
      if (entry.kind !== subject.kind) {
        add(`${path}.kind: "${entry.subject_id}" is a ${subject.kind} in the case set`);
      }
      if (!isNonEmptyString(entry.name)) {
        add(`${path}.name: must be a non-empty string`);
        continue;
      }
      if (entry.name !== subject.name && entry.name !== identityOnlyName(subject)) {
        add(
          `${path}.name: "${entry.subject_id}" must carry the case-set name "${subject.name}" or its identity-only form "${identityOnlyName(subject)}"`,
        );
      }
      if (seenNames.has(entry.name)) add(`entries: duplicates name "${entry.name}"; household members must stay distinguishable`);
      else seenNames.add(entry.name);
    }
  }

  for (const subject of caseSubjects.values()) {
    if (!seenIds.has(subject.id)) {
      add(`entries: case-set subject "${subject.id}" (${subject.name}) has no roster entry`);
    }
  }

  return violations;
}

export interface RosterLockResult {
  sha256: string;
  rosterVersion: string;
}

export function rosterSha256(rosterPath: string | URL): string {
  return createHash("sha256").update(readFileSync(rosterPath)).digest("hex");
}

export function verifyRosterLock(rosterPath: string | URL, lockPath: string | URL): RosterLockResult {
  const sha256 = rosterSha256(rosterPath);
  let lock: unknown;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    throw new Error(`roster lock is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(lock) || !isNonEmptyString(lock.sha256)) {
    throw new Error("roster lock is missing its sha256 field");
  }
  if (lock.sha256 !== sha256) {
    throw new Error(
      `roster no longer matches its frozen lock: lock records ${lock.sha256} but the file hashes to ${sha256}; ` +
        "if the change is intended, re-freeze with `bun run freeze:roster` and record the reason",
    );
  }
  return { sha256, rosterVersion: isNonEmptyString(lock.roster_version) ? lock.roster_version : "" };
}

export function loadRoster(rosterPath: string | URL, lockPath: string | URL, caseSet?: CaseSet): Roster {
  verifyRosterLock(rosterPath, lockPath);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(rosterPath, "utf8"));
  } catch (error) {
    throw new RosterValidationError([`file is not valid JSON: ${(error as Error).message}`]);
  }
  const violations = validateRoster(data, caseSet ?? data);
  if (violations.length > 0) throw new RosterValidationError(violations);
  return data as Roster;
}
