import type { EvidenceRecord, Json, JsonObject } from '../kernel/types.js';
import type { EvidenceSourceConfig } from '../language/schemas.js';

export type { EvidenceRecord, EvidenceSet, MarkSample, SampleReading, SourceEvidence, SourceMarks } from '../kernel/types.js';

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// Maps one raw record into the envelope (spec §1). Throws on a record that
// cannot be placed in a source's sequence.
export function toEnvelope(source: string, cfg: EvidenceSourceConfig, raw: unknown): EvidenceRecord {
  if (!isObject(raw)) throw new Error(`${source}: record is not an object`);
  const seq = raw['seq'];
  if (typeof seq !== 'number' || !Number.isInteger(seq)) throw new Error(`${source}: record without an integer seq`);
  const fixtureTime = cfg.fixture_time === 'known' ? strOrNull(raw['fixture_time']) : null;

  if (cfg.shape === 'flat') {
    const env = cfg.envelope;
    if (!env) throw new Error(`${source}: flat source without an envelope block`);
    let kind: string;
    if ('literal' in env.kind) kind = env.kind.literal;
    else {
      const from = raw[env.kind.from];
      if (typeof from !== 'string') throw new Error(`${source}: record seq ${seq} has no string "${env.kind.from}" for its kind`);
      kind = `${env.kind.prefix}${from}`;
    }
    return {
      source,
      seq,
      recorded_at: strOrNull(raw['recorded_at']),
      fixture_time: fixtureTime,
      trace_id: strOrNull(raw['trace_id']),
      ids: {},
      kind,
      data: raw,
    };
  }

  const kind = raw['kind'];
  if (typeof kind !== 'string') throw new Error(`${source}: record seq ${seq} has no kind`);
  return {
    source,
    seq,
    recorded_at: strOrNull(raw['recorded_at']),
    fixture_time: fixtureTime,
    trace_id: strOrNull(raw['trace_id']),
    ids: isObject(raw['ids']) ? raw['ids'] : {},
    kind,
    data: isObject(raw['data']) ? raw['data'] : ({} as Record<string, Json>),
  };
}
