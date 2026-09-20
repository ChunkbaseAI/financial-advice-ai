"""Frozen-lock verification for the case-set fixture.

Mirrors typescript/src/case_set_lock.ts: the case set was frozen before any
model run, and every test suite verifies its sha256 so post-freeze edits
fail loudly.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .case_set_schema import is_non_empty_string, load_case_set


def verify_case_set_lock(case_set_path: str | Path, lock_path: str | Path) -> dict[str, str]:
    """Verify the case-set file still hashes to its frozen lock; raise loudly if not."""
    case_set_file = Path(case_set_path)
    sha256 = hashlib.sha256(case_set_file.read_bytes()).hexdigest()

    lock_file = Path(lock_path)
    try:
        lock: Any = json.loads(lock_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError(f"case set lock is not valid JSON: {error}") from error
    if not isinstance(lock, dict) or not is_non_empty_string(lock.get("sha256")):
        raise RuntimeError("case set lock is missing its sha256 field")
    if lock["sha256"] != sha256:
        raise RuntimeError(
            f"case set no longer matches its frozen lock: lock records {lock['sha256']} but the file hashes to {sha256}; "
            "if the change is intended, re-freeze with `bun run freeze:case-set` and record the reason"
        )
    case_set = load_case_set(case_set_file)
    lock_version = lock.get("case_set_version")
    if case_set["case_set_version"] != lock_version:
        raise RuntimeError(f"case set version {case_set['case_set_version']} does not match lock version {lock_version}")
    return {"sha256": sha256, "caseSetVersion": case_set["case_set_version"]}
