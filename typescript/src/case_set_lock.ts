import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isNonEmptyString, isRecord, loadCaseSet } from "./case_set_schema.ts";

export interface CaseSetLockResult {
  sha256: string;
  caseSetVersion: string;
}

export function verifyCaseSetLock(caseSetPath: string | URL, lockPath: string | URL): CaseSetLockResult {
  const caseSetBytes = readFileSync(caseSetPath);
  const sha256 = createHash("sha256").update(caseSetBytes).digest("hex");

  let lock: unknown;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    throw new Error(`case set lock is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(lock) || !isNonEmptyString(lock.sha256)) {
    throw new Error("case set lock is missing its sha256 field");
  }
  if (lock.sha256 !== sha256) {
    throw new Error(
      `case set no longer matches its frozen lock: lock records ${lock.sha256} but the file hashes to ${sha256}; ` +
        "if the change is intended, re-freeze with `bun run freeze:case-set` and record the reason",
    );
  }
  const caseSet = loadCaseSet(caseSetPath);
  const lockVersion = isNonEmptyString(lock.case_set_version) ? lock.case_set_version : "";
  if (caseSet.case_set_version !== lockVersion) {
    throw new Error(`case set version ${caseSet.case_set_version} does not match lock version ${lockVersion}`);
  }
  return { sha256, caseSetVersion: caseSet.case_set_version };
}
