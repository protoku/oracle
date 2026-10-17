import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPath } from '../../src/kernel/paths.js';
import type { Json } from '../../src/kernel/types.js';

const doc: Json = { a: { b: { c: 1, n: null, f: false, z: 0 }, list: [{ q: 2 }, 'x'] }, 'idempotency-key': 'k1', top: 'v' };

const rows: [string, Json][] = [
  ['top', 'v'],
  ['a.b.c', 1],
  ['a.b.n', null],
  ['a.b.f', false],
  ['a.b.z', 0],
  ['a.b', { c: 1, n: null, f: false, z: 0 }],
  ['a.missing', null],
  ['a.b.c.deeper', null],
  ['a.b.n.deeper', null],
  ['a.list.0.q', 2],
  ['a.list.1', 'x'],
  ['a.list.5', null],
  ['a.list.q', null],
  ['idempotency-key', 'k1'],
  ['nope.nope', null],
];

for (const [path, expected] of rows) {
  test(`getPath ${path}`, () => assert.deepEqual(getPath(doc, path), expected));
}

test('getPath on null and undefined roots', () => {
  assert.equal(getPath(null, 'a'), null);
  assert.equal(getPath(undefined, 'a'), null);
});
