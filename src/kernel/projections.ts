import { evaluateAll } from './conditions.js';
import { projectionSequence } from './dag.js';
import { canonicalJson, compareStrings, isObject, jsonEqual, maxTime, sortedKeys, uniqueSorted } from './json.js';
import { getPath } from './paths.js';
import type {
  Aggregate,
  EvidenceRecord,
  EvidenceSet,
  GroupProjection,
  Json,
  JsonObject,
  JoinProjection,
  MapProjection,
  ProjectionDef,
  ProjectionExample,
} from './types.js';

// An event as the kernel carries it: the typed fields that conditions see,
// plus the evidence it was derived from.
export interface KEvent {
  name: string;
  id: string;
  fields: JsonObject;
  // Supporting raw records, as recordRef strings, sorted.
  records: string[];
  // Supporting upstream events (transitively), as event ids, sorted.
  events: string[];
}

export type EventStore = Map<string, KEvent[]>;

export function recordRef(source: string, seq: number): string {
  return `${source}\t${seq}`;
}

export function parseRecordRef(ref: string): { source: string; seq: number } {
  const i = ref.lastIndexOf('\t');
  return { source: ref.slice(0, i), seq: Number(ref.slice(i + 1)) };
}

export function eventSeq(e: KEvent): number {
  const s = e.fields['seq'];
  return typeof s === 'number' ? s : 0;
}

export function eventSource(e: KEvent): string {
  const s = e.fields['source'];
  return typeof s === 'string' ? s : 'derived';
}

