# oracle

A test-oracle runtime for backend systems. It judges a running system against
human-confirmed expectations, using evidence collected at the system's seams,
and says plainly when the evidence is not enough to judge.

**Status: no runtime code yet.** This repository currently holds the design, two
independent reviews of it, the expectation language draft, and a hand-authored
corpus against the first target system. The corpus is the specification the
first runtime milestone must satisfy.

## The idea in one paragraph

Three things are kept apart at every layer: what a system was *observed* doing,
what its code *declares*, and what humans *intend*. A fallible, LLM-driven
learner explores systems and proposes candidate expectations. Humans with
authority confirm them. A small deterministic kernel applies confirmed
expectations to evidence and produces verdicts: satisfied, violated, pending,
inconclusive, not applicable. Behavior no expectation covers is reported as a
coverage gap, not silently accepted. The kernel never learns; only humans
decide what it believes. See `docs/design.md`, then `docs/design-addendum.md`
for the positions taken after review.

## Runtime and project data

The runtime is generic and versioned on its own. Everything specific to a
target system is plain text that lives with that system, pinned to a runtime
version: its evidence sources, projections, expectations, experiments and
decision records. In a real target that directory is `.oracle/` in the
target's own repository. For runtime development the same layout lives here
under `corpus/<target>/`, so the runtime's own tests have stable material and
the fixture repositories stay free of any dependency on this one.

## Layout

```
docs/
  design.md                  the design as summarized before review
  design-addendum.md         what changed after the two reviews; current positions
  expectation-language.md    evidence model, projections, expectation kinds, verdict semantics (v0)
  reviews/                   the two independent reviews, verbatim
corpus/
  fixture-order-service/     hand-authored corpus against github.com/protoku/fixture-order-service
    oracle.yaml              how to reach the target, its control seams, its evidence sources
    vocabulary.yaml          technical names → business meaning
    projections/             typed, versioned transformations from raw evidence to events
    expectations/            confirmed expectations, one file each
    decisions/               who confirmed what, and why
    experiments/             reproducible stimulus sequences with expected verdicts per defect flag
    README.md                the expected verdict matrix and the evidence gaps the exercise found
```

## Milestone 1: `oracle check`

The first runtime (TypeScript, Node 22) must:

1. Load a target directory (`oracle.yaml`, projections, expectations).
2. Drive an experiment against the running target through generic HTTP steps,
   call quiesce, and fetch every evidence source up to its `complete_through`.
3. Apply projections and evaluate expectations with the semantics in
   `docs/expectation-language.md`.
4. Emit verdicts plus a coverage report, and compare them to the experiment's
   `expected` block.

It is done when every cell of the verdict matrix in
`corpus/fixture-order-service/README.md` matches, for the clean fixture and for
each defect flag, and when the two deliberately degraded experiments come back
`pending` and `inconclusive` rather than `satisfied`.

Not in milestone 1: the learner, the review console, any LLM call, any
collector beyond the fixture's control endpoints. Those come after the kernel
and the trusted path are proven on this corpus.

## Target systems

- `fixture-order-service`: an order service with PostgreSQL, a fake payment
  provider with per-trace fault injection, a fulfillment job, a fake clock,
  control and evidence endpoints, and seven defects (six switchable, one
  always on). It exists to be judged.
