import type { CoverageClass, Evaluation, EvidenceSet, Horizon, InstanceVerdict, RunError, SourceStatus, Verdict } from '../kernel/types.js';
import type { Experiment } from '../language/schemas.js';

export interface Cell {
  expectation: string;
  expected: Verdict;
  actual: Verdict;
  match: boolean;
  reason: string | null;
  detail: string;
  // For mismatches: the instances that produced the actual verdict.
  instances: InstanceVerdict[];
}

export type CoverageExpectationStatus = 'seen_unexplained' | 'seen_explained' | 'not_seen';

export interface CoverageExpectation {
  class: string;
  status: CoverageExpectationStatus;
  total: number;
  unexplained: number;
}

export interface ExperimentReport {
  experiment: string;
  run_id: string;
  configuration: string;
  run_error: RunError | null;
  horizon: Horizon;
  cells: Cell[];
  mismatches: number;
  coverage_unexplained: CoverageClass[];
  coverage_expected: CoverageExpectation[];
  sources: SourceStatus[];
}

export function buildReport(
  xp: Experiment,
  runId: string,
  configuration: string,
  expected: Record<string, Verdict>,
  evidence: EvidenceSet,
  evaluation: Evaluation,
): ExperimentReport {
  const byId = new Map(evaluation.verdicts.map((v) => [v.expectation, v]));
  const cells: Cell[] = xp.investigates.map((id) => {
    const v = byId.get(id);
    const exp = expected[id] as Verdict;
    if (!v) {
      return { expectation: id, expected: exp, actual: 'inconclusive', match: false, reason: 'not_evaluated', detail: 'expectation was not evaluated', instances: [] };
    }
    const match = v.verdict === exp;
    return {
      expectation: id,
      expected: exp,
      actual: v.verdict,
      match,
      reason: v.reason,
      detail: v.detail,
      instances: match ? [] : v.instances.filter((i) => i.verdict === v.verdict),
    };
  });

  const httpClasses = new Map(evaluation.coverage.filter((c) => c.kind === 'http').map((c) => [c.class, c]));
  const coverageExpected = xp.coverage_expected.map((cls): CoverageExpectation => {
    const c = httpClasses.get(cls);
    if (!c) return { class: cls, status: 'not_seen', total: 0, unexplained: 0 };
    return { class: cls, status: c.unexplained > 0 ? 'seen_unexplained' : 'seen_explained', total: c.total, unexplained: c.unexplained };
  });

  return {
    experiment: xp.id,
    run_id: runId,
    configuration,
    run_error: evidence.run_error,
    horizon: evidence.horizon,
    cells,
    mismatches: cells.filter((c) => !c.match).length,
    coverage_unexplained: evaluation.coverage.filter((c) => c.unexplained > 0),
    coverage_expected: coverageExpected,
    sources: evaluation.sources,
  };
}
