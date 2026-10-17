# Independent architecture review: Self-learning test oracle

Verdict: The design is technically coherent and worth prototyping, but I would not freeze the architecture yet. There are several unresolved problems at the foundations of the system, not merely implementation details.

The revised document has improved substantially. In particular, separating the learner, human adjudication and deterministic oracle is the right direction. Making experiments first-class, supporting intent-first development, and incorporating deliberate changes into the workflow also addresses significant weaknesses in the earlier proposal.

However, I see three problems that deserve priority over the Kubernetes infrastructure, causal graph and agent orchestration:

1. The oracle can execute a rule perfectly while evaluating fundamentally incomplete or incorrectly interpreted evidence.
2. The proposed verdict model cannot adequately represent uncertainty, incomplete observations and temporal obligations.
3. The system may never discover enough meaningful intent to justify the human review effort.

The first two threaten technical correctness. The third threatens the entire product proposition.

## 1. Your trusted kernel is smaller than your actual trusted system

The design says the oracle is a deterministic kernel without an LLM, network access or mutable internal state.

That's desirable, but it doesn't establish a trustworthy oracle.

Consider a confirmed expectation:

> Every completed payment must have a corresponding ledger entry.

The raw evidence contains:

```
payment.completed
ledger.entry.created
```

The oracle reports success.

But consider what could have happened before those events reached it:

- An LLM-generated projection matched ledger entries using the wrong identifier.
- A collector silently dropped an event.
- The projection discarded a duplicate ledger entry.
- The event correlation joined two different payment attempts.
- The data represented an uncommitted transaction that subsequently rolled back.

The evaluator can be mathematically correct while the verdict is factually incorrect.

### My proposed correction

Your trusted computing base should be:

Raw evidence + evidence integrity

Completeness · Ordering · Commit status · Source identity

Versioned semantic projections

Typed · Auditable · Independently testable

Versioned expectation definitions

Approved meaning · Authority · Applicability

Deterministic evaluator

Rule evaluation · Evidence validation · Verdicts

Semantic projections are particularly dangerous because they determine what information the oracle can see.

For example, removing `requestId` may be sensible when comparing equivalent HTTP responses, but disastrous when validating request idempotency.

I would require projections to be property-specific, immutable once approved, versioned independently of expectations, and testable using known counterexamples.

An LLM can propose a projection, but it must not silently redefine what a confirmed expectation means.

That is a more important trust boundary than separating the LLM from the final evaluator.

## 2. The verdict model needs another dimension

The document currently proposes satisfied, violated and outside-the-model outcomes for behavior classes.

That works for simple observations but breaks down for temporal rules.

Suppose the expectation is:

> An approved order must be dispatched within 30 seconds.

You observe approval at 12:00:00.

At 12:00:10, no dispatch has occurred.

Is this a failure? No. Is it satisfied? No. Is it outside the model? No.

The obligation is pending.

At 12:00:31, there is still no dispatch, but the message collector has been offline since 12:00:05.

You cannot distinguish a system failure from missing evidence.

The verdict is inconclusive, not violated.

This is a known issue in runtime verification: temporal properties evaluated over incomplete execution histories require semantics that represent inconclusive results.

ACM Digital Library

+1

I'd model this as two separate questions:

Rule evaluation

| Outcome        | Meaning                                                               |
| -------------- | --------------------------------------------------------------------- |
| Satisfied      | Sufficient evidence establishes the property within its defined scope |
| Violated       | Sufficient evidence establishes a contradiction                       |
| Pending        | The obligation has not reached its evaluation boundary                |
| Inconclusive   | Missing or unreliable evidence prevents a decision                    |
| Not applicable | The rule's preconditions do not hold                                  |

Model coverage: Independently determine whether a meaningful observed behavior is covered by an expectation or remains unexplained.

Outside-the-model is not really the same type of result as a rule verdict. Keeping them separate would simplify the formal semantics considerably.

One particularly important consequence: an unbounded eventuality cannot generally be declared violated simply because nothing happened during a finite observation period. You need either a bounded deadline or a separately defined termination/failure condition.

## 3. A concrete contradiction in your payment example

Your appendix contains this expectation:

```
given:
  - payment_request.sent
  - provider.timeout
  - provider.state == accepted

then:
  not exists(charge.new)
  until reconciliation.completed
```

There's a subtle but important problem.

When a payment provider times out, the caller often cannot know whether the provider accepted the payment.

In your controlled experiment, the fault injector might know that the provider committed before dropping the response.

But in production, that knowledge may be fundamentally unavailable until reconciliation occurs.

You've encoded the condition you're trying to reason about as a precondition that might not be observable.

