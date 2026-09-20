import hashlib
import json
from pathlib import Path

import pytest

from faai.case_set import (
    DEFAULT_CASE_SET_LOCK_PATH,
    DEFAULT_CASE_SET_PATH,
    CaseSetValidationError,
    check_value_presence,
    format_claim_value,
    load_case_set,
    validate_case_set,
    value_present,
    verify_case_set_lock,
)


def minimal_case_set() -> dict:
    return {
        "format_version": 1,
        "case_set_version": "1.0.0",
        "description": "Minimal synthetic case set used to test the schema.",
        "provenance": {
            "synthetic": True,
            "jurisdiction": "GB",
            "statement": "All people, households and figures are fictional.",
        },
        "households": [{"id": "hh-t", "name": "Test household"}],
        "subjects": [
            {"id": "sub-t-alex", "household_id": "hh-t", "kind": "person", "name": "Alex Field"},
            {"id": "sub-t-bea", "household_id": "hh-t", "kind": "person", "name": "Bea Field"},
            {"id": "sub-t-plan", "household_id": "hh-t", "kind": "policy", "name": "Test plan", "owner_subject_id": "sub-t-alex"},
        ],
        "fields": [
            {"code": "pension.plan-value", "description": "Current market value of the subject's defined-contribution pension plan."},
            {"code": "salary.annual-gross", "description": "The subject's gross annual salary before tax."},
        ],
        "units": [
            {"code": "GBP", "description": "Pounds sterling, whole amount."},
            {"code": "GBP/year", "description": "Pounds sterling per year."},
        ],
        "source_artifacts": [
            {
                "id": "art-t-transcript",
                "household_id": "hh-t",
                "revision": "r1",
                "kind": "meeting-transcript",
                "title": "Test review meeting",
                "date": "2026-04-17",
                "lines": [
                    "Adviser: Alex, your basic salary is £52,000.",
                    "Bea: And the plan was worth £40,000 two years ago.",
                    "Adviser: We'll confirm the plan against the statement.",
                ],
            },
            {
                "id": "art-t-statement",
                "household_id": "hh-t",
                "revision": "r1",
                "kind": "provider-document",
                "title": "Test plan statement",
                "date": "2026-04-02",
                "lines": ["Plan value as at 1 April 2026: £45,250", "Plan holder: Mr Alex Field"],
            },
        ],
        "category_distribution": {
            "correct": 1,
            "wrong-subject": 1,
            "stale-value": 0,
            "hypothetical": 0,
            "unsupported": 0,
            "wrong-basis": 0,
            "conflict": 1,
        },
        "cards": [
            {
                "id": "card-t-01",
                "category": "correct",
                "expected_verdict": "supported",
                "rationale": "The statement states the plan value as at 1 April 2026, matching the claim.",
                "claim": {
                    "subject_id": "sub-t-plan",
                    "field": "pension.plan-value",
                    "value": 45250,
                    "unit": "GBP",
                    "period_or_basis": "plan value as at 1 April 2026",
                    "as_of": "2026-04-01",
                },
                "evidence_spans": [
                    {"artifact_id": "art-t-statement", "line_start": 1, "line_end": 1, "quote": "Plan value as at 1 April 2026: £45,250"}
                ],
            },
            {
                "id": "card-t-02",
                "category": "wrong-subject",
                "expected_verdict": "unsupported",
                "rationale": "The salary figure belongs to Alex, not Bea.",
                "claim": {
                    "subject_id": "sub-t-bea",
                    "field": "salary.annual-gross",
                    "value": 52000,
                    "unit": "GBP/year",
                    "period_or_basis": "current basic gross annual salary",
                    "as_of": "2026-04-17",
                },
                "evidence_spans": [
                    {"artifact_id": "art-t-transcript", "line_start": 1, "line_end": 1, "quote": "Adviser: Alex, your basic salary is £52,000."}
                ],
            },
            {
                "id": "card-t-03",
                "category": "conflict",
                "expected_verdict": "unsupported",
                "rationale": "The transcript and the statement disagree, and the claimed value matches neither.",
                "claim": {
                    "subject_id": "sub-t-plan",
                    "field": "pension.plan-value",
                    "value": 43000,
                    "unit": "GBP",
                    "period_or_basis": "current plan value",
                    "as_of": "2026-04-17",
                },
                "evidence_spans": [
                    {"artifact_id": "art-t-transcript", "line_start": 2, "line_end": 2, "quote": "Bea: And the plan was worth £40,000 two years ago."},
                    {"artifact_id": "art-t-statement", "line_start": 1, "line_end": 1, "quote": "Plan value as at 1 April 2026: £45,250"},
                ],
            },
        ],
    }


