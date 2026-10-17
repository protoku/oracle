import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateExpectation } from '../../src/kernel/expectations.js';
import type { KEvent } from '../../src/kernel/projections.js';
import type { SourceStatus, Verdict } from '../../src/kernel/types.js';
import { completeStatus, context, ev, expectation, incompleteStatus, projection } from '../support/build.js';

const T = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}Z`;

type Mode = 'require' | 'forbid';
type WindowKind = 'within' | 'until' | 'horizon';

function obligation(mode: Mode, window: WindowKind, clause: Record<string, unknown> = {}, required: string[] = []) {
  const w = window === 'within' ? { within: '10s' } : window === 'until' ? { until: { event: 'close', where: [{ path: 'k', equals: '$trigger.k' }] } } : { horizon: true };
  return expectation({
    id: 'exp-o',
    kind: 'obligation',
    evidence: { required, completeness: 'required' },
    when: { event: 'trig', where: [{ path: 'go', equals: true }] },
    correlate_by: { k: '$trigger.k' },
    [mode]: { event: 'cand', ...clause },
    window: w,
  });
}

function verdictOf(def: ReturnType<typeof obligation>, events: KEvent[], fixtureTime: string | null = null, statuses?: SourceStatus[]) {
  const r = evaluateExpectation(def, context(events, { fixture_time: fixtureTime, statuses }));
  return r.verdict;
}

const trigger = () => ev('trig', 'o', 1, { k: 'a', go: true }, T(0));
const candidate = (seq = 2, at = T(5), k = 'a') => ev('cand', 'o', seq, { k }, at);
const closing = (at = T(7)) => ev('close', 'h', 1, { k: 'a' }, at);

// Spec §4.3, row by row. "closed"/"open" is the window at the horizon;
// "met" means a correlated candidate inside the window.
interface Cell {
  window: WindowKind;
  closed: boolean;
  met: boolean;
  require: Verdict;
  forbid: Verdict;
}
const cells: Cell[] = [];
for (const window of ['within', 'until', 'horizon'] as const) {
  for (const closed of [true, false]) {
    if (window === 'horizon' && !closed) continue; // the horizon window is closed by definition at evaluation
    for (const met of [true, false]) {
      cells.push({
        window,
        closed,
        met,
        require: met ? 'satisfied' : closed ? 'violated' : 'pending',
        forbid: met ? 'violated' : closed ? 'satisfied' : 'pending',
      });
    }
  }
}

function scenario(c: Cell): { events: KEvent[]; fixtureTime: string | null } {
  const events = [trigger(), ...(c.met ? [candidate()] : [])];
  if (c.window === 'until' && c.closed) events.push(closing());
  const fixtureTime = c.window === 'within' ? (c.closed ? T(30) : T(8)) : null;
  return { events, fixtureTime };
}

for (const c of cells) {
  for (const mode of ['require', 'forbid'] as const) {
    test(`obligation ${mode} ${c.window}: window ${c.closed ? 'closed' : 'open'}, condition ${c.met ? 'met' : 'not met'} → ${c[mode]}`, () => {
      const { events, fixtureTime } = scenario(c);
      const v = verdictOf(obligation(mode, c.window), events, fixtureTime);
      assert.equal(v.verdict, c[mode], v.detail);
      assert.equal(v.instances.length, 1);
    });
  }
}

test('no trigger occurrence: not_applicable', () => {
  const v = verdictOf(obligation('forbid', 'until'), [ev('trig', 'o', 1, { k: 'a', go: false }, T(0)), candidate()]);
  assert.equal(v.verdict, 'not_applicable');
  assert.equal(v.instances.length, 0);
});

test('candidates before the trigger, uncorrelated, or failing where do not count', () => {
  const t = ev('trig', 'o', 5, { k: 'a', go: true }, T(5));
  const events = [t, ev('cand', 'o', 3, { k: 'a' }, T(3)), candidate(6, T(6), 'b'), ev('cand', 'o', 7, { k: 'a', bad: true }, T(7))];
  const def = obligation('forbid', 'horizon', { where: [{ path: 'bad', not_equals: true }] });
  assert.equal(verdictOf(def, events).verdict, 'satisfied');
});

test('until: a candidate after the closing event is outside the window', () => {
  const events = [trigger(), closing(T(4)), candidate(2, T(5))];
  assert.equal(verdictOf(obligation('forbid', 'until'), events).verdict, 'satisfied');
  assert.equal(verdictOf(obligation('require', 'until'), events).verdict, 'violated');
});

test('until: the closing event must itself follow the trigger', () => {
  const events = [trigger(), ev('close', 'h', 1, { k: 'a' }, '2025-12-31T23:59:59Z')];
  assert.equal(verdictOf(obligation('forbid', 'until'), events).verdict, 'pending');
});

test('within: a candidate after the window end is outside the window', () => {
  const events = [trigger(), candidate(2, T(15))];
  assert.equal(verdictOf(obligation('forbid', 'within'), events, T(30)).verdict, 'satisfied');
});

test('within: a trigger without fixture_time cannot bound the window', () => {
  const v = verdictOf(obligation('forbid', 'within'), [ev('trig', 'o', 1, { k: 'a', go: true }, null)], T(30));
  assert.equal(v.verdict, 'inconclusive');
  assert.equal(v.reason, 'window_unbounded');
});

test('within: an unknown horizon fixture time leaves the window open', () => {
  assert.equal(verdictOf(obligation('require', 'within'), [trigger()], null).verdict, 'pending');
});

test('require: a closed window is violated only if the carrying source is complete', () => {
  const carrier = projection({ id: 'prj-cand', emits: 'cand', from: { source: 'o' }, map: { k: 'data.k' } });
  const def = obligation('require', 'horizon');
  const incomplete = evaluateExpectation(def, context([trigger()], { statuses: [incompleteStatus('o'), completeStatus('h')], projections: [carrier] })).verdict;
  assert.equal(incomplete.verdict, 'inconclusive');
  assert.equal(incomplete.reason, 'incomplete_through_window_end');
  const complete = evaluateExpectation(def, context([trigger()], { statuses: [completeStatus('o')], projections: [carrier] })).verdict;
  assert.equal(complete.verdict, 'violated');
});

test('require count_distinct: comparators, and equals above target violates while open', () => {
  const events = [trigger(), ev('cand', 'o', 2, { k: 'a', id: 'x' }, T(2)), ev('cand', 'o', 3, { k: 'a', id: 'x' }, T(3)), ev('cand', 'o', 4, { k: 'a', id: 'y' }, T(4))];
  const v = (clause: Record<string, unknown>, window: WindowKind = 'until') => verdictOf(obligation('require', window, { count_distinct: 'id', ...clause }), events).verdict;
  assert.equal(v({ equals: 2 }), 'satisfied');
  assert.equal(v({ equals: 1 }), 'violated');
  assert.equal(v({ equals: 3 }), 'pending');
  assert.equal(v({ equals: 3 }, 'horizon'), 'violated');
  assert.equal(v({ gte: 2 }), 'satisfied');
  assert.equal(v({ gte: 3 }), 'pending');
  assert.equal(v({ lte: 1 }), 'violated');
  assert.equal(v({ lte: 2 }), 'satisfied');
  assert.equal(v({}), 'satisfied');
});

test('cross-source ordering: fixture_time first, then recorded_at; unknown fixture_time is inconclusive', () => {
  const t = ev('trig', 'o', 9, { k: 'a', go: true, recorded_at: T(10) }, T(1));
  const sameTimeLater = ev('cand', 'x', 1, { k: 'a', recorded_at: T(11) }, T(1));
  const sameTimeEarlier = ev('cand', 'x', 2, { k: 'a', recorded_at: T(9) }, T(1));
  assert.equal(verdictOf(obligation('forbid', 'horizon'), [t, sameTimeEarlier]).verdict, 'satisfied');
  assert.equal(verdictOf(obligation('forbid', 'horizon'), [t, sameTimeLater]).verdict, 'violated');
  const unknown = verdictOf(obligation('forbid', 'horizon'), [t, ev('cand', 'x', 3, { k: 'a' }, null)]);
  assert.equal(unknown.verdict, 'inconclusive');
  assert.equal(unknown.reason, 'ordering_unknown');
});

test('one instance per trigger occurrence, rolled up worst-first', () => {
  const t1 = ev('trig', 'o', 1, { k: 'a', go: true }, T(0));
  const t2 = ev('trig', 'o', 3, { k: 'b', go: true }, T(2));
  const v = verdictOf(obligation('forbid', 'horizon'), [t1, t2, ev('cand', 'o', 4, { k: 'b' }, T(4))]);
  assert.deepEqual(v.instances.map((i) => i.verdict), ['satisfied', 'violated']);
  assert.equal(v.verdict, 'violated');
});
