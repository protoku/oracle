I think this is a genuinely interesting direction, particularly for complex, stateful, distributed backend systems. But I would change how you frame the architecture, narrow the first implementation considerably, and challenge a few assumptions that could otherwise make the system much less useful than it initially appears.

The strongest idea here isn't automated testing. It's building an executable understanding of what a system is supposed to do, continuously improving that understanding through experimentation and human decisions.

That's a substantially more ambitious objective than generating tests with an LLM.

I also think there's a potentially important architectural distinction hiding in your proposal: the oracle should not be the thing that learns. It should be the thing that judges against established knowledge. Learning, exploration, hypothesis generation and adjudication should be separate processes.

That distinction becomes important when you start thinking about correctness, reproducibility, and trust.

## 1. What I think you've got right

### Separating observed behavior from intended behavior

This is the foundation of the entire concept.

Most existing test-generation approaches start with some combination of source code, requirements, schemas, or observed behavior and generate tests from them.

Your proposal acknowledges a deeper problem: all those sources can be wrong.

A system that has incorrectly charged customers twice for three years might consistently exhibit that behavior. It doesn't make it correct.

Keeping these separate is essential:

Observed

What happened

Declared

What code suggests

Intended

What should happen

Agreement is evidence of consistency, not necessarily correctness. Disagreement is an opportunity for investigation.

I'd preserve this separation throughout the system, including the database, agent context, UI, and test execution.

### Using the codebase as an exploration map

I particularly like this.

You're not trying to prove correctness by inspecting code. You're exploiting code's structural information to identify the system's possible behaviors.

Consider:

```
if (order.amount > 1000) {
  await requireApproval(order);
}
```

The code doesn't establish that €1,000 is the correct approval threshold.

But it tells your exploration engine something valuable: test 999.99, 1000, 1000.01, and investigate who decided the threshold.

This creates an interesting relationship between static analysis and runtime discovery.

### Turning human reviews into accumulating knowledge

This may be the most valuable product feature.

Imagine a senior engineer answers:

> If the payment provider times out after accepting the payment, we must never initiate another charge until we've reconciled the original attempt.

That answer shouldn't disappear into a Jira comment, Slack discussion, or test implementation.

It becomes a versioned expectation that future changes must respect.

Over months, the system builds an institutional memory of engineering intent that survives developers leaving, architectural changes, and AI-generated implementations.

That's potentially more valuable than the test runner itself.

## 2. Where I would challenge the design

There are six issues I'd address before committing to the full architecture.

### A. Closed-world checking is more difficult than it sounds

Your rule is:

> Every observed behavior must be explained by some expectation.

I like the philosophy, but applied literally, it's not workable.

Consider a `GET /orders/123` returning:

```
{
  "id": "123",
  "status": "pending",
  "createdAt": "2026-10-17T10:32:14Z",
  "requestId": "abc-456"
}
```

What does it mean to explain every observed behavior?

Does the oracle need expectations for the precise timestamp? The request ID? The JSON field order? Every latency variation?

You'll need a rigorous concept of behavioral equivalence.

For example, all responses with a valid timestamp and a unique request ID might belong to the same meaningful behavior class.

Even more importantly, the oracle needs a way to separate consequential changes from harmless variations.

Otherwise, unexplained observations grow faster than humans can adjudicate them.

I would introduce semantic projections: typed transformations that strip irrelevant differences while preserving the properties being judged.

And I'd distinguish three outcomes that your current model risks conflating:

- A known behavior satisfies an expectation.
- A known behavior violates an expectation.
- A behavior is outside the current model and requires investigation.

The third is not automatically a bug or even an alert. It's a knowledge gap, which needs its own prioritization.

### B. The system can never learn intent from observation alone

You already recognize status-quo bias, but I think it deserves an even stronger position in the architecture.

Suppose the explorer observes that all refunded orders are marked `completed`.

It generates the candidate:

"Refunded orders retain completed status."

