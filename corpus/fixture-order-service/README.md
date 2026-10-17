# Corpus: fixture-order-service

A hand-authored oracle directory for
[protoku/fixture-order-service](https://github.com/protoku/fixture-order-service)
at commit `4c17f89`. It is the specification for the first runtime milestone:
when `oracle check` exists, running these experiments against the fixture must
produce exactly the verdicts below.

Nothing here was learned by a machine. Every expectation was written by hand
from the fixture brief, its README, its OpenAPI file and its decision log, and
each one has a decision record naming the question it answers. The learner
comes later; this corpus is what it will be measured against.

## Contents

| Directory | Count | What |
|---|---|---|
| `projections/` | 13 | typed transformations from raw evidence to events, each with examples |
| `expectations/` | 9 | confirmed expectations: 1 transition rule, 7 invariants, 1 obligation |
| `decisions/` | 9 | one per expectation: question, answer, authority, reasoning |
| `experiments/` | 10 | 8 that exercise defects, 2 that degrade the oracle's own evidence |

Plus `oracle.yaml` (how to reach the target and read its evidence) and
`vocabulary.yaml` (names for people).

## On "confirmed"

The expectations carry `governance.status: confirmed`, and each decision file
says why. They were drafted by an assistant, not by the owner, so the decision
files state that **committing them to the repository is the confirmation**.
Read the nine questions in `decisions/` before committing. If any answer is
wrong, change the expectation and the decision together; do not commit a rule
you would not defend.

## Expected verdicts by configuration

Worst verdict per expectation across the eight defect experiments, per
configuration (clean, or exactly one flag). The two degraded experiments are
listed separately below.

| Expectation | clean | D1 | D2 | D3 | D4 | D5 | D6 |
|---|---|---|---|---|---|---|---|
| exp-order-transitions | S | **V** | S | S | **V** | S | S |
| exp-order-total-equals-lines | S | S | S | S | S | S | **V** |
| exp-line-quantity-positive | S | S | S | S | S | **V** | S |
| exp-create-rejects-nonpositive-quantity | S | S | S | S | S | **V** | S |
| exp-create-idempotent | S | S | S | **V** | S | S | S |
| exp-charge-at-most-once-per-order | S | S | **V** | S | S | S | S |
| exp-no-new-charge-after-ambiguous-outcome | S | S | **V** | S | S | S | S |
| exp-fulfilled-and-refunded-exclusive | **V**¹ | **V** | **V**¹ | **V**¹ | **V** | **V**¹ | **V**¹ |
| exp-failed-attempt-has-no-charge | S | S | **V** | S | S | S | S |

S satisfied · V violated. Flags: D1 fulfill_cancelled, D2 timeout_as_failed,
D3 create_idempotency_ignored, D4 cancel_fulfilled_allowed,
D5 negative_quantity_accepted, D6 client_total_trusted.

¹ Violated in every configuration by `xp-refund-vs-job-race`: the clean fixture
can fulfil an order while its refund is in flight (the always-on defect D0,
documented in the fixture's decision log as deliberately left in place). This
is the row that shows the oracle finding something nobody flagged. Under D1
and D4 the same expectation is additionally violated by their own experiments.

Each defect is caught by at least one expectation, and D2 by three: the
obligation (what the service may do), the ledger invariant (what is true), and
the bookkeeping invariant (what the service believes). D5 is caught twice, at
the API and in storage, because the storage rule alone would never fire
without a probe.

## Degraded experiments

These exist to prove the runtime says "I cannot tell" when it cannot.

| Experiment | Expectation | Expected | Why |
|---|---|---|---|
| xp-ledger-stream-reset | exp-charge-at-most-once-per-order | **inconclusive** | provider.ledger high-water mark regressed 1 → 0 |
| xp-ledger-stream-reset | exp-failed-attempt-has-no-charge | **inconclusive** | same |
| xp-ledger-stream-reset | exp-order-transitions | satisfied | db evidence is intact |
| xp-ambiguous-charge-unresolved | exp-no-new-charge-after-ambiguous-outcome | **pending** | window `until reconcile 200` never closed; nothing forbidden observed |
| xp-ambiguous-charge-unresolved | exp-charge-at-most-once-per-order | satisfied | zero charges |
| xp-ambiguous-charge-unresolved | exp-failed-attempt-has-no-charge | not_applicable | no attempt has a ledger charge |

A runtime that reports `satisfied` for the first two rows has the exact failure
the second review warned about: an empty, "complete" ledger looks like a
provider that never charged anyone.

## What the experiments map to

| Experiment | Flag it exercises | Flips |
|---|---|---|
| xp-happy-path | none | nothing; baseline |
| xp-cancel-after-pay-before-job | D1 | transitions, exclusive |
| xp-cancel-fulfilled | D4 | transitions, exclusive |
| xp-create-same-key-twice | D3 | create-idempotent |
| xp-nonpositive-quantity | D5 | create-rejects, line-quantity |
| xp-client-total | D6 | total-equals-lines |
| xp-ambiguous-charge-then-repay | D2 | no-new-charge, charge-at-most-once, failed-attempt |
| xp-refund-vs-job-race | D0 (always on) | exclusive |
| xp-ledger-stream-reset | none (degrades evidence) | inconclusive for ledger-backed rules |
| xp-ambiguous-charge-unresolved | none (leaves an obligation open) | pending |

## Coverage the runtime should report

No expectation in this corpus consults the responses of `POST /orders/:id/pay`,
`POST /orders/:id/cancel`, `POST /orders/:id/reconcile` or `GET /orders/:id`.
All of their `(route, status)` classes will appear as unexplained, which is
correct: the corpus has no rule about them yet. Two are worth a human's
attention first:

- `POST /orders/:id/cancel 409` in `xp-refund-vs-job-race`: the `order_changed`
  response, where a refund succeeded but the order was not cancelled. Money
  moved; state did not. No expectation names this outcome.
- `POST /orders 500` under D5: a validation gap surfacing as an outage.

## Evidence gaps this exercise found

Writing expectations on paper against real evidence exposed these. The first
is a defect in the fixture's completeness claim; the rest are missing seams.

1. **`http` and `outbound` completeness is optimistic.** The response reaches
   the client before the evidence row exists, and `complete_through` equals
   `high_water_mark` regardless. Reported against the fixture; until fixed,
   every experiment reads evidence only after `quiesce`.
2. **No job-run evidence.** The fulfillment job's runs are visible only through
   the db changes they cause. An obligation cannot say "until the job ran". The
   corpus works around it with the transition rule; a `job.run` evidence record
   (name, trace, started, finished, processed, skipped) would make obligations
   about the job expressible.
3. **A provider reset is not an evidence event.** The runtime must infer it from
   a high-water-mark regression. A `generation` field in the provider's read
   responses would make it explicit.
4. **`app.idempotency_keys` has no trigger**, so create idempotency is judged
   at the HTTP boundary only.
5. **Cross-source ordering is by `fixture_time`.** The obligation correlates an
   `outbound` trigger with an `http` closing event; that works because both
   come from one process with one clock. It will not generalize.

## Language growth caused by this corpus

- `any` / `all` array conditions, needed to express "a request with any line
  below quantity one" without a projection that flattens request lines.
- `expected.default` in experiments, so that one baseline covers every flag.

Both are recorded in `docs/expectation-language.md`.

## Running (once the runtime exists)

```sh
# in fixture-order-service
docker compose up -d && npm run migrate

# in oracle
oracle check --target corpus/fixture-order-service --config clean
FIXTURE_DEFECTS=D2_timeout_as_failed docker compose up -d order-service   # restart with one flag
oracle check --target corpus/fixture-order-service --config D2_timeout_as_failed
```

`oracle check` runs every experiment, compares verdicts to `expected`, prints
the coverage list, and exits non-zero on any mismatch.
