# Expectation language, v0

This is the smallest language that can express the corpus in
`corpus/fixture-order-service`. It will grow, slowly, and every addition must
come with a projection or expectation in a corpus that needs it. There is no
embedded code anywhere: no JavaScript, no SQL, no template expressions beyond
variable substitution in experiments.

Vocabulary used below: a **record** is one raw evidence item; an **event** is
the typed output of a projection; an **instance** is one evaluation of an
expectation (one entity, or one trigger occurrence); a **verdict** is the
outcome for one instance; a **horizon** is the moment evaluation happens.

---

## 1. Evidence records

Every source yields records in one envelope. Field names follow the fixture's
control API; other collectors must map into the same shape.

| Field | Type | Meaning |
|---|---|---|
| `source` | string | Source name as declared in `oracle.yaml` (`http`, `db`, `provider.ledger`, …) |
| `seq` | integer | Monotonic within the source. Gaps are allowed and mean nothing. |
| `recorded_at` | timestamp | The observer's wall clock. |
| `fixture_time` | timestamp or null | The system's own notion of now, when the source knows it. |
| `trace_id` | string or null | |
| `ids` | object | Whichever correlation identifiers are known. Absent means unknown. |
| `kind` | string | Dotted, source-specific (`db.update`, `http.request`, …). |
| `data` | object | Source-specific payload. |

A source read returns `records`, `high_water_mark` and `complete_through`.
`complete_through` is the source's claim that every record with
`seq <= complete_through` that will ever exist is already visible. The kernel
treats records above `complete_through` as **visible but unclaimable**.

### Evidence set

