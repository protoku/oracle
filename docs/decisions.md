# Decision log

Append-only. One paragraph per decision: what was open, what was chosen, and
why. Entries marked **corpus** report something believed wrong or surprising in
`corpus/`; the corpus was not edited. Entries marked **spec** have a matching
v0.1 proposal at the end of `docs/expectation-language.md`.

---

**D-001 Starting marks are taken after setup, not before.** Brief §7 step 2
says to take a starting mark per source and then run `setup`. Every corpus
experiment resets both services in setup, and a reset restarts sequences: a
mark taken before it (say `db` at 40) would exclude every record of the run
(they start again at 1), and the drop from 40 to 0 would read as a stream
reset of every source. The runtime runs setup (resets, then clock), then takes
the starting marks as the first sample, labelled `start`. Earlier runs' records
are still excluded, which is what the mark is for. Regression detection covers
everything after `start`.

**D-002 (spec) Null semantics of conditions.** Spec §2 says "comparisons against
null are false except `equals: null`, `not_equals: null`, and `exists`". Read
literally, `{ path: from, not_equals: $.to }` with `from = null` is false, and
the corpus example "creation is a change from null" in
`prj-order-status-changed` would fail. Chosen: `equals` and `not_equals` are
JSON equality in which null is an ordinary value (missing = null); `in` and
`not_in` are false when the path value is null; `lt`/`lte`/`gt`/`gte` are false
when either side is null or the two are not both numbers or both strings;
`exists` tests for null; `any`/`all` are false on a non-array or missing value
and `all` is true on an empty array.

**D-003 (spec) An incomplete required source makes the expectation
inconclusive even with zero instances.** Spec §5 says a run with no instances
is `not_applicable`; §6 says that with an incomplete required source "every
instance" is `inconclusive`. Together they let an emptied ledger produce no
events, hence no instances, hence `not_applicable`: exactly the failure the
brief names as the gate (`exp-failed-attempt-has-no-charge` in
`xp-ledger-stream-reset` has no instances after the reset). Chosen: when any
source in `evidence.required` is unreliable or incomplete and `completeness`
is `required`, the expectation's verdict is `inconclusive` regardless of its
instances, with the reason (`stream_reset`, `incomplete`, `read_failed` or
`sample_failed`) and the numbers or samples in the verdict. Every instance,
including ones that would have been `not_applicable`, is also `inconclusive`.
When several required sources have gaps, `stream_reset` is reported as the
reason first.

**D-004 Projection meta fields for group and join events.** The spec fixes
`seq` (maximum input seq) and `fixture_time` (maximum input fixture_time).
Chosen for the rest: `source` is the inputs' common source, or `derived` when
they differ (so a join across sources is `derived`); `recorded_at` is the
maximum; `trace_id` is the common trace id or null. Timestamps compare as
instants, not strings.

**D-005 Aggregates over missing values.** `count_distinct` ignores nulls (brief).
`sum_product` of a row with a null or non-numeric factor contributes 0 and the
event carries `partial: true` (brief). The same rule is applied to `sum`, `min`
and `max`: non-numbers are skipped and mark the event partial. The sum of no
numbers is 0; the min or max of no numbers is null. `first`/`last` order members
by `seq`, ties by source name; they return the path's value in the first/last
member that passes the aggregate's `where`, even if that value is null.

**D-006 (spec) Cross-source ordering, v0.** As the brief prescribes: "after"
means same source and greater `seq`, or different sources and greater
`fixture_time`, ties broken by `recorded_at`, then `seq`. The brief leaves
open what happens when a `fixture_time` is missing (the provider sources have
none). Chosen: the pair cannot be ordered, and an obligation instance that
would need that ordering (for its closing event or any candidate) is
`inconclusive` with reason `ordering_unknown`. This rule lives in one function,
`compareOccurrence` in `src/kernel/ordering.ts`, so it can be replaced when
cross-source happens-before exists (spec §11). It works for the corpus because
`http` and `outbound` share one process clock.

