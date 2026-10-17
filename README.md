# oracle

A test-oracle runtime for backend systems. It judges a running system against
human-confirmed expectations, using evidence collected at the system's seams,
and says plainly when the evidence is not enough to judge.

**Status: milestone 1 runtime (`oracle check`) implemented.** This repository
holds the design, two independent reviews of it, the expectation language
draft, a hand-authored corpus against the first target system, and the first
runtime, which reproduces that corpus's verdict matrix for the clean target and
every defect flag.

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
  briefs/                    build briefs for Claude Code, one per milestone
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
src/
  cli/main.ts                validate | check | evaluate
  language/                  schemas, loader, cross-reference checks
  evidence/                  envelope mapping and the control-endpoint collector
  kernel/                    pure: paths, conditions, projections, expectations, completeness, coverage
  driver/                    experiment runner, templating, configuration detection, run store
  report/                    text report, matrix, comparison with expected verdicts
test/                        node --test suites; fixtures/evidence holds recorded runs for offline replay
scripts/check-all-configs.sh restarts the fixture once per configuration and runs oracle check
docs/decisions.md            every choice the brief and the spec left open
```

## Milestone 1: `oracle check`

The build brief is `docs/briefs/milestone-1-runtime.md`. In short, the first
runtime (TypeScript, Node 22) does this:

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

### Running it

Requires Node 22. No target needs to be running for the build or the tests:

```sh
npm install
npm run build          # tsc, strict
npm test               # offline: kernel, language, evidence and driver suites, replay of recorded runs
```

Against the fixture ([protoku/fixture-order-service](https://github.com/protoku/fixture-order-service)
at `4c17f89`, checked out next to this repository and started with
`docker compose up -d && npm run migrate`):

```sh
node dist/cli/main.js validate corpus/fixture-order-service
node dist/cli/main.js check --target corpus/fixture-order-service            # every experiment, current configuration
node dist/cli/main.js check --target corpus/fixture-order-service --config clean --experiment xp-ledger-stream-reset
node dist/cli/main.js evaluate --target corpus/fixture-order-service --evidence .oracle-data/runs/<run-id>

scripts/check-all-configs.sh     # clean and each of the six flags; restarts order-service per flag
ORACLE_FIXTURE=1 npm run test:integration    # check against the running clean fixture
```

`npm run oracle -- <args>` runs the CLI from source without building.

`check` detects the configuration from `control.version` (zero flags is clean,
one flag selects that experiment block, more is refused), runs each experiment,
prints one block per experiment and a final expectation × experiment matrix,
and exits 1 if any cell differs from the experiment's `expected` block or a run
errored. Every run is saved under `.oracle-data/runs/<run-id>/` (evidence as
JSON lines, mark samples, configuration, verdicts, coverage, report);
`evaluate` re-judges a saved run from those files without touching the network.

To refresh the recorded runs in `test/fixtures/evidence/` after running
`scripts/check-all-configs.sh`: `npx tsx scripts/record-fixtures.ts`. This also
rewrites the verdict snapshots the determinism test compares against, so
review the diff.

## Target systems

- `fixture-order-service`: an order service with PostgreSQL, a fake payment
  provider with per-trace fault injection, a fulfillment job, a fake clock,
  control and evidence endpoints, and seven defects (six switchable, one
  always on). It exists to be judged.
