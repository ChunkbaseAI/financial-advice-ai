import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_CASE_SET_PATH, loadCaseSet } from "./case_set_schema.ts";
import { DEFAULT_ROSTER_LOCK_PATH, DEFAULT_ROSTER_PATH, deriveRoster, rosterSha256 } from "./roster.ts";

const caseSetRaw = readFileSync(DEFAULT_CASE_SET_PATH);
const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
const roster = deriveRoster(caseSet);
writeFileSync(DEFAULT_ROSTER_PATH, `${JSON.stringify(roster, null, 2)}\n`);

const lock = {
  roster_file: "roster_v1.json",
  roster_version: roster.roster_version,
  case_set_version: caseSet.case_set_version,
  case_set_sha256: createHash("sha256").update(caseSetRaw).digest("hex"),
  sha256: rosterSha256(DEFAULT_ROSTER_PATH),
  frozen_at: new Date().toISOString().slice(0, 10),
  note:
    "Frozen identity-only roster for the checker experiment (issue #2), derived from the frozen case set. " +
    "Names are case-set names with person-attribution parentheticals removed; nothing else is changed. " +
    "Every test verifies this hash. Re-freeze only for an intended change, and record the reason in the write-up.",
};
writeFileSync(DEFAULT_ROSTER_LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Froze roster ${roster.roster_version} at sha256 ${lock.sha256} (${roster.entries.length} subjects)`);
