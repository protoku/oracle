# A self-learning test oracle for backend systems

**Status:** design discussion summary, for independent review
**Scope:** backend software systems (services, databases, queues, external APIs); no UI testing
**Purpose of this document:** capture a multi-step design conversation in enough detail that another agent can judge its soundness, find weaknesses, and challenge assumptions. Sections 11, 12 and 15 are the most useful starting points for a critical reader.

---

## 1. Problem statement

How can you gain confidence that software works correctly without reading its code?

The answer we converged on: treat the system as a black box and compare what it *does* against what it *should do*. Testing can show the presence of bugs but never their absence, so the goal is strong evidence rather than proof. The hard part is not running tests; it is knowing the right answer to compare against. Testers call that the **test oracle problem**.

The design that follows is an attempt to build an oracle that:

1. holds a precise, machine-checkable model of what a backend should do,
2. is populated by learning from the running system and from human decisions rather than by hand-authoring every rule,
3. judges new behavior against that model deterministically, and
4. flags behavior it has no expectation for, instead of silently assuming it is fine.

---

## 2. Core concepts

### 2.1 Three sources, kept apart

Every piece of knowledge about the system comes from one of three sources, and the design keeps them separate at every layer (data model, agent context, UI, execution):

| Source | Meaning | Trust level |
|---|---|---|
| **Observed** | What the system actually did | Fact, but not correctness |
| **Declared** | What code, schemas and config suggest | A developer's belief at one point in time |
| **Intended** | What the system should do | Human intent, with an identified authority |

Agreement between sources is evidence of *consistency*, not correctness: a system that has double-charged customers for three years exhibits that behavior consistently. Disagreement between sources is the primary signal for where to investigate.

### 2.2 Observation versus expectation

An **observation** is something the system was seen doing. An **expectation** is a rule about what it should do. Observations are immutable facts. Expectations are judgments with provenance, status and an owner. Nothing becomes an expectation without passing through human adjudication.

### 2.3 Closed-world checking, at the right granularity

Conventional testing is open-world: anything not explicitly checked is assumed fine. The design flips this: every observed behavior should be explained by some expectation, and unexplained behavior is a visible gap.

Applied literally this is unworkable (timestamps, request IDs, field order, latency jitter would all be "unexplained"). It is therefore applied to **semantic projections**: typed transformations that strip irrelevant variation and group observations into behavior classes. The oracle produces three distinct outcomes per behavior class:

- **Satisfied**: a known behavior matches an expectation.
- **Violated**: a known behavior contradicts an expectation.
- **Outside the model**: no expectation covers it. This is a *knowledge gap* to prioritize, not automatically a bug or an alert.

### 2.4 Three roles: learner, adjudication, oracle

The single most important architectural decision: **the oracle does not learn.**

- The **learner** is large, LLM-driven and allowed to be wrong. It explores the system, runs experiments, records observations, infers candidate expectations, tries to falsify them, and presents survivors to humans with evidence and a single question.
- **Adjudication** is performed by humans with the right authority. They confirm, reject, resolve conflicts, or approve intentional changes, and every decision is recorded with its reasoning.
- The **oracle** is a small deterministic kernel. It holds confirmed expectations and applies them to observations, producing verdicts. It contains no LLM, no network access to the target, and no state beyond what it reads from the stores.

Trust flows downward (learner proposes, humans decide, oracle enforces). Information flows back up (the oracle's violations and gaps become the learner's next leads).

---

## 3. Dimensions of behavior worth covering

These serve two purposes: a checklist for exploration of existing systems, and a question generator for eliciting expectations about new ones.

