# Brief: milestone 1, `oracle check`

You are building the first runtime of the oracle: a TypeScript program that
loads a target directory, drives experiments against a running system, collects
evidence, applies projections and expectations, and reports verdicts. The
design is in `docs/design.md` and `docs/design-addendum.md`; the language is in
`docs/expectation-language.md`; the acceptance test is the corpus in
`corpus/fixture-order-service/`. Read all four before writing code. The
language spec is authoritative; this brief adds engineering constraints and
resolves ambiguities the spec leaves open.

When something is still ambiguous, choose the simpler option, implement it,
and record the choice in `docs/decisions.md` (append-only, one paragraph per
decision). If the ambiguity is in the language itself, also propose the spec
edit in the same commit as a clearly marked "v0.1 proposal" paragraph at the
end of `docs/expectation-language.md`. Do not ask me; decide and document.

---

## 1. What done looks like

`oracle check --target corpus/fixture-order-service` against the clean
fixture reproduces every cell of the verdict matrix in
`corpus/fixture-order-service/README.md`, including:

- `exp-fulfilled-and-refunded-exclusive` **violated** on the clean build by
  `xp-refund-vs-job-race` (the unflagged defect D0),
- `exp-no-new-charge-after-ambiguous-outcome` **pending** in
  `xp-ambiguous-charge-unresolved`,
- the two ledger-backed expectations **inconclusive** in
  `xp-ledger-stream-reset`, with the reason naming the stream reset.

The same command with the fixture restarted under each of the six defect flags
reproduces that flag's column. A run with a mismatch exits non-zero and says
which cell differed and why.

The last two bullets are the gate. A runtime that gets everything else right
but reports `satisfied` for an emptied ledger has built the precise failure
the design is meant to prevent.

---

## 2. Hard constraints

- **TypeScript, strict mode, ESM, Node 22.** Dependencies: `typescript`,
  `tsx` (dev), `yaml`, `zod`. Nothing else without a decision-log entry
  explaining why the standard library could not do it. HTTP through the
  built-in `fetch`. Tests with the built-in `node --test` (run through `tsx`).
  No ORM, no database, no test framework, no CLI framework (`util.parseArgs`
  is enough).
- **The kernel is pure.** Everything under `src/kernel/` takes an evidence set
  and loaded definitions as plain data and returns verdicts and coverage as
  plain data. It imports nothing from `node:*`, nothing that touches the
  network, filesystem, clock, environment or randomness. A test scans its
  imports and fails the build if that changes.
- **The kernel is deterministic.** The same evidence set and definitions
  produce byte-identical output. Sort everything you iterate over; never
  depend on object key order or `Map` insertion order from I/O.
- **No code evaluation anywhere.** No `eval`, no `new Function`, no template
  engines, no expression libraries. Conditions are interpreted by a small
  recursive evaluator over the closed set in the spec. Experiment templating
  is string substitution of `{{name}}` only.
- **The runtime knows nothing about orders.** No identifier, string literal or
  comment under `src/` may mention the fixture's domain (order, payment,
  charge, refund, fulfillment, provider). A test greps for it. The corpus and
  recorded evidence under `test/fixtures/` are exempt.
- **The corpus is not edited to make the runtime pass.** If you believe a
  corpus file is wrong, say so in `docs/decisions.md` with the reason and the
  cell it affects, and stop there. I will decide.
- **Evidence is never mutated.** Records are read, mapped into the envelope
  once at collection, and from then on treated as immutable input.

---

## 3. Layout

```
.
├── package.json  tsconfig.json
├── src/
│   ├── cli/main.ts                 validate | check | evaluate
│   ├── language/                   zod schemas, loader, cross-reference checks, DAG order
│   ├── evidence/                   envelope types, control-endpoint collector, completeness
│   ├── kernel/                     pure: paths, conditions, projections, expectations, verdicts, coverage
│   ├── driver/                     experiment runner: templating, steps, parallel, horizon, config detection
│   └── report/                     text and JSON reports, matrix comparison
├── test/
│   ├── kernel/  language/  driver/  evidence/
│   └── fixtures/evidence/<experiment-id>/   recorded evidence sets for offline replay
├── scripts/check-all-configs.sh    restarts the fixture per flag and runs check
└── docs/decisions.md
```

---

## 4. The language layer

Zod schemas for `oracle.yaml`, projections, expectations, experiments and
decisions, mirroring the spec exactly. Unknown keys are errors, not warnings:
a typo in `forbid` must not silently become "no obligation".

`oracle validate <target>` loads everything and checks:

- every `id` equals its file name;
- every `source` an input names exists in `oracle.yaml`; every `event` an input
  names is emitted by exactly one projection; the projection graph is acyclic;
- every expectation's events exist; a non-candidate expectation's decision
  exists and points back at it; required evidence sources exist;
- every experiment's `investigates` entries exist; `expected.default` covers all
  of them; flag blocks name only investigated expectations and only flags listed
  in `oracle.yaml`; every step's `service` exists;
- every projection's `examples` pass when run through the kernel.

