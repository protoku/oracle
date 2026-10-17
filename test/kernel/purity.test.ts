import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const KERNEL = resolve(import.meta.dirname, '../../src/kernel');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
}

const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Ambient capabilities that would make the kernel depend on the world.
const FORBIDDEN = [
  /\bprocess\./,
  /\bDate\.now\b/,
  /\bnew Date\s*\(/,
  /\bMath\.random\b/,
  /\bperformance\./,
  /\bcrypto\./,
  /\bfetch\s*\(/,
  /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/,
  /\beval\s*\(/,
  /\bnew Function\b/,
  /\bglobalThis\b/,
];

test('the kernel imports only other kernel modules', () => {
  const offenders: string[] = [];
  for (const file of files(KERNEL)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
      const inside = spec.startsWith('.') && !relative(KERNEL, resolve(dirname(file), spec)).startsWith('..');
      if (!inside) offenders.push(`${relative(KERNEL, file)}: imports "${spec}"`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the kernel touches no clock, randomness, environment, network or evaluator', () => {
  const offenders: string[] = [];
  for (const file of files(KERNEL)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const re of FORBIDDEN) if (re.test(line)) offenders.push(`${relative(KERNEL, file)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(offenders, []);
});