- **User journeys**: end-to-end flows rather than isolated endpoints.
- **Failures and bad input**: invalid, missing, oversized, malformed; graceful failure.
- **State and data**: lifecycles, transitions, stored-data consistency.
- **Concurrency**: overlapping actions on the same records, double submits, racing jobs.
- **Time**: zones, DST, month/year end, expiry, scheduled jobs, long idle periods.
- **Scale and volume**: large data sets, payloads, peak load, gradual degradation.
- **Permissions**: who may do what; role changes mid-session.
- **External dependencies**: slow, down, changed, unexpected responses.
- **Recovery**: crashes mid-operation, restarts, retries, consistent end states, no duplicate effects.
- **Change over time**: migrations, old data meeting new code, mixed versions, flags.
- **Data lifecycle**: archiving, export, deletion, retention.
- **Observability**: whether failures in production are detectable.

Compact form: *who, what, when, where, how much, what if.*

---

## 4. Learning from an existing system

### 4.1 The discovery loop

1. **Explore**: use the system as its callers do; vary inputs, walk entity lifecycles, trigger failures, run concurrent requests, inject faults at boundaries.
2. **Observe**: record API traffic, database changes (change data capture), emitted events, outbound calls and timings, all correlated by trace id.
3. **Infer**: draft candidate expectations (state machines, invariants, causal patterns) using specification-mining and invariant-inference techniques plus LLM interpretation.
4. **Falsify**: before any candidate reaches a human, design and run experiments that would disprove it. Only survivors are presented.
5. **Present**: plain-language statement, two or three supporting examples, any counterexamples, origin, the consequence of approving it, and one clear question.
6. **Adjudicate and update**: decisions enter the knowledge store; exploration refocuses on the least certain areas (active learning).

### 4.2 Principles

- The learner learns what the system *does*, not what it *should* do. Existing bugs look normal. Everything inferred is a candidate until confirmed.
- Distinguish "never happens" from "never observed." Absence of evidence is a gap, not a rule.
- Prioritize human attention: rare paths, boundaries, contradictions, high-consequence behavior.
- Show examples, not only rules.

### 4.3 Where observations come from

API requests/responses, change-data-capture streams from databases, message-broker traffic, outbound calls to dependencies, distributed traces linking all of the above to a cause, and (optionally) code-coverage feedback indicating which branches a probe reached.

---

## 5. Building new code and changing existing systems

### 5.1 Direction flips

With existing code, behavior exists and intent is reconstructed. With new code, intent exists and behavior does not yet. The oracle, learner and stores are the same; their roles shift.

### 5.2 Expectations enter before the system does

Candidates arrive from intent sources (tickets, design docs, product conversations) with authored provenance. They need a status the existing-code flow lacks: **confirmed but unrealized**. The oracle must distinguish "the system violates this" from "the system does not do this yet." When experiments satisfy an unrealized expectation it becomes **realized**. A previously realized expectation that now fails is a regression.

### 5.3 Elicitation replaces inference as the learner's main skill

A requirement states the happy path. The learner interrogates it using the dimensions in section 3 before code is written: what if the dependency is down, what if cancelled first, is the operation idempotent, who may perform it, what happens at period end. The bias to guard against changes: status-quo bias disappears and **specification optimism** (specifying what should happen, skipping what should happen when things fail) takes its place.

### 5.4 Experiments are derived, not authored

Each unrealized expectation implies the experiment that would falsify it. These are the acceptance tests. A developer can run them against a branch at any time and see which unrealized expectations now pass, which confirmed ones broke, and which behaviors the oracle cannot explain.

### 5.5 The change workflow is the front door

Most new code is a change to an existing system. The workflow:

1. Query the knowledge store for expectations touching the affected scope.
2. Decide which the change will intentionally break; propose edits (deprecate, modify, add).
3. Adjudicate the edits with decision records.
4. Write the code.
5. Run derived experiments; unrealized expectations become realized; anything else that fails is a regression; anything unexplained is a candidate.

The store then holds old expectations deprecated as of the change and new ones unrealized until it, so intended evolution and accidents are distinguishable. Without this workflow the system degrades into ignored snapshot tests, which we consider the largest adoption risk.