def validated_minimal_case_set() -> dict:
    violations = validate_case_set(minimal_case_set())
    assert violations == []
    return minimal_case_set()


MUTATIONS = [
    ("a missing format_version", lambda cs: cs.pop("format_version"), "format_version"),
    ("an unsupported format_version", lambda cs: cs.update(format_version=2), "format_version"),
    ("a non-semver case_set_version", lambda cs: cs.update(case_set_version="v1"), "case_set_version"),
    ("an unknown category", lambda cs: cs["cards"][0].update(category="mistake"), "category"),
    ("a correct card with an unsupported verdict", lambda cs: cs["cards"][0].update(expected_verdict="unsupported"), "expected_verdict"),
    ("a wrong-subject card with a supported verdict", lambda cs: cs["cards"][1].update(expected_verdict="supported"), "expected_verdict"),
    ("an unknown verdict", lambda cs: cs["cards"][0].update(expected_verdict="maybe"), "expected_verdict"),
    ("an unknown claim subject", lambda cs: cs["cards"][0]["claim"].update(subject_id="sub-t-nobody"), "subject_id"),
    ("an unknown claim field", lambda cs: cs["cards"][0]["claim"].update(field="pension.mystery"), "field"),
    ("an unknown claim unit", lambda cs: cs["cards"][0]["claim"].update(unit="EUR"), "unit"),
    ("a value with three decimal places", lambda cs: cs["cards"][0]["claim"].update(value=45250.125), "value"),
    ("a negative value", lambda cs: cs["cards"][0]["claim"].update(value=-5), "value"),
    ("a boolean value", lambda cs: cs["cards"][0]["claim"].update(value=True), "value"),
    ("a non-ISO as_of date", lambda cs: cs["cards"][0]["claim"].update(as_of="17 April 2026"), "as_of"),
    ("an empty period_or_basis", lambda cs: cs["cards"][0]["claim"].update(period_or_basis=" "), "period_or_basis"),
    ("an unknown artifact in a span", lambda cs: cs["cards"][0]["evidence_spans"][0].update(artifact_id="art-t-ghost"), "artifact_id"),
    ("a zero line_start", lambda cs: cs["cards"][0]["evidence_spans"][0].update(line_start=0), "line_start"),
    ("a line_end beyond the artifact", lambda cs: cs["cards"][0]["evidence_spans"][0].update(line_end=9), "line_end"),
    ("a quote that does not match the artifact lines", lambda cs: cs["cards"][0]["evidence_spans"][0].update(quote="Plan value: £99,999"), "quote"),
    ("a conflict card citing one artifact", lambda cs: cs["cards"][2].update(evidence_spans=[cs["cards"][2]["evidence_spans"][0]]), "conflict"),
    ("an empty evidence_spans list", lambda cs: cs["cards"][0].update(evidence_spans=[]), "evidence_spans"),
    ("a missing rationale", lambda cs: cs["cards"][0].pop("rationale"), "rationale"),
    ("duplicate card ids", lambda cs: cs["cards"][1].update(id="card-t-01"), "id"),
    ("a recorded distribution that disagrees with the cards", lambda cs: cs["cards"][1].update(category="unsupported"), "category_distribution"),
    ("a missing distribution key", lambda cs: cs["category_distribution"].pop("conflict"), "category_distribution"),
    ("an unknown policy owner", lambda cs: cs["subjects"][2].update(owner_subject_id="sub-t-ghost"), "owner_subject_id"),
    ("a subject pointing at an unknown household", lambda cs: cs["subjects"][0].update(household_id="hh-ghost"), "household_id"),
    ("an artifact with an empty lines list", lambda cs: cs["source_artifacts"][1].update(lines=[]), "lines"),
    ("an artifact with an unknown kind", lambda cs: cs["source_artifacts"][1].update(kind="email"), "kind"),
]


