"""Case-set checks for the claim-card fixtures.

Barrel module mirroring typescript/src/case_set.ts: the schema, loading,
value-presence and lock checks live in focused sibling modules.
"""

from .case_set_schema import (
    CATEGORIES,
    DEFAULT_CASE_SET_LOCK_PATH,
    DEFAULT_CASE_SET_PATH,
    FORMAT_VERSION,
    VERDICTS,
    CaseSetValidationError,
    load_case_set,
    validate_case_set,
)
from .case_set_lock import verify_case_set_lock
from .value_presence import check_value_presence, format_claim_value, value_present

__all__ = [
    "CATEGORIES",
    "DEFAULT_CASE_SET_LOCK_PATH",
    "DEFAULT_CASE_SET_PATH",
    "FORMAT_VERSION",
    "VERDICTS",
    "CaseSetValidationError",
    "check_value_presence",
    "format_claim_value",
    "load_case_set",
    "validate_case_set",
    "value_present",
    "verify_case_set_lock",
]
