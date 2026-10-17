// Copies recorded runs from .oracle-data/runs into test/fixtures/evidence and
// writes each one's verdict snapshot. One run per experiment from the clean
// fixture, plus one per experiment that has a flag block, under that flag.
// The latest matching run wins.
//
//   npx tsx scripts/record-fixtures.ts [--runs .oracle-data/runs] [--target corpus/fixture-order-service]
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readEvidence, readRunMeta } from '../src/driver/runstore.js';
import { evaluate } from '../src/kernel/evaluate.js';
import { definitionsOf } from '../src/language/loader.js';
import { validateTarget } from '../src/language/validate.js';
import { snapshotOf } from '../test/support/snapshot.js';

const { values } = parseArgs({ options: { runs: { type: 'string' }, target: { type: 'string' } } });
const root = resolve(import.meta.dirname, '..');
const runsDir = resolve(values.runs ?? join(root, '.oracle-data/runs'));
const targetDir = resolve(values.target ?? join(root, 'corpus/fixture-order-service'));
const outDir = join(root, 'test/fixtures/evidence');

const v = validateTarget(targetDir);
if (!v.target || v.errors.length) throw new Error(v.errors.join('\n'));
const definitions = definitionsOf(v.target);

const wanted = new Set<string>();
for (const { value: xp } of v.target.experiments) {
  wanted.add(`${xp.id}/clean`);
  for (const block of Object.keys(xp.expected)) if (block !== 'default') wanted.add(`${xp.id}/${block}`);
}

const latest = new Map<string, string>();
for (const id of readdirSync(runsDir).sort()) {
  const dir = join(runsDir, id);
  if (!existsSync(join(dir, 'run.json'))) continue;
  const meta = readRunMeta(dir);
  const key = `${meta.experiment}/${meta.configuration.name}`;
  if (wanted.has(key)) latest.set(key, dir);
}

const missing = [...wanted].filter((k) => !latest.has(k)).sort();
if (missing.length) throw new Error(`no recorded run for: ${missing.join(', ')}`);

rmSync(outDir, { recursive: true, force: true });
for (const key of [...wanted].sort()) {
  const src = latest.get(key) as string;
  const dst = join(outDir, key);
  mkdirSync(dst, { recursive: true });
  for (const f of ['run.json', 'evidence.json', 'samples.json', 'evidence']) cpSync(join(src, f), join(dst, f), { recursive: true });
  writeFileSync(join(dst, 'verdicts.snapshot.json'), snapshotOf(evaluate(readEvidence(dst), definitions)));
  console.log(`${key}  ←  ${src}`);
}
