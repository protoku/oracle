import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// Opt-in: needs the fixture running (clean) on its default ports.
const enabled = process.env['ORACLE_FIXTURE'] === '1';
const ROOT = resolve(import.meta.dirname, '../..');

test('oracle check against the running clean fixture reproduces the matrix', { skip: !enabled && 'set ORACLE_FIXTURE=1 with the fixture running' }, () => {
  const data = mkdtempSync(join(tmpdir(), 'oracle-it-'));
  try {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'check', '--target', 'corpus/fixture-order-service', '--config', 'clean', '--data', data], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^PASS {2}config clean: 10 experiments, 33 cells, 33 match, 0 mismatch, 0 run errors$/m);
    assert.match(r.stdout, /exp-fulfilled-and-refunded-exclusive\s+expected violated\s+actual violated\s+✓/);
    assert.match(r.stdout, /exp-no-new-charge-after-ambiguous-outcome\s+expected pending\s+actual pending\s+✓/);
    assert.match(r.stdout, /exp-charge-at-most-once-per-order\s+expected inconclusive\s+actual inconclusive\s+✓\s+provider\.ledger: stream_reset/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
