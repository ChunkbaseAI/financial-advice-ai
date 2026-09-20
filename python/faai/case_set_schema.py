"""Case-set schema validation and loading for the claim-card fixtures.

Mirrors typescript/src/case_set_schema.ts so both languages validate the
same language-neutral JSON fixtures and fail loudly on malformed input.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

FORMAT_VERSION = 1

CATEGORIES = (
    "correct",
    "wrong-subject",
    "stale-value",
    "hypothetical",
    "unsupported",
    "wrong-basis",
    "conflict",
)

VERDICTS = ("supported", "unsupported")

SUBJECT_KINDS = ("person", "policy")
ARTIFACT_KINDS = ("meeting-transcript", "provider-document")
ISO_DATE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")
VERSION = re.compile(r"^\d+\.\d+\.\d+$")

_FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"
DEFAULT_CASE_SET_PATH = _FIXTURES_DIR / "case_set_v1.json"
DEFAULT_CASE_SET_LOCK_PATH = _FIXTURES_DIR / "case_set_v1.lock.json"


class CaseSetValidationError(Exception):
    """Raised when a case-set file fails validation, listing every violation."""

    def __init__(self, violations: list[str]) -> None:
        self.violations = violations
        joined = "\n- ".join(violations)
        super().__init__(f"case set failed validation with {len(violations)} violation(s):\n- {joined}")


def is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _is_non_negative_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _is_iso_date(value: Any) -> bool:
    return isinstance(value, str) and ISO_DATE.match(value) is not None


def _is_valid_value(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return False
    return value >= 0 and round(value, 2) == value


def validate_case_set(data: Any) -> list[str]:
    """Return every schema violation in the given parsed case set; empty means valid."""
    violations: list[str] = []

    def add(path: str, message: str) -> None:
        violations.append(f"{path}: {message}")

    if not isinstance(data, dict):
        return ["case set: expected a JSON object"]

    if data.get("format_version") != FORMAT_VERSION:
        add("format_version", f"must be {FORMAT_VERSION} so a later page can render this file without this repository's code")
    if not is_non_empty_string(data.get("case_set_version")) or not VERSION.match(str(data.get("case_set_version"))):
        add("case_set_version", 'must be a version string like "1.0.0"')
    if not is_non_empty_string(data.get("description")):
        add("description", "must be a non-empty string")

    provenance = data.get("provenance")
    if not isinstance(provenance, dict):
        add("provenance", "must be an object")
    else:
        if provenance.get("synthetic") is not True:
            add("provenance.synthetic", "must be true: this repository publishes synthetic data only")
        if not is_non_empty_string(provenance.get("jurisdiction")):
            add("provenance.jurisdiction", "must be a non-empty string")
        if not is_non_empty_string(provenance.get("statement")):
            add("provenance.statement", "must state the fictional provenance of the data")

    households = data.get("households")
    household_ids: set[str] = set()
    if not isinstance(households, list) or not households:
        add("households", "must be a non-empty array")
    else:
        for i, household in enumerate(households):
            path = f"households[{i}]"
            if not isinstance(household, dict):
                add(path, "must be an object")
                continue
            if not is_non_empty_string(household.get("id")):
                add(f"{path}.id", "must be a non-empty string")
            elif household["id"] in household_ids:
                add(f"{path}.id", f'duplicates household id "{household["id"]}"')
            else:
                household_ids.add(household["id"])
            if not is_non_empty_string(household.get("name")):
                add(f"{path}.name", "must be a non-empty string")

    subjects = data.get("subjects")
    subject_ids: set[str] = set()
    person_ids: set[str] = set()
    if not isinstance(subjects, list) or not subjects:
        add("subjects", "must be a non-empty array")
    else:
        for i, subject in enumerate(subjects):
            path = f"subjects[{i}]"
            if not isinstance(subject, dict):
                add(path, "must be an object")
                continue
            if not is_non_empty_string(subject.get("id")):
                add(f"{path}.id", "must be a non-empty string")
            elif subject["id"] in subject_ids:
                add(f"{path}.id", f'duplicates subject id "{subject["id"]}"')
            else:
                subject_ids.add(subject["id"])
            if subject.get("household_id") not in household_ids:
                add(f"{path}.household_id", "must reference a known household")
            if subject.get("kind") not in SUBJECT_KINDS:
                add(f"{path}.kind", f"must be one of {', '.join(SUBJECT_KINDS)}")
            if not is_non_empty_string(subject.get("name")):
                add(f"{path}.name", "must be a non-empty string")
            if subject.get("kind") == "person" and is_non_empty_string(subject.get("id")):
                person_ids.add(subject["id"])
            if subject.get("kind") == "policy" and "owner_subject_id" in subject:
                if subject.get("owner_subject_id") not in person_ids:
                    add(f"{path}.owner_subject_id", "when present, must reference a known person subject declared earlier")

    def validate_codes(key: str, label: str) -> set[str]:
        codes: set[str] = set()
        entries = data.get(key)
        if not isinstance(entries, list) or not entries:
            add(key, "must be a non-empty array")
            return codes
        for i, entry in enumerate(entries):
            path = f"{key}[{i}]"
            if not isinstance(entry, dict):
                add(path, "must be an object")
                continue
            if not is_non_empty_string(entry.get("code")):
                add(f"{path}.code", "must be a non-empty string")
            elif entry["code"] in codes:
                add(f"{path}.code", f'duplicates {label} code "{entry["code"]}"')
            else:
                codes.add(entry["code"])
            if not is_non_empty_string(entry.get("description")):
                add(f"{path}.description", "must be a non-empty string")
        return codes

    field_codes = validate_codes("fields", "field")
    unit_codes = validate_codes("units", "unit")

    artifacts: dict[str, list[str]] = {}
    artifact_list = data.get("source_artifacts")
    if not isinstance(artifact_list, list) or not artifact_list:
        add("source_artifacts", "must be a non-empty array")
    else:
        for i, artifact in enumerate(artifact_list):
            path = f"source_artifacts[{i}]"
            if not isinstance(artifact, dict):
                add(path, "must be an object")
                continue
            if not is_non_empty_string(artifact.get("id")):
                add(f"{path}.id", "must be a non-empty string")
            elif artifact["id"] in artifacts:
                add(f"{path}.id", f'duplicates artifact id "{artifact["id"]}"')
            if artifact.get("household_id") not in household_ids:
                add(f"{path}.household_id", "must reference a known household")
            if not is_non_empty_string(artifact.get("revision")):
                add(f"{path}.revision", 'must be a non-empty revision label such as "r1"')
            if artifact.get("kind") not in ARTIFACT_KINDS:
                add(f"{path}.kind", f"must be one of {', '.join(ARTIFACT_KINDS)}")
            if not is_non_empty_string(artifact.get("title")):
                add(f"{path}.title", "must be a non-empty string")
            if not _is_iso_date(artifact.get("date")):
                add(f"{path}.date", "must be an ISO date, YYYY-MM-DD")
            lines = artifact.get("lines")
            if not isinstance(lines, list) or not lines or not all(is_non_empty_string(line) for line in lines):
                add(f"{path}.lines", "must be a non-empty array of non-empty strings")
            elif is_non_empty_string(artifact.get("id")):
                artifacts[artifact["id"]] = lines

    distribution = data.get("category_distribution")
    actual_counts = {category: 0 for category in CATEGORIES}
    if not isinstance(distribution, dict):
        add("category_distribution", "must be an object")
    else:
        for category in CATEGORIES:
            if category not in distribution:
                add("category_distribution", f'missing key "{category}"')
            elif not _is_non_negative_integer(distribution[category]):
                add("category_distribution", f'"{category}" must be a non-negative integer')

    cards = data.get("cards")
    card_ids: set[str] = set()
    if not isinstance(cards, list) or not cards:
        add("cards", "must be a non-empty array")
    else:
        for i, card in enumerate(cards):
            path = f"cards[{i}]"
            if not isinstance(card, dict):
                add(path, "must be an object")
                continue
            if not is_non_empty_string(card.get("id")):
                add(f"{path}.id", "must be a non-empty string")
            elif card["id"] in card_ids:
                add(f"{path}.id", f'duplicates card id "{card["id"]}"')
            else:
                card_ids.add(card["id"])

            category = card.get("category")
            if category not in CATEGORIES:
                add(f"{path}.category", f"must be one of {', '.join(CATEGORIES)}")
            else:
                actual_counts[category] += 1

            verdict = card.get("expected_verdict")
            if verdict not in VERDICTS:
                add(f"{path}.expected_verdict", f"must be one of {', '.join(VERDICTS)}")
            elif (verdict == "supported") != (category == "correct"):
                add(f"{path}.expected_verdict", 'must be "supported" for correct cards and "unsupported" for every corrupted category')

            if not is_non_empty_string(card.get("rationale")):
                add(f"{path}.rationale", "must be a non-empty string a person can check against the card")

            claim = card.get("claim")
            if not isinstance(claim, dict):
                add(f"{path}.claim", "must be an object")
            else:
                if claim.get("subject_id") not in subject_ids:
                    add(f"{path}.claim.subject_id", "must reference a known subject")
                if claim.get("field") not in field_codes:
                    add(f"{path}.claim.field", "must reference a known field code")
                if claim.get("unit") not in unit_codes:
                    add(f"{path}.claim.unit", "must reference a known unit code")
                if not _is_valid_value(claim.get("value")):
                    add(f"{path}.claim.value", "must be a number of at least 0 with at most two decimal places")
                if not is_non_empty_string(claim.get("period_or_basis")):
                    add(f"{path}.claim.period_or_basis", "must be a non-empty string stating the period or basis asserted")
                if not _is_iso_date(claim.get("as_of")):
                    add(f"{path}.claim.as_of", "must be an ISO date, YYYY-MM-DD")

            spans = card.get("evidence_spans")
            if not isinstance(spans, list) or not spans:
                add(f"{path}.evidence_spans", "must be a non-empty array")
            else:
                distinct_artifacts: set[str] = set()
                for j, span in enumerate(spans):
                    span_path = f"{path}.evidence_spans[{j}]"
                    if not isinstance(span, dict):
                        add(span_path, "must be an object")
                        continue
                    lines = artifacts.get(span.get("artifact_id"))
                    if lines is None:
                        add(f"{span_path}.artifact_id", "must reference a known source artifact")
                    else:
                        line_start = span.get("line_start")
                        line_end = span.get("line_end")
                        if (
                            _is_non_negative_integer(line_start)
                            and _is_non_negative_integer(line_end)
                            and line_start >= 1
                            and line_end >= 1
                        ):
                            if line_start > line_end:
                                add(f"{span_path}.line_start", f"must not exceed line_end ({line_end})")
                            if line_end > len(lines):
                                add(f"{span_path}.line_end", f"must not exceed the artifact's {len(lines)} line(s)")
                            if line_start <= line_end <= len(lines):
                                expected_quote = "\n".join(lines[line_start - 1 : line_end])
                                if span.get("quote") != expected_quote:
                                    add(f"{span_path}.quote", "must quote the artifact lines exactly, joined with newlines")
                        else:
                            add(f"{span_path}.line_start", "line_start and line_end must be integers of at least 1")
                    if isinstance(span.get("artifact_id"), str):
                        distinct_artifacts.add(span["artifact_id"])
                if category == "conflict" and len(distinct_artifacts) < 2:
                    add(f"{path}.evidence_spans", "a conflict card must cite at least two distinct source artifacts")

    if isinstance(distribution, dict):
        recorded_total = 0
        counts_are_numbers = True
        for category in CATEGORIES:
            if category not in distribution:
                counts_are_numbers = False
                continue
            recorded = distribution[category]
            if not _is_non_negative_integer(recorded):
                counts_are_numbers = False
                continue
            recorded_total += recorded
            if isinstance(cards, list) and recorded != actual_counts[category]:
                add("category_distribution", f'recorded {recorded} "{category}" cards but found {actual_counts[category]}')
        if counts_are_numbers and isinstance(cards, list) and recorded_total != len(cards):
            add("category_distribution", f"records {recorded_total} cards in total but the cards array has {len(cards)}")

    return violations


def load_case_set(path: str | Path) -> dict:
    """Read, parse and validate a case-set JSON file, raising on any violation."""
    raw = Path(path).read_text(encoding="utf-8")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as error:
        raise CaseSetValidationError([f"file is not valid JSON: {error}"]) from error
    violations = validate_case_set(data)
    if violations:
        raise CaseSetValidationError(violations)
    return data
