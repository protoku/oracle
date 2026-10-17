import type { Verdict } from '../kernel/types.js';
import type { ExperimentReport } from './experiment.js';

const MAX_INSTANCES = 5;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function renderExperiment(r: ExperimentReport): string {
  const lines: string[] = [`${pad(r.experiment, 34)}   config: ${r.configuration}`];
  if (r.run_error) lines.push(`  run error: step "${r.run_error.step}" failed: ${r.run_error.detail}`);
  else if (!r.horizon.reached) lines.push(`  horizon not reached: ${r.horizon.reason ?? 'unknown'}`);
  for (const s of r.sources) if (!s.complete) lines.push(`  evidence: ${s.detail}`);

  const width = Math.max(...r.cells.map((c) => c.expectation.length));
  for (const c of r.cells) {
    lines.push(
      `  ${pad(c.expectation, width)}   expected ${pad(c.expected, 14)} actual ${pad(c.actual, 14)} ${c.match ? '✓' : '✗'}   ${c.detail}`,
    );
    if (c.match) continue;
    if (c.actual === 'inconclusive') lines.push(`      reason: ${c.reason ?? 'unknown'}; evidence gap: ${c.detail}`);
    for (const i of c.instances.slice(0, MAX_INSTANCES)) {
      const range = Object.entries(i.evidence_range)
        .map(([s, rg]) => `${s} ${rg.from}..${rg.to}`)
        .join(', ');
      lines.push(`      ${i.verdict}: ${i.detail}${i.reason ? ` [${i.reason}]` : ''}${range ? ` (evidence ${range})` : ''}`);
    }
    if (c.instances.length > MAX_INSTANCES) lines.push(`      … ${c.instances.length - MAX_INSTANCES} more`);
  }

  const expected = new Map(r.coverage_expected.map((e) => [e.class, e]));
  const parts: string[] = [];
  for (const c of r.coverage_unexplained) {
    const name = c.kind === 'http' ? c.class : `event ${c.class}`;
    parts.push(`${name} (${c.unexplained}, unexplained${c.kind === 'http' && expected.has(c.class) ? ', expected' : ''})`);
  }
  for (const e of r.coverage_expected) {
    if (e.status === 'seen_explained') parts.push(`${e.class} (${e.total}, explained, expected)`);
    if (e.status === 'not_seen') parts.push(`${e.class} (not seen, expected)`);
  }
  if (parts.length) lines.push(`  coverage: ${parts.join('  ')}`);
  return lines.join('\n');
}

const SHORT: Record<Verdict, string> = { satisfied: 'S', violated: 'V', pending: 'P', inconclusive: 'I', not_applicable: 'N' };

// Expectation × experiment. A cell is the actual verdict; "!" marks a
// mismatch with the expected one.
export function renderMatrix(reports: ExperimentReport[]): string {
  const expectations = [...new Set(reports.flatMap((r) => r.cells.map((c) => c.expectation)))].sort();
  const width = Math.max(10, ...expectations.map((e) => e.length));
  const lines = ['matrix (S satisfied, V violated, P pending, I inconclusive, N not applicable, ! mismatch, · not investigated)'];
  reports.forEach((r, i) => lines.push(`  [${i + 1}] ${r.experiment}`));
  lines.push(`  ${pad('', width)}  ${reports.map((_, i) => pad(String(i + 1), 3)).join('')}`);
  for (const e of expectations) {
    const row = reports.map((r) => {
      const c = r.cells.find((x) => x.expectation === e);
      return pad(c ? `${SHORT[c.actual]}${c.match ? '' : '!'}` : '·', 3);
    });
    lines.push(`  ${pad(e, width)}  ${row.join('')}`);
  }
  return lines.join('\n');
}

export function summaryLine(reports: ExperimentReport[]): string {
  const cells = reports.flatMap((r) => r.cells);
  const mismatched = cells.filter((c) => !c.match).length;
  const errors = reports.filter((r) => r.run_error !== null || !r.horizon.reached).length;
  const configs = [...new Set(reports.map((r) => r.configuration))].join(', ') || 'none';
  const verdict = mismatched === 0 && errors === 0 ? 'PASS' : 'FAIL';
  return `${verdict}  config ${configs}: ${reports.length} experiments, ${cells.length} cells, ${cells.length - mismatched} match, ${mismatched} mismatch, ${errors} run errors`;
}
