import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceStatus } from '../../src/kernel/completeness.js';
import { evaluate } from '../../src/kernel/evaluate.js';
import { evaluateExpectation, rollUp } from '../../src/kernel/expectations.js';
import type { Definitions, EvidenceSet, Verdict } from '../../src/kernel/types.js';
import { context, ev, evidenceSet, expectation, projection, rec } from '../support/build.js';

const transition = expectation({
  id: 'exp-t',
  kind: 'transition',
  over: 'st',
  entity: 'id',
  rule: { allowed: [{ from: null, to: 'a' }, { from: 'a', to: 'b' }] },
});

test('transition: each event is an instance; null from denotes creation', () => {
  const v = evaluateExpectation(
    transition,
    context([ev('st', 's', 1, { id: 'e1', from: null, to: 'a' }), ev('st', 's', 2, { id: 'e1', from: 'a', to: 'b' }), ev('st', 's', 3, { id: 'e1', to: 'a' })]),
  ).verdict;
  assert.deepEqual(v.instances.map((i) => i.verdict), ['satisfied', 'satisfied', 'satisfied']);
  assert.equal(v.verdict, 'satisfied');
});

test('transition: a pair outside allowed is violated and located by entity', () => {
  const v = evaluateExpectation(transition, context([ev('st', 's', 1, { id: 'e1', from: 'b', to: 'a' })])).verdict;
  assert.equal(v.verdict, 'violated');
  assert.deepEqual(v.instances[0]?.locator.entity, { field: 'id', value: 'e1' });
  assert.match(v.detail, /b → a/);
});

const invariant = expectation({
  id: 'exp-i',
  kind: 'invariant',
  over: 'g',
  entity: 'id',
  where: [{ path: 'applies', equals: true }],
  assert: [{ path: 'n', lte: 1 }],
});

test('invariant: satisfied, violated and not_applicable instances', () => {
  const v = evaluateExpectation(
    invariant,
    context([ev('g', 's', 1, { id: 'a', applies: true, n: 1 }), ev('g', 's', 2, { id: 'b', applies: true, n: 2 }), ev('g', 's', 3, { id: 'c', applies: false, n: 9 })]),
  ).verdict;
  assert.deepEqual(v.instances.map((i) => i.verdict), ['satisfied', 'violated', 'not_applicable']);
  assert.equal(v.verdict, 'violated');
  assert.match(v.detail, /id b: n 2/);
});

test('invariant: only not_applicable instances, or none, roll up to not_applicable', () => {
  assert.equal(evaluateExpectation(invariant, context([ev('g', 's', 1, { applies: false })])).verdict.verdict, 'not_applicable');
  assert.equal(evaluateExpectation(invariant, context([])).verdict.verdict, 'not_applicable');
});

test('roll-up precedence: violated > inconclusive > pending > satisfied > not_applicable', () => {
  const order: Verdict[] = ['violated', 'inconclusive', 'pending', 'satisfied', 'not_applicable'];
  for (let i = 0; i < order.length; i++) {
    for (let j = i; j < order.length; j++) {
      assert.equal(rollUp([order[j] as Verdict, order[i] as Verdict]), order[i]);
      assert.equal(rollUp([order[i] as Verdict, order[j] as Verdict]), order[i]);
    }
  }
  assert.equal(rollUp([]), 'not_applicable');
});

// ---------------------------------------------------------------------------
// Evidence contracts through the full kernel

const countP = projection({ id: 'prj-c', emits: 'c', group: { source: 'ledger', by: 'data.k' }, map: { k: { key: true }, n: { count: true } } });
const joinedP = projection({ id: 'prj-j', emits: 'j', from: { source: 'ledger' }, map: { k: 'data.k' } });
const definitions = (completeness: 'required' | 'best_effort' = 'required'): Definitions => ({
  sources: ['db', 'ledger'],
  projections: [countP, joinedP],
  expectations: [
    expectation({ id: 'exp-count', kind: 'invariant', over: 'c', entity: 'k', assert: { path: 'n', lte: 1 }, evidence: { required: ['ledger'], completeness } }),
    expectation({ id: 'exp-any', kind: 'invariant', over: 'j', assert: { path: 'k', exists: true }, evidence: { required: ['ledger'], completeness } }),
  ],
});

const verdict = (e: EvidenceSet, defs = definitions()) => {
  const out = evaluate(e, defs);
  return Object.fromEntries(out.verdicts.map((v) => [v.expectation, v]));
};

