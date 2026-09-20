"""Naive value-presence matching for claim cards.

Mirrors typescript/src/value_presence.ts. This is the check the checker
experiment (#2) exists to beat: it passes any card whose value literally
appears in the evidence, including wrong-subject, stale, hypothetical and
wrong-basis cards. The case set is built so exactly those categories pass.
"""

from __future__ import annotations

import re
from typing import Any

VALUE_PRESENCE_PASS_CATEGORIES = frozenset(
    {"correct", "wrong-subject", "stale-value", "hypothetical", "wrong-basis"}
)


def format_claim_value(value: int | float) -> str:
    """Format a claim value the way the artifacts write figures: comma-grouped, minimal decimals."""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return f"{value:,}"


def value_present(text: str, formatted_value: str) -> bool:
    """Naive value-presence: does the formatted figure appear, not inside a larger number?"""
    pattern = rf"(?<![\d.,]){re.escape(formatted_value)}(?!\d|,\d|\.\d)"
    return re.search(pattern, text) is not None


def check_value_presence(case_set: dict[str, Any]) -> dict[str, dict[str, bool]]:
    """Report naive value presence per card alongside the property's naive expectation."""
    results: dict[str, dict[str, bool]] = {}
    for card in case_set["cards"]:
        evidence = "\n".join(span["quote"] for span in card["evidence_spans"])
        present = value_present(evidence, format_claim_value(card["claim"]["value"]))
        results[card["id"]] = {
            "present": present,
            "expectedPresent": card["category"] in VALUE_PRESENCE_PASS_CATEGORIES,
        }
    return results
