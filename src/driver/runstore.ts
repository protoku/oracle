import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deepFreeze } from '../evidence/envelope.js';
import { canonicalJson } from '../kernel/json.js';
import type { EvidenceRecord, EvidenceSet, Evaluation, Json, MarkSample, SourceEvidence } from '../kernel/types.js';
import type { DetectedConfiguration } from './configuration.js';
import type { ExperimentRun } from './runner.js';

// Layout of .oracle-data/runs/<run-id>/:
//   run.json             run id, experiment, configuration, timing, step log
//   evidence.json        per source: start mark, horizon marks, read error; horizon; run error
//   evidence/<src>.jsonl records as collected, one per line
//   samples.json         high_water_mark samples in the sequence taken
//   verdicts.json        kernel output: source statuses and verdicts
//   coverage.json        kernel output: coverage classes
//   report.json/.txt     comparison with the experiment's expected block

export interface RunMeta {
  run_id: string;
  experiment: string;
  configuration: DetectedConfiguration;
  started_at: string;
  finished_at: string;
  steps: ExperimentRun['steps'];
}

function pretty(value: unknown): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(value as Json)), null, 2)}\n`;
}

export function writeEvidence(dir: string, evidence: EvidenceSet): void {
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  const meta: Record<string, Omit<SourceEvidence, 'records'> & { record_count: number }> = {};
  for (const name of Object.keys(evidence.sources).sort()) {
    const s = evidence.sources[name] as SourceEvidence;
    meta[name] = { start_mark: s.start_mark, horizon: s.horizon, read_error: s.read_error, record_count: s.records.length };
    writeFileSync(join(dir, 'evidence', `${name}.jsonl`), s.records.map((r) => canonicalJson(r as unknown as Json)).join('\n') + (s.records.length ? '\n' : ''));
  }
  writeFileSync(join(dir, 'evidence.json'), pretty({ sources: meta, horizon: evidence.horizon, run_error: evidence.run_error }));
  writeFileSync(join(dir, 'samples.json'), pretty(evidence.samples));
}

export function writeRun(dir: string, run: ExperimentRun, evaluation: Evaluation, report: unknown, text: string): void {
  mkdirSync(dir, { recursive: true });
  const meta: RunMeta = {
    run_id: run.run_id,
    experiment: run.experiment,
    configuration: run.configuration,
    started_at: run.started_at,
    finished_at: run.finished_at,
    steps: run.steps,
  };
  writeFileSync(join(dir, 'run.json'), pretty(meta));
  writeEvidence(dir, run.evidence);
  writeEvaluation(dir, evaluation);
  writeFileSync(join(dir, 'report.json'), pretty(report));
  writeFileSync(join(dir, 'report.txt'), text);
}

export function writeEvaluation(dir: string, evaluation: Evaluation): void {
  writeFileSync(join(dir, 'verdicts.json'), pretty({ sources: evaluation.sources, verdicts: evaluation.verdicts }));
  writeFileSync(join(dir, 'coverage.json'), pretty(evaluation.coverage));
}

export function readRunMeta(dir: string): RunMeta {
  return JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunMeta;
}

export function readEvidence(dir: string): EvidenceSet {
  const meta = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')) as {
    sources: Record<string, Omit<SourceEvidence, 'records'>>;
    horizon: EvidenceSet['horizon'];
    run_error: EvidenceSet['run_error'];
  };
  const samples = JSON.parse(readFileSync(join(dir, 'samples.json'), 'utf8')) as MarkSample[];
  const sources: Record<string, SourceEvidence> = {};
  const evDir = join(dir, 'evidence');
  const files = existsSync(evDir) ? readdirSync(evDir).filter((f) => f.endsWith('.jsonl')) : [];
  for (const name of Object.keys(meta.sources).sort()) {
    const s = meta.sources[name] as Omit<SourceEvidence, 'records'>;
    const file = `${name}.jsonl`;
    const lines = files.includes(file) ? readFileSync(join(evDir, file), 'utf8').split('\n').filter((l) => l.length > 0) : [];
    sources[name] = { start_mark: s.start_mark, horizon: s.horizon, read_error: s.read_error, records: lines.map((l) => JSON.parse(l) as EvidenceRecord) };
  }
  return deepFreeze({ sources, samples, horizon: meta.horizon, run_error: meta.run_error });
}
