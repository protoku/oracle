import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { expectedFor } from '../../src/driver/configuration.js';
import { readEvidence, readRunMeta } from '../../src/driver/runstore.js';
import { evaluate } from '../../src/kernel/evaluate.js';
import { definitionsOf } from '../../src/language/loader.js';
import { validateTarget } from '../../src/language/validate.js';
import { snapshotOf } from '../support/snapshot.js';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURES = join(ROOT, 'test/fixtures/evidence');
const target = validateTarget(join(ROOT, 'corpus/fixture-order-service')).target;
if (!target) throw new Error('corpus does not load');
const definitions = definitionsOf(target);

const runs = readdirSync(FIXTURES)
  .sort()
  .flatMap((xp) => readdirSync(join(FIXTURES, xp)).sort().map((config) => ({ xp, config, dir: join(FIXTURES, xp, config) })));

test('every experiment has a recorded clean run, and every flag block a run under its flag', () => {
  const have = new Set(runs.map((r) => `${r.xp}/${r.config}`));
  for (const { value: xp } of target.experiments) {
    assert.ok(have.has(`${xp.id}/clean`), `${xp.id}/clean`);
    for (const block of Object.keys(xp.expected)) if (block !== 'default') assert.ok(have.has(`${xp.id}/${block}`), `${xp.id}/${block}`);
  }
});

for (const run of runs) {
  test(`replay ${run.xp} under ${run.config}: deterministic and equal to the committed snapshot`, () => {
    const meta = readRunMeta(run.dir);
    assert.equal(meta.configuration.name, run.config);
    const first = evaluate(readEvidence(run.dir), definitions);
    const second = evaluate(readEvidence(run.dir), definitions);
    assert.deepEqual(first, second);
    assert.equal(snapshotOf(first), snapshotOf(second));
    assert.equal(snapshotOf(first), readFileSync(join(run.dir, 'verdicts.snapshot.json'), 'utf8'));
  });

  test(`replay ${run.xp} under ${run.config}: matches the experiment's expected verdicts`, () => {
    const xp = target.experiments.find((x) => x.value.id === run.xp)?.value;
    assert.ok(xp);
    const expected = expectedFor(xp, run.config);
    const actual = Object.fromEntries(evaluate(readEvidence(run.dir), definitions).verdicts.filter((v) => xp.investigates.includes(v.expectation)).map((v) => [v.expectation, v.verdict]));
    assert.deepEqual(actual, expected);
  });
}

// The three cells the brief names as the gate (§1).
const verdictIn = (xp: string, config: string, exp: string) => evaluate(readEvidence(join(FIXTURES, xp, config)), definitions).verdicts.find((v) => v.expectation === exp);

test('gate: the unflagged race violates exclusivity on the clean build', () => {
  assert.equal(verdictIn('xp-refund-vs-job-race', 'clean', 'exp-fulfilled-and-refunded-exclusive')?.verdict, 'violated');
});

test('gate: an unresolved ambiguous outcome leaves the obligation pending', () => {
  assert.equal(verdictIn('xp-ambiguous-charge-unresolved', 'clean', 'exp-no-new-charge-after-ambiguous-outcome')?.verdict, 'pending');
});

test('gate: an emptied ledger makes both ledger-backed expectations inconclusive, naming the stream reset', () => {
  for (const exp of ['exp-charge-at-most-once-per-order', 'exp-failed-attempt-has-no-charge']) {
    const v = verdictIn('xp-ledger-stream-reset', 'clean', exp);
    assert.equal(v?.verdict, 'inconclusive', exp);
    assert.equal(v?.reason, 'stream_reset', exp);
    assert.match(v?.detail ?? '', /provider\.ledger: stream_reset, high_water_mark went 1 → 0/);
  }
});