I'd separate the rule into two parts.

The system's obligation:

```
when:
  payment_attempt.response: timeout

require:
  - no_new_charge_for_same_intent
  - reconciliation_required_before_retry

until:
  original_attempt_status: resolved
```

The experiment:

```
scenario:
  provider_commit: successful
  response_to_client: dropped
```

The oracle checks the obligation using evidence the system can actually possess. The experiment uses privileged knowledge about what happened inside the simulated dependency.

That distinction should exist throughout the architecture:

- What is true in the environment.
- What the application knows.
- What the oracle can establish from its observations.

These may all differ.

It also means an observation isn't automatically a complete fact about an operation. It's evidence from a particular observer.

## 4. The knowledge lifecycle needs independent dimensions

The addition of `confirmed but unrealized` is a good improvement. But I wouldn't keep expanding a single expectation status enum.

Consider an expectation that is:

- Confirmed by an authorized decision.
- Implemented on a feature branch.
- Verified against the branch.
- Not deployed to production.
- Applicable only when a feature flag is enabled.
- In conflict with an older expectation still applicable to the previous deployment.

A single lifecycle status struggles to express this without becoming a combinatorial state machine.

I'd separate three dimensions.

| Dimension     | Example values                                       |
| ------------- | ---------------------------------------------------- |
| Governance    | Candidate, confirmed, rejected, deprecated           |
| Applicability | Code version, deployment, environment, tenant, flags |
| Verification  | Untested, satisfied, violated, pending, inconclusive |

Realization then becomes a result of evaluating a confirmed expectation against a particular target system, rather than a permanent property of the expectation itself.

You could say:

"Expectation E-42 is confirmed, applies to feature version 2, passed against commit A, but has not been verified against the production deployment."

That's substantially more precise.

I'd also avoid assuming software versions form a simple linear sequence. Feature branches, rolling deployments, configuration changes and mixed-version clusters make applicability a predicate over deployment context, not just a `valid_from` commit hash.

## 5. The formal expectation language is the next thing to design

You have identified the right categories, but not yet defined their semantics.

I would avoid inventing a general-purpose language capable of expressing arbitrary temporal logic immediately.

Start with a small set of composable primitives:

| Primitive        | Meaning                                       |
| ---------------- | --------------------------------------------- |
| `when`           | An observable trigger                         |
| `where`          | Preconditions and correlation                 |
| `require`        | Something must hold or occur                  |
| `forbid`         | Something must not occur                      |
| `within`         | A bounded observation window                  |
| `until`          | A condition defining the end of an obligation |
| `count_distinct` | Cardinality over logical entities             |
| `evidence`       | Sources and completeness needed to judge      |

For example:

```
kind: temporal_effect

when:
  event: order.approved

correlate_by:
  order_id: $trigger.order_id

require:
  event: fulfillment.created
  count_distinct: fulfillment_id
  equals: 1

within: 30s

evidence:
  required:
    - orders.cdc
    - fulfillment.cdc
  completeness: required
```

This only works if `orders.cdc` and `fulfillment.cdc` have defined, trustworthy semantics, including what counts as a committed operation and when their event streams are complete.

I would also make the approval UI display an example that passes and one that violates the rule.

For instance, ask the reviewer to confirm what happens when two fulfillment records refer to the same order. Do they represent two legitimate shipments, two attempts at one shipment, or an invalid duplicate?

That's a better test of whether the human-approved wording matches the formal specification than merely translating prose back into prose.

### An important constraint

Don't let expectation definitions contain unrestricted Python, JavaScript or SQL expressions in the first implementation.

You want a small language whose behavior can be validated and whose supported cases can be exhaustively tested.

Existing stateful testing tools such as Hypothesis already provide mature mechanisms for generating sequences and checking invariants. You could use those underneath your experimentation layer rather than implementing every testing mechanism yourself.

Hypothesis 6.170.1 documentation

## 6. Observation completeness must be first-class

Your current design requires every observation, experiment and verdict to carry a trace ID.

That's too strong as an infrastructure assumption, and not strong enough as an evidence requirement.

A PostgreSQL WAL change won't necessarily contain an application trace ID. A batch job may have no incoming trace. A message may lose its tracing context. A third-party service may expose no correlation identifier at all.

Correlation may require several sources:

- Trace and span identifiers.
- Business identifiers, such as order IDs.
- Database transaction IDs or WAL positions.
- Message offsets and partition information.
- Experiment-generated identifiers.
- Timestamps, with explicit uncertainty about ordering.

Instead of requiring a trace ID everywhere, define an evidence envelope containing the available identifiers, source, time information, completeness status and correlation method.