Validation runs before every `check` and `evaluate`. The corpus must validate
cleanly; a test confirms it, and sibling tests mutate copies (missing decision,
unknown event, a cycle, an id mismatch, an unknown key) and confirm each is
rejected with a message naming the file.

---

## 5. Evidence

### Envelope and collection

One `EvidenceRecord` type as in spec §1. The milestone's single collector reads
the fixture-style control endpoints described by `oracle.yaml`: it pages with
`since`/`limit` from the run's starting mark until a page is empty, keeps the
last page's `high_water_mark` and `complete_through`, and maps flat-shaped
sources into the envelope using the `envelope` block (`kind` from a prefixed
field or a literal, everything under `data`, empty `ids`).

Collection is the one place that knows about HTTP; it produces an
`EvidenceSet`: per source, the records, the marks at the horizon, and the list
of high-water-mark samples taken during the run.

### Samples and reliability

After every experiment step, and at the horizon, sample every source's
`high_water_mark` (a read with the smallest permitted `limit`, or `since` at
the current mark). A source whose mark ever decreases between two samples is
**unreliable for the run**, reason `stream_reset`, with both samples recorded.
This is how the provider reset in `xp-ledger-stream-reset` is detected; nothing
in the evidence announces it, and a runtime that only reads at the horizon
will see a complete, empty ledger and be wrong.

### Completeness

A source is complete at the horizon when it is reliable and
`complete_through >= high_water_mark` in the horizon read. Apply spec §6 to the
letter: an expectation with `completeness: required` whose required source is
incomplete or unreliable is `inconclusive` for every instance, with the reason
and the two numbers (or the two samples) in the verdict. An instance that
consulted a record above a source's `complete_through` is `inconclusive`.

The fixture's `http` and `outbound` sources currently claim
`complete_through = high_water_mark` even with requests in flight (a known
fixture issue). The runtime does not work around it beyond reading only after
`quiesce`; do not special-case these sources.

### Horizon

`horizon: quiesce` calls `control.quiesce`. If it fails or times out, the
horizon was not reached: every expectation in the experiment is `inconclusive`
with reason `horizon_not_reached`, and the run continues to the report. Never
read evidence for a verdict without a reached horizon.

---

## 6. The kernel

### Paths, values, conditions

Dotted paths over plain JSON; missing segments yield `null`. Values may be
scalars or references (`$trigger.`, `$left.`, `$right.`, `$.`). Implement every
condition in spec §2 including `any`/`all` over arrays and the stated `null`
semantics. Table-driven tests: one row per operator per interesting input,
including `null`, missing, wrong type, empty array.

### Projections

Map, group and join as in spec §3, evaluated in DAG order over the whole
evidence set. Pin these semantics and test them:

- Group keys and join keys compare by JSON equality; a `null` or missing key
  never matches and never forms a group.
- `count_distinct` ignores `null`s. `first`/`last` order by `seq` of the input
  record or event. `sum_product` of a row with a `null` factor contributes 0 and
  the event records `partial: true` (a decision-log item if you disagree).
- A group or join event's `seq` is the maximum input `seq`, `fixture_time` the
  maximum input `fixture_time`, `source` the input source (or `derived` for
  joins across sources).
- Example runner: inputs for `from`/`group` over a source are records; over an
  event they are events; for a join they are keyed by event name as in the
  corpus. Match `output` on listed fields only, order-insensitive.

Run every corpus projection's examples as part of `npm test`.

### Expectations

Transition, invariant and obligation exactly as in spec §4, with these
additions:

- **Ordering across sources.** "After the trigger" for an obligation means:
  same source, greater `seq`; different source, greater `fixture_time`, ties
  broken by `recorded_at`, then `seq`. Record this as the v0 cross-source rule
  in `docs/decisions.md`; it is a known weakness (spec §11) and must be
  isolated in one function so it can be replaced.
- **Obligation table.** Implement spec §4.3 row by row and test each cell for
  both `require` and `forbid`, for `within`, `until` and `horizon` windows, with
  synthetic events. A `require ... within` whose window closed is `violated`
  only when the source that would have carried the event is complete through
  the window's end; otherwise `inconclusive`.
- **Roll-up** per spec §5, with the stated precedence. Verdicts carry the
  instance locator, the evidence range, the expectation version and every
  consulted projection's version.

### Coverage

Per spec §7: events of any projection, and raw `http.request` records grouped
by `(data.route, data.status)`, that no expectation consulted. "Consulted"
means the event or record contributed to at least one instance (as trigger,
candidate, group member, or join side). Output is a sorted list of classes with
counts and example `seq`s.

### Purity and determinism tests

A test scans `src/kernel/**` imports and fails on anything outside the kernel
or the TypeScript standard types. A test evaluates each recorded evidence set
twice and asserts deep equality, then compares to a committed snapshot of the
expected verdicts.

---

## 7. The driver

`oracle check` per experiment:

1. Detect the configuration: call `control.version`; zero active flags is
   `clean` (use `expected.default`); exactly one flag selects that block merged
   over `default`; more than one is an error ("not a supported configuration").
   Warn once per run if the reported `git_sha` differs from `oracle.yaml`'s
   `target.commit`; applicability by commit is not evaluated in this milestone
   and the limitation goes in the decision log.
