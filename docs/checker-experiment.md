# Checker experiment v1

Part of the checker experiment ([issue #2](https://github.com/ChunkbaseAI/financial-advice-ai/issues/2)), running on the frozen [case set v1](./case-set-v1.md) and recording through the [run recorder](./run-recorder.md) machinery. The results themselves live in the generated [checker experiment results](./checker-experiment-results.md) once runs exist.

## Problem, and who experiences it

A proposed client record can copy every number perfectly from the evidence and still be wrong: the value belongs to the wrong subject, to an older statement, to a hypothetical scenario, or to nothing in the Source Artifact at all. Naive checks ("does this number appear in the passage?") pass these Claims. Advisers and paraplanners inherit the error at review time, and builders of advice software have no public evidence about which checking approach actually catches it.

## Research question

> Given a frozen set of synthetic Claims with labelled corruption categories, can a decomposed Jev check identify unsupported or misattributed Claims more effectively, and more cheaply, than generative-LLM checkers and rule-based matching?

This is a question that can fail. Any checker may lose.

## What this is

Ten scored checker arms over the same 50 frozen cards, plus nine separately labelled verdict-only timing arms:

| Arm | Checker | Decision policy |
| --- | --- | --- |
| `rules` | value-presence matching (offline, no credentials) | categorical, exists to demonstrate the failure |
| `jev` | TypeSafe's Jev (`typesafe-ai/jev`) through the gateway's TypeSafe evaluate endpoint, three frozen typed questions | probability-gated (0.90 / 0.10) |
| `<model>-overall` × 4 | one overall question per card, schema-constrained output | categorical verdict |
| `<model>-three` × 4 | the same three questions bundled into one request | categorical verdicts, all three must pass |

The four pinned models: `anthropic/claude-sonnet-5`, `google/gemini-3.8-flash`, `openai/gpt-5.4-mini`, `anthropic/claude-haiku-4.5`. No aliases: each record carries the exact version the gateway reported back. Jev's probability-gated acceptance and the LLMs' categorical verdicts are labelled as different decision policies in the results; they are not a like-for-like accuracy claim.

Three fresh evaluations per scored arm (never replays; retries belong inside a repeat), scored independently with median and min-max. The rules checker runs offline without credentials; every other arm routes through the Vercel AI Gateway so latency and cost are measured on the same network path for every checker.

## The frozen contract

Everything a run depends on is frozen and locked before any model run:

```
fixtures/case_set_v1.json + .lock.json        the 50 cards (issue #3, unchanged)
fixtures/roster_v1.json + .lock.json          identity-only ID-to-name roster
fixtures/checker_protocol_v0_1.json + .lock   the protocol: questions, thresholds, prompts, retry rules, rendering rules
```

A run refuses to start if any hash differs from its lock, and the protocol lock is bound to the case-set and roster hashes, so nothing drifts silently. Any protocol change means a new version and a rerun.

The **Protocol** is the single source of the frozen decisions: the three Jev questions verbatim (ownership as a Choice over the household's subjects plus joint/unknown/not-stated; value support and time status as Noul questions), the 0.90/0.10 thresholds (experimental starting lines, not validated safety limits; actual answer probabilities, never Jev's separate confidence field), the LLM prompts for both configurations, the strict `json_schema` output schemas, the frozen retry instruction, the input-rendering rules, three repeats, and the limitations — written before any performance claim.

## The input contract

Every arm sees the identical model-visible input, derived from the frozen case set via the roster:

- an identity-only who's-who line naming the household's people in subject-id order, with no ownership hints (policies are never listed);
- the Claim translated via the roster — as written, never corrected, so a wrongly-attributed card keeps the wrong name;
- the card's Evidence Spans as exact quotes with artifact and line ranges; no artifact dates or titles, so the quoted text must carry any time signal.

If a subject ID cannot be resolved to exactly one roster name, the card records an **Input-Preparation Error** before any checker call — never guessed, silently dropped, or counted as a factual catch.

## Outcomes and the retry policy

A card passes only when all three checks pass; the passing outcome is named "passed these three checks", never "fully verified". Any mismatch, uncertainty or unsupported check sends the card to review, with the most severe failing check as the review reason (unsupported > mismatch > uncertain). "Unsupported" means the source lacks or contradicts the claimed support — never "proven wrong". The `mismatch` review reason is the ownership check's outcome when the source attributes the value to a different specific subject at or above the threshold; it is a check outcome, not the domain's Conflict concept (two Claims that cannot all be accepted), for which CONTEXT.md rightly avoids the word "mismatch".

Invalid output is retried exactly once with the frozen retry instruction; both responses are preserved, all cost and elapsed time including the failed attempt is counted, and two failed attempts are an **Execution Error** — never a pass or a caught mistake. A valid answer is never retried for disagreeing with the answer key. HTTP 429 uses the recorded exponential backoff; the plain-fetch client has no hidden SDK retries.

## Records

One immutable evaluation record per card × arm × repeat (run-record format version 2, extending the versioned v1 schema): original claim, exact model-visible input, every attempt and retry with raw responses, the raw generation-lookup payload, aggregate gateway-reported usage, the mapped decision, and errors. Runs refuse to overwrite an earlier run. Credentials never appear in records. Each manifest identifies the protocol version and hash, case-set version and hash, roster version and hash, the arm's model configuration, and the runner commit.

Because the gateway ingests usage events asynchronously (about 15-20 seconds), an arm's generation lookups are deferred until after its calls complete; an answer whose usage never arrives is an execution error, never a pass. Records carry both the charged cost (0 when calls are covered by credits) and the gateway-reported market cost.

## Running it

```text
cd typescript && bun install && bun test        # offline: protocol, roster, thresholds, retry, scorer, records
cd typescript && bun run typecheck
cd typescript && bun run experiment:estimate    # pre-run cost estimate from the actual inputs (network: public pricing, no credentials)
cd typescript && bun src/smoke_gateway.ts       # one Jev + one schema-constrained chat call; network + AI_GATEWAY_API_KEY
cd typescript && bun run experiment:run -- --arm rules          # offline arm (refuses to overwrite the recorded run)
cd typescript && bun run experiment:run -- --arm jev            # networked arms (AI_GATEWAY_API_KEY in .env at the repo root)
cd typescript && bun run experiment:score       # deterministic scorer: records -> docs/checker-experiment-results.md, zero model calls
```

(Verified with Bun 1.3.13, TypeScript 7.0.2, zero runtime dependencies.) Networked arms fail with a useful message when `AI_GATEWAY_API_KEY` is absent. The scorer refuses to score runs recorded under a different protocol or case set.

## Evaluation method

Per arm, per repeat (scored independently): dangerous passes (corrupted cards accepted, broken out by all seven categories), nuisance flags (correct cards sent to review), per-category catch rates, gateway-reported latency (median, p95) and cost per card evaluation. Across repeats: action flips (pass/review switches, with the cards-with-three-valid-evaluations denominator), verdict changes (review-bound verdict changes without a pass/review switch), execution errors, input-preparation errors, structured-output failures (first attempt vs remaining after retry), and cards without three valid evaluations — reported separately, never counted as passes or catches. Jev additionally gets an exploratory calibration section: when its value-support probability is high, how often is the value truly present, against the case set's value-presence ground truth.

The canonical results document is generated from the saved records by the pinned scorer with zero new model calls, limitations first.

## Pre-run cost estimate and sign-off

The estimate is computed from the actual frozen inputs (largest request per arm, characters-per-token approximation), public list prices fetched live from the gateway, and the retry allowance (worst case: every networked call retried once). The frozen estimate for protocol v0.1 lives at `fixtures/experiment_v1/cost_estimate.json`. The paid batch does not start until the maintainer signs off an explicit spending cap against it.

## Limitations

The protocol's frozen limitations bound every published number: 50 synthetic cards from one author; per-category counts of 3-5 cannot support per-category accuracy claims; three repeats establish spread, not stability; calibration findings are exploratory; the thresholds are experimental starting lines; different decision policies make the comparison a catch/cost trade-off, not a like-for-like accuracy claim; token estimates for the pre-run figure use an approximation, not a tokenizer; no extraction, no generation, no suitability or compliance claim; single case set, single run day, no cross-vendor leaderboard or "first" claim.

## What ran

The full batch ran back to back on 2026-09-20: ten scored arms (3 fresh repeats each over the 50 cards) and nine verdict-only timing arms, all through the Vercel AI Gateway, total gateway-reported list-price spend $4.10 (charged $0.005; the pre-batch and superseded runs add $1.96 market). The results are in the generated [checker experiment results](./checker-experiment-results.md).

Getting there took three frozen protocol versions, each bump forced by a failure that changed the design, with every superseded run preserved under `fixtures/experiment_v1/superseded_v0_1/` and `superseded_v0_2/`:

- **0.1.0 -> 0.2.0**: the 300-token reasoned output limit truncated three-question responses (`finish_reason: length`; 111/150 execution errors on the `claude-sonnet-5-three` pre-batch run). 0.2.0 raised it to 1000 and the batch was rerun.
- **0.2.0 -> 0.3.0**: the 100-token verdict-only limit truncated gemini-3.8-flash timing responses with empty content (hidden reasoning tokens precede visible output). 0.3.0 raised it to 1000 and the timing arms were rerun; the change touches a parameter scored arms never use, and 0.3.0 declares 0.2.0 scored runs compatible by hash, which the scorer verifies.
- **The free-tier blocker**: before the first batch, all four pinned LLMs returned HTTP 403 `RestrictedModelsError` on the experiment key's free-tier credits. Per the issue brief no model was substituted; the maintainer added credits and the batch ran with the original pins.

The pre-batch smoke check, estimate, and the maintainer's signed spending cap ($8.00, revised from $5.00 when the v0.2 estimate grew) are recorded in `fixtures/experiment_v1/spend_cap_signoff.json`.

## Next steps

- The paid batch, scoring, and the generated results document (this issue).
- A Python mirror of the run machinery is a welcome sibling-language contribution.
- Deep Agents integration, candidate selection, and UI composition are explicitly out of scope here (separate, later issues).