A human confirms it, perhaps because that's how the system has always worked.

But what if accounting considers refunded orders a distinct financial state?

You've now created a formally confirmed error.

The missing ingredient is independent sources of intent: accounting rules, product requirements, regulations, stakeholder decisions and, sometimes, external reference implementations.

I'd give each confirmed expectation an explicit authority or owner.

A backend engineer can confirm that something describes current engineering intent, but may not be qualified to confirm financial or regulatory correctness.

Confirmation needs to establish who has authority to decide, not merely who clicked Approve.

### C. You're missing a first-class notion of experiments

Your model has Observations, Expectations, Decisions, Findings and Coverage.

I'd add Experiment as a separate, durable object.

An observation tells you what happened. An experiment tells you what question you were trying to answer.

For example:

```
experiment:
  hypothesis: "duplicate payment requests are idempotent"
  setup:
    order_state: pending
    payment_provider: simulated
  stimulus:
    requests: 2
    concurrency: simultaneous
  fault:
    location: payment_provider_response
    timing: after_commit
    action: drop
  measurements:
    - payment_attempts
    - successful_charges
    - final_order_state
  seed: 48192
```

Experiments should be replayable, comparable across software versions, and connected to the expectations they investigate.

This makes the system much more scientifically structured:

Hypothesis → Experiment → Observation → Interpretation → Decision.

It also makes exploration useful before any expectations are confirmed.

### D. Determinism is a major unresolved problem

Fault injection gets you closer to difficult concurrency bugs, but it doesn't automatically make those bugs reproducible.

A test that triggers two requests simultaneously may succeed 999 times and fail once, depending on scheduling, queue consumption, transaction ordering and network behavior.

Saving the input and random seed is insufficient to guarantee replay across an ordinary Kubernetes cluster.

You need to decide whether your target is:

1. Best-effort reproducibility using trace IDs, deterministic test data and controlled injection.
2. Controlled scheduling at significant synchronization points.
3. Full deterministic simulation or record-and-replay.

These are radically different engineering investments.

This is one area where Antithesis is worth studying: deterministic execution and reproducible fault injection are central to its testing model.

Antithesis

I would start with the first approach and design an abstraction that allows stronger scheduling later.

### E. Your knowledge model needs conditional expectations

Most interesting backend invariants aren't universally true.

For example:

"An approved order emits exactly one fulfillment event."

What if the event is delayed? What if an outage occurs? What if the order is cancelled before fulfillment? What if there is an intentional retry?

You need to represent preconditions, temporal windows, exceptions and observation boundaries.

Perhaps the true expectation is:

> Given a committed order approval, and assuming the message broker eventually recovers, exactly one logical fulfillment must eventually occur.

That's a temporal property, not simply an event-count assertion.

Even the term "exactly one" needs qualification: exactly one logical side effect is different from exactly one message, one network attempt, or one database insert.

I would design the expectation language around predicates over traces and state histories, rather than standalone request/response comparisons.

### F. The system could become a sophisticated noise generator

This is my biggest practical concern.

With enough instrumentation, you can discover thousands of correlations, transitions, boundary conditions, protocol variations and potential invariants.

The problem becomes deciding what deserves human attention.

A rule observed 10,000 times can still be coincidental. Conversely, a serious bug may only be observable once.

Statistical confidence isn't the same as business importance.

I would prioritize candidates using a combination of:

- Consequence if the rule is violated.
- Novelty relative to existing expectations.
- Strength and diversity of supporting evidence.
- Whether multiple independent sources disagree.
- Whether an experiment can falsify the candidate.
- Cost of getting a human decision.

In particular, the system should try to disprove its own hypotheses before requesting human confirmation.

That one design choice could eliminate enormous amounts of noise.

## 3. The architecture I'd build

I'd separate the system into five major subsystems, rather than making a single self-learning oracle.

1\. Discovery

Schemas · Code analysis · Runtime traces · State analysis

2\. Experimentation