function str(v: Json | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

interface Input {
  fields: JsonObject;
  records: string[];
  events: string[];
}

function recordInput(r: EvidenceRecord): Input {
  return { fields: r as unknown as JsonObject, records: [recordRef(r.source, r.seq)], events: [] };
}

function eventInput(e: KEvent): Input {
  return { fields: e.fields, records: e.records, events: [...e.events, e.id] };
}

function baseFields(i: Input): JsonObject {
  return {
    seq: i.fields['seq'] ?? null,
    source: i.fields['source'] ?? null,
    recorded_at: i.fields['recorded_at'] ?? null,
    fixture_time: i.fields['fixture_time'] ?? null,
    trace_id: i.fields['trace_id'] ?? null,
  };
}

// Meta fields of an event built from several inputs (group members, join sides).
function combinedFields(inputs: Input[]): JsonObject {
  const seqs = inputs.map((i) => i.fields['seq']).filter((s): s is number => typeof s === 'number');
  const sources = uniqueSorted(inputs.map((i) => str(i.fields['source']) ?? 'derived'));
  const traces = uniqueSorted(inputs.map((i) => str(i.fields['trace_id']) ?? ''));
  return {
    seq: seqs.length ? Math.max(...seqs) : null,
    source: sources.length === 1 ? (sources[0] as string) : 'derived',
    recorded_at: maxTime(inputs.map((i) => str(i.fields['recorded_at']))),
    fixture_time: maxTime(inputs.map((i) => str(i.fields['fixture_time']))),
    trace_id: traces.length === 1 && traces[0] !== '' ? (traces[0] as string) : null,
  };
}

function mergeSupport(inputs: Input[]): { records: string[]; events: string[] } {
  return {
    records: uniqueSorted(inputs.flatMap((i) => i.records)),
    events: uniqueSorted(inputs.flatMap((i) => i.events)),
  };
}

function bySeq(a: Input, b: Input): number {
  const sa = typeof a.fields['seq'] === 'number' ? a.fields['seq'] : 0;
  const sb = typeof b.fields['seq'] === 'number' ? b.fields['seq'] : 0;
  if (sa !== sb) return sa - sb;
  return compareStrings(str(a.fields['source']) ?? '', str(b.fields['source']) ?? '');
}

function runMap(p: MapProjection, inputs: Input[]): Omit<KEvent, 'id' | 'name'>[] {
  const out: Omit<KEvent, 'id' | 'name'>[] = [];
  for (const input of inputs) {
    if (!evaluateAll(p.where, { subject: input.fields, scopes: { self: input.fields } })) continue;
    const fields = baseFields(input);
    for (const [name, expr] of p.map) {
      fields[name] = expr.kind === 'literal' ? expr.value : getPath(input.fields, expr.path);
    }
    if (!evaluateAll(p.keep, { subject: fields, scopes: { self: fields } })) continue;
    out.push({ fields, records: input.records, events: input.events });
  }
  return out;
}

function aggregate(agg: Aggregate, key: Json, members: Input[]): { value: Json; partial: boolean } {
  if (agg.op === 'key') return { value: key, partial: false };
  const matching = members.filter((m) => evaluateAll(agg.where, { subject: m.fields, scopes: { self: m.fields } }));
  switch (agg.op) {
    case 'first':
    case 'last': {
      const m = agg.op === 'first' ? matching[0] : matching[matching.length - 1];
      return { value: m ? getPath(m.fields, agg.path) : null, partial: false };
    }
    case 'count':
      return { value: matching.length, partial: false };
    case 'any':
      return { value: matching.length > 0, partial: false };
    case 'count_distinct': {
      const distinct = new Set<string>();
      for (const m of matching) {
        const v = getPath(m.fields, agg.path);
        if (v !== null) distinct.add(canonicalJson(v));
      }
      return { value: distinct.size, partial: false };
    }
    case 'sum':
    case 'min':
    case 'max': {
      const nums: number[] = [];
      let partial = false;
      for (const m of matching) {
        const v = getPath(m.fields, agg.path);
        if (typeof v === 'number') nums.push(v);
        else partial = true;
      }
      if (agg.op === 'sum') return { value: nums.reduce((a, b) => a + b, 0), partial };
      if (nums.length === 0) return { value: null, partial };
      return { value: agg.op === 'min' ? Math.min(...nums) : Math.max(...nums), partial };
    }
    case 'sum_product': {
      let total = 0;
      let partial = false;
      for (const m of matching) {
        const a = getPath(m.fields, agg.paths[0]);
        const b = getPath(m.fields, agg.paths[1]);
        if (typeof a === 'number' && typeof b === 'number') total += a * b;
        else partial = true;
      }
      return { value: total, partial };
    }
  }
}

function runGroup(p: GroupProjection, inputs: Input[]): Omit<KEvent, 'id' | 'name'>[] {
  const groups = new Map<string, { key: Json; members: Input[] }>();
  for (const input of inputs) {
    if (!evaluateAll(p.where, { subject: input.fields, scopes: { self: input.fields } })) continue;
    const key = getPath(input.fields, p.by);
    if (key === null) continue;
    const k = canonicalJson(key);
    const g = groups.get(k);
    if (g) g.members.push(input);
    else groups.set(k, { key, members: [input] });
  }
  const out: Omit<KEvent, 'id' | 'name'>[] = [];
  for (const k of [...groups.keys()].sort(compareStrings)) {
    const g = groups.get(k) as { key: Json; members: Input[] };
    const members = [...g.members].sort(bySeq);
    const fields = combinedFields(members);
    let partial = false;
    for (const [name, agg] of p.map) {
      const r = aggregate(agg, g.key, members);
      fields[name] = r.value;
      partial ||= r.partial;
    }
    if (partial) fields['partial'] = true;
    out.push({ fields, ...mergeSupport(members) });
  }
  return out;
}

function runJoin(p: JoinProjection, left: Input[], right: Input[]): Omit<KEvent, 'id' | 'name'>[] {
  const index = new Map<string, Input[]>();
  for (const r of right) {
    const key = getPath(r.fields, p.right.key);
    if (key === null) continue;
    const k = canonicalJson(key);
    const list = index.get(k);
    if (list) list.push(r);
    else index.set(k, [r]);
  }
  const out: Omit<KEvent, 'id' | 'name'>[] = [];
  const emit = (l: Input, r: Input | null) => {
    const sides = r ? [l, r] : [l];
    const fields = combinedFields(sides);
    for (const [name, expr] of p.map) {
      if (expr.kind === 'exists') fields[name] = r !== null;
      else fields[name] = getPath(expr.side === 'left' ? l.fields : (r?.fields ?? null), expr.path);
    }
    out.push({ fields, ...mergeSupport(sides) });
  };
  for (const l of left) {
    const key = getPath(l.fields, p.left.key);
    const matches = key === null ? [] : (index.get(canonicalJson(key)) ?? []);
    if (matches.length === 0) {
      if (p.type === 'left') emit(l, null);
      continue;
    }
    for (const r of matches) emit(l, r);
  }
  return out;
}

function named(p: ProjectionDef, events: Omit<KEvent, 'id' | 'name'>[]): KEvent[] {
  return events.map((e, i) => ({ name: p.emits, id: `${p.emits}#${i + 1}`, ...e }));
}

function sourceRecords(evidence: EvidenceSet, source: string): EvidenceRecord[] {
  const records = evidence.sources[source]?.records ?? [];
  return [...records].sort((a, b) => a.seq - b.seq);
}

export function runProjection(p: ProjectionDef, records: (source: string) => EvidenceRecord[], store: EventStore): KEvent[] {
  if (p.shape === 'join') {
    const left = (store.get(p.left.event) ?? []).map(eventInput);
    const right = (store.get(p.right.event) ?? []).map(eventInput);
    return named(p, runJoin(p, left, right));
  }
  const inputs = p.input.kind === 'source' ? records(p.input.source).map(recordInput) : (store.get(p.input.event) ?? []).map(eventInput);
  return named(p, p.shape === 'map' ? runMap(p, inputs) : runGroup(p, inputs));
}

// Every projection over the whole evidence set, in DAG sequence.
export function evaluateProjections(projections: ProjectionDef[], evidence: EvidenceSet): EventStore {
  const dag = projectionSequence(projections);
  if (!dag.ok) throw new Error(`projection graph has a cycle: ${dag.cycle.join(', ')}`);
  const store: EventStore = new Map();
  for (const p of dag.sequence) store.set(p.emits, runProjection(p, (s) => sourceRecords(evidence, s), store));
  return store;
}

// ---------------------------------------------------------------------------
// Examples

function exampleRecord(raw: JsonObject, defaultSource: string): EvidenceRecord {
  return {
    source: str(raw['source']) ?? defaultSource,
    seq: typeof raw['seq'] === 'number' ? raw['seq'] : 0,
    recorded_at: str(raw['recorded_at']),
    fixture_time: str(raw['fixture_time']),
    trace_id: str(raw['trace_id']),
    ids: isObject(raw['ids']) ? raw['ids'] : {},
    kind: str(raw['kind']) ?? '',
    data: isObject(raw['data']) ? raw['data'] : {},
  };
}

function exampleEvents(name: string, raw: JsonObject[]): KEvent[] {
  return raw.map((fields, i) => ({ name, id: `${name}#example${i + 1}`, fields, records: [], events: [] }));
}

function matchesListed(expected: JsonObject, actual: JsonObject): boolean {
  return sortedKeys(expected).every((k) => jsonEqual(expected[k] as Json, actual[k] ?? null));
}

// Matches expected outputs to actual events one to one, in any sequence.
function assign(expected: JsonObject[], actual: JsonObject[], used: boolean[] = []): boolean {
  const [first, ...rest] = expected;
  if (!first) return true;
  for (let i = 0; i < actual.length; i++) {
    if (used[i] || !matchesListed(first, actual[i] as JsonObject)) continue;
    used[i] = true;
    if (assign(rest, actual, used)) return true;
    used[i] = false;
  }
  return false;
}

export interface ExampleResult {
  projection: string;
  example: string;
  passed: boolean;
  actual: JsonObject[];
}

export function runExample(p: ProjectionDef, example: ProjectionExample): ExampleResult {
  const store: EventStore = new Map();
  let records: EvidenceRecord[] = [];
  const input = example.input;
  if (p.shape === 'join') {
    const keyed = Array.isArray(input) ? {} : input;
    for (const name of [p.left.event, p.right.event]) store.set(name, exampleEvents(name, keyed[name] ?? []));
  } else {
    const list = Array.isArray(input) ? input : [];
    if (p.input.kind === 'source') {
      const source = p.input.source;
      records = list.map((r) => exampleRecord(r, source));
    } else {
      store.set(p.input.event, exampleEvents(p.input.event, list));
    }
  }
  const events = runProjection(p, () => [...records].sort((a, b) => a.seq - b.seq), store);
  const actual = events.map((e) => e.fields);
  const passed = actual.length === example.output.length && assign(example.output, actual);
  return { projection: p.id, example: example.name, passed, actual };
}

export function runAllExamples(projections: ProjectionDef[]): ExampleResult[] {
  return [...projections]
    .sort((a, b) => compareStrings(a.id, b.id))
    .flatMap((p) => p.examples.map((ex) => runExample(p, ex)));
}
