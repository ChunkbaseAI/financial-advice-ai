# Superseded runs under protocol 0.1.0

These runs were recorded under checker protocol 0.1.0 before the scored
batch. The pre-batch `claude-sonnet-5-three` run showed the 300-token
reasoned output limit truncating three-question responses
(`finish_reason: length`): 111 of 150 evaluations became execution
errors that were a design fault of the protocol, not a property of the
checker. Per the freeze rule, the fix (a 1000-token limit and one-short-
sentence reason descriptions) became protocol 0.2.0 with a new lock, and
every arm was rerun under it. These directories are preserved, never
overwritten; the `gemini-3.8-flash-overall` run here was halted mid-run
when the batch was stopped.

The scored results in `docs/checker-experiment-results.md` come only from
the protocol 0.2.0 runs in the parent directory.
