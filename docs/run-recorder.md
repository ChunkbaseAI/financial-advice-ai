# Run recorder v1

Part of the checker experiment ([issue #4](https://github.com/ChunkbaseAI/financial-advice-ai/issues/4); runs against the [case set v1](./case-set-v1.md) fixture, and will be driven end-to-end by #2).

## Problem, and who experiences it

"One run as a benchmark" is one of the six ways to mislead a learner. The checker experiment needs a public, versioned evidence trail for every model call, and a future public page needs machine-readable run records. This repository serves code and records only — no frontend is deployed from here — but the record format must be renderable elsewhere later.

## What this is

A run-recorder module that captures one self-describing record per model call, plus one manifest per run, written as language-neutral JSON so either language (or a later page) can read them without this repository's code.

```
typescript/src/run_record_schema.ts   record + manifest types and validation; malformed records fail loudly
typescript/src/run_recorder.ts        RunRecorder: writes manifest.json + records.jsonl
typescript/src/rules_checker.ts       prompt-set builder (strips ground truth) + deterministic rules checker
typescript/src/gateway_backoff.ts     429 retry with exponential backoff; every failed attempt stays recordable
typescript/src/record_rules_run.ts    records the offline rules run into fixtures/rules_run_v1/
fixtures/rules_run_v1/manifest.json   the frozen rules run manifest
fixtures/rules_run_v1/records.jsonl   50 records, one per card
```

## Record schema (format version 1)

One line of `records.jsonl` per model call:

| Field | Meaning |
| --- | --- |
| `format_version` | Always `1`. Self-describing so a later page can render records without this repository's code. |
| `run_id` | Identifies the run; also recorded in the manifest. |
| `sample_index` | Zero-based ordinal of the card in the frozen prompt set. |
| `repeat_index` | Zero-based repeat within the run; bounded by the manifest's `repeat_count`. |
| `timestamp` | ISO 8601 datetime with timezone, from the recorder clock. |
| `checker` | Checker name, e.g. `rules` or `jev`. |
| `card_id` | The card this call assessed. |
| `prompt_hash` | `sha256:` + 64 hex over the canonical JSON of the exact prompt the checker saw. |
| `model` | `null` for deterministic checkers; otherwise `{ id, version, provider, generation_id? }` taken from gateway response metadata — `version` is the exact version reported back, never an alias, and `provider` records which provider served the call so routing is not a hidden variable. |
| `verdict` | `supported` / `unsupported`, or `null` when the call failed. |
| `raw_answer` | The raw answer as parsed, including probabilities and confidence where the model returns them; `null` on failure. |
| `usage` | `{ latency_ms, input_tokens, output_tokens, cost }` from gateway-reported usage (provider metadata or the generation lookup), or `null`. Cost is `{ amount, currency }` or `null` when the gateway reported none. **Never a client-side estimate**: a successful model call without usage fails validation, and a deterministic checker recording usage fails validation. |
| `error` | `null`, or `{ kind, message, status? }` with kind `rate-limit` (must be status 429), `timeout`, `http-error` (must carry its status), `invalid-response`, or `other`. Error and timeout records are preserved, never discarded. |

## Manifest schema (format version 1)

`manifest.json`, one per run: `format_version`, `run_id`, `created_at`, `case_set_version` and `case_set_sha256` (verified against the frozen lock before recording), `code_commit` (full git sha that produced the run), `repeat_count`, `prompt_set_sha256` (the frozen prompt-set hash), and `checkers`.

## The prompt set

`buildPromptSet` derives one prompt per card: `{ card_id, claim, evidence_spans }`, ordered by card id. It strips `category`, `expected_verdict` and `rationale` — a checker must never see ground truth (see [case-set docs](./case-set-v1.md#how-checkers-must-consume-cards)). The prompt set is hashed (`prompt_set_sha256`) into the manifest, and each prompt is hashed into its record, so any drift between a run and the frozen case set is detectable.

## The rules checker records the same way

The rules checker is the naive value-presence matcher: a card is `supported` when the claimed value literally appears in the cited spans. It is deterministic, offline and needs no credentials, but it records through the identical `RunRecorder` path — same manifest, same record schema — with `model: null` and `usage: null`, because a deterministic checker has no gateway to report usage and must not record an estimate. Its raw answer is `{ value_present: boolean }`, the evidence a person needs to check the verdict.

The frozen run in `fixtures/rules_run_v1/` was recorded with `bun run record:rules-run` (50 records: 42 supported, 8 unsupported — exactly the dangerous passes and expected failures the case set was built to show). Tests re-derive every record from the frozen case set, so the fixture cannot silently drift.

## 429s and other failures

Model calls in #2 go through `callWithBackoff`: HTTP 429 retries with exponential backoff (default 3 attempts, 500 ms base), every other error and timeout propagates immediately. Every failed attempt is reported through `onError` so the runner records it as an error record; exhausting the attempt budget throws `RateLimitExhaustedError`, which is also preserved as a record rather than discarded.

## Running and verifying

```text
cd typescript && bun install && bun test        # includes schema, recorder, backoff and frozen-run fixture tests (offline)
cd typescript && bun run typecheck              # tsc --noEmit
cd typescript && bun run record:rules-run       # re-record the rules run fixture (use --commit/--repeat/--out to override)
```

Everything runs offline; no credentials are required. Networked model runs belong to #2 and will fail with a useful message when `AI_GATEWAY_API_KEY` is absent.

## Limitations

- Only the rules checker is recorded so far; Jev and the generative comparators are driven by #2, so the model-call record path is tested against synthetic inputs, not yet a live gateway response.
- `usage` is taken on trust from whoever builds the record: the schema enforces presence and shape, not that the values came from a gateway. #2 maps the gateway response fields directly.
- Records carry wall-clock timestamps, so re-recording a run is not byte-identical to the previous one; only the verdicts, hashes and counts are deterministic.
- No aggregation or scoring here — that stays in the results write-up, per the issue scope.
- No Python mirror yet; the fixture is language-neutral JSON, so a mirrored recorder is a good sibling-language contribution.

## Before the first networked run (#2)

- Set a gateway budget cap for the experiment API key.
- The runner must fail loudly if a state exceeds Jev's 32,000-token context window (not a v1 constraint; cards are far below it).

## Next steps

- #2 drives the checker comparison (rules, Jev, generative checkers) through this recorder, using the gateway for model calls and cost/latency reporting.