This matters especially when detecting something that did not happen.

Suppose you want to prove that a particular order emitted no fulfillment event within 30 seconds.

You need evidence that the relevant stream has been completely observed through the deadline, including any permitted lateness.

Otherwise, a missing event might simply reflect delayed collection.

OpenTelemetry explicitly documents how independent sampling decisions can produce incomplete traces. That is one concrete reason ordinary observability telemetry cannot automatically serve as complete verification evidence.

OpenTelemetry

I'd introduce an observability contract for every expectation: which evidence is required, which sources are authoritative, how completion is established, and what happens when evidence is unavailable.

## 7. The dependency pairing rule is too absolute

Your rule says every assumption about an external dependency must have a response expectation for its violation.

The intention is good. It prevents teams from assuming dependencies will always behave correctly.

But mechanically enforcing this for every assumption can produce an enormous number of expectations.

Imagine a service depending on seven external systems, each with ten conceivable failure modes.

Now add combinations: a queue outage during a database failover while another provider is returning stale responses.

There's no useful upper bound.

I would introduce failure classes, with risk-based coverage obligations.

For example, a dependency could have four general failure classes: unavailable, slow, invalid response and ambiguous outcome.

The system would require the team to cover each relevant class or explicitly approve a risk exception. Specific experimentally discovered failure modes could then be mapped to those classes.

This preserves the discipline without demanding exhaustive failure permutations.

## 8. Authority and contested intent need an explicit governance model

Your document correctly says that confirmation must come from someone with authority, rather than simply anyone who clicks Approve.

But authority is rarely a straightforward property of a person.

Suppose finance requires a refund to complete immediately, while engineering knows the payment provider may take hours to reconcile a transaction.

Who gets to approve the expectation?

Neither team can independently define the whole rule.

I would treat authority as a relation between a person or role, a domain, an action, and a period of validity.

A conflict should have a designated resolution owner and remain unresolved until the appropriate decision is recorded.

Importantly, a conflict must never be resolved by choosing whichever expectation best matches observed behavior.

That would silently reintroduce status-quo bias.

## 9. Best-effort reproducibility is defensible, with one qualification

I agree with the staged approach in the document.

You don't need deterministic simulation to discover every potential defect.

However, I would distinguish:

| Evidence status                                    | Treatment                                                |
| -------------------------------------------------- | -------------------------------------------------------- |
| Reproduced violation                               | Confirmed finding, eligible to block CI                  |
| Strongly evidenced but intermittent                | Investigation required, with original evidence preserved |
| Suspicious pattern without a confirmed expectation | Candidate, not a defect                                  |
| Failed reproduction with incomplete evidence       | Unresolved, not automatically dismissed                  |

Don't require exact reproduction before reporting an important anomaly. Some serious production races may be difficult or impossible to reproduce in the initial test environment.

But don't treat a single ambiguous trace as equivalent to a reproducible violation either.

As a longer-term investment, Antithesis demonstrates the value of exact replay. Its documentation describes deterministic simulation, multiple execution timelines and investigating how interventions affect bug occurrence.

Antithesis Docs

+1

That is an expensive capability to recreate. I'd treat it as an optional future execution backend rather than a prerequisite for the core product.

## 10. What I think is missing entirely

These are the additional areas I'd explicitly put into the design.

Observation-system health. The test oracle needs to detect when its own collectors, correlators or projections are failing. Otherwise, losing observability can make a faulty system appear healthier.

Test isolation and reset semantics. Active exploration changes state. It needs a trustworthy way to establish the initial state, clean up afterward and prevent tests from affecting external real-world systems.

Data sensitivity. Capturing arbitrary API payloads, database records and third-party traffic creates privacy and security obligations. Redaction can itself remove evidence needed by expectations, so this must be designed rather than added later.

Equivalence-class evolution. The learner will continually discover that two behaviors previously considered equivalent are actually different. Splitting a behavior class must not silently reinterpret historical verdicts.

Expectation conflicts. Two individually valid expectations might be impossible to satisfy simultaneously. The store needs consistency checks before confirmation, at least for the subset of rules that can be compared mechanically.

Evaluation integrity. If the system learns from the same examples used to benchmark it, it can appear successful without discovering new generalizable knowledge. Hold back undisclosed behaviors and defects when evaluating the learner.

## 11. The cheapest experiment I'd run before the vertical slice

Your proposed vertical slice is sensible, but it's still a considerable engineering investment.

There's a cheaper way to test the most consequential assumption.

Can the learner propose expectations that humans genuinely recognize as useful, rather than merely restating the behavior of the code?

I would conduct an offline discovery experiment.

