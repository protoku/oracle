import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const SRC = resolve(import.meta.dirname, '../../src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]));
}

// Splits identifiers, strings and comments into lowercase words:
// orderId → order id, ORDER_ID → order id, "order.paid" → order paid.
function words(line: string): string[] {
  return line
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

// The fixture's domain. The runtime must work for any target, so none of it
// may appear under src/ (brief §2). The corpus and test fixtures are exempt.
const DOMAIN = /^(orders?|payments?|charge[sd]?|charging|refund(s|ed|ing)?|fulfil\w*|provider(s)?)$/;

test('no fixture domain words under src/', () => {
  const offenders: string[] = [];
  for (const file of files(SRC)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const hit = words(line).filter((w) => DOMAIN.test(w));
        if (hit.length) offenders.push(`${relative(SRC, file)}:${i + 1}: ${hit.join(', ')}`);
      });
  }
  assert.deepEqual(offenders, []);
});

test('no code evaluation under src/', () => {
  const offenders: string[] = [];
  for (const file of files(SRC)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/\beval\s*\(|\bnew Function\b|\bvm\.|from ['"]node:vm['"]/.test(line)) offenders.push(`${relative(SRC, file)}:${i + 1}`);
      });
  }
  assert.deepEqual(offenders, []);
});