### 5.6 Coding agents

An agent that writes code must not also define correctness. It reads the store, proposes an implementation, and the learner and oracle verify it. It may propose expectation changes, which go through human adjudication like any other. This gives an agent loop where implementation and the definition of correct are produced by different parties.

### 5.7 Learning does not stop for new code

New code does things nobody specified. Observation-first exploration runs alongside intent-first verification: one checks that the system does what was asked, the other catches what it does that nobody asked for. Static cross-checks apply in reverse: if intent says orders are capped at 10,000 and the new code declares no check, the mismatch is visible before anything runs.

---

## 6. Knowledge model

### 6.1 Records

| Record | Content | Notes |
|---|---|---|
| **Observation** | Stimulus, effects (response, state changes, events, outbound calls, timings), context (system version, environment, seed data, trace id) | Immutable, append-only; the only record holding facts |
| **Experiment** | Hypothesis, setup, stimulus, faults (location, timing, action), measurements, seed; links to resulting observations and to the expectations investigated | Replayable; comparable across versions; useful before any expectation is confirmed |
| **Declaration** | A constraint extracted from code, schema, migration or config, with source location and commit | Exploration hint and candidate; never truth |
| **Expectation** | Typed formal body; human-approved wording; scope; status; provenance; owner/authority; links to supporting and contradicting observations; system version range; full history | Nothing enters confirmed status without adjudication |
| **Verdict** | One behavior class checked against one expectation: satisfied / violated / outside model | Produced only by the kernel |
| **Decision** | Question asked, answer, who, authority, when, reasoning | The record of intent and of resolved conflicts |
| **Finding** | A confirmed violation with its reproducing experiment and observation | The bug tracker as a by-product |
| **Coverage** | Behavior classes, states, transitions, declared boundaries, fault types and code branches exercised; last-verified time per expectation | Drives exploration and signals staleness |
| **Vocabulary** | Glossary mapping technical identifiers to business meaning | Enables human-readable rendering |

### 6.2 Expectation lifecycle

`candidate → confirmed (unrealized → realized) | rejected | deprecated`

### 6.3 Outcomes of adjudication (four, not two)

- **Rejected hypothesis**: the proposed rule does not describe intent (an inference error, e.g. "amounts are always positive" rejected because refunds are negative). Not a bug.
- **Confirmed violation**: observed behavior contradicts an authoritative expectation. This, and only this, is automatically a finding.
- **Unresolved disagreement**: credible sources of intent conflict; needs escalation to the right authority.
- **Approved change**: intended behavior has deliberately evolved; old expectation deprecated, new one unrealized.

### 6.4 Authority and provenance

Each confirmed expectation carries an owner with authority over its domain. An engineer can confirm engineering intent but may not be qualified to confirm financial or regulatory correctness. Confirmation records who had authority, not merely who clicked approve. Independent sources of intent (accounting rules, regulations, product decisions, reference implementations) are first-class inputs, because intent can never be derived from observation alone.

### 6.5 Expectation kinds and formal language

A closed set of kinds, each with a typed schema and a natural rendering:

invariant · state transition · contract · causality · idempotency · ordering · temporal bound · failure behavior · performance bound

Most interesting backend expectations are conditional and temporal rather than simple request/response assertions. The formal language should therefore be built around **predicates over traces and state histories**, with preconditions, temporal windows, exceptions and observation boundaries. Example of the true shape of a rule: *given a committed order approval, and assuming the broker eventually recovers, exactly one logical fulfillment eventually occurs.* "Exactly one" must be qualified: one logical side effect is different from one message, one network attempt or one database insert.

Trade-off acknowledged: temporal predicates are harder for humans to read, which increases the burden on the presentation layer.

### 6.6 Presentation and round trip

Humans see views, not the store: a candidate with plain statement, examples for and against, origin, consequence and one question; conflicts with the exposing observation; gaps; changes since last review; stale expectations.