test('stream reset: a decreasing high_water_mark makes the source unreliable and every dependent expectation inconclusive', () => {
  const e = evidenceSet([rec('db', 1, 'x')], {
    sources: ['ledger'],
    marks: { ledger: { high_water_mark: 0, complete_through: 0 }, db: { high_water_mark: 1, complete_through: 1 } },
    samples: [
      { label: 'start', marks: { ledger: { high_water_mark: 0, complete_through: 0 } } },
      { label: 'mark', marks: { ledger: { high_water_mark: 1, complete_through: 1 } } },
      { label: 'lose', marks: { ledger: { high_water_mark: 0, complete_through: 0 } } },
    ],
  });
  const status = sourceStatus(e, 'ledger');
  assert.equal(status.reliable, false);
  assert.equal(status.reason, 'stream_reset');
  assert.deepEqual(status.regression, { before: { label: 'mark', high_water_mark: 1 }, after: { label: 'lose', high_water_mark: 0 } });

  // The emptied ledger yields no events; that must not read as not_applicable or satisfied.
  const v = verdict(e);
  for (const id of ['exp-count', 'exp-any']) {
    assert.equal(v[id]?.verdict, 'inconclusive', id);
    assert.equal(v[id]?.reason, 'stream_reset');
    assert.match(v[id]?.detail ?? '', /stream_reset, high_water_mark went 1 → 0 between samples "mark" and "lose"/);
  }
});

test('a regression against the horizon read is also a stream reset', () => {
  const e = evidenceSet([], {
    marks: { ledger: { high_water_mark: 2, complete_through: 2 } },
    samples: [{ label: 'last-step', marks: { ledger: { high_water_mark: 5, complete_through: 5 } } }],
  });
  assert.equal(sourceStatus(e, 'ledger').reason, 'stream_reset');
});

test('a failed sample makes the source unreliable', () => {
  const e = evidenceSet([], { sources: ['ledger'], samples: [{ label: 's1', marks: { ledger: { error: 'ECONNREFUSED' } } }] });
  const s = sourceStatus(e, 'ledger');
  assert.equal(s.reliable, false);
  assert.equal(s.reason, 'sample_failed');
});

test('incomplete at the horizon: inconclusive with both numbers, every instance', () => {
  const e = evidenceSet([rec('ledger', 1, 'x', { k: 'a' }), rec('ledger', 2, 'x', { k: 'a' })], { marks: { ledger: { high_water_mark: 4, complete_through: 3 } } });
  const v = verdict(e)['exp-count'];
  assert.equal(v?.verdict, 'inconclusive');
  assert.equal(v?.reason, 'incomplete');
  assert.match(v?.detail ?? '', /complete_through 3 < high_water_mark 4/);
  assert.ok(v?.instances.every((i) => i.verdict === 'inconclusive'));
});

test('an instance that consulted a record above complete_through is inconclusive', () => {
  const defs = definitions();
  defs.expectations = defs.expectations.map((x) => ({ ...x, evidence: { required: [], completeness: 'required' } }));
  const e = evidenceSet([rec('ledger', 1, 'x', { k: 'a' }), rec('ledger', 5, 'x', { k: 'b' })], { marks: { ledger: { high_water_mark: 5, complete_through: 3 } } });
  const v = verdict(e, defs)['exp-any'];
  assert.deepEqual(v?.instances.map((i) => [i.verdict, i.reason]), [
    ['satisfied', null],
    ['inconclusive', 'unclaimed_record'],
  ]);
  assert.equal(v?.verdict, 'inconclusive');
});

test('best_effort: verdicts on visible records, flagged', () => {
  const e = evidenceSet([rec('ledger', 1, 'x', { k: 'a' })], { marks: { ledger: { high_water_mark: 4, complete_through: 0 } } });
  const v = verdict(e, definitions('best_effort'))['exp-count'];
  assert.equal(v?.verdict, 'satisfied');
  assert.equal(v?.best_effort, true);
});

test('verdicts carry versions, consulted projections and per-source marks', () => {
  const e = evidenceSet([rec('ledger', 1, 'x', { k: 'a' })]);
  const v = verdict(e)['exp-count'];
  assert.equal(v?.version, 1);
  assert.deepEqual(v?.projections, [{ id: 'prj-c', version: 1 }]);
  assert.deepEqual(v?.sources['ledger'], { high_water_mark: 1, complete_through: 1, reliable: true });
  assert.deepEqual(v?.instances[0]?.evidence_range, { ledger: { from: 1, to: 1 } });
});

test('horizon not reached or a failed step: everything inconclusive, nothing judged', () => {
  const e = evidenceSet([rec('ledger', 1, 'x', { k: 'a' })]);
  const noHorizon = evaluate({ ...e, horizon: { reached: false, reason: 'quiesce answered 504', fixture_time: null } }, definitions());
  assert.ok(noHorizon.verdicts.every((v) => v.verdict === 'inconclusive' && v.reason === 'horizon_not_reached'));
  const failed = evaluate({ ...e, run_error: { reason: 'step_failed', step: 'pay', detail: 'ECONNRESET' } }, definitions());
  assert.ok(failed.verdicts.every((v) => v.verdict === 'inconclusive' && v.reason === 'step_failed' && v.detail.includes('"pay"')));
});
