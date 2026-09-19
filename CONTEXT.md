# AdviceKit domain language

These terms define the path from source material to human-reviewed client information across AdviceKit, the Advice Harness, and Financial Advice AI.

## Language

**Source Artifact**:
An immutable, versioned input such as a transcript, note, document, or provider response.
_Avoid_: Source, file

**Evidence Span**:
An exact location within a specific Source Artifact revision that supports or contradicts a Claim.
_Avoid_: Citation, reference

**Observation**:
A source-linked item extracted or derived from a Source Artifact that has not been accepted as client information.
_Avoid_: Extracted fact, finding

**Claim**:
A proposition about a specific subject and field that can be assessed against evidence.
_Avoid_: Answer, value

**Hard Fact Candidate**:
A Claim about objective or structured client information, such as identity, income, assets, liabilities, or dates, that still requires review.
_Avoid_: Hard Fact, extracted fact

**Soft Fact Candidate**:
A Claim about goals, preferences, priorities, concerns, experience, or other client context that still requires review and careful attribution.
_Avoid_: Soft Fact, inferred motivation

**Fact**:
A Claim accepted by an authorised reviewer as client information for a stated context and time.
_Avoid_: High-confidence claim, extracted fact

**Unknown**:
An explicit record that required information is absent, unclear, unsupported, or not yet established.
_Avoid_: Empty value, null

**Conflict**:
Two or more Claims that cannot all be accepted for the same subject, meaning, and time without resolution.
_Avoid_: Mismatch, discrepancy

**Review Item**:
A bounded question or decision presented to an authorised person because information needs confirmation, correction, rejection, or deferral.
_Avoid_: Alert, task

**FactFind Draft**:
A structured set of proposed Claims, Unknowns, Conflicts, and Review Items prepared for human review.
_Avoid_: Completed fact-find, client record

**Provider Adapter**:
A boundary that translates a provider's API and semantics while preserving provider-native identity, permissions, unsupported fields, and receipts.
_Avoid_: Connector, wrapper