**D-007 (spec) `until` windows.** The closing event is the earliest event of
`until.event` that passes `until.where` (which may use `$trigger`) and comes
after the trigger. `correlate_by` is not applied to it; the corpus correlates
explicitly in `until.where`. A candidate is in the window when it comes after
the trigger and strictly before the closing event. The closing event counts as
consulted for coverage.

**D-008 (spec) `within` windows.** Durations are an integer with `ms`, `s`, `m` or
`h`. The window ends at the trigger's `fixture_time` plus the duration. It is
closed when the fixture clock at the horizon (read once from `control.clock`
after quiesce and stored in the evidence set) is at or past the end; when that
clock is unknown the window is treated as open, so an unmet `require` is
`pending`, never `violated`. A trigger without `fixture_time` makes the instance
`inconclusive` (`window_unbounded`); a candidate without one is
`ordering_unknown`. `horizon: true` windows are closed at evaluation.

**D-009 (spec) `lte` behaves like `equals` above its target.** Spec §4.3 says a
count above an `equals` target is a violation as soon as observed. A count
above an `lte` target can never come back under it either, so the same rule
applies to `lte`. Otherwise the table's "window open, condition not met →
pending" would hold an already-broken bound open.

**D-010 A closed `require` is violated only when its carrying sources are
complete.** Spec §6 and the brief say this for `require … within`; it is applied
to every window kind, since an `until` or `horizon` window that closed without
the required event is the same claim of absence. The carrying sources are the
raw sources in the lineage of the required event. "Complete through the
window's end" cannot be mapped from a fixture time to a `seq` without inference,
so it is approximated conservatively by "complete at the horizon"; otherwise the
instance is `inconclusive` (`incomplete_through_window_end`). Applies only with
`completeness: required`.

**D-011 Records above `complete_through`.** An instance whose supporting events
include a record with `seq` above its source's `complete_through` at the horizon
is `inconclusive` (`unclaimed_record`). The check covers every source the
instance consulted, not only the required ones, and applies with
`completeness: required`. Supporting events are: the event itself (transition,
invariant); trigger, in-window candidates and closing event (obligation); each
transitively through group members and join sides down to raw records.

**D-012 (spec) Coverage.** A record or event is consulted when it supports an
instance whose own verdict is not `not_applicable`: an expectation whose
`where` rejected an event did not judge it, so the behavior is still
unexplained. Only `confirmed` expectations explain behavior. All expectations
in the target are evaluated for coverage, not only the ones an experiment
investigates; the brief's own example (no `POST /orders 201` in the D2 block)
implies this. HTTP classes are keyed `METHOD route status`, because
`coverage_expected` in the corpus includes the method; event classes are keyed
by event name. Each class reports its total, the count not consulted, and up to
three example `seq`s (of unconsulted members if any).

