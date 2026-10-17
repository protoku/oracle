import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from '../../src/kernel/evaluate.js';
import type { Definitions } from '../../src/kernel/types.js';
import { evidenceSet, expectation, projection, rec } from '../support/build.js';

const req = (seq: number, method: string, route: string | null, status: number | null, data: Record<string, unknown> = {}) =>
  rec('http', seq, 'http.request', { method, route, status, ...data } as never);

const createP = projection({
  id: 'prj-create',
  emits: 'create',
  from: { source: 'http', where: [{ path: 'data.route', equals: '/things' }] },
  map: { status: 'data.status', n: 'data.n' },
});
const otherP = projection({ id: 'prj-other', emits: 'other', from: { source: 'db' }, map: { x: 'data.x' } });

function defs(status: 'confirmed' | 'candidate' = 'confirmed'): Definitions {
  return {
    sources: ['db', 'http'],
    projections: [createP, otherP],
    expectations: [
      expectation({
        id: 'exp-small',
        kind: 'invariant',
        over: 'create',
        where: [{ path: 'n', lt: 1 }],
        assert: { path: 'status', equals: 422 },
        governance: { status, ...(status === 'confirmed' ? { decision: 'dec-x' } : {}) },
      }),
    ],
  };
}

const evidence = evidenceSet([
  req(1, 'POST', '/things', 422, { n: 0 }),
  req(2, 'POST', '/things', 201, { n: 3 }),
  req(3, 'POST', '/things', 201, { n: 0 }),
  req(4, 'GET', '/things/:id', 200),
  req(5, 'GET', '/things/:id', 200),
  req(6, 'GET', null, 404),
  rec('db', 1, 'db.insert', { x: 1 }),
]);

test('coverage: classes of records and events no instance consulted, sorted, with counts and example seqs', () => {
  const c = evaluate(evidence, defs()).coverage;
  assert.deepEqual(
    c.map((x) => [x.kind, x.class, x.total, x.unexplained, x.example_seqs]),
    [
      ['event', 'create', 3, 1, [2]],
      ['event', 'other', 1, 1, [1]],
      ['http', 'GET /things/:id 200', 2, 2, [4, 5]],
      ['http', 'GET null 404', 1, 1, [6]],
      ['http', 'POST /things 201', 2, 1, [2]],
      ['http', 'POST /things 422', 1, 0, [1]],
    ],
  );
});

test('coverage: a not_applicable instance does not explain its event', () => {
  const c = evaluate(evidence, defs()).coverage.find((x) => x.class === 'POST /things 201');
  // seq 2 has n = 3: the expectation's where fails, so nobody judged it.
  assert.deepEqual(c?.example_seqs, [2]);
});

test('coverage: candidate expectations explain nothing', () => {
  const c = evaluate(evidence, defs('candidate')).coverage.find((x) => x.class === 'POST /things 422');
  assert.equal(c?.unexplained, 1);
});
