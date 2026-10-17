import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { runExample } from '../../src/kernel/projections.js';
import { validateTarget } from '../../src/language/validate.js';

const CORPUS = resolve(import.meta.dirname, '../../corpus/fixture-order-service');

test('the corpus validates cleanly', () => {
  const v = validateTarget(CORPUS);
  assert.deepEqual(v.errors, []);
  assert.equal(v.target?.projections.length, 13);
  assert.equal(v.target?.expectations.length, 9);
  assert.equal(v.target?.decisions.length, 9);
  assert.equal(v.target?.experiments.length, 10);
});

const loaded = validateTarget(CORPUS).target;
for (const p of loaded?.projections ?? []) {
  for (const ex of p.value.def.examples) {
    test(`${p.value.def.id} example: ${ex.name}`, () => {
      const r = runExample(p.value.def, ex);
      assert.ok(r.passed, `actual ${JSON.stringify(r.actual)}`);
    });
  }
}

// Mutated copies of the corpus: each must be rejected with a message naming the file.
const scratch = mkdtempSync(join(tmpdir(), 'oracle-corpus-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function mutated(change: (dir: string) => void): string[] {
  const dir = join(scratch, String(++n));
  cpSync(CORPUS, dir, { recursive: true });
  change(dir);
  return validateTarget(dir).errors;
}

function edit(dir: string, file: string, from: string | RegExp, to: string): void {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  const next = text.replace(from, to);
  assert.notEqual(next, text, `mutation did not apply to ${file}`);
  writeFileSync(path, next);
}

function assertNamed(errors: string[], file: string, pattern: RegExp): void {
  assert.ok(
    errors.some((e) => e.includes(file) && pattern.test(e)),
    `expected an error naming ${file} matching ${pattern}; got:\n${errors.join('\n')}`,
  );
}

const mutations: [string, (dir: string) => void, string, RegExp][] = [
  ['missing decision', (d) => unlinkSync(join(d, 'decisions/dec-001.yaml')), 'expectations/exp-order-transitions.yaml', /decision "dec-001" does not exist/],
  [
    'decision pointing at another expectation',
    (d) => edit(d, 'decisions/dec-002.yaml', 'expectation: exp-order-total-equals-lines', 'expectation: exp-order-transitions'),
    'expectations/exp-order-total-equals-lines.yaml',
    /belongs to "exp-order-transitions"/,
  ],
  ['unknown event', (d) => edit(d, 'expectations/exp-order-transitions.yaml', 'over: order.status_changed', 'over: order.status_changd'), 'expectations/exp-order-transitions.yaml', /event "order.status_changd" is not emitted/],
  [
    'a cycle',
    (d) => edit(d, 'projections/prj-charge-call-vs-ledger.yaml', 'left: { event: outbound.charge_call, key: idempotency_key }', 'left: { event: order.ledger_charges, key: idempotency_key }'),
    'projections/prj-charge-call-vs-ledger.yaml',
    /cycle/,
  ],
  ['an id mismatch', (d) => edit(d, 'projections/prj-ledger-charge.yaml', 'id: prj-ledger-charge', 'id: prj-ledger-charges'), 'projections/prj-ledger-charge.yaml', /does not match the file name/],
  ['an unknown key (forbid misspelled)', (d) => edit(d, 'expectations/exp-no-new-charge-after-ambiguous-outcome.yaml', /^forbid:/m, 'forbidd:'), 'expectations/exp-no-new-charge-after-ambiguous-outcome.yaml', /forbidd/],
  ['an unknown condition operator', (d) => edit(d, 'expectations/exp-line-quantity-positive.yaml', '{ path: quantity, gte: 1 }', '{ path: quantity, gt_or_equal: 1 }'), 'expectations/exp-line-quantity-positive.yaml', /unknown operator gt_or_equal/],
  ['an unknown source', (d) => edit(d, 'projections/prj-ledger-charge.yaml', 'source: provider.ledger', 'source: provider.ledgr'), 'projections/prj-ledger-charge.yaml', /source "provider.ledgr" is not declared/],
  ['two producers of one event', (d) => edit(d, 'projections/prj-http-reconcile.yaml', 'emits: http.reconcile', 'emits: http.create_order'), 'projections/prj-http-reconcile.yaml', /emitted by more than one projection/],
  ['an unknown required source', (d) => edit(d, 'expectations/exp-create-idempotent.yaml', 'required: [http]', 'required: [htp]'), 'expectations/exp-create-idempotent.yaml', /"htp" is not declared/],
  ['expected.default missing an investigated expectation', (d) => edit(d, 'experiments/xp-client-total.yaml', /default:\n\s+exp-order-total-equals-lines: satisfied\n/, 'default: {}\n'), 'experiments/xp-client-total.yaml', /does not cover "exp-order-total-equals-lines"/],
  ['a flag block for an unlisted flag', (d) => edit(d, 'experiments/xp-client-total.yaml', 'D6_client_total_trusted:', 'D7_unknown:'), 'experiments/xp-client-total.yaml', /D7_unknown is not a defect flag/],
  ['a flag block naming an uninvestigated expectation', (d) => edit(d, 'experiments/xp-client-total.yaml', 'exp-order-total-equals-lines: violated', 'exp-order-transitions: violated'), 'experiments/xp-client-total.yaml', /does not investigate/],
  ['investigating an unknown expectation', (d) => edit(d, 'experiments/xp-client-total.yaml', 'investigates:\n  - exp-order-total-equals-lines', 'investigates:\n  - exp-order-total-equals-lines\n  - exp-nope'), 'experiments/xp-client-total.yaml', /unknown expectation "exp-nope"/],
  ['a step naming an unknown service', (d) => edit(d, 'experiments/xp-client-total.yaml', 'service: order-service', 'service: orders'), 'experiments/xp-client-total.yaml', /unknown service "orders"/],
  ['a step with an unknown key', (d) => edit(d, 'experiments/xp-client-total.yaml', 'note: under test; clean build stores 1000', 'notes: typo'), 'experiments/xp-client-total.yaml', /notes/],
  ['a failing projection example', (d) => edit(d, 'projections/prj-order-line-inserted.yaml', 'output:\n      - { order_id: o1, line_id: l1', 'output:\n      - { order_id: o2, line_id: l1'), 'projections/prj-order-line-inserted.yaml', /example "a stored line is emitted as is" fails/],
  ['an unknown key in oracle.yaml', (d) => edit(d, 'oracle.yaml', 'language_version: 0', 'language_version: 0\nlanguage: yaml'), 'oracle.yaml', /language/],
];

for (const [name, change, file, pattern] of mutations) {
  test(`rejects ${name}`, () => assertNamed(mutated(change), file, pattern));
}
