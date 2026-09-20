# Claim-card case set v1

Part of the checker experiment ([issue #3](https://github.com/ChunkbaseAI/financial-advice-ai/issues/3), a dependency of [#2](https://github.com/ChunkbaseAI/financial-advice-ai/issues/2)).

## Problem, and who experiences it

A drafted Claim can copy every number perfectly from the evidence and still be wrong: the value belongs to the wrong subject, to an older statement, to a hypothetical scenario, or to nothing in the Source Artifact at all. Naive checks ("does this number appear in the passage?") pass these Claims. The experiment needs a frozen, labelled, synthetic case set before any model runs, and builders of advice software need inspectable teaching fixtures that show the gap between a Source Artifact and a Claim made from it.

## What this is

Fifty synthetic Claim cards across three fictional UK advice households. Each card pairs one Claim with one or more Evidence Spans quoted from fictional Source Artifacts, plus the expected verdict and a rationale a person can check by reading the card.

The fixture is language-neutral JSON shared by the TypeScript and Python examples. Both languages implement the same schema validation, the same naive value-presence matcher, and the same frozen-hash lock check, and both fail loudly on malformed input.

```
fixtures/case_set_v1.json        the case set (households, subjects, fields, units, source artifacts, cards)
fixtures/case_set_v1.lock.json   frozen sha256 of the case set, verified by every test run
typescript/                      Bun package: schema, presence and lock modules + tests
python/                          uv project: the same checks mirrored in Python
```

## Schema

Top level: `format_version` (must be `1`; self-describing so a later page can render the file without this repository's code), `case_set_version`, `description`, `provenance` (`synthetic: true`, `jurisdiction`, `statement`), `usage`, `households`, `subjects`, `fields`, `units`, `source_artifacts`, `category_distribution`, `cards`.

A **subject** is a person or a policy: `{ id, household_id, kind: "person" | "policy", name, owner_subject_id? }`. A policy owner, when present, must reference a person in the same household. Joint items (the mortgage) carry no owner.

A **field** and a **unit** are controlled vocabularies: `{ code, description }`. Every claim must use a registered code, so claims stay comparable across cards and languages.

A **source artifact** is a fictional meeting transcript or provider document: `{ id, household_id, revision, kind, title, date, lines }`. `lines` is the full text, one array entry per line, numbered from 1.

A **card** is:

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier, e.g. `card-sp-13`. |
| `category` | One of the seven categories below. |
| `expected_verdict` | `"supported"` for correct cards, `"unsupported"` for every corrupted category. Enforced by tests. |
| `rationale` | One or two sentences explaining the verdict, so a reviewer can challenge it by reading the card. |
| `claim.subject_id` | The person or policy the Claim is about. |
| `claim.field` / `claim.value` / `claim.unit` | What is claimed, how much, in what unit. Values are numbers of at least 0 with at most two decimal places. |
| `claim.period_or_basis` | The period or basis the Claim asserts, e.g. "current plan value at the date of the meeting" or "of total gross salary". |
| `claim.as_of` | ISO date the Claim is asserted for. |
| `evidence_spans[]` | `{ artifact_id, line_start, line_end, quote }`. The quote must equal the artifact's lines for that range joined with newlines — validated, never approximate. |

## Categories and design rules

| Category | Expected verdict | Design rule that makes it checkable |
| --- | --- | --- |
| `correct` | supported | Subject, value, unit, basis and as-of all match the cited span. |
| `wrong-subject` | unsupported | The value appears in the span but is explicitly attributed to another household member or policy. |
| `stale-value` | unsupported | The value appears as an explicitly historical figure ("two years ago", "in 2021"); the claim presents it as current. |
| `hypothetical` | unsupported | The value appears inside an explicitly conditional statement ("if", "could", "would"); the claim presents it with an actual-sounding basis. |
| `unsupported` | unsupported | The cited span is topically relevant but the claimed value appears nowhere in it. |
| `wrong-basis` | unsupported | The value is right but the span states a different basis: basic vs total salary, gross vs net, member vs member-plus-employer, five- vs ten-year guarantee. |
| `conflict` | unsupported | Two Source Artifacts state different values for the same subject and field, and the claim's value matches **neither** — it cannot be accepted without resolution. |

Every card is checkable by a person: read the claim, read the quoted lines, and the category rule above either holds or the card is wrong.

## The required value-presence property

The rules checker in the experiment (#2) is naive value-presence matching. The case set is built so that:

- `correct`, `wrong-subject`, `stale-value`, `hypothetical` and `wrong-basis` cards **pass** it (the value literally appears in the span) — the wrong-subject, stale, hypothetical and wrong-basis passes are the dangerous passes the experiment exists to demonstrate;
- `unsupported` and `conflict` cards **fail** it.

Both language suites assert this property for every card (`checkValuePresence` / `check_value_presence`). The matcher formats the claim value the way the artifacts write figures — comma-grouped thousands, at most two decimal places, no trailing zeros — and searches for it with boundaries so a figure never matches inside a larger number (`1,207,432` does not contain `207,432`; `£5,000` does not contain `5`). A sentence period or comma after a figure is allowed; a comma before a further digit is not.

Consequently, all monetary figures in the artifacts are written numerically (`£207,432`, `2.84%`, `£230.25`), never as words, and decimal values always have two non-zero places so the natural written form is the minimal one.

## Category distribution

Recorded in the fixture itself (`category_distribution`) and asserted by tests in both languages:

| Category | Cards |
| --- | --- |
| correct | 25 |
| wrong-subject | 5 |
| stale-value | 4 |
| hypothetical | 4 |
| unsupported | 4 |
| wrong-basis | 4 |
| conflict | 4 |
| **total** | **50** (25 correct / 25 corrupted) |

## Provenance and safety

All households, people, employers, providers and figures are fictional and were written for this repository. Provider names are fictional (Aldgate Life, Bramwell Bank, Calderdale Building Society, Meridian, Dunston & Vale, Eastgate Bank, Sefton and Pennine schemes) except generic references to public schemes (the NHS Pension Scheme and the UK State Pension). No real client data, transcripts or firm material, per AGENTS.md and CONTRIBUTING.md.

## How checkers must consume cards

`category`, `expected_verdict` and `rationale` are ground truth for evaluation. A checker must only be shown `claim` and `evidence_spans` — feeding a checker the category or rationale would leak the answer. The runner built in #2 and #4 is responsible for stripping these fields.

## Freeze and lock

The case set was frozen before any model run. `fixtures/case_set_v1.lock.json` records the sha256 of the exact file bytes, and every test suite verifies it, so any post-freeze edit fails loudly. If a change is intended, re-freeze with `bun run freeze:case-set` from `typescript/`, and record the reason in the experiment write-up.

## Running the checks

```text
cd typescript && bun install && bun test        # schema, presence, lock and fixture tests (verified with Bun 1.3.13)
cd typescript && bun run typecheck              # tsc --noEmit
cd python && uv sync && uv run pytest           # the same checks mirrored (verified with uv 0.11.12, Python 3.12)
```

Everything runs offline; no credentials are required.

## Limitations

- 50 cards is a small sample: per-category counts of 3–5 cannot support per-category accuracy claims; the write-up must state this.
- Three synthetic households from one author; the difficulty of the case set is a design choice, not a measured property.
- Text Evidence Spans only — no audio, OCR or PDF inputs in v1.
- Figures are plausible, not actuarially derived; DB benefits and projections are invented for teaching.
- The value-presence property depends on formatting conventions (numeric figures, comma grouping, minimal decimals); artifacts written differently could weaken the property test without changing the semantics.
- `conflict` cards are designed so the claim matches neither disagreeing artifact (required for the naive matcher to fail); real-world conflicts where a claim echoes one side are not represented in v1.

## Next steps

- [#4](https://github.com/ChunkbaseAI/financial-advice-ai/issues/4) builds the run recorder that will capture one versioned record per model call against these cards — landed, see [run-recorder docs](./run-recorder.md).
- #2 runs the checker comparison (rules, Jev, and the generative checkers) on this frozen set.
