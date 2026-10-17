import { compareStrings, isObject } from './json.js';
import { eventSeq, recordRef, type EventStore } from './projections.js';
import type { CoverageClass, EvidenceSet, Json } from './types.js';

export const HTTP_REQUEST_KIND = 'http.request';

function show(v: Json | undefined): string {
  return v === undefined || v === null ? 'null' : typeof v === 'string' ? v : JSON.stringify(v);
}

// Spec §7: events of any projection, and raw http.request records grouped by
// (method, route, status), that no expectation consulted.
export function computeCoverage(
  evidence: EvidenceSet,
  store: EventStore,
  consulted: { events: Set<string>; records: Set<string> },
): CoverageClass[] {
  const classes = new Map<string, CoverageClass & { seen: number[]; missed: number[] }>();
  const add = (kind: CoverageClass['kind'], name: string, seq: number, explained: boolean) => {
    const key = `${kind}\n${name}`;
    let c = classes.get(key);
    if (!c) {
      c = { kind, class: name, total: 0, unexplained: 0, example_seqs: [], seen: [], missed: [] };
      classes.set(key, c);
    }
    c.total++;
    c.seen.push(seq);
    if (!explained) {
      c.unexplained++;
      c.missed.push(seq);
    }
  };

  for (const name of [...store.keys()].sort(compareStrings)) {
    for (const e of store.get(name) ?? []) add('event', name, eventSeq(e), consulted.events.has(e.id));
  }
  for (const source of Object.keys(evidence.sources).sort(compareStrings)) {
    for (const r of evidence.sources[source]?.records ?? []) {
      if (r.kind !== HTTP_REQUEST_KIND) continue;
      const d = isObject(r.data) ? r.data : {};
      add('http', `${show(d['method'])} ${show(d['route'])} ${show(d['status'])}`, r.seq, consulted.records.has(recordRef(r.source, r.seq)));
    }
  }

  return [...classes.keys()]
    .sort(compareStrings)
    .map((k) => {
      const { seen, missed, ...c } = classes.get(k) as CoverageClass & { seen: number[]; missed: number[] };
      const examples = (missed.length ? missed : seen).sort((a, b) => a - b).slice(0, 3);
      return { ...c, example_seqs: examples };
    });
}