2. Take a starting mark per source (so earlier runs' records are excluded),
   then run `setup`: each `reset` in order, then `clock` if present. Resets are
   taken from `control.reset` by service name.
3. Run `steps` in order. `http` steps substitute `{{run}}`, `{{uuid}}`,
   `{{seed}}` and captured variables, one attempt, 30 s timeout, no retries; a
   transport failure is a run error for that experiment (all its expectations
   `inconclusive`, reason `step_failed`, step id in the verdict). `expect_status`
   mismatch is the same run error. `capture` reads JSON paths from the response
   body. `parallel` runs each inner list sequentially and the lists
   concurrently, and waits for all. `sleep_ms` is real time. `clock` posts to
   `control.clock`. Every step is followed by a high-water-mark sample;
   `evidence_mark` only names its sample.
4. Horizon: `quiesce`, then one read per source from the starting mark.
5. Evaluate: projections, expectations, coverage, through the kernel.
6. Compare to the selected `expected` block; report `coverage_expected`
   classes as seen-and-unexplained, seen-and-explained, or not seen.

Save every run under `.oracle-data/runs/<run-id>/`: the evidence per source as
JSON lines, the samples, the detected configuration, verdicts, coverage and the
report. `{{run}}` is `<experiment-id>-<iso-timestamp>-<4 hex>`.

`oracle evaluate --target <dir> --evidence <run-dir>` re-runs step 5 on a saved
run without touching the network. This is what the kernel tests use and what
makes a finding reproducible from files alone.

---

## 8. Reports

Text, to stdout, one block per experiment:

```
xp-ambiguous-charge-then-repay   config: D2_timeout_as_failed
  exp-no-new-charge-after-ambiguous-outcome   expected violated   actual violated   ✓   1 trigger, 1 forbidden event (outbound seq 2)
  exp-charge-at-most-once-per-order           expected violated   actual violated   ✓   order …: ledger_charge_count 2
  exp-failed-attempt-has-no-charge            expected violated   actual violated   ✓   attempt …: failed with charge ch_…
  exp-order-transitions                       expected satisfied  actual satisfied  ✓   2 transitions
  coverage: POST /orders/:id/pay 502 (1, unexplained, expected)  POST /orders/:id/pay 200 (1, unexplained)
```

Mismatches print the instance detail and, for `inconclusive`, the reason and
the evidence gap. A final matrix (expectation × experiment) and a one-line
summary close the run. JSON with the same content goes to the run directory.
Exit code 1 on any mismatch or run error, 0 otherwise.

---

## 9. Tests

- `test/kernel/`: conditions (table-driven), paths, each projection shape with
  synthetic input, the obligation table cell by cell, transition and invariant
  outcomes including `not_applicable`, completeness and stream-reset →
  `inconclusive`, roll-up precedence, coverage, purity scan, determinism.
- `test/language/`: the corpus validates; each mutation is rejected with a
  message naming the file; projection examples run.
- `test/evidence/`: envelope mapping for flat sources, paging, sample
  regression detection, completeness evaluation, all against an in-process
  mock of the control endpoints.
- `test/driver/`: templating, capture, `parallel` ordering, config detection,
  `expect_status` failure handling, against an in-process mock target.
- `test/fixtures/evidence/`: one recorded run per experiment from the clean
  fixture, plus one per flag experiment under its flag, committed. The
  determinism test and an "expected matrix" test replay them offline, so
  `npm test` passes with no fixture running.
- Integration (opt-in with `ORACLE_FIXTURE=1`): `oracle check` against the
  running clean fixture, asserting the matrix.

`scripts/check-all-configs.sh` runs the full matrix: for `clean` and each flag,
restart the fixture's `order-service` with `FIXTURE_DEFECTS` set, wait for
health, run `oracle check`, and collect the exit codes.

---

## 10. Definition of done

- `npm run build` is clean under `strict`; `npm test` passes offline.
- `oracle validate corpus/fixture-order-service` passes; every projection
  example passes.
- `scripts/check-all-configs.sh` passes for `clean` and all six flags against
  `fixture-order-service@4c17f89`, including the three gate cells in §1.
- Recorded evidence sets for every experiment are committed and replay to the
  same verdicts.
- The purity, determinism and no-domain-words tests exist and pass.
- `docs/decisions.md` records every choice this brief and the spec left open,
  and any proposed spec edits are appended to `docs/expectation-language.md`
  under a "v0.1 proposals" heading.
- `README.md`'s milestone section is updated to say how to run it.

## 11. Do not

- Do not call an LLM, build a learner, add a UI, or add a database.
- Do not retry failed steps or failed evidence reads. A failure is a result.
- Do not downgrade `inconclusive` to anything else under any flag or option.
- Do not infer a source's completeness from the absence of new records.
- Do not put fixture knowledge in the runtime, and do not put runtime knowledge
  in the corpus.
- Do not "fix" the corpus; report what you think is wrong and stop.