The human-approved wording is stored alongside the formal body so an LLM paraphrase never silently becomes what was approved. Translation runs both ways with a round trip: prose → formal → prose → "is this what you meant?" before confirmation.

---

## 7. Boundaries and external dependencies

### 7.1 Assumptions versus responses

The boundary is where observability and fixability both drop. Dependencies use the same records, but their expectations split in two:

- **Assumptions**: expectations about the dependency (responds within 2 s, writes are durable, never returns duplicate IDs). Unenforceable; held with explicit uncertainty; never "confirmed" in the internal sense; carry a "last seen in real traffic" date.
- **Responses**: expectations about the system's behavior given each possible dependency behavior (on payment timeout: order stays pending, retry scheduled, no double charge). Owned by the team; most of the value lives here.

**Pairing rule, enforced mechanically:** every assumption must be paired with a response expectation for its violation.

### 7.2 Probes

A probe is a controllable proxy at each boundary.

- **Passive mode**: pass traffic through and record it. Recordings of real dependency behavior (response shapes, latency distributions, actual error codes) are the model of "normal" and a better stub than anything hand-written.
- **Active mode**: perturb normal. Fault catalogue: delay, timeout, connection drop, specific error codes, malformed or partial responses, duplicates, reordering, outage and recovery.
- **Timing is the critical dimension.** A timeout before the dependency did anything is easy. A timeout after the dependency committed but before the response arrived is where double charges and lost orders come from. Probes must inject at those moments, and every fault is tied to a trace id.

### 7.3 Databases

Half inside the boundary: owned, directly observable, with declared constraints, but with their own faults: slow queries, pool exhaustion, deadlocks, transaction aborts, failover, replication lag (write succeeds, immediate replica read is stale). Application-level validation and database constraints should be cross-checked; gaps between them are findings in themselves.

### 7.4 Kinds of boundary

Owned infrastructure (nearly internal) · other teams' services (shareable contracts and oracles) · third parties (sandboxes that differ from production; recordings essential) · time (a dependency in its own right) · inbound callers (the system's contract to them, in the other direction).

### 7.5 Causality through intervention

Observing that approval is followed by an event is correlation. Blocking the event, delaying the commit, reordering messages or restarting the service between operations, and observing how downstream behavior changes, produces far stronger evidence. The learner maintains a causal graph as a projection over observations, with edges labelled *observed correlation*, *inferred dependency* or *experimentally supported*. The causal model is a hypothesis generator and change-impact tool in the learner; it is never judged against directly by the kernel.

### 7.6 Production loop

Assumptions can be checked in production by observing boundary traffic only (no exploration). A never-before-seen dependency behavior is both an alert and a new exploration task for the test environment.

---

## 8. Using the codebase as a map, not as truth

Code tells the learner **where to look** without telling it **what is correct**:

- Types and schemas describe what is representable (a `Decimal(12,2)` can be negative and up to ~10 billion), which determines probe values: zero, negative, boundaries, maximum, maximum plus one.
- Conditionals and validation declare boundaries; each branch is a hypothesis that two input classes behave differently, so both sides are probed.
- Enums and state fields reveal states never reached; defined error types reveal failures never triggered.
- Database constraints are declarations that are also enforcements.

Everything from code is tagged **declared** and treated as a candidate. Disagreement between sources is the high-value signal (code says reject, observation shows accept; code says nothing, observation shows a limit). Agreement between code and behavior is "one source seen twice," because the same developer wrote both, and should not raise confidence.

The loosest coupling is **coverage feedback**: unreached branches are behavior that has not happened yet, directly addressing the weakness that observation cannot show what did not happen.

Caution: the more the learner leans on code, the more its candidates mirror the developer's beliefs. Code-derived hints and observation-only exploration are kept visibly separate so they can contradict each other.

---

## 9. Architecture

### 9.1 Two planes

