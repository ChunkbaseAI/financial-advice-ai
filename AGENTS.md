# Financial Advice AI

Financial Advice AI is the public learning and reference repository for evidence-aware financial-advice workflows. It should help a developer understand the problem, run a complete example, inspect the architecture, see how it fails, and reproduce the result.

The repository may show several architectures and frameworks, but every example must use one honest domain model and one standard of evidence. All teaching material must be original and written for this repository.

## Where we start

The first complete path is:

`Transcript -> summary + hard-fact candidates + soft-fact candidates + unknowns + conflicts -> review items -> FactFind Draft`

The summary is for reading. Exact Evidence Spans support Claims. Generated output remains proposed until a person reviews it.

Meeting intelligence follows the same source material but remains a separate output. A failed summary must not discard valid fact-find observations, and polished summary prose must not become evidence by repetition.

Read [CONTEXT.md](./CONTEXT.md) before changing domain terms.

## What belongs here

- runnable Python and TypeScript examples;
- alternative architectures using frameworks such as LangChain or Haystack;
- synthetic transcripts, documents, and provider fixtures;
- evaluation scripts and expected outputs;
- explanations of design choices, limitations, and failure modes;
- migration examples that later show the same workflow with AdviceKit.

## What does not belong here

- the reusable library contract, which belongs in AdviceKit;
- private evaluation methods or provider access, which belong in the Advice Harness;
- production Chunkbase application code;
- real client data, credentials, private API documents, or unlicensed course material;
- claims that an example gives financial advice, proves suitability, or is production compliant.

## What every example needs

An example is not complete because a notebook produced attractive output. Each example needs:

- a short problem statement and architecture diagram or description;
- executable code outside the notebook where practical;
- pinned dependencies and exact run commands;
- synthetic input with provenance;
- inspectable structured output;
- at least one failure or edge case;
- deterministic validation where possible;
- an evaluation method and the actual result;
- a limitations section;
- a clear link to the next example or reusable AdviceKit concept.

Notebooks may teach and explore. They must not be the only executable form of a core workflow.

## The six ways to mislead a learner

1. **Calling an extraction a fact.** Use Observation or Claim until an authorised reviewer accepts it.
2. **Showing only the happy path.** Include wrong speaker, unsupported number or date, missing information, conflict, and ambiguous language cases.
3. **Leaving dependencies floating.** Pin enough of the environment for another person to reproduce the run.
4. **Hiding paid services or credentials.** State what requires an account, cost, network call, or provider approval.
5. **Presenting one run as a benchmark.** State sample size, repeat count, model version, and limitations.
6. **Copying architecture without its reason.** Explain what the pattern helps, what it costs, and when a simpler approach is better.

## Repository state

This repository is at bootstrap. Do not invent a mature directory map in documentation before the first examples establish it.

When the initial examples land, update this file with the real Python and TypeScript commands. Python examples use `uv`. TypeScript examples use Bun. Keep shared input and expected-output fixtures language-neutral where possible.

## Verification

Every example should run from a clean environment using its documented command. Offline fixtures must run without credentials. Networked examples must fail with a useful message when credentials are absent.

Tests should check structure, evidence location, subject identity, units, dates, explicit unknowns, conflicts, and review state. Do not assert exact model prose unless the wording itself is the subject of the example.

## Pull requests and contribution risk

Read [CONTRIBUTING.md](./CONTRIBUTING.md). A new isolated example is usually Bounded. Domain vocabulary, benchmark methodology, regulatory explanation, model-quality claims, licensing, or a change presented as a recommended architecture is Governed.

A contributor must be able to explain what the example teaches, how to run it, and what it does not prove. Reviewers run the example rather than approving screenshots of output.

## Public contribution standard

Welcome small contributions. Good first contributions include a synthetic edge case, a source correction, a failing fixture, a clearer limitation, or the same supported example in the sibling language.

Do not lower the standard for a new contributor. Make the issue smaller and the proof clearer.

## Taste

- Teach one idea per example.
- Prefer working code over a long framework tour.
- Show the source, the output, and the gap between them.
- Publish failures that change the design.
- Make it easy for a learner to tell demo code from a production boundary.
