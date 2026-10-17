import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'oracle-cli-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function oracle(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('validate exits 0 on the corpus', () => {
  const r = oracle('validate', 'corpus/fixture-order-service');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /valid\. 13 projections \(30 examples pass\)/);
});

test('evaluate replays a saved run offline and exits 0 when every cell matches', () => {
  const r = oracle('evaluate', '--target', 'corpus/fixture-order-service', '--evidence', 'test/fixtures/evidence/xp-ledger-stream-reset/clean');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /exp-failed-attempt-has-no-charge\s+expected inconclusive\s+actual inconclusive\s+✓/);
});

test('a mismatch exits 1 and says which cell differed and why', () => {
  // A D2 run judged against the clean expectations.
  const dir = join(scratch, 'd2-as-clean');
  cpSync(join(ROOT, 'test/fixtures/evidence/xp-ambiguous-charge-then-repay/D2_timeout_as_failed'), dir, { recursive: true });
  const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  meta.configuration = { name: 'clean', flags: [], git_sha: null };
  writeFileSync(join(dir, 'run.json'), JSON.stringify(meta));
  const r = oracle('evaluate', '--target', 'corpus/fixture-order-service', '--evidence', dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /exp-charge-at-most-once-per-order\s+expected satisfied\s+actual violated\s+✗/);
  assert.match(r.stdout, /violated: order_id [^:]+: ledger_charge_count 2 \(evidence /);
  assert.match(r.stdout, /^FAIL .* 1 match, 3 mismatch/m);
});

test('an invalid target exits 2 and names the file', () => {
  const dir = join(scratch, 'broken');
  cpSync(join(ROOT, 'corpus/fixture-order-service'), dir, { recursive: true });
  rmSync(join(dir, 'decisions/dec-005.yaml'));
  const r = oracle('check', '--target', dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /expectations\/exp-create-idempotent\.yaml: decision "dec-005" does not exist/);
});