Hypotheses · Test generation · Fault injection · Replay

3\. Knowledge & Adjudication

Candidate rules · Contradictions · Human decisions · Versioning

4\. Deterministic Oracle

Typed expectations · Trace evaluation · Verdicts

5\. Feedback & Evolution

Findings · Knowledge gaps · Coverage · Change impact

Feedback into discovery and experimentation

The central design constraint I'd enforce is:

An LLM may propose expectations, explanations and experiments, but only a deterministic evaluator applies confirmed expectations to observations.

This gives you an interesting separation of responsibilities.

The LLM does what it's good at: interpreting complex systems, identifying patterns, formulating hypotheses and communicating with humans.

The runtime does what it's good at: executing precise rules reproducibly.

And human decisions remain explicit, attributable and reviewable.

## 4. An important missing dimension: causality

I think this could be an even more powerful idea than mining state machines.

Backend systems are not just collections of states and transitions. They're networks of causes and effects.

Consider this sequence:

POST /orders/123/approve

Database transaction

Order → approved

OrderApproved event

Fulfillment service

External warehouse request

Your system observes this repeatedly and learns the causal pattern.

Now imagine it sees an approved order without an event.

That's interesting, but it's still primarily correlation.

What you really want to know is whether approving an order requires the event to be emitted, or whether both actions happen because of a third condition.

To distinguish those possibilities, the exploration engine should perform interventions.

For example, block the event, delay the database commit, reorder messages, or restart the service between two operations. Observe how downstream behavior changes.

This moves your system from passive specification mining toward experimental causal discovery.

There's a caveat: fault injection alone doesn't prove causality, especially when hidden state or asynchronous processes exist. But carefully controlled interventions can generate far stronger evidence than merely observing traces.

I'd make a causal graph a first-class projection of the collected observations, with edges labelled as observed correlation, inferred dependency, or experimentally supported causation.

## 5. How different is this from existing systems?

Several parts of your architecture already exist, at least independently.

| Project    | Relevant capability                                                       | What's missing relative to your vision                            |
| ---------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Daikon     | Learns likely invariants from executions                                  | Business intent, human adjudication and lifecycle management      |
| Antithesis | Autonomous exploration, fault injection, reproducible distributed testing | Your proposed human-approved, evolving business expectation model |
| Specmatic  | Executable API contracts, generated tests, dependency simulation          | Learning cross-service intent from experiments and human review   |

These distinctions are based on the publicly documented capabilities of each project, not a claim that none has internal or newer features in this area.

plse.cs.washington.edu

+3

I wouldn't attempt to outperform all three on their existing specialties.

Instead, your differentiation could be:

A system that turns discovered backend behavior into continuously maintained, human-approved executable specifications.

The competitive advantage would be the accumulated understanding of a company's systems, not necessarily a novel test generator.

## 6. What I would build first

I would explicitly avoid building the complete Kubernetes observation and fault-injection infrastructure initially.

The tempting approach is to start with Envoy, eBPF, CDC, distributed tracing and an agentic orchestration layer.

You could spend six months building impressive infrastructure without validating your central hypothesis: can this process actually discover meaningful expectations with acceptably little human effort?

I'd build a small vertical slice.

Choose one stateful service

A REST API with PostgreSQL, a few lifecycle transitions, and one external dependency. Ideally use a real service whose behavior is only partially documented.

Build discovery and experiments

Read its OpenAPI schema, optionally inspect its source code, generate stateful request sequences, snapshot relevant database state, and record immutable observations.

Infer candidate expectations

Start with state transitions, idempotency, uniqueness, invariants, and required side effects. Have the explorer actively seek counterexamples before presenting candidates.

Build human adjudication

Present a single proposed rule, actual evidence, counterexamples and the consequence of approving it. Convert approved rules into typed executable expectations.

Verify a changed version

Introduce intentional changes and deliberately seeded defects. Check whether the system detects regressions, identifies unexplained behavior, and distinguishes intended evolution from errors.

