export {
  CATEGORIES,
  CaseSetValidationError,
  DEFAULT_CASE_SET_LOCK_PATH,
  DEFAULT_CASE_SET_PATH,
  FORMAT_VERSION,
  VERDICTS,
  loadCaseSet,
  validateCaseSet,
} from "./case_set_schema.ts";
export type {
  Card,
  CaseSet,
  Category,
  CategoryDistribution,
  Claim,
  CodeDefinition,
  EvidenceSpan,
  ExpectedVerdict,
  Household,
  PersonSubject,
  PolicySubject,
  SourceArtifact,
  Subject,
} from "./case_set_schema.ts";
export { checkValuePresence, formatClaimValue, valuePresent } from "./value_presence.ts";
export type { ValuePresenceResult } from "./value_presence.ts";
export { verifyCaseSetLock } from "./case_set_lock.ts";
export type { CaseSetLockResult } from "./case_set_lock.ts";
