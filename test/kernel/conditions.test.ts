import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCondition, type Scopes } from '../../src/kernel/conditions.js';
import type { Json } from '../../src/kernel/types.js';
import { parseCondition, parseConditionList, parseAssert } from '../../src/language/conditions.js';

function cond(raw: unknown) {
  const issues: string[] = [];
  const c = parseCondition(raw, 'c', issues);
  if (!c || issues.length) throw new Error(issues.join('; '));
  return c;
}

// [operator, condition, subject, expected, scopes]
type Row = [string, Record<string, unknown>, Json, boolean, Scopes?];

const rows: Row[] = [
  // equals: JSON equality, null is an ordinary value
  ['equals', { path: 'x', equals: 1 }, { x: 1 }, true],
  ['equals', { path: 'x', equals: 1 }, { x: 2 }, false],
  ['equals', { path: 'x', equals: '1' }, { x: 1 }, false],
  ['equals', { path: 'x', equals: 1 }, {}, false],
  ['equals', { path: 'x', equals: null }, {}, true],
  ['equals', { path: 'x', equals: null }, { x: null }, true],
  ['equals', { path: 'x', equals: null }, { x: 0 }, false],
  ['equals', { path: 'x', equals: [1, { a: 2 }] }, { x: [1, { a: 2 }] }, true],
  ['equals', { path: 'x', equals: { a: 1, b: 2 } }, { x: { b: 2, a: 1 } }, true],
  ['equals', { path: 'x', equals: '$.y' }, { x: 3, y: 3 }, true, { self: { x: 3, y: 3 } }],
  ['equals', { path: 'x', equals: '$trigger.k' }, { x: 'a' }, true, { trigger: { k: 'a' } }],
  ['equals', { path: 'x', equals: '$trigger.k' }, { x: null }, true, { trigger: {} }],
  // not_equals
  ['not_equals', { path: 'x', not_equals: 1 }, { x: 2 }, true],
  ['not_equals', { path: 'x', not_equals: 1 }, { x: 1 }, false],
  ['not_equals', { path: 'x', not_equals: 1 }, {}, true],
  ['not_equals', { path: 'x', not_equals: null }, {}, false],
  ['not_equals', { path: 'x', not_equals: null }, { x: 'a' }, true],
  ['not_equals', { path: 'from', not_equals: '$.to' }, { from: null, to: 'created' }, true, { self: { from: null, to: 'created' } }],
  ['not_equals', { path: 'from', not_equals: '$.to' }, { from: 'paid', to: 'paid' }, false, { self: { from: 'paid', to: 'paid' } }],
  // in / not_in: false when the value is null
  ['in', { path: 'x', in: [1, 2] }, { x: 2 }, true],
  ['in', { path: 'x', in: [1, 2] }, { x: 3 }, false],
  ['in', { path: 'x', in: [1, 2] }, {}, false],
  ['in', { path: 'x', in: [] }, { x: 1 }, false],
  ['in', { path: 'x', in: ['1'] }, { x: 1 }, false],
  ['not_in', { path: 'x', not_in: [1, 2] }, { x: 3 }, true],
  ['not_in', { path: 'x', not_in: [1, 2] }, { x: 1 }, false],
  ['not_in', { path: 'x', not_in: [1, 2] }, {}, false],
  ['not_in', { path: 'x', not_in: [] }, { x: 1 }, true],
  // ordering: numbers or strings of the same type; null and mixed types are false
  ['lt', { path: 'x', lt: 1 }, { x: 0 }, true],
  ['lt', { path: 'x', lt: 1 }, { x: 1 }, false],
  ['lt', { path: 'x', lt: 1 }, {}, false],
  ['lt', { path: 'x', lt: 1 }, { x: '0' }, false],
  ['lt', { path: 'x', lt: 'b' }, { x: 'a' }, true],
  ['lte', { path: 'x', lte: 1 }, { x: 1 }, true],
  ['lte', { path: 'x', lte: 1 }, { x: 2 }, false],
  ['lte', { path: 'x', lte: 1 }, { x: null }, false],
  ['gt', { path: 'x', gt: 1 }, { x: 2 }, true],
  ['gt', { path: 'x', gt: 1 }, { x: 1 }, false],
  ['gt', { path: 'x', gt: 1 }, { x: true }, false],
  ['gte', { path: 'x', gte: 1 }, { x: 1 }, true],
  ['gte', { path: 'x', gte: 1 }, { x: 0 }, false],
  ['gte', { path: 'x', gte: '$.y' }, { x: 3, y: 2 }, true, { self: { x: 3, y: 2 } }],
  ['gte', { path: 'x', gte: '$.y' }, { x: 3 }, false, { self: { x: 3 } }],
  // exists
  ['exists', { path: 'x', exists: true }, { x: 0 }, true],
  ['exists', { path: 'x', exists: true }, { x: false }, true],
  ['exists', { path: 'x', exists: true }, { x: null }, false],
  ['exists', { path: 'x', exists: true }, {}, false],
  ['exists', { path: 'x', exists: false }, {}, true],
  ['exists', { path: 'x', exists: false }, { x: [] }, false],
  // combinators
  ['all_of', { all_of: [{ path: 'a', equals: 1 }, { path: 'b', equals: 2 }] }, { a: 1, b: 2 }, true],
  ['all_of', { all_of: [{ path: 'a', equals: 1 }, { path: 'b', equals: 2 }] }, { a: 1, b: 3 }, false],
  ['all_of', { all_of: [] }, {}, true],
  ['any_of', { any_of: [{ path: 'a', equals: 1 }, { path: 'b', equals: 2 }] }, { a: 0, b: 2 }, true],
  ['any_of', { any_of: [{ path: 'a', equals: 1 }, { path: 'b', equals: 2 }] }, { a: 0, b: 0 }, false],
  ['any_of', { any_of: [] }, {}, false],
  ['not', { not: { path: 'a', equals: 1 } }, { a: 2 }, true],
  ['not', { not: { path: 'a', equals: 1 } }, { a: 1 }, false],
  ['not', { not: { path: 'a', lt: 1 } }, {}, true],
  // arrays: paths relative to the element; false on a non-array or missing value
  ['any', { path: 'lines', any: { path: 'q', lt: 1 } }, { lines: [{ q: 2 }, { q: 0 }] }, true],
  ['any', { path: 'lines', any: { path: 'q', lt: 1 } }, { lines: [{ q: 2 }, { q: 1 }] }, false],
  ['any', { path: 'lines', any: { path: 'q', lt: 1 } }, { lines: [] }, false],
  ['any', { path: 'lines', any: { path: 'q', lt: 1 } }, {}, false],
  ['any', { path: 'lines', any: { path: 'q', lt: 1 } }, { lines: { q: 0 } }, false],
  ['any', { path: 'lines', any: { path: 'q', lt: 1 } }, { lines: [{ q: null }] }, false],
  ['all', { path: 'lines', all: { path: 'q', gte: 1 } }, { lines: [{ q: 2 }, { q: 1 }] }, true],
  ['all', { path: 'lines', all: { path: 'q', gte: 1 } }, { lines: [{ q: 2 }, { q: 0 }] }, false],
  ['all', { path: 'lines', all: { path: 'q', gte: 1 } }, { lines: [] }, true],
  ['all', { path: 'lines', all: { path: 'q', gte: 1 } }, {}, false],
  ['all', { path: 'lines', all: { path: 'q', gte: 1 } }, { lines: 'x' }, false],
  ['any', { path: 'xs', any: { path: 'k', equals: '$.want' } }, { xs: [{ k: 1 }], want: 1 }, true, { self: { xs: [{ k: 1 }], want: 1 } }],
];

