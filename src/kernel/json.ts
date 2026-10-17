import type { Json, JsonObject } from './types.js';

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i] as Json));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    return ka.every((k, i) => k === kb[i] && jsonEqual(a[k] as Json, b[k] as Json));
  }
  return false;
}

// Stable serialization with sorted keys: equal JSON values give equal strings.
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as Json)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortedKeys(obj: object): string[] {
  return Object.keys(obj).sort(compareStrings);
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

export function timeValue(ts: string | null): number | null {
  if (ts === null) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

export function maxTime(values: (string | null)[]): string | null {
  let best: string | null = null;
  let bestT = -Infinity;
  for (const v of values) {
    const t = timeValue(v);
    if (t !== null && t > bestT) {
      best = v;
      bestT = t;
    }
  }
  return best;
}
