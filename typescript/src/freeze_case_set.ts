import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_CASE_SET_LOCK_PATH, DEFAULT_CASE_SET_PATH, loadCaseSet } from "./case_set_schema.ts";

const raw = readFileSync(DEFAULT_CASE_SET_PATH);
const caseSet = loadCaseSet(DEFAULT_CASE_SET_PATH);
const lock = {
  case_set_file: "case_set_v1.json",
  case_set_version: caseSet.case_set_version,
  sha256: createHash("sha256").update(raw).digest("hex"),
  frozen_at: new Date().toISOString().slice(0, 10),
  note:
    "Frozen before any model run (issue #3). Every test verifies this hash, so editing the case set fails loudly. " +
    "Re-freeze only for an intended change, and record the reason in the write-up.",
};
writeFileSync(DEFAULT_CASE_SET_LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Froze case set ${caseSet.case_set_version} at sha256 ${lock.sha256}`);