for (const [op, raw, subject, expected, scopes] of rows) {
  test(`${op} ${JSON.stringify(raw)} on ${JSON.stringify(subject)} → ${expected}`, () => {
    assert.equal(evaluateCondition(cond(raw), { subject, scopes: scopes ?? { self: subject } }), expected);
  });
}

test('a condition list is an implicit all_of; assert accepts one or a list', () => {
  const issues: string[] = [];
  const list = parseConditionList([{ path: 'a', equals: 1 }, { path: 'b', equals: 2 }], 'w', issues);
  assert.equal(list.length, 2);
  const asserted = parseAssert([{ path: 'a', equals: 1 }, { path: 'b', equals: 2 }], 'assert', issues);
  assert.equal(evaluateCondition(asserted, { subject: { a: 1, b: 2 }, scopes: {} }), true);
  assert.equal(evaluateCondition(asserted, { subject: { a: 1, b: 3 }, scopes: {} }), false);
  assert.deepEqual(issues, []);
});

const invalid: [string, unknown][] = [
  ['misspelled operator', { path: 'x', equal: 1 }],
  ['two operators', { path: 'x', equals: 1, lt: 2 }],
  ['no operator', { path: 'x' }],
  ['sibling of all_of', { all_of: [], path: 'x' }],
  ['unknown combinator', { one_of: [] }],
  ['in without a list', { path: 'x', in: 1 }],
  ['exists not boolean', { path: 'x', exists: 'yes' }],
  ['not an object', 'x == 1'],
];
for (const [name, raw] of invalid) {
  test(`rejects ${name}`, () => {
    const issues: string[] = [];
    parseCondition(raw, 'c', issues);
    assert.ok(issues.length > 0, 'expected a parse issue');
  });
}
