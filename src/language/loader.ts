import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Definitions } from '../kernel/types.js';
import {
  parseDecision,
  parseExpectation,
  parseExperiment,
  parseOracleConfig,
  parseProjection,
  type Decision,
  type Experiment,
  type LoadedExpectation,
  type LoadedProjection,
  type OracleConfig,
  type Parsed,
} from './schemas.js';

export interface Located<T> {
  file: string;
  value: T;
}

export interface LoadedTarget {
  dir: string;
  config: OracleConfig;
  projections: Located<LoadedProjection>[];
  expectations: Located<LoadedExpectation>[];
  decisions: Located<Decision>[];
  experiments: Located<Experiment>[];
}

export interface LoadResult {
  target: LoadedTarget | null;
  errors: string[];
}

function readYaml(dir: string, file: string, errors: string[]): unknown {
  try {
    return parseYaml(readFileSync(join(dir, file), 'utf8'), { uniqueKeys: true });
  } catch (e) {
    errors.push(`${file}: ${(e as Error).message.split('\n')[0]}`);
    return undefined;
  }
}

function loadOne<T>(dir: string, file: string, parse: (raw: unknown) => Parsed<T>, errors: string[]): Located<T> | null {
  const raw = readYaml(dir, file, errors);
  if (raw === undefined) return null;
  const r = parse(raw);
  if (!r.ok) {
    errors.push(...r.issues.map((i) => `${file}: ${i}`));
    return null;
  }
  return { file, value: r.value };
}

function loadDir<T>(
  dir: string,
  sub: string,
  parse: (raw: unknown) => Parsed<T>,
  idOf: (v: T) => string,
  errors: string[],
): Located<T>[] {
  const full = join(dir, sub);
  if (!existsSync(full)) return [];
  const files = readdirSync(full)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();
  const out: Located<T>[] = [];
  for (const f of files) {
    const loaded = loadOne(dir, `${sub}/${f}`, parse, errors);
    if (!loaded) continue;
    const id = idOf(loaded.value);
    const stem = basename(f).replace(/\.ya?ml$/, '');
    if (id !== stem) {
      errors.push(`${loaded.file}: id "${id}" does not match the file name "${stem}"`);
      continue;
    }
    out.push(loaded);
  }
  return out;
}

// Structural loading only: schemas, unknown keys, id = file name.
// Cross-references are checked by validate().
export function loadTarget(dir: string): LoadResult {
  const errors: string[] = [];
  if (!existsSync(join(dir, 'oracle.yaml'))) return { target: null, errors: [`oracle.yaml: not found in ${dir}`] };
  const config = loadOne(dir, 'oracle.yaml', parseOracleConfig, errors);
  if (existsSync(join(dir, 'vocabulary.yaml'))) readYaml(dir, 'vocabulary.yaml', errors);
  const projections = loadDir(dir, 'projections', parseProjection, (p) => p.def.id, errors);
  const expectations = loadDir(dir, 'expectations', parseExpectation, (e) => e.def.id, errors);
  const decisions = loadDir(dir, 'decisions', parseDecision, (d) => d.id, errors);
  const experiments = loadDir(dir, 'experiments', parseExperiment, (x) => x.id, errors);
  if (!config) return { target: null, errors };
  return { target: { dir, config: config.value, projections, expectations, decisions, experiments }, errors };
}

export function definitionsOf(target: LoadedTarget): Definitions {
  return {
    sources: Object.keys(target.config.evidence.sources).sort(),
    projections: target.projections.map((p) => p.value.def),
    expectations: target.expectations.map((e) => e.value.def),
  };
}
