#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { commitMismatch, ConfigurationError, detectConfiguration, expectedFor } from '../driver/configuration.js';
import { defaultDeps, runExperiment } from '../driver/runner.js';
import { readEvidence, readRunMeta, writeRun } from '../driver/runstore.js';
import { evaluate } from '../kernel/evaluate.js';
import { definitionsOf } from '../language/loader.js';
import { validateTarget } from '../language/validate.js';
import { buildReport, type ExperimentReport } from '../report/experiment.js';
import { renderExperiment, renderMatrix, summaryLine } from '../report/text.js';

const USAGE = `usage:
  oracle validate <target> | --target <dir>
  oracle check --target <dir> [--experiment <id>]... [--config <name>] [--data <dir>]
  oracle evaluate --target <dir> --evidence <run-dir>

exit codes: 0 all cells match, 1 a mismatch or run error, 2 invalid target or usage`;

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function loadValid(dir: string) {
  const v = validateTarget(dir);
  if (v.errors.length > 0 || !v.target) {
    fail(`${dir}: invalid target\n${v.errors.map((e) => `  ${e}`).join('\n')}`);
  }
  return v;
}

function cmdValidate(dir: string): number {
  const v = loadValid(dir);
  const t = v.target as NonNullable<typeof v.target>;
  process.stdout.write(
    `${dir}: valid. ${t.projections.length} projections (${v.examples.passed} examples pass), ${t.expectations.length} expectations, ` +
      `${t.decisions.length} decisions, ${t.experiments.length} experiments\n`,
  );
  return 0;
}

async function cmdCheck(dir: string, only: string[], assertConfig: string | undefined, dataDir: string): Promise<number> {
  const v = loadValid(dir);
  const target = v.target as NonNullable<typeof v.target>;
  const definitions = definitionsOf(target);
  const known = new Set(target.experiments.map((x) => x.value.id));
  for (const id of only) if (!known.has(id)) fail(`unknown experiment ${id}`);
  const experiments = target.experiments.map((x) => x.value).filter((x) => only.length === 0 || only.includes(x.id));

  const reports: ExperimentReport[] = [];
  let warned = false;
  for (const xp of experiments) {
    let configuration;
    try {
      configuration = await detectConfiguration(defaultDeps.fetch, target.config);
    } catch (e) {
      if (e instanceof ConfigurationError) fail(`${xp.id}: ${e.message}`, 1);
      throw e;
    }
    if (assertConfig !== undefined && configuration.name !== assertConfig) {
      fail(`${xp.id}: --config ${assertConfig} given, but the target reports ${configuration.name}`, 1);
    }
    const mismatch = commitMismatch(configuration, target.config);
    if (mismatch && !warned) {
      process.stderr.write(`warning: ${mismatch}\n`);
      warned = true;
    }

    const run = await runExperiment(target.config, xp, configuration);
    const evaluation = evaluate(run.evidence, definitions);
    const report = buildReport(xp, run.run_id, configuration.name, expectedFor(xp, configuration.name), run.evidence, evaluation);
    const text = renderExperiment(report);
    writeRun(join(dataDir, 'runs', run.run_id), run, evaluation, report, `${text}\n`);
    process.stdout.write(`${text}\n\n`);
    reports.push(report);
  }

  const matrix = renderMatrix(reports);
  const summary = summaryLine(reports);
  process.stdout.write(`${matrix}\n\n${summary}\n`);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'last-check.json'), `${JSON.stringify({ summary, reports: reports.map((r) => ({ experiment: r.experiment, run_id: r.run_id, configuration: r.configuration, mismatches: r.mismatches, run_error: r.run_error })) }, null, 2)}\n`);
  return reports.every((r) => r.mismatches === 0 && r.run_error === null && r.horizon.reached) ? 0 : 1;
}

function cmdEvaluate(dir: string, runDir: string): number {
  const v = loadValid(dir);
  const target = v.target as NonNullable<typeof v.target>;
  const meta = readRunMeta(runDir);
  const xp = target.experiments.find((x) => x.value.id === meta.experiment)?.value;
  if (!xp) fail(`${runDir}: experiment ${meta.experiment} is not in ${dir}`);
  const evidence = readEvidence(runDir);
  const evaluation = evaluate(evidence, definitionsOf(target));
  const report = buildReport(xp, meta.run_id, meta.configuration.name, expectedFor(xp, meta.configuration.name), evidence, evaluation);
  process.stdout.write(`${renderExperiment(report)}\n\n${summaryLine([report])}\n`);
  return report.mismatches === 0 && report.run_error === null && report.horizon.reached ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      target: { type: 'string' },
      experiment: { type: 'string', multiple: true },
      config: { type: 'string' },
      data: { type: 'string' },
      evidence: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, positionalTarget] = positionals;
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 2;
  }
  const targetArg = values.target ?? positionalTarget;
  if (!targetArg) fail(`${command}: a target directory is required\n${USAGE}`);
  const dir = resolve(targetArg);
  switch (command) {
    case 'validate':
      return cmdValidate(dir);
    case 'check':
      return cmdCheck(dir, values.experiment ?? [], values.config, resolve(values.data ?? '.oracle-data'));
    case 'evaluate':
      if (!values.evidence) fail(`evaluate: --evidence <run-dir> is required\n${USAGE}`);
      return cmdEvaluate(dir, resolve(values.evidence));
    default:
      fail(`unknown command ${command}\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)),
);