@pytest.mark.parametrize(("name", "mutate", "needle"), MUTATIONS)
def test_rejects_malformed_case_sets(name, mutate, needle):
    case_set = minimal_case_set()
    mutate(case_set)
    violations = validate_case_set(case_set)
    assert violations, f"expected violations for {name}"
    assert any(needle in violation for violation in violations), violations


def test_collects_every_violation_rather_than_stopping_at_the_first():
    case_set = minimal_case_set()
    case_set["format_version"] = 2
    case_set["cards"][0]["claim"]["unit"] = "EUR"
    violations = validate_case_set(case_set)
    assert any("format_version" in violation for violation in violations)
    assert any("unit" in violation for violation in violations)


def test_load_case_set_reads_and_validates_a_file(tmp_path):
    path = tmp_path / "case_set.json"
    path.write_text(json.dumps(minimal_case_set()), encoding="utf-8")
    loaded = load_case_set(path)
    assert loaded["case_set_version"] == "1.0.0"
    assert len(loaded["cards"]) == 3


def test_load_case_set_raises_listing_violations(tmp_path):
    path = tmp_path / "case_set.json"
    case_set = minimal_case_set()
    case_set["cards"][0]["claim"]["value"] = -5
    path.write_text(json.dumps(case_set), encoding="utf-8")
    with pytest.raises(CaseSetValidationError, match="value"):
        load_case_set(path)


def test_load_case_set_raises_for_invalid_json(tmp_path):
    path = tmp_path / "case_set.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(CaseSetValidationError, match="JSON"):
        load_case_set(path)


PRESENCE_EXAMPLES = [
    ("Current plan value: £207,432", 207432, True),
    ("It was about £185,000 two years ago.", 185000, True),
    ("a fixed rate of 2.84% until November", 2.84, True),
    ("the State Pension is £230.25 a week", 230.25, True),
    ("The mortgage is down to about £186,000.", 186400, False),
    ("Fund A: £5,000", 5, False),
    ("a pot of £1,207,432", 207432, False),
    ("could be worth around £350,000 by your 60th", 350000, True),
    ("contributing 8% of basic salary", 8, True),
    ("interest paid: £3,412.68", 3412.68, True),
    ("remaining term of 18 years", 18, True),
    ("your basic salary is £52,000.", 52000, True),
    ("the fund might support around £9,750 a year.", 9750, True),
    ("a rate of 230.255 applied", 230.25, False),
    ("a pot of £52,000,000", 52000, False),
    ("Still £78,600, though the car allowance sits on top.", 78600, True),
    ("around £91,600, and the rest would buy less income", 91600, True),
]


@pytest.mark.parametrize(("text", "value", "expected"), PRESENCE_EXAMPLES)
def test_value_presence_literals(text, value, expected):
    assert value_present(text, format_claim_value(value)) is expected


@pytest.mark.parametrize(
    ("value", "formatted"),
    [(207432, "207,432"), (230.25, "230.25"), (5, "5"), (3412.68, "3,412.68")],
)
def test_formats_claim_values_the_way_artifacts_write_them(value, formatted):
    assert format_claim_value(value) == formatted


def test_check_value_presence_reports_each_card():
    results = check_value_presence(validated_minimal_case_set())
    assert results["card-t-01"] == {"present": True, "expectedPresent": True}
    assert results["card-t-02"] == {"present": True, "expectedPresent": True}
    assert results["card-t-03"] == {"present": False, "expectedPresent": False}


