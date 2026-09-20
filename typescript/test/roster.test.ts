import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimalCaseSet } from "./case_set_fixture.ts";
import type { CaseSet } from "../src/case_set_schema.ts";
import {
  DEFAULT_ROSTER_LOCK_PATH,
  DEFAULT_ROSTER_PATH,
  RosterValidationError,
  deriveRoster,
  identityOnlyName,
  loadRoster,
  validateRoster,
  verifyRosterLock,
  type Roster,
} from "../src/roster.ts";
import { DEFAULT_CASE_SET_PATH, loadCaseSet } from "../src/case_set_schema.ts";

function minimalRoster(): Roster {
  return {
    format_version: 1,
    roster_version: "1.0.0",
    description: "Minimal roster used to test the schema.",
    case_set_version: "1.0.0",
    identity_only_rule:
      "Policy names omit person-attribution parentheticals present in the case set (for example '(Alex Field's service)'); nothing else is changed.",
    entries: [
      { subject_id: "sub-t-alex", household_id: "hh-t", kind: "person", name: "Alex Field" },
      { subject_id: "sub-t-bea", household_id: "hh-t", kind: "person", name: "Bea Field" },
      { subject_id: "sub-t-plan", household_id: "hh-t", kind: "policy", name: "Test plan" },
    ],
  };
}

describe("validateRoster", () => {
  test("accepts a roster that covers every case-set subject exactly once", () => {
    expect(validateRoster(minimalRoster(), minimalCaseSet())).toEqual([]);
  });

  test("rejects a roster missing a case-set subject", () => {
    const roster = minimalRoster();
    roster.entries = roster.entries.filter((e) => e.subject_id !== "sub-t-bea");
    const violations = validateRoster(roster, minimalCaseSet());
    expect(violations.some((v) => v.includes("sub-t-bea"))).toBe(true);
  });

  test("rejects a roster entry for an unknown subject", () => {
    const roster = minimalRoster();
    roster.entries.push({ subject_id: "sub-t-nobody", household_id: "hh-t", kind: "person", name: "Nobody" });
    expect(validateRoster(roster, minimalCaseSet()).length).toBeGreaterThan(0);
  });

  test("rejects duplicate subject ids and duplicate names", () => {
    const roster = minimalRoster();
    roster.entries.push({ ...roster.entries[0]! });
    expect(validateRoster(roster, minimalCaseSet()).some((v) => v.includes("duplicates"))).toBe(true);

    const named = minimalRoster();
    named.entries[2] = { ...named.entries[2]!, name: "Alex Field" };
    expect(validateRoster(named, minimalCaseSet()).some((v) => v.includes("Alex Field"))).toBe(true);
  });

  test("rejects a name that is not the case-set name or the identity-only form of it", () => {
    const roster = minimalRoster();
    roster.entries[0] = { ...roster.entries[0]!, name: " Alexandra Field" };
    const violations = validateRoster(roster, minimalCaseSet());
    expect(violations.some((v) => v.includes("sub-t-alex") && v.includes("identity-only"))).toBe(true);
  });

  test("rejects household or kind drift against the case set", () => {
    const roster = minimalRoster();
    roster.entries[2] = { ...roster.entries[2]!, kind: "person" };
    expect(validateRoster(roster, minimalCaseSet()).some((v) => v.includes("sub-t-plan"))).toBe(true);

    const household = minimalRoster();
    household.entries[0] = { ...household.entries[0]!, household_id: "hh-other" };
    expect(validateRoster(household, minimalCaseSet()).some((v) => v.includes("sub-t-alex"))).toBe(true);
  });

  test("rejects a roster recorded against a different case-set version", () => {
    const roster = minimalRoster();
    roster.case_set_version = "2.0.0";
    expect(validateRoster(roster, minimalCaseSet()).some((v) => v.includes("case_set_version"))).toBe(true);
  });
});

describe("deriveRoster", () => {
  test("derives identity-only names by stripping person-attribution parentheticals only", () => {
    const caseSet = minimalCaseSet() as unknown as CaseSet;
    caseSet.subjects.push({
      id: "sub-t-scheme",
      household_id: "hh-t",
      kind: "policy",
      name: "Test Teachers' Scheme (Alex Field's service)",
    });
    const roster = deriveRoster(caseSet);
    const scheme = roster.entries.find((e) => e.subject_id === "sub-t-scheme")!;
    expect(scheme.name).toBe("Test Teachers' Scheme");
    expect(roster.entries.find((e) => e.subject_id === "sub-t-plan")!.name).toBe("Test plan");
    expect(roster.entries.find((e) => e.subject_id === "sub-t-alex")!.name).toBe("Alex Field");
  });

  test("leaves a membership-number suffix untouched", () => {
    const caseSet = minimalCaseSet() as unknown as CaseSet;
    caseSet.subjects.push({
      id: "sub-t-group",
      household_id: "hh-t",
      kind: "policy",
      name: "Group plan, member MGP 1",
    });
    expect(deriveRoster(caseSet).entries.find((e) => e.subject_id === "sub-t-group")!.name).toBe("Group plan, member MGP 1");
  });

  test("derived roster validates against its own case set", () => {
    const caseSet = minimalCaseSet() as unknown as CaseSet;
    expect(validateRoster(deriveRoster(caseSet), caseSet)).toEqual([]);
  });
});

describe("roster fixture and lock", () => {
  test("the frozen roster covers the frozen case set and matches its lock", () => {
    const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
    const lock = verifyRosterLock(DEFAULT_ROSTER_PATH, DEFAULT_ROSTER_LOCK_PATH);
    const roster = loadRoster(DEFAULT_ROSTER_PATH, DEFAULT_ROSTER_LOCK_PATH, caseSet);
    expect(validateRoster(roster, caseSet)).toEqual([]);
    expect(lock.rosterVersion).toBe(roster.roster_version);
    expect(roster.entries.length).toBe(caseSet.subjects.length);
  });

  test("the frozen roster strips person-attribution parentheticals from policy names only", () => {
    const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
    const roster = loadRoster(DEFAULT_ROSTER_PATH, DEFAULT_ROSTER_LOCK_PATH, caseSet);
    for (const entry of roster.entries) {
      const subject = caseSet.subjects.find((s) => s.id === entry.subject_id)!;
      if (entry.name !== subject.name) {
        expect(entry.name).toBe(identityOnlyName(subject));
        expect(subject.kind).toBe("policy");
      }
    }
  });
});

describe("loadRoster", () => {
  test("fails loudly on a roster that does not match its lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "faai-roster-"));
    const rosterPath = join(dir, "roster.json");
    const lockPath = join(dir, "roster.lock.json");
    writeFileSync(rosterPath, JSON.stringify(minimalRoster(), null, 2));
    writeFileSync(lockPath, JSON.stringify({ sha256: "0".repeat(64), roster_version: "1.0.0", case_set_version: "1.0.0" }));
    expect(() => loadRoster(rosterPath, lockPath)).toThrow(/no longer matches its frozen lock/);
  });
});