A successful demonstration would be something like this:

The system explores an order service, discovers that `cancelled` orders sometimes emit fulfillment events, identifies the pattern as suspicious, produces a reproducible experiment, asks one relevant human question, and turns the answer into a permanent regression check.

Crucially, it must achieve that without the developer hand-authoring the test case.

That's the core hypothesis worth proving.

## 7. How I'd measure whether this works

Traditional code coverage is inadequate for evaluating this product.

I'd use these metrics:

| Metric                                           | What it tells you                                               |
| ------------------------------------------------ | --------------------------------------------------------------- |
| Defects discovered per 100 human decisions       | Whether it generates useful insights rather than noise          |
| Validated expectations per hour of reviewer time | How efficiently it captures knowledge                           |
| Mutation detection rate                          | Whether it can catch deliberately introduced behavioral defects |
| False-positive rate after changes                | Whether its rules are maintainable                              |
| Experiment reproducibility                       | Whether findings can be reliably investigated                   |
| New behavior-class coverage                      | Whether exploration is actually expanding understanding         |
| Surviving expectation rate                       | Whether confirmed knowledge remains useful across versions      |

I'd also benchmark against two baselines: a competent engineer writing conventional integration tests, and an LLM generating tests directly from the same codebase.

If your architecture requires substantially more infrastructure and reviewer time but doesn't outperform these baselines on meaningful defect discovery, something is wrong with the value proposition.

## 8. One change I'd make to the knowledge lifecycle

Your current flow is:

`observation → candidate → confirmed / rejected`

I wouldn't automatically turn every rejected candidate into a bug report.

A rejected candidate might simply have been an incorrect inference.

For example, after observing ten transactions, the model infers that amounts must be positive. A reviewer rejects the candidate because refund transactions legitimately have negative amounts.

That doesn't establish a bug.

I'd distinguish:

- Rejected hypothesis: The proposed rule doesn't describe the intended behavior.
- Confirmed violation: The observed behavior contradicts an authoritative expectation.
- Unresolved disagreement: Multiple credible sources of intent conflict.
- Approved change: The intended behavior has deliberately evolved.

Only the second is automatically a defect finding. This distinction matters because otherwise learning mistakes will pollute the issue tracker.

## 9. The longer-term opportunity

I see a possible evolution beyond testing.

Once your knowledge system understands the intended behavior of a backend, it can become valuable to AI coding agents.

Imagine a coding agent receives a task:

"Change how order cancellation works."

Before modifying anything, it queries the expectation store and discovers all existing rules, dependencies, historical decisions and previously observed failure modes related to cancellation.

It proposes an implementation.

The exploration engine generates experiments around affected behavior.

The oracle verifies that unrelated approved expectations still hold.

Any intentionally changed expectations go through human review.

That creates a feedback loop between implementation and verification, without requiring the same agent to invent both the implementation and the definition of correctness.

For autonomous software engineering, this is an important separation of responsibility.

## My overall assessment

Conceptual strength

High

Technical feasibility

Feasible in stages

Infrastructure complexity

Very high at full scope

Novelty

Primarily in the integration and knowledge lifecycle

Biggest risk

Too much noise, too little validated intent

The most important architectural decision, in my view, is to treat the oracle as a small, trustworthy kernel of executable expectations, surrounded by an intelligent but fallible discovery and experimentation system.

And the most important product decision is to optimize not for the number of tests generated, but for how much reliable knowledge about the system you can acquire per minute of human attention.

There's one deeper question I think is worth exploring next:

Should the system's primary unit of knowledge actually be an expectation, or should it be a causal model of the backend from which many expectations can be derived?

An expectation says that an approved order must eventually result in fulfillment. A causal model attempts to explain how approval, transactions, events, retries and fulfillment relate.

The second representation might enable much more powerful exploration, automatic test generation and change-impact analysis. But it also introduces uncertainty that a simple executable rule doesn't have.

I suspect the strongest eventual architecture will need both.