Take a real, partially documented backend and provide the learner with a constrained evidence bundle: API descriptions, recorded execution traces, state changes and selected schema declarations.

Prepare a separate evaluation set containing known defects, legitimate exceptions and intended business rules not explicitly revealed to the learner.

Have the learner generate candidate expectations and explanations, including attempts to falsify its own hypotheses.

Then let experienced engineers review them without telling them which candidates relate to seeded defects.

PROPOSED EXPERIMENT

# 30

Candidate expectations presented

# 2

Independent reviewers

# 3

Evidence sources per candidate, when available

# 1

Baseline: direct LLM test generation

Primary measurement

## Novel, correct expectations confirmed per reviewer hour

Also measure incorrect approvals, meaningful defects surfaced, review fatigue and how often a reviewer needs information the system cannot provide.

The numbers above are proposed experiment parameters, not established benchmarks.

The most revealing outcome isn't necessarily whether the learner discovers a seeded bug. It's whether humans can efficiently distinguish valuable expectations from plausible but misleading ones.

If reviewers consistently have to reconstruct the entire system themselves to decide whether a candidate is correct, your proposed human-in-the-loop advantage may disappear.

I'd test this before building CDC integration, a sophisticated DSL or Kubernetes fault injection.

## 12. Is the differentiation defensible?

I think this is a real question.

Much of the surrounding tooling is becoming increasingly sophisticated. Antithesis, for example, already describes agent-assisted property catalogs alongside autonomous state exploration and fault injection.

Antithesis Docs

An AI that suggests invariants is unlikely to remain a differentiator by itself.

Your stronger potential advantage is the combination of:

Institutional intent + executable verification + change governance.

That could become a durable asset because a company accumulates validated rules, the reasons behind them, historical exceptions and their relationship to deployed behavior.

But I would not assume that automatically becomes a standalone product. It's also conceivable that this belongs inside an existing developer platform, CI system or AI coding environment.

My test would be whether engineering teams find the expectation repository useful before running any tests.

If engineers and coding agents routinely consult it to understand what must remain true during a change, you've created something more valuable than another testing tool.

## 13. Answers to the ten questions in section 15

Here's how I would resolve the document's explicit open questions.

| Question                                               | My conclusion                                                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Is the learner/oracle separation sufficient?        | No. Projections, evidence completeness, correlation and formalization are also in the trusted path.                                                 |
| 2. Can projections avoid becoming hand-authored rules? | Partly. Generate candidates, but require typed, versioned, property-specific transformations.                                                       |
| 3. Is confirmed-but-unrealized sufficient?             | No. Separate governance, applicability and verification instead of adding more lifecycle statuses.                                                  |
| 4. Does assumption-response pairing scale?             | Not literally. Use failure classes, risk-based obligations and explicit exceptions.                                                                 |
| 5. Is best-effort reproducibility acceptable?          | Yes for discovery. Preserve evidence and classify confidence; stronger replay is a later investment.                                                |
| 6. Who resolves contested intent?                      | Explicit domain authority and conflict escalation, not engineering consensus by default.                                                            |
| 7. Product or incumbent feature?                       | Unproven. The maintained intent repository is the candidate differentiator.                                                                         |
| 8. Minimum expectation language?                       | A small typed event/trace DSL with bounded temporal operators and explicit evidence contracts.                                                      |
| 9. Most likely fatal risk?                             | Too few valuable expectations per unit of reviewer effort. Test offline before building infrastructure.                                             |
| 10. What's missing?                                    | Evidence integrity, partial observability, semantic versioning, test isolation, data sensitivity and verification of the observation system itself. |

## Final assessment

I would preserve the overall architecture and the central principle that humans authorize intent while deterministic machinery enforces it.

But I'd reorder the engineering priorities:

Keep: learner, adjudication, deterministic oracle, experiments and immutable evidence.

Redesign before implementation: evidence integrity, verdict semantics, projections, applicability and the expectation language.

Validate first: useful expectation discovery with minimal human involvement.

Defer: sophisticated causal inference, eBPF infrastructure, distributed orchestration and deterministic simulation.

There is also a more fundamental architectural insight here.

Your system isn't just learning a specification. It's learning which claims about a system can legitimately be made from the evidence available.

That means it needs an explicit model of what it knows, what it assumes, what it cannot observe, and what it cannot conclude.

Without that, you risk creating an extremely sophisticated mechanism for giving false confidence.

With it, I think the design becomes much more compelling, because a trustworthy system that can tell an engineer "I cannot establish that this operation is correct, and here's the specific evidence or decision I need" could be more useful than one that simply generates another thousand passing tests.