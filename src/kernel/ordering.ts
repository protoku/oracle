import { compareStrings, timeValue } from './json.js';
import { eventSeq, eventSource, type KEvent } from './projections.js';

// The v0 cross-source ordering rule (docs/decisions.md, D-007). Spec §11 calls
// it a known weakness; it is kept in this one function so it can be replaced.
//
// Same source: by seq. Different sources: by fixture_time, ties broken by
// recorded_at, then seq. Returns null when the two cannot be ordered because
// either lacks a fixture_time.
export function compareOccurrence(a: KEvent, b: KEvent): number | null {
  if (eventSource(a) === eventSource(b)) return Math.sign(eventSeq(a) - eventSeq(b));
  const fa = timeValue(typeof a.fields['fixture_time'] === 'string' ? a.fields['fixture_time'] : null);
  const fb = timeValue(typeof b.fields['fixture_time'] === 'string' ? b.fields['fixture_time'] : null);
  if (fa === null || fb === null) return null;
  if (fa !== fb) return Math.sign(fa - fb);
  const ra = timeValue(typeof a.fields['recorded_at'] === 'string' ? a.fields['recorded_at'] : null);
  const rb = timeValue(typeof b.fields['recorded_at'] === 'string' ? b.fields['recorded_at'] : null);
  if (ra !== null && rb !== null && ra !== rb) return Math.sign(ra - rb);
  if (eventSeq(a) !== eventSeq(b)) return Math.sign(eventSeq(a) - eventSeq(b));
  return compareStrings(a.id, b.id);
}

export type Placement = 'after' | 'not_after' | 'unknown';

export function placeAfter(candidate: KEvent, reference: KEvent): Placement {
  const c = compareOccurrence(candidate, reference);
  if (c === null) return 'unknown';
  return c > 0 ? 'after' : 'not_after';
}
