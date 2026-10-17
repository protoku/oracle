import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectionSequence } from '../../src/kernel/dag.js';
import { evaluateProjections } from '../../src/kernel/projections.js';
import { evidenceSet, projection, rec } from '../support/build.js';

const T = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}Z`;

test('map: copies paths and literals, carries meta fields, filters with where and keep', () => {
  const p = projection({
    id: 'prj-m',
    emits: 'm.event',
    from: { source: 's', where: [{ path: 'kind', equals: 'k.a' }] },
    map: { v: 'data.v', fixed: { literal: 'L' }, missing: 'data.nope' },
    keep: [{ path: 'v', gte: 2 }],
  });
  const ev = evidenceSet([
    rec('s', 1, 'k.a', { v: 1 }),
    rec('s', 2, 'k.b', { v: 5 }),
    rec('s', 3, 'k.a', { v: 3 }, { trace_id: 't3', fixture_time: T(3), recorded_at: T(4) }),
  ]);
  const out = evaluateProjections([p], ev).get('m.event') ?? [];
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]?.fields, { seq: 3, source: 's', recorded_at: T(4), fixture_time: T(3), trace_id: 't3', v: 3, fixed: 'L', missing: null });
  assert.deepEqual(out[0]?.records, ['s\t3']);
});

test('map: an explicit mapping of a meta field wins', () => {
  const p = projection({ id: 'prj-m', emits: 'm', from: { source: 's' }, map: { seq: 'data.n' } });
  const out = evaluateProjections([p], evidenceSet([rec('s', 1, 'k', { n: 42 })])).get('m') ?? [];
  assert.equal(out[0]?.fields['seq'], 42);
});

const groupDef = (map: Record<string, unknown>, by = 'data.k') => projection({ id: 'prj-g', emits: 'g', group: { source: 's', by }, map: { key: { key: true }, ...map } });

test('group: keys compare by JSON equality; null or missing keys form no group', () => {
  const p = groupDef({ n: { count: true } });
  const ev = evidenceSet([
    rec('s', 1, 'k', { k: { a: 1, b: 2 } }),
    rec('s', 2, 'k', { k: { b: 2, a: 1 } }),
    rec('s', 3, 'k', { k: null }),
    rec('s', 4, 'k', {}),
    rec('s', 5, 'k', { k: '1' }),
    rec('s', 6, 'k', { k: 1 }),
  ]);
  const out = (evaluateProjections([p], ev).get('g') ?? []).map((e) => [e.fields['key'], e.fields['n']]);
  assert.deepEqual(out, [
    ['1', 1],
    [1, 1],
    [{ a: 1, b: 2 }, 2],
  ]);
});

test('group: count_distinct ignores nulls; first/last follow seq; aggregate where', () => {
  const p = groupDef({
    distinct: { count_distinct: 'data.v' },
    first: { first: 'data.v' },
    last: { last: 'data.v' },
    lastBig: { last: 'data.v', where: [{ path: 'data.v', gte: 10 }] },
    total: { sum: 'data.v' },
    lo: { min: 'data.v' },
    hi: { max: 'data.v' },
    big: { any: true, where: [{ path: 'data.v', gte: 10 }] },
    huge: { any: true, where: [{ path: 'data.v', gte: 100 }] },
  });
  const ev = evidenceSet([
    rec('s', 7, 'k', { k: 'a', v: 3 }),
    rec('s', 2, 'k', { k: 'a', v: 10 }),
    rec('s', 5, 'k', { k: 'a', v: null }),
    rec('s', 9, 'k', { k: 'a', v: 3 }),
  ]);
  const [g] = evaluateProjections([p], ev).get('g') ?? [];
  assert.ok(g);
  assert.equal(g.fields['distinct'], 2);
  assert.equal(g.fields['first'], 10);
  assert.equal(g.fields['last'], 3);
  assert.equal(g.fields['lastBig'], 10);
  assert.equal(g.fields['total'], 16);
  assert.equal(g.fields['lo'], 3);
  assert.equal(g.fields['hi'], 10);
  assert.equal(g.fields['big'], true);
  assert.equal(g.fields['huge'], false);
});

test('group: sum_product with a null factor contributes 0 and marks the event partial', () => {
  const p = groupDef({ sp: { sum_product: ['data.q', 'data.p'] } });
  const whole = evaluateProjections([p], evidenceSet([rec('s', 1, 'k', { k: 'a', q: 2, p: 5 }), rec('s', 2, 'k', { k: 'a', q: 1, p: 3 })])).get('g') ?? [];
  assert.equal(whole[0]?.fields['sp'], 13);
  assert.equal(whole[0]?.fields['partial'], undefined);
  const partial = evaluateProjections([p], evidenceSet([rec('s', 1, 'k', { k: 'a', q: 2, p: 5 }), rec('s', 2, 'k', { k: 'a', q: null, p: 3 })])).get('g') ?? [];
  assert.equal(partial[0]?.fields['sp'], 10);
  assert.equal(partial[0]?.fields['partial'], true);
});

test('group: seq and fixture_time are the maxima of the inputs; source is the input source', () => {
  const p = groupDef({ n: { count: true } });
  const ev = evidenceSet([rec('s', 4, 'k', { k: 'a' }, { fixture_time: T(9) }), rec('s', 8, 'k', { k: 'a' }, { fixture_time: T(2) })]);
  const [g] = evaluateProjections([p], ev).get('g') ?? [];
  assert.equal(g?.fields['seq'], 8);
  assert.equal(g?.fields['fixture_time'], T(9));
  assert.equal(g?.fields['source'], 's');
  assert.deepEqual(g?.records, ['s\t4', 's\t8']);
});

const leftP = projection({ id: 'prj-l', emits: 'l', from: { source: 'a' }, map: { k: 'data.k', v: 'data.v' } });
const rightP = projection({ id: 'prj-r', emits: 'r', from: { source: 'b' }, map: { k: 'data.k', w: 'data.w' } });
const joinDef = (type: 'inner' | 'left') =>
  projection({
    id: 'prj-j',
    emits: 'j',
    join: { left: { event: 'l', key: 'k' }, right: { event: 'r', key: 'k' }, type },
    map: { v: '$left.v', w: '$right.w', matched: { exists: 'right' } },
  });

const joinEvidence = evidenceSet([
  rec('a', 1, 'x', { k: 'k1', v: 1 }, { fixture_time: T(1) }),
  rec('a', 2, 'x', { k: 'k2', v: 2 }),
  rec('a', 3, 'x', { k: null, v: 3 }),
  rec('b', 10, 'y', { k: 'k1', w: 'a' }, { fixture_time: T(5) }),
  rec('b', 11, 'y', { k: 'k1', w: 'b' }),
  rec('b', 12, 'y', { k: null, w: 'n' }),
]);

test('join inner: many-to-many emits one event per pair; null keys never match', () => {
  const out = evaluateProjections([leftP, rightP, joinDef('inner')], joinEvidence).get('j') ?? [];
  assert.deepEqual(
    out.map((e) => [e.fields['v'], e.fields['w'], e.fields['matched']]),
    [
      [1, 'a', true],
      [1, 'b', true],
    ],
  );
  assert.equal(out[0]?.fields['seq'], 10);
  assert.equal(out[0]?.fields['source'], 'derived');
  assert.equal(out[0]?.fields['fixture_time'], T(5));
  assert.deepEqual(out[0]?.records, ['a\t1', 'b\t10']);
});

test('join left: unmatched left events carry null right fields', () => {
  const out = evaluateProjections([leftP, rightP, joinDef('left')], joinEvidence).get('j') ?? [];
  assert.deepEqual(
    out.map((e) => [e.fields['v'], e.fields['w'], e.fields['matched']]),
    [
      [1, 'a', true],
      [1, 'b', true],
      [2, null, false],
      [3, null, false],
    ],
  );
  assert.equal(out[2]?.fields['source'], 'a');
});

test('DAG: evaluation follows dependencies; a cycle is reported', () => {
  const seq = projectionSequence([joinDef('inner'), rightP, leftP]);
  assert.ok(seq.ok);
  assert.deepEqual(seq.sequence.map((p) => p.id), ['prj-l', 'prj-r', 'prj-j']);
  const a = projection({ id: 'prj-a', emits: 'ea', from: { event: 'eb' }, map: { x: 'x' } });
  const b = projection({ id: 'prj-b', emits: 'eb', from: { event: 'ea' }, map: { x: 'x' } });
  const cyc = projectionSequence([a, b, leftP]);
  assert.equal(cyc.ok, false);
  if (!cyc.ok) assert.deepEqual(cyc.cycle, ['prj-a', 'prj-b']);
});
