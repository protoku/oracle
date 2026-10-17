import { compareStrings } from './json.js';
import type { ProjectionDef } from './types.js';

export function inputEvents(p: ProjectionDef): string[] {
  if (p.shape === 'join') return [p.left.event, p.right.event];
  return p.input.kind === 'event' ? [p.input.event] : [];
}

export function inputSources(p: ProjectionDef): string[] {
  if (p.shape === 'join') return [];
  return p.input.kind === 'source' ? [p.input.source] : [];
}

export type DagResult = { ok: true; sequence: ProjectionDef[] } | { ok: false; cycle: string[] };

// Kahn's algorithm with ties broken by projection id, so the evaluation
// sequence depends only on the definitions.
export function projectionSequence(projections: ProjectionDef[]): DagResult {
  const byEvent = new Map<string, ProjectionDef>();
  for (const p of projections) byEvent.set(p.emits, p);
  const deps = new Map<string, Set<string>>();
  for (const p of projections) {
    const d = new Set<string>();
    for (const e of inputEvents(p)) {
      const producer = byEvent.get(e);
      if (producer) d.add(producer.id);
    }
    deps.set(p.id, d);
  }
  const done = new Set<string>();
  const sequence: ProjectionDef[] = [];
  const sorted = [...projections].sort((a, b) => compareStrings(a.id, b.id));
  while (sequence.length < sorted.length) {
    const ready = sorted.find((p) => !done.has(p.id) && [...(deps.get(p.id) ?? [])].every((d) => done.has(d)));
    if (!ready) {
      return { ok: false, cycle: sorted.filter((p) => !done.has(p.id)).map((p) => p.id) };
    }
    done.add(ready.id);
    sequence.push(ready);
  }
  return { ok: true, sequence };
}

// Every projection an event name depends on, itself included.
export function lineage(event: string, projections: ProjectionDef[]): ProjectionDef[] {
  const byEvent = new Map<string, ProjectionDef>();
  for (const p of projections) byEvent.set(p.emits, p);
  const seen = new Map<string, ProjectionDef>();
  const visit = (name: string) => {
    const p = byEvent.get(name);
    if (!p || seen.has(p.id)) return;
    seen.set(p.id, p);
    for (const e of inputEvents(p)) visit(e);
  };
  visit(event);
  return [...seen.values()].sort((a, b) => compareStrings(a.id, b.id));
}

// The raw sources an event is ultimately derived from.
export function eventSources(event: string, projections: ProjectionDef[]): string[] {
  const out = new Set<string>();
  for (const p of lineage(event, projections)) for (const s of inputSources(p)) out.add(s);
  return [...out].sort(compareStrings);
}