- **Data plane**, deployed next to the system under test. Dumb on purpose: collectors (traces, CDC, eBPF, mesh logs), probes (mesh faults, TCP proxies, time seam), and a driver (API calls, job triggers, state seeding). No business logic; configurable, not clever. The same components run in production in observe-only mode.
- **Control plane**: discovery, experimentation, inference, prioritizer, the oracle kernel, and the stores.

### 9.2 Components

| Component | Responsibility |
|---|---|
| Discovery | Static analysis of schemas, code, migrations → declarations; builds the map of entities, states, branches, boundaries |
| Experimentation | Hypothesis → reproducible plan → execution via driver and probes → links to observations |
| Inference | Candidates, explanations, causal graph; hands candidates to experimentation for falsification |
| Prioritizer | Ranks candidates by consequence, novelty, evidence strength and diversity, source disagreement, falsifiability, cost of a decision |
| Oracle kernel | Confirmed expectations × observations (through projections) → verdicts; deterministic; packaged as a library |
| Stores | Observation store (facts), knowledge store (expectations, decisions, findings, coverage, vocabulary), experiment store (plans, seeds) |
| Interfaces | Review console (candidates, conflicts, decisions), change desk (scope query, expectation edits), integrations (CI, VCS, tickets, coding agents) |

### 9.3 Rules enforced from day one

- Only the kernel applies confirmed expectations. Everything an LLM produces is a candidate.
- Every observation, experiment and verdict carries a trace id and a system version.
- Writes to the knowledge store go through adjudication with an identified authority; no service promotes a candidate on its own.
- The kernel has no LLM, no network access to the target, and is small enough to audit.
- Observations are append-only and separated from judgments.

### 9.4 Modes

- **Exploration**: full loop against a test environment.
- **CI**: kernel plus experimentation against a branch; reports realized, regressed and unexplained.
- **Production**: collectors plus kernel only; checks assumptions at boundaries; feeds novelty back to exploration.

The first implementation can be a single process with these boundaries in the data model rather than separate services. The kernel is the one component worth separating physically from the start.

---

## 10. Mechanisms on Kubernetes

| Layer | Role | Notes |
|---|---|---|
| Service mesh (Envoy/Istio) | HTTP/gRPC faults and recording | Header-matched fault injection ties a fault to one trace; makes exploration precise, reproducible and safe in shared environments. Weak for non-HTTP protocols; response-side faults need custom/WASM filters |
| TCP proxies (e.g. Toxiproxy) and Chaos Mesh | Database and queue faults | Downstream-direction faults where the database commits but the application never hears; Chaos Mesh packages network, HTTP (request and response phases), I/O, pod and time faults as Kubernetes resources |
| eBPF | Observation everywhere | Sees every socket, protocol and syscall without application changes (including TLS via userspace hooks); crude faults only; privileged and kernel-version dependent |
| In-process seam | Time and semantically precise faults | The clock is read in-process via a fast path eBPF cannot override; ptrace patching, `LD_PRELOAD` and time namespaces all have holes. Reliable approach: a clock abstraction reading an override propagated through trace baggage. Mind multiple clocks (application, database `NOW()`, token issuers, schedulers) and trigger scheduled jobs directly |

Header-targeted injection is the thread tying every fault to the trace that produced the observation.

This infrastructure is deliberately **not** the first thing to build (see section 14).

---

## 11. Risks and known gaps

Ordered roughly by how much we think they matter.