def test_check_value_presence_detects_broken_cards():
    value_in_evidence = minimal_case_set()
    value_in_evidence["cards"][2]["claim"]["value"] = 40000
    results = check_value_presence(value_in_evidence)
    assert results["card-t-03"] == {"present": True, "expectedPresent": False}

    absent_value = minimal_case_set()
    absent_value["cards"][1]["claim"]["value"] = 999
    results = check_value_presence(absent_value)
    assert results["card-t-02"] == {"present": False, "expectedPresent": True}


def _write_lock(tmp_path, case_set, sha256, version):
    case_set_path = tmp_path / "case_set.json"
    lock_path = tmp_path / "case_set.lock.json"
    case_set_path.write_text(json.dumps(case_set), encoding="utf-8")
    lock_path.write_text(
        json.dumps({"case_set_file": "case_set.json", "case_set_version": version, "sha256": sha256}),
        encoding="utf-8",
    )
    return case_set_path, lock_path


def test_verify_lock_passes_when_the_hash_matches(tmp_path):
    case_set = minimal_case_set()
    raw = json.dumps(case_set)
    sha256 = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    case_set_path, lock_path = _write_lock(tmp_path, case_set, sha256, "1.0.0")
    result = verify_case_set_lock(case_set_path, lock_path)
    assert result["caseSetVersion"] == "1.0.0"
    assert len(result["sha256"]) == 64


def test_verify_lock_raises_when_the_file_changed(tmp_path):
    case_set_path, lock_path = _write_lock(tmp_path, minimal_case_set(), "0" * 64, "1.0.0")
    with pytest.raises(RuntimeError, match="frozen|sha256"):
        verify_case_set_lock(case_set_path, lock_path)


def test_verify_lock_raises_on_version_disagreement(tmp_path):
    raw = json.dumps(minimal_case_set())
    sha256 = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    case_set_path, lock_path = _write_lock(tmp_path, minimal_case_set(), sha256, "9.9.9")
    with pytest.raises(RuntimeError, match="version"):
        verify_case_set_lock(case_set_path, lock_path)


def test_frozen_case_set_loads():
    case_set = load_case_set(DEFAULT_CASE_SET_PATH)
    assert case_set["format_version"] == 1
    assert case_set["case_set_version"] == "1.0.0"


def test_frozen_case_set_has_40_to_50_cards():
    case_set = load_case_set(DEFAULT_CASE_SET_PATH)
    assert 40 <= len(case_set["cards"]) <= 50


def test_frozen_case_set_matches_the_recorded_distribution():
    case_set = load_case_set(DEFAULT_CASE_SET_PATH)
    expected = {
        "correct": 25,
        "wrong-subject": 5,
        "stale-value": 4,
        "hypothetical": 4,
        "unsupported": 4,
        "wrong-basis": 4,
        "conflict": 4,
    }
    actual = {category: 0 for category in expected}
    for card in case_set["cards"]:
        actual[card["category"]] += 1
    assert actual == expected == case_set["category_distribution"]
    assert 0.45 <= actual["correct"] / len(case_set["cards"]) <= 0.55


def test_frozen_case_set_satisfies_the_value_presence_property():
    case_set = load_case_set(DEFAULT_CASE_SET_PATH)
    results = check_value_presence(case_set)
    must_pass_naively = {"correct", "wrong-subject", "stale-value", "hypothetical", "wrong-basis"}
    for card in case_set["cards"]:
        assert results[card["id"]]["present"] is (card["category"] in must_pass_naively), card["id"]


def test_conflict_cards_cite_two_distinct_artifacts():
    case_set = load_case_set(DEFAULT_CASE_SET_PATH)
    for card in case_set["cards"]:
        if card["category"] == "conflict":
            artifacts = {span["artifact_id"] for span in card["evidence_spans"]}
            assert len(artifacts) >= 2, card["id"]


def test_frozen_case_set_verifies_against_the_lock():
    result = verify_case_set_lock(DEFAULT_CASE_SET_PATH, DEFAULT_CASE_SET_LOCK_PATH)
    assert result["caseSetVersion"] == "1.0.0"
    assert len(result["sha256"]) == 64
