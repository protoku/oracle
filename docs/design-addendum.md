# Design addendum: positions after review

`design.md` is the design as it stood before the two reviews in `reviews/`.
This file records what changed. Where the two disagree, this file wins.

## 1. The trusted path is longer than the kernel

The first design treated "no LLM in the evaluator" as the trust boundary. That
is necessary and not sufficient: a deterministic evaluator applied to
mis-correlated, incomplete or over-projected evidence is wrong with perfect
precision. The trusted computing base is the whole path:

1. **Raw evidence with integrity markers**: source identity, sequence,
   completeness claim, ordering uncertainty, commit status where relevant.
2. **Versioned semantic projections**: typed, property-specific, immutable once
   approved, versioned independently of expectations, tested against
   counterexamples. A projection may be proposed by an LLM; it may never
   silently change what a confirmed expectation means.
3. **Versioned expectation definitions**: formal body, approved wording,
   authority, applicability.
4. **The deterministic evaluator**: rule evaluation, evidence validation,
   verdicts.

Every verdict records the (projection version, expectation version, evidence
range) it was computed under and is never rewritten. Splitting a behavior class
produces new verdicts next to the old ones.

## 2. Verdicts have five outcomes; coverage is a separate question

| Outcome | Meaning |
|---|---|
| satisfied | sufficient evidence establishes the property within its scope |
| violated | sufficient evidence establishes a contradiction |
| pending | the obligation has not reached its evaluation boundary |
| inconclusive | missing or unreliable evidence prevents a decision |
| not applicable | the rule's preconditions do not hold |

"Outside the model" is not a verdict. It is a **coverage** result: a meaningful
behavior class with no expectation covering it. Coverage is reported alongside
verdicts and prioritized as a knowledge gap, not as an alarm.

Two consequences. An unbounded eventuality cannot be declared violated by a
finite observation; it needs a bound (`within`), a termination condition
(`until`), or the experiment horizon as an explicit boundary. And losing
observability must surface as `inconclusive`, never as `satisfied`;
observation-system health is part of the design, not a dashboard.

## 3. Three levels of truth

For any operation that crosses a boundary there are three different things:

- what is true in the environment (the provider recorded the charge),
- what the application knows (its call timed out),
- what the oracle can establish from its evidence.

Expectations about the system's behavior are written over evidence the
application can possess. Experiments may use privileged knowledge of the
simulated environment (the injected fault committed before dropping the
response). The appendix example in `design.md` violated this by putting an
unobservable fact in a precondition; the corpus does not.

## 4. Three independent dimensions instead of one status

| Dimension | Values | Where it lives |
|---|---|---|
| governance | candidate, confirmed, rejected, deprecated | the expectation file |
| applicability | a predicate over target, version, environment, flags | the expectation file |
| verification | untested, satisfied, violated, pending, inconclusive | verdicts, per target instance |

"Realized" is a verification result against a particular target, not a
property of the expectation. Versions are not assumed linear.

## 5. Evidence envelopes and observability contracts

A trace id on every record is too strong as an infrastructure assumption and
too weak as an evidence requirement. Each record carries whatever identifiers
exist (trace, business ids, transaction id, sequence, experiment ids), its
source, its times with explicit uncertainty, and the source's completeness
claim. Each expectation carries an **evidence contract**: which sources it
needs, which are authoritative, and whether completeness is required. Proving
that something did *not* happen needs a complete source through the deadline.

## 6. Boundaries: failure classes, not exhaustive pairing

The pairing rule ("every assumption needs a response for its violation") is
kept as a discipline but enforced per **failure class**, not per assumption:
unavailable, slow, invalid response, ambiguous outcome. A team covers each
relevant class or records an explicit risk exception. The ambiguous-outcome
class cannot be exception-approved for operations that move money or trigger
irreversible side effects.

## 7. Authority and contested intent

Authority is a relation between a person or role, a domain, an action and a
period of validity, not a property of whoever clicked approve. Conflicts get a
designated resolution owner and stay open until a decision is recorded. A
conflict is never resolved by picking the expectation that matches observed
behavior; that would reintroduce status-quo bias through the back door.

## 8. Reproducibility is staged by what it is for

| Evidence status | Treatment |
|---|---|
| reproduced violation | confirmed finding; may block CI |
| strongly evidenced, intermittent | investigation required; original evidence preserved |
| suspicious pattern without a confirmed expectation | candidate, not a defect |
| failed reproduction with incomplete evidence | unresolved, not dismissed |

Best-effort reproducibility (seeds, trace ids, controlled injection) is the
starting point. Determinism budget goes to findings, not to exploration.
Deterministic simulation is a possible later execution backend, not a
prerequisite.

## 9. The expectation language stays small

No embedded code in expectations. A closed set of primitives (`when`, `where`,
`require`, `forbid`, `within`, `until`, `count_distinct`, `evidence`) over
typed events produced by projections. Complexity that does not fit goes into a
typed, versioned, counterexample-tested projection, never into an expression
language. The v0 spec is `expectation-language.md`; the corpus is its first
test.

## 10. Adjudication outcomes

Four, not two: rejected hypothesis (an inference error, not a bug), confirmed
violation (the only automatic finding), unresolved disagreement, approved
change. The review UI shows a passing and a violating example for every
candidate, not only prose, because "what happens when two fulfillments refer
to one order?" tests understanding better than paraphrase.

## 11. Things the first design missed

Observation-system health. Test isolation and reset semantics. Data
sensitivity (redaction can delete the evidence an expectation needs). Behavior
class evolution without rewriting history. Mechanical conflict checks between
expectations before confirmation. Evaluation integrity: hold out defects and
rules the learner never sees.

## 12. Sequencing

The reviews converge on: keep the architecture, validate the product
hypothesis cheaply, and defer infrastructure. The plan:

1. **Trusted path first** (this corpus, then the kernel): evidence envelopes,
   completeness, projections, the five verdict outcomes, the three dimensions,
   the small language.
2. **In parallel, the offline discovery experiment**: feed a learner a frozen
   evidence bundle from a real backend, have two reviewers judge its
   candidates blind to seeded defects, and measure novel correct expectations
   per reviewer hour against an LLM-writes-tests baseline. This tests the
   fatal risk (too little valuable intent per unit of human attention) without
   building anything.
3. **Defer**: causal inference, eBPF, service-mesh fault injection,
   deterministic simulation, the review console.

The differentiation claim to keep testing: not a better test generator, but a
maintained, version-aware, human-approved model of intent that engineers and
coding agents consult *before* changing code. If nobody reads the expectation
repository before a change, the product does not exist yet.

## 13. Self-application

The runtime is a backend and should eventually be judged by itself: taint rules
over its own store (nothing LLM-provenanced reaches confirmed status without a
decision), determinism as an invariant (replayed experiments produce identical
verdicts), completeness rules over its own collectors. Self-claims whose
evidence path is not independent of the claim are inconclusive by
construction; a few integrity properties need an independent observer. Not a
first target: the builders know it too well and there is no independent source
of intent.