1. **The learner cannot see what did not happen.** Missing validation, missing events and missing side effects are invisible to a model of what occurs. Mitigations: hypothesis-driven experiments with negative results, code-as-map probing of representable-but-untested inputs, coverage feedback, elicitation for new code. None is complete.
2. **Status-quo bias in adjudication.** Confirming is cheaper than thinking; the review flow risks laundering existing bugs into confirmed expectations. Mitigations: show consequences not bare rules, make "no" as cheap as "yes", require authority, pull in independent sources of intent.
3. **Noise.** Mined specifications produce many coincidental rules; statistical confidence is not business importance. If most candidates are noise, humans disengage and the loop dies. Mitigations: falsify before asking; prioritize by consequence and novelty; measure defects per human decision.
4. **Intentional change.** Without the change workflow in section 5.5, every intended change is a false alarm and the system becomes ignored snapshot tests.
5. **Environment fidelity.** Exploration cannot run in production, so the learner learns a test environment whose mocks and synthetic data diverge from reality. Recordings from real traffic reduce but do not remove this.
6. **Determinism.** Fault injection does not make concurrency bugs reproducible; seeds and inputs are insufficient across an ordinary cluster. Position taken: best-effort reproducibility (trace ids, deterministic data, controlled injection) first, with an abstraction that allows controlled scheduling later; spend determinism budget on findings, which need a reproduction, not on exploration, which can tolerate flaky evidence.
7. **Reachability and time.** Deep states, expiries and periodic jobs are under-explored without time control and state seeding.
8. **Representation.** Expectations must be machine-checkable and human-readable at once; temporal predicates strain the second requirement.
9. **Consistency versus truth.** The oracle verifies internal coherence (the ledger balances), not external correctness (the tax rate was right).
10. **Specification optimism** for new code: humans specify the happy path and skip failure behavior.

---

## 12. Review feedback incorporated along the way

An independent critique was applied during the discussion. Points adopted:

- Separate the deterministic oracle from the learner (section 2.4).
- Add **Experiment** as a first-class record (section 6.1).
- Replace literal closed-world checking with semantic projections and a three-way verdict (section 2.3).
- Attach authority/ownership to confirmation and treat independent sources of intent as first-class (section 6.4).
- Replace the two-way candidate outcome with the four-way split; rejected candidates are no longer automatically bugs (section 6.3).
- Design the expectation language around conditional, temporal predicates over traces (section 6.5).
- Falsify before asking; prioritize by consequence, novelty, evidence, disagreement, falsifiability and decision cost (sections 4.1, 9.2).
- Pursue causality through interventions, with a causal graph as a projection (section 7.5).
- Build a vertical slice before infrastructure (section 14); adopt the proposed metrics (section 13).

Points where we took a more specific position than the critique:

- **Determinism** is staged by outcome type: findings need reproductions, candidates do not.
- **Expectation versus causal model as the unit of knowledge:** the expectation remains the unit of *confirmed intent* (approvable by humans, evaluable by the kernel); the causal model is the unit of *understanding* in the learner and is never judged against directly, so its inference uncertainty does not leak into the kernel.
- **Five subsystems** are the right boundaries but should be one program with those boundaries in the data model, not five services, until the slice has proven the core hypothesis.
- **Intentional change** is treated as the primary adoption risk and belongs in the vertical slice, not a later phase.

Relative to existing tools (invariant miners, autonomous fault-injection platforms, executable API contract tools), the differentiation is not a better test generator but the continuously maintained, human-approved, version-aware model of intent, and the loop that keeps it current.

---

## 13. Metrics

Code coverage is inadequate for this system. Proposed measures:

| Metric | Question it answers |
|---|---|
| Defects discovered per 100 human decisions | Insight or noise? |
| Validated expectations per hour of reviewer time | How efficiently is knowledge captured? |
| Mutation detection rate | Does the oracle catch deliberately introduced behavioral defects? (Also the answer to "who tests the oracle") |
| False-positive rate after intentional changes | Are rules maintainable? |
| Experiment reproducibility | Can findings be investigated reliably? |
| New behavior-class coverage over time | Is exploration expanding understanding? |
| Surviving expectation rate across versions | Does confirmed knowledge stay useful? |