**D-013 (corpus) `POST /orders 500` under D5 is explained, not unexplained.**
`xp-nonpositive-quantity` lists it in `coverage_expected` with the comment
"a 500 is never explained by an expectation", and the corpus README lists it as
coverage the runtime should report. But `exp-create-rejects-nonpositive-quantity`
judges that request (it has a line with quantity −1) and finds it violated, so
by D-012 it is consulted. The runtime reports it as "seen, explained, expected".
`coverage_expected` is informational and affects no verdict cell. Suggested fix,
for the owner to decide: drop the entry or reword the comment ("…is explained
only as a violation").

**D-014 (spec) Keys the corpus uses that the spec does not list.** Schemas are
strict (unknown keys are errors), yet the corpus must validate. Accepted, typed
and validated: `oracle.yaml` `target.notes`, `control.jobs`, `control.faults`,
`evidence.sources.*.shape` (`enveloped` default, or `flat`), `.envelope`
(`kind: { prefix, from } | { literal }`, `data: all`), `.notes`, and top-level
`defect_flags`; expectation `declared_in: [{ file, path, value }]`; decision
`confirmation`; step `note`. The spec text already mentions `note` and flag
lists; the rest is proposed for v0.1.

**D-015 (corpus) `independent_sources` entries in dec-003 and dec-004 parse as
YAML maps.** The unquoted entry `fixture-order-service/openapi.yaml (declared,
minimum: 1)` contains `: `, so YAML reads it as a one-key map. The spec gives
the field no type; it is accepted as free-form JSON. Probably meant as a string
(quote it). Affects no cell.

**D-016 Configuration detection.** `control.version` is read once per
experiment; the active flags are taken from its `defects` list, which is the
fixture-style control API this milestone supports. Zero flags is `clean`; one
listed flag selects that block merged over `default`; more than one, or a flag
not in `defect_flags`, is "not a supported configuration" and stops the check
(exit 1). `--config <name>` asserts the detected configuration. The reported
`git_sha` is compared with `target.commit` (prefix match either way) and a
mismatch is warned once per run; `applicability.since_commit`/`until_commit` are
not evaluated in this milestone, so an expectation is judged regardless of the
target's commit.

**D-017 Mark samples.** After every step (including each step inside a
`parallel` lane, and the `parallel` step itself), every source's
`high_water_mark` is sampled: sources with a `limit_param` are read with
`limit=1` from the starting mark; sources without one are read from the last
mark seen. Samples are taken one source at a time through a single chain, so
concurrent lanes cannot interleave two reads and fake a decrease. The horizon
read counts as the last sample. A failed sample makes the source unreliable
(`sample_failed`), because a reset between the samples around it can no longer
be ruled out.

**D-018 Steps.** A capture whose JSON path finds no scalar, or a template
variable that is neither built in nor captured, is `step_failed` like a
transport failure or an `expect_status` mismatch. `{{seed}}` substitutes as a
string like everything else. On a run error the remaining steps are skipped,
no horizon is attempted and no evidence is read; every expectation is
`inconclusive` (`step_failed`, with the step id). Setup failures name the step
`setup.reset.<service>`, `setup.clock` or `start`. Steps under test without
`expect_status` only have their status logged. A `clock` step posts
`{ advance: <ms> }` and `setup.clock` posts `{ set: <timestamp> }` to
`control.clock` (fixture-style).

**D-019 Evidence reads at the horizon.** After a successful `quiesce` the marks it
returns are not used; each source is paged from its starting mark until an empty
page, and that page's marks are the horizon marks. A failed read or a record
that cannot be mapped into the envelope marks the source `read_failed`
(unreliable). Collected records are deep-frozen. The fixture's optimistic
`http`/`outbound` completeness claim is not special-cased (brief §5).

**D-020 Which expectations are evaluated.** The kernel evaluates every
expectation in the target, whatever its governance status; an experiment
compares only the ones it investigates. Coverage uses confirmed ones only
(D-012).

**D-021 Projection example runner.** Missing record fields default to the
envelope's empty values (`source` from the projection, `ids` and `data` empty,
times null). An example passes when the actual events can be matched one to one
to the listed outputs on the listed fields, in any sequence, and the counts are
equal (so `output: []` asserts nothing is emitted). `keep` is allowed only on map
projections.

**D-022 Additional dev dependency: `@types/node`.** Type declarations for the
Node standard library are needed to type-check the runtime under `strict`; the
standard library cannot provide them. Dev-only; no runtime code.

**D-023 Run ids and data.** `{{run}}` is `<experiment-id>-<UTC timestamp in ISO
8601 basic format, e.g. 20261017T193005Z>-<4 hex>`; the basic format avoids `:`
in directory names. Each run is saved under `.oracle-data/runs/<run-id>/`
(`run.json`, `evidence.json`, `evidence/<source>.jsonl`, `samples.json`,
`verdicts.json`, `coverage.json`, `report.json`, `report.txt`), and
`oracle evaluate` rebuilds the evidence set from those files alone.

**D-024 Exit codes.** 0 when every cell matches and no run errored; 1 on any
mismatch, run error, unreached horizon or unsupported configuration; 2 on an
invalid target or bad usage.

**D-025 (corpus) `provider.requests` also resets in `xp-ledger-stream-reset`.**
Resetting the provider empties both of its sources, so `provider.requests` is
reported unreliable too. No expectation requires it, so no cell changes; noted
because the report shows two evidence lines for that experiment.
