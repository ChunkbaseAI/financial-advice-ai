# Financial Advice AI

Open learning and reference examples for evidence-aware financial-advice workflows.

The repository starts with a complete transcript-to-review path:

`Transcript -> summary + hard-fact candidates + soft-fact candidates + unknowns + conflicts -> review items -> FactFind Draft`

It will show runnable Python and TypeScript implementations, several architecture choices, synthetic inputs, evaluation methods, and the failures that change the design. Core workflows should not exist only as notebooks.

This repository teaches. Reusable contracts belong in AdviceKit, private evaluation belongs in the Advice Harness, and production behaviour belongs in the relevant Chunkbase product repository.

## Contributing

Read [AGENTS.md](./AGENTS.md), [CONTEXT.md](./CONTEXT.md), and [CONTRIBUTING.md](./CONTRIBUTING.md) before making a change.

Good first contributions include a synthetic edge case, a source correction, a failing fixture, a clearer limitation, or a supported example in the sibling language.

## Licence

Apache License 2.0. See [LICENSE](./LICENSE).