An evaluation runs over an **evidence set**: for each source, all records
fetched from `since = 0` (or an experiment's starting mark) up to the horizon,
plus the source's `high_water_mark` and `complete_through` at the horizon.

A source is **complete at the horizon** when `complete_through >=
high_water_mark` at that moment and the source's `high_water_mark` never
decreased during the run. A decrease (a stream reset) marks the source
**unreliable** for the whole run, because records that existed may have been
lost without trace.

---

## 2. Paths, values, conditions

A **path** is a dotted reference into a record or event: `data.new.status`,
`ids.order_id`, `trace_id`. Missing segments yield `null`.

A **value** is a JSON scalar, or a reference: `$trigger.<path>` (the trigger
event in an obligation), `$left.<path>` / `$right.<path>` (in a join), `$.<path>`
(the current event).

A **condition** is one object from this closed set:

```yaml
{ path: <path>, equals: <value> }
{ path: <path>, not_equals: <value> }
{ path: <path>, in: [<value>, ...] }
{ path: <path>, not_in: [<value>, ...] }
{ path: <path>, lt | lte | gt | gte: <value> }
{ path: <path>, exists: true | false }
{ all_of: [<condition>, ...] }
{ any_of: [<condition>, ...] }
{ not: <condition> }
{ path: <array path>, any: <condition> }      # some element satisfies it (paths relative to the element)
{ path: <array path>, all: <condition> }      # every element satisfies it; true for an empty array
```

A list of conditions is an implicit `all_of`. Comparisons against `null` are
false except `equals: null`, `not_equals: null`, and `exists`. `any` and `all`
on a non-array or missing value are false.

---

## 3. Projections

A projection turns records (or other projections' events) into typed events.
Projections are the only place where evidence is interpreted, which is why they
are versioned, immutable once approved, and tested with examples. Projections
may read other projections' events, forming a DAG; cycles are rejected.

Common header:

```yaml
id: prj-<name>
version: 1
emits: <event name>            # dotted, e.g. order.status_changed
description: one sentence
```

Three shapes. A file has exactly one of `from`, `group`, or `join`.

### 3.1 Map

```yaml
from:
  source: db                   # or  event: <event name>
  where: [<condition>, ...]
map:
  <field>: <path>              # copied from the input
  <field>: { literal: <value> }
keep: [<condition>, ...]       # optional filter on the mapped event
```

Every emitted event also carries `seq`, `source`, `recorded_at`, `fixture_time`
and `trace_id` from its input record, unless the projection maps them
explicitly. For group and join projections, `seq` is the maximum input `seq`,
and `fixture_time` is the maximum input `fixture_time`.

### 3.2 Group

```yaml
group:
  source: db                   # or  event: <event name>
  where: [<condition>, ...]
  by: <path>                   # grouping key
map:
  <field>: { key: true }
  <field>: { first | last: <path>, where: [...] }      # ordered by seq
  <field>: { count: true, where: [...] }
  <field>: { count_distinct: <path>, where: [...] }
  <field>: { sum | min | max: <path>, where: [...] }
  <field>: { sum_product: [<path>, <path>], where: [...] }
  <field>: { any: true, where: [...] }                  # boolean: at least one input matches
```

A group event is emitted once per key over the whole evidence set. Its
`seq` is the maximum input `seq`, which is how completeness is checked (§6).

### 3.3 Join

```yaml
join:
  left:  { event: <event name>, key: <path> }
  right: { event: <event name>, key: <path> }
  type: inner | left
map:
  <field>: $left.<path> | $right.<path>
  <field>: { exists: right }
```

Keys match on JSON equality. A `left` join emits unmatched left events with
`$right.*` null. Many-to-many matches emit one event per pair.

### 3.4 Examples

```yaml
examples:
  - name: status change is emitted
    input:
      - { source: db, seq: 7, kind: db.update, ids: { order_id: o1, txid: 9 },
          data: { table: orders, old: { status: created }, new: { status: paid, version: 2 } } }
    output:
      - { order_id: o1, from: created, to: paid }
  - name: unrelated table is ignored
    input: [ ... ]
    output: []
```

Examples are the projection's counterexample tests. `output` is matched on the
listed fields only. A runtime must run them on load and refuse a projection
whose examples fail.

---

## 4. Expectations

Common header, all fields required unless marked:

```yaml
id: exp-<name>
version: 1
kind: transition | invariant | obligation
wording: >
  The sentence the human approved. Stored verbatim; never regenerated.
provenance: human_authored | declared | inferred
governance:
  status: candidate | confirmed | rejected | deprecated
  decision: dec-<id>           # required when confirmed, rejected or deprecated
owner:
  authority: <person, role or team>
  domain: <short domain name>
applicability:
  target: <target name>
  since_commit: <sha>          # optional
  until_commit: <sha>          # optional
evidence:
  required: [<source>, ...]
  completeness: required | best_effort
consequence: >                 # optional, shown at review: what a violation means for people
  ...
```

### 4.1 transition

Judges a sequence of `from → to` changes for one entity.

```yaml
over: <event name>             # events with from, to, and the entity field
entity: <field>
rule:
  allowed:
    - { from: <value or null>, to: <value> }
```

Each event is one instance. Satisfied if `(from, to)` is in `allowed`,
violated otherwise. `from: null` denotes creation.

### 4.2 invariant

Judges a condition over every event of a type.

```yaml
over: <event name>
entity: <field>                # optional; used for grouping in reports
where: [<condition>, ...]      # optional; events failing it are not applicable
assert: <condition>            # may use $.<path>
```

Each event is one instance: satisfied if `assert` holds, violated if it does
not, not applicable if `where` fails.

### 4.3 obligation

Judges that, after a trigger, something does or does not happen, correlated by
identifiers, inside a window.

```yaml
when:
  event: <event name>
  where: [<condition>, ...]
correlate_by:
  <field>: $trigger.<path>     # applied as equality on candidate events
require:                       # exactly one of require / forbid
  event: <event name>
  where: [<condition>, ...]    # may use $trigger.<path>
  count_distinct: <path>       # optional
  equals | gte | lte: <int>    # with count_distinct; default: at least one event
forbid:
  event: <event name>
  where: [<condition>, ...]
window:                        # exactly one of
  within: <duration>           # fixture_time of trigger + duration
  until:  { event: <event name>, where: [...] }     # first matching event after the trigger
  horizon: true                # the experiment's horizon (CI mode only)
```

Each trigger occurrence is one instance. Candidate events are those after the
trigger (`seq` greater, same source ordering) that pass `correlate_by` and
`where`. The window closes at `within`, at the first `until` event, or at the
horizon.

| Situation at horizon | `require` | `forbid` |
|---|---|---|
| window closed, condition met | satisfied | violated |
| window closed, condition not met | violated | satisfied |
| window still open, condition already met | satisfied | violated |
| window still open, condition not met | pending | pending |

"Condition met" for `require` with `count_distinct` means the count satisfies
the comparator; for `equals`, a count above the target is a violation as soon
as it is observed.

An obligation with `window: horizon` is only meaningful under an experiment; in
production monitoring it is rejected at load.

---

## 5. Verdicts and roll-up

Each instance gets one of `satisfied`, `violated`, `pending`, `inconclusive`,
`not_applicable`, plus the identifiers that locate it (entity, trigger seq) and
the evidence range consulted.

Per expectation, per run, the roll-up is the worst instance in this order:
`violated` > `inconclusive` > `pending` > `satisfied` > `not_applicable`. A run
with no instances is `not_applicable`.

Verdicts are immutable and carry `expectation.version`, every consulted
projection's `version`, and the per-source `(high_water_mark, complete_through)`
at the horizon.

---

## 6. Evidence contracts and inconclusive

Before an instance can be `satisfied` or `violated`, its evidence must be good
enough. With `completeness: required`:

- Every source in `evidence.required` must be complete at the horizon (§1).
  Otherwise every instance of the expectation is `inconclusive`, and the verdict
  names the source and the gap (`complete_through` vs `high_water_mark`, or
  `stream_reset`).
- An instance whose supporting events include any record above a source's
  `complete_through` is `inconclusive`.
- A `require` can be `violated` only if the source that would have carried the
  required event is complete through the window's end.

With `completeness: best_effort`, verdicts are computed on visible records and
flagged `best_effort: true`. Use it only for exploratory expectations; a
confirmed expectation about money or irreversible effects must be `required`.

Inconclusive is not a soft failure to be tuned away. Its rate is a tracked
metric; every inconclusive verdict must say what evidence or decision would
resolve it.

---

## 7. Coverage

Separately from verdicts, the runtime reports **unexplained behavior classes**:
events of any projection, and raw `http.request` records grouped by
`(route, status)`, that no expectation's `over`, `when`, `require` or `forbid`
consulted. Coverage is informational and prioritized by the learner later; in
milestone 1 it is a list.

---

## 8. Experiments

```yaml
id: xp-<name>
hypothesis: one sentence, falsifiable
investigates: [exp-<id>, ...]
target: <target name>
seed: <int>
setup:
  reset: [<service>, ...]          # control.reset in oracle.yaml, in order
  clock: { set: <iso timestamp> }  # optional
steps: [<step>, ...]
horizon: quiesce                   # call control.quiesce, then read all sources
expected:
  default:                         # applies to every configuration not listed below
    <exp-id>: satisfied | violated | pending | inconclusive | not_applicable
  <defect flag>:                   # overrides for a configuration (one flag active)
    <exp-id>: ...
coverage_expected:                 # optional: behavior classes that, when observed, are expected to be unexplained
  - "<route> <status>"
```

A configuration is the clean target or the target with exactly one defect flag
active, as reported by `control.version`. `expected.default` must list every
expectation in `investigates`; a flag block may list a subset.
`coverage_expected` is informational: the runtime reports which of the listed
classes it saw and whether they were unexplained, and does not fail a run over
them.

The runtime samples every source's `high_water_mark` after each step; a step
with `evidence_mark: true` only names such a sample so that a human reading
the experiment knows where a regression is expected to be detected.

A step is one of:

```yaml
- id: <name>
  http:
    service: <service name from oracle.yaml>
    method: GET | POST
    path: /orders/{{order_id}}/pay
    headers: { Idempotency-Key: "{{uuid}}", x-trace-id: "{{run}}-pay1" }
    body: { ... }
  capture: { order_id: $.id }      # JSON paths into the response body
  expect_status: 201               # setup sanity only; never used on behavior under test
- id: <name>
  sleep_ms: 300                    # real time; for scheduling, not business time
- id: <name>
  parallel:                        # lists of step lists; each list runs sequentially
    - [<step>, ...]
    - [<step>, ...]
- id: <name>
  clock: { advance_ms: 60000 }     # control.clock
- id: <name>
  evidence_mark: true              # record every source's high_water_mark under this id
```

Templating is substitution only: `{{run}}` (a unique id per run), `{{uuid}}`
(fresh each use), `{{seed}}`, and any captured variable. Nothing is evaluated.

`expect_status` exists so a broken setup fails loudly instead of producing a
misleading verdict; a step under test carries a `note` instead.

---

## 9. Decisions

```yaml
id: dec-<id>
expectation: exp-<id>
version: 1
date: <iso date>
authority: <who, and in what role>
question: >
  The single question that was put to the human.
answer: confirm | reject | deprecate | resolve
reasoning: >
  Why. This is the part people will need in two years.
independent_sources: [ ... ]       # optional: requirements, regulations, reference systems
```

---

## 10. Target configuration (`oracle.yaml`)

```yaml
language_version: 0
target: { name, repo, commit }
services:
  <name>: { base_url }
control:
  reset: [{ service, method, path }, ...]
  quiesce: { service, method, path }
  clock: { service, path }
  version: { service, path }
evidence:
  sources:
    <name>:
      service: <service name>
      path: /__control/evidence/db
      paging: { param: since, limit_param: limit, limit: 10000 }
      fixture_time: known | unknown
      notes: free text; known limitations go here
```

---

## 11. Known weaknesses of v0

- Ordering across sources relies on `fixture_time` and `seq` within a source;
  there is no cross-source happens-before. Obligations that correlate `http`
  triggers with `db` effects assume the trigger's `seq` ordering is comparable
  through `fixture_time`, which holds in the fixture (one clock, one process)
  and will not hold in general. Cross-source ordering needs explicit
  uncertainty; deferred.
- Group projections emit once per key over the whole evidence set, so an
  invariant over a group is really an invariant at the horizon. Intermediate
  states are not judged.
- `within` is measured on `fixture_time`; a source that does not know the
  fixture clock (the provider) cannot bound windows and must use `until` or
  `horizon`.
- There is no way yet to express "at the moment event A happened, entity E was
  in state S" (state-at-time). The corpus works around it with transition rules
  and horizon invariants. This is the most likely next primitive.
- Projection examples test projections; nothing yet tests expectations
  against synthetic events. Experiments against the fixture are the only
  expectation tests in milestone 1.
