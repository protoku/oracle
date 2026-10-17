import type { EvalContext } from '../../src/kernel/expectations.js';
import type { KEvent } from '../../src/kernel/projections.js';
import { recordRef } from '../../src/kernel/projections.js';
import type {
  EvidenceRecord,
  EvidenceSet,
  ExpectationDef,
  JsonObject,
  MarkSample,
  ProjectionDef,
  SourceMarks,
  SourceStatus,
} from '../../src/kernel/types.js';
import { parseExpectation, parseProjection } from '../../src/language/schemas.js';

export function rec(source: string, seq: number, kind: string, data: JsonObject = {}, extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return { source, seq, recorded_at: null, fixture_time: null, trace_id: null, ids: {}, kind, data, ...extra };
}

export function evidenceSet(
  records: EvidenceRecord[],
  opts: { marks?: Record<string, SourceMarks>; samples?: MarkSample[]; sources?: string[]; fixture_time?: string | null } = {},
): EvidenceSet {
  const names = new Set([...(opts.sources ?? []), ...records.map((r) => r.source), ...Object.keys(opts.marks ?? {})]);
  const sources: EvidenceSet['sources'] = {};
  for (const name of [...names].sort()) {
    const own = records.filter((r) => r.source === name);
    const hwm = Math.max(0, ...own.map((r) => r.seq));
    sources[name] = { start_mark: 0, records: own, horizon: opts.marks?.[name] ?? { high_water_mark: hwm, complete_through: hwm }, read_error: null };
  }
  return { sources, samples: opts.samples ?? [], horizon: { reached: true, reason: null, fixture_time: opts.fixture_time ?? null }, run_error: null };
}

const HEADER = {
  version: 1,
  wording: 'test',
  provenance: 'human_authored',
  governance: { status: 'confirmed', decision: 'dec-test' },
  owner: { authority: 'tests', domain: 'tests' },
  applicability: { target: 'test-target' },
};

export function expectation(raw: Record<string, unknown>): ExpectationDef {
  const r = parseExpectation({ ...HEADER, evidence: { required: [], completeness: 'required' }, ...raw });
  if (!r.ok) throw new Error(r.issues.join('\n'));
  return r.value.def;
}

export function projection(raw: Record<string, unknown>): ProjectionDef {
  const r = parseProjection({ version: 1, description: 'test', ...raw });
  if (!r.ok) throw new Error(r.issues.join('\n'));
  return r.value.def;
}

let counter = 0;
export function ev(name: string, source: string, seq: number, fields: JsonObject = {}, fixtureTime: string | null = null): KEvent {
  counter++;
  return {
    name,
    id: `${name}#t${counter}`,
    fields: { seq, source, recorded_at: null, fixture_time: fixtureTime, trace_id: null, ...fields },
    records: [recordRef(source, seq)],
    events: [],
  };
}

export function completeStatus(source: string, hwm = 100): SourceStatus {
  return { source, reliable: true, complete: true, reason: null, high_water_mark: hwm, complete_through: hwm, regression: null, detail: `${source}: complete` };
}

export function incompleteStatus(source: string, hwm = 100, ct = 50): SourceStatus {
  return {
    source,
    reliable: true,
    complete: false,
    reason: 'incomplete',
    high_water_mark: hwm,
    complete_through: ct,
    regression: null,
    detail: `${source}: incomplete at the horizon, complete_through ${ct} < high_water_mark ${hwm}`,
  };
}

export function context(events: KEvent[], opts: { statuses?: SourceStatus[]; projections?: ProjectionDef[]; fixture_time?: string | null } = {}): EvalContext {
  const store = new Map<string, KEvent[]>();
  for (const e of events) store.set(e.name, [...(store.get(e.name) ?? []), e]);
  const statuses = opts.statuses ?? [...new Set(events.map((e) => String(e.fields['source'])))].map((s) => completeStatus(s));
  return {
    definitions: { sources: statuses.map((s) => s.source), projections: opts.projections ?? [], expectations: [] },
    store,
    statuses: new Map(statuses.map((s) => [s.source, s])),
    horizon: { reached: true, reason: null, fixture_time: opts.fixture_time ?? null },
  };
}
