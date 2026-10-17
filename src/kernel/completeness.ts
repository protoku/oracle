import { uniqueSorted } from './json.js';
import type { EvidenceSet, SourceMarks, SourceStatus } from './types.js';

function isMarks(r: unknown): r is SourceMarks {
  return typeof r === 'object' && r !== null && 'high_water_mark' in r;
}

// Spec §1 and §6: a source is complete at the horizon when it is reliable
// (its high_water_mark never decreased between two consecutive samples, the
// horizon read included) and complete_through >= high_water_mark at the
// horizon. Absence of new records is never taken as completeness.
export function sourceStatus(evidence: EvidenceSet, source: string): SourceStatus {
  const ev = evidence.sources[source];
  const base = {
    source,
    high_water_mark: ev?.horizon?.high_water_mark ?? null,
    complete_through: ev?.horizon?.complete_through ?? null,
    regression: null,
  };
  if (!ev || ev.read_error !== null || ev.horizon === null) {
    return { ...base, reliable: false, complete: false, reason: 'read_failed', detail: `${source}: horizon read failed${ev?.read_error ? ` (${ev.read_error})` : ''}` };
  }

  const series: { label: string; marks: SourceMarks }[] = [];
  for (const sample of evidence.samples) {
    const reading = sample.marks[source];
    if (reading === undefined) continue;
    if (!isMarks(reading)) {
      return {
        ...base,
        reliable: false,
        complete: false,
        reason: 'sample_failed',
        detail: `${source}: high_water_mark sample "${sample.label}" failed (${reading.error}); a stream reset cannot be ruled out`,
      };
    }
    series.push({ label: sample.label, marks: reading });
  }
  series.push({ label: 'horizon', marks: ev.horizon });

  for (let i = 1; i < series.length; i++) {
    const before = series[i - 1] as (typeof series)[number];
    const after = series[i] as (typeof series)[number];
    if (after.marks.high_water_mark < before.marks.high_water_mark) {
      const regression = {
        before: { label: before.label, high_water_mark: before.marks.high_water_mark },
        after: { label: after.label, high_water_mark: after.marks.high_water_mark },
      };
      return {
        ...base,
        regression,
        reliable: false,
        complete: false,
        reason: 'stream_reset',
        detail: `${source}: stream_reset, high_water_mark went ${regression.before.high_water_mark} → ${regression.after.high_water_mark} between samples "${regression.before.label}" and "${regression.after.label}"`,
      };
    }
  }

  const { high_water_mark, complete_through } = ev.horizon;
  if (complete_through < high_water_mark) {
    return {
      ...base,
      reliable: true,
      complete: false,
      reason: 'incomplete',
      detail: `${source}: incomplete at the horizon, complete_through ${complete_through} < high_water_mark ${high_water_mark}`,
    };
  }
  return { ...base, reliable: true, complete: true, reason: null, detail: `${source}: complete through ${complete_through}` };
}

export function allSourceStatuses(evidence: EvidenceSet, declared: string[]): SourceStatus[] {
  return uniqueSorted([...declared, ...Object.keys(evidence.sources)]).map((n) => sourceStatus(evidence, n));
}