Baselines: a competent engineer writing conventional integration tests, and an LLM generating tests directly from the same codebase. If the system needs substantially more infrastructure and reviewer time without outperforming these on meaningful defect discovery, the value proposition is wrong.

---

## 14. First build: a vertical slice

Explicitly avoid building the full Kubernetes observation and fault-injection infrastructure first.

1. **One stateful service**: REST API, PostgreSQL, a few lifecycle transitions, one external dependency; ideally a real service whose behavior is only partially documented.
2. **Discovery and experiments**: read the OpenAPI schema, optionally inspect source, generate stateful request sequences, snapshot relevant database state, record immutable observations.
3. **Infer candidates**: state transitions, idempotency, uniqueness, invariants, required side effects; seek counterexamples before presenting.
4. **Adjudication**: present one rule, its evidence, counterexamples and the consequence of approving it; convert approvals into typed executable expectations.
5. **Verify a changed version**: introduce intentional changes and seeded defects; check that the system detects regressions, surfaces unexplained behavior, and distinguishes intended evolution from errors, using the change workflow.

Success criterion: the system explores an order service, discovers that cancelled orders sometimes emit fulfillment events, flags the pattern as suspicious, produces a reproducible experiment, asks one relevant human question, and turns the answer into a permanent regression check, with no hand-authored test case.

---

## 15. Open questions for the reviewing agent

1. Is the learner/adjudication/oracle separation sufficient to keep LLM error out of the trusted path, or are there leakage routes we have missed (for example through projections, vocabulary, or the prioritizer deciding what humans never see)?
2. Can semantic projections be defined without themselves becoming a large hand-authored rule set that reintroduces the authoring burden the design is trying to avoid?
3. Is "confirmed but unrealized" sufficient for intent-first work, or does the lifecycle need further states (for example, *proposed change pending code*, *realized in branch but not main*)?
4. Does the pairing rule (every assumption needs a response) scale, or does it generate an unmanageable number of required expectations for systems with many dependencies?
5. Is best-effort reproducibility defensible as a starting point, or will the first serious concurrency finding without a reproduction destroy trust in the system?
6. How should authority be modelled when intent is contested between functions (finance versus product), and who owns the unresolved-disagreement queue?
7. Is the proposed differentiation (a maintained model of intent rather than a test generator) a product, or a feature that incumbents can add?
8. What is the minimum expectation language that is both evaluable over traces and readable by a product owner after LLM rendering?
9. Which of the risks in section 11 is most likely to be fatal, and is there a cheaper experiment than the vertical slice that would expose it?
10. What is missing entirely?

---

## Appendix A: illustrative sketches

**Experiment**

```yaml
experiment:
  hypothesis: duplicate payment requests are idempotent
  setup:
    order_state: pending
    payment_provider: recorded_normal
  stimulus:
    requests: 2
    concurrency: simultaneous
  fault:
    boundary: payment_provider
    phase: response
    timing: after_commit
    action: drop
  measurements: [payment_attempts, successful_charges, final_order_state]
  seed: 48192
  system_version: 3f9c2e1
```

**Expectation (response kind, temporal)**

```yaml
expectation:
  id: exp-0412
  kind: failure_behavior
  status: confirmed
  provenance: human_authored
  owner: payments-team-lead
  scope: { entity: order, boundary: payment_provider }
  wording: >
    If the payment provider times out after accepting the payment,
    no new charge is initiated until the original attempt is reconciled.
  formal:
    given: [payment_request.sent, provider.timeout, provider.state == accepted]
    then: not exists(charge.new) until reconciliation.completed
    window: unbounded
  evidence: { supports: [obs-88120, obs-88131], contradicts: [] }
  valid_from: 3f9c2e1
  decision: dec-0199
```

**Verdict**

```yaml
verdict:
  expectation: exp-0412
  behavior_class: bc-payment-timeout-after-accept
  observation: obs-91002
  system_version: 4a01b77
  outcome: violated
  finding: fin-0031
```
