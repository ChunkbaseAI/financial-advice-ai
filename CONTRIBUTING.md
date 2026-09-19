# Contributing

Chunkbase repositories are built by people working with coding agents. The agent can do a large share of the implementation. A person still owns the problem, the review, and the decision to merge.

Read `AGENTS.md` before changing anything. If the repository has a `CONTEXT.md`, read that before changing domain names or public contracts.

## Start from a bounded piece of work

Every contribution should have an owning Linear item or GitHub issue that states:

- the problem and who experiences it;
- the repository and intended outcome;
- what is outside the change;
- the proof required before completion;
- the contribution risk level.

A useful issue lets a teammate or agent begin without reconstructing the company strategy. If the task changes a public contract, domain term, provider write path, security boundary, release, or public claim, agree the direction before implementation.

## Contribution risk

Risk depends on what the change can affect, not how many lines it contains.

### Routine

Examples include a typo, a source correction, an isolated test, a synthetic fixture, or an example that does not change a public contract.

The author may use a fast coding model. The pull request still needs self-review and the relevant checks.

### Bounded

Examples include internal behaviour, a new example workflow, a read-only adapter, build configuration, or a bug fix within an established contract.

Use a model capable of following the whole repository context. A teammate reviews the code and evidence before merge.

### Governed

This includes:

- public APIs, schemas, names, or versioning;
- evidence authority, review state, or subject identity;
- provider authentication, permissions, or writes;
- secrets, personal data, client material, or retention;
- regulatory interpretation or public claims;
- releases and migrations.

Use the strongest suitable model and keep its task narrow. A named human owner reviews the change. The producing agent cannot approve or merge its own governed change.

If the level is unclear, use the higher one.

## Working method

1. Sync the default branch and create a short-lived branch.
2. Keep one problem in one pull request.
3. Preserve unrelated work and never clean another person's working tree.
4. Add or update tests and fixtures with the behaviour.
5. Run the narrowest relevant checks, then any repository gate required by `AGENTS.md`.
6. Open a draft pull request early when the change crosses packages, repositories, or more than one working session.
7. Complete the pull request template with commands, results, limitations, and cross-repository effects.
8. Request the review required by the risk level.
9. Merge only after the latest commit has the required review and evidence.

Direct commits to the default branch are exceptional and require an explicit repository-owner instruction.

## Using coding agents

Give an agent the owning issue, `AGENTS.md`, relevant source files, and the required proof. Do not ask it to “improve the repository” without a boundary.

The agent must:

- state assumptions and stop when a missing decision would change the result;
- inspect the current branch and working tree before editing;
- avoid secrets, private client information, and unlicensed vendor material;
- report which checks actually ran;
- distinguish code proof, synthetic proof, hosted proof, and human acceptance;
- disclose meaningful agent assistance in the pull request.

A human reviewer should test the claim made by the pull request, not merely approve a plausible diff.

## Review standard

Reviewers check:

- whether the change solves the stated problem;
- whether its names match the domain language;
- whether uncertainty and unsupported states remain visible;
- whether tests would fail if the behaviour broke;
- whether public API and cross-language effects are handled;
- whether docs and examples still tell the truth;
- whether the evidence supports the completion claim.

Review the latest commit. Resolve conversations before merge. A green check is evidence about a check, not proof that the product outcome is correct.

## Data and credentials

Use fictional or synthetic data in public repositories and tests. Never commit credentials, access tokens, private API documentation, personal data, client transcripts, or firm material without explicit authority and a suitable repository boundary.

## Commit and pull request style

Use a concise conventional commit subject when the repository does not specify something stricter, for example:

```text
docs(contributing): define governed review
fix(evidence): preserve explicit unknowns
feat(example): add transcript review workflow
```

Write the pull request for a teammate who does not share your chat history.
