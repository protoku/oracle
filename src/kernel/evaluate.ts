import { allSourceStatuses } from './completeness.js';
import { computeCoverage } from './coverage.js';
import { evaluateExpectation, unjudged } from './expectations.js';
import { compareStrings } from './json.js';
import { evaluateProjections } from './projections.js';
import type { Definitions, Evaluation, EvidenceSet } from './types.js';

// The kernel's entry point: evidence and definitions in, verdicts and
// coverage out, as plain data. Same input, same output.
export function evaluate(evidence: EvidenceSet, definitions: Definitions): Evaluation {
  const expectations = [...definitions.expectations].sort((a, b) => compareStrings(a.id, b.id));

  if (evidence.run_error !== null) {
    const e = evidence.run_error;
    const detail = `step "${e.step}" failed: ${e.detail}`;
    return { sources: [], verdicts: expectations.map((d) => unjudged(d, e.reason, detail)), coverage: [] };
  }
  if (!evidence.horizon.reached) {
    const detail = `horizon not reached${evidence.horizon.reason ? `: ${evidence.horizon.reason}` : ''}`;
    return { sources: [], verdicts: expectations.map((d) => unjudged(d, 'horizon_not_reached', detail)), coverage: [] };
  }

  const statuses = allSourceStatuses(evidence, definitions.sources);
  const store = evaluateProjections(definitions.projections, evidence);
  const ctx = { definitions, store, statuses: new Map(statuses.map((s) => [s.source, s])), horizon: evidence.horizon };

  const consulted = { events: new Set<string>(), records: new Set<string>() };
  const verdicts = expectations.map((def) => {
    const r = evaluateExpectation(def, ctx);
    // Only confirmed expectations explain behavior (docs/decisions.md).
    if (def.status === 'confirmed') {
      for (const e of r.consulted.events) consulted.events.add(e);
      for (const ref of r.consulted.records) consulted.records.add(ref);
    }
    return r.verdict;
  });

  return { sources: statuses, verdicts, coverage: computeCoverage(evidence, store, consulted) };
}
