# Financial Advice AI

Open learning and reference examples for evidence-aware financial-advice workflows.

The repository starts with a complete transcript-to-review path:

`Transcript -> summary + hard-fact candidates + soft-fact candidates + unknowns + conflicts -> review items -> FactFind Draft`

It will show runnable Python and TypeScript implementations, several architecture choices, synthetic inputs, evaluation methods, and the failures that change the design. Core workflows should not exist only as notebooks.

The first fixture set is in place: the synthetic Claim-card case set for the checker experiment — [docs/case-set-v1.md](./docs/case-set-v1.md), language-neutral JSON in `fixtures/`, with schema, value-presence and frozen-lock checks in `typescript/` (Bun) and `python/` (uv).

The checker experiment's run recorder has landed: a versioned, self-describing record for every model call — gateway-reported usage only, errors and 429s preserved — with an offline rules-checker run recorded in `fixtures/rules_run_v1/` ([docs/run-recorder.md](./docs/run-recorder.md), TypeScript).

This repository teaches. Reusable contracts belong in AdviceKit, private evaluation belongs in the Advice Harness, and production behaviour belongs in the relevant Chunkbase product repository.

## Contributing

Read [AGENTS.md](./AGENTS.md), [CONTEXT.md](./CONTEXT.md), and [CONTRIBUTING.md](./CONTRIBUTING.md) before making a change.

Good first contributions include a synthetic edge case, a source correction, a failing fixture, a clearer limitation, or a supported example in the sibling language.

## Licence

Apache License 2.0. See [LICENSE](./LICENSE).
