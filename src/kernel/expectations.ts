import { conditionPaths, evaluateAll, evaluateCondition, resolveValue } from './conditions.js';
import { eventSources, lineage } from './dag.js';
import { canonicalJson, jsonEqual, timeValue, uniqueSorted } from './json.js';
import { compareOccurrence, placeAfter } from './ordering.js';
import { getPath } from './paths.js';
import { eventSeq, eventSource, parseRecordRef, type EventStore, type KEvent } from './projections.js';
import type {
  Definitions,
  ExpectationDef,
  ExpectationVerdict,
  Horizon,
  InstanceVerdict,
  InvariantDef,
  Json,
  ObligationDef,
  SeqRange,
  SourceStatus,
  TransitionDef,
  Verdict,
} from './types.js';

export interface EvalContext {
  definitions: Definitions;
  store: EventStore;
  statuses: Map<string, SourceStatus>;
  horizon: Horizon;
}

// An instance before evidence-contract checks, with what it consulted.
interface RawInstance {
  primary: KEvent;
  entity: { field: string; value: Json } | null;
  verdict: Verdict;
  reason: string | null;
  detail: string;
  supporting: KEvent[];
}

export interface EvaluatedExpectation {
  verdict: ExpectationVerdict;
  // Event ids and record refs that contributed to an applicable instance.
  consulted: { events: Set<string>; records: Set<string> };
}

const SEVERITY: Verdict[] = ['not_applicable', 'satisfied', 'pending', 'inconclusive', 'violated'];

export function rollUp(verdicts: Verdict[]): Verdict {
  let worst: Verdict = 'not_applicable';
  for (const v of verdicts) if (SEVERITY.indexOf(v) > SEVERITY.indexOf(worst)) worst = v;
  return worst;
}

function show(value: Json): string {
  return typeof value === 'string' ? value : canonicalJson(value);
}

function at(e: KEvent): string {
  return `${eventSource(e)} seq ${eventSeq(e)}`;
}

function entityOf(e: KEvent, field: string | null): { field: string; value: Json } | null {
  return field === null ? null : { field, value: getPath(e.fields, field) };
}

function entityPrefix(entity: { field: string; value: Json } | null): string {
  return entity ? `${entity.field} ${show(entity.value)}: ` : '';
}

function events(ctx: EvalContext, name: string): KEvent[] {
  return ctx.store.get(name) ?? [];
}

// ---------------------------------------------------------------------------
// transition (spec §4.1)

function evaluateTransition(def: TransitionDef, ctx: EvalContext): RawInstance[] {
  return events(ctx, def.over).map((e) => {
    const from = getPath(e.fields, 'from');
    const to = getPath(e.fields, 'to');
    const allowed = def.allowed.some((a) => jsonEqual(a.from, from) && jsonEqual(a.to, to));
    const entity = entityOf(e, def.entity);
    return {
      primary: e,
      entity,
      verdict: allowed ? 'satisfied' : 'violated',
      reason: null,
      detail: `${entityPrefix(entity)}${show(from)} → ${show(to)}${allowed ? '' : ' (not allowed)'}`,
      supporting: [e],
    };
  });
}

// ---------------------------------------------------------------------------
// invariant (spec §4.2)

function evaluateInvariant(def: InvariantDef, ctx: EvalContext): RawInstance[] {
  const shownPaths = uniqueSorted(conditionPaths(def.assert));
  return events(ctx, def.over).map((e) => {
    const scopes = { self: e.fields };
    const entity = entityOf(e, def.entity);
    if (!evaluateAll(def.where, { subject: e.fields, scopes })) {
      return { primary: e, entity, verdict: 'not_applicable', reason: null, detail: `${entityPrefix(entity)}where does not hold`, supporting: [e] };
    }
    const holds = evaluateCondition(def.assert, { subject: e.fields, scopes });
    const values = shownPaths.map((p) => `${p} ${show(getPath(e.fields, p))}`).join(', ');
    return { primary: e, entity, verdict: holds ? 'satisfied' : 'violated', reason: null, detail: `${entityPrefix(entity)}${values}`, supporting: [e] };
  });
}

// ---------------------------------------------------------------------------
// obligation (spec §4.3)

function compareCount(op: 'equals' | 'gte' | 'lte', count: number, target: number): boolean {
  return op === 'equals' ? count === target : op === 'gte' ? count >= target : count <= target;
}

function evaluateObligation(def: ObligationDef, ctx: EvalContext): RawInstance[] {
  const clause = def.clause;
  const triggers = events(ctx, def.when.event).filter((t) =>
    evaluateAll(def.when.where, { subject: t.fields, scopes: { self: t.fields, trigger: t.fields } }),
  );
  const entityField = def.correlate_by[0]?.[0] ?? null;

  return triggers.map((t): RawInstance => {
    const scopes = { trigger: t.fields };
    const entity = entityField === null ? null : { field: entityField, value: getPath(t.fields, entityField) };
    const base = { primary: t, entity };
    const uncertain: KEvent[] = [];

    // Window boundary.
    let closed: boolean;
    let closing: KEvent | null = null;
    let windowEnd: number | null = null;
    if (def.window.kind === 'until') {
      const window = def.window;
      for (const e of events(ctx, window.event)) {
        if (!evaluateAll(window.where, { subject: e.fields, scopes: { self: e.fields, trigger: t.fields } })) continue;
        const placed = placeAfter(e, t);
        if (placed === 'unknown') uncertain.push(e);
        if (placed !== 'after') continue;
        if (closing === null) closing = e;
        else {
          const c = compareOccurrence(e, closing);
          if (c === null) uncertain.push(e);
          else if (c < 0) closing = e;
        }
      }
      closed = closing !== null;
    } else if (def.window.kind === 'within') {
      const start = timeValue(typeof t.fields['fixture_time'] === 'string' ? t.fields['fixture_time'] : null);
      if (start === null) {
        return {
          ...base,
          verdict: 'inconclusive',
          reason: 'window_unbounded',
          detail: `${entityPrefix(entity)}trigger at ${at(t)} has no fixture_time, so "within ${def.window.raw}" cannot be bounded`,
          supporting: [t],
        };
      }
      windowEnd = start + def.window.ms;
      const now = timeValue(ctx.horizon.fixture_time);
      closed = now !== null && now >= windowEnd;
    } else {
      closed = true;
    }

    // Candidates after the trigger, correlated, inside the window.
    const inWindow: KEvent[] = [];
    for (const c of events(ctx, clause.event)) {
      if (c.id === t.id) continue;
      const correlated = def.correlate_by.every(([field, expr]) => {
        const expected = resolveValue(expr, scopes);
        return expected !== null && jsonEqual(getPath(c.fields, field), expected);
      });
      if (!correlated) continue;
      if (!evaluateAll(clause.where, { subject: c.fields, scopes: { self: c.fields, trigger: t.fields } })) continue;
      const placed = placeAfter(c, t);
      if (placed === 'unknown') {
        uncertain.push(c);
        continue;
      }
      if (placed === 'not_after') continue;
      if (closing !== null) {
        const before = compareOccurrence(c, closing);
        if (before === null) uncertain.push(c);
        else if (before < 0) inWindow.push(c);
      } else if (windowEnd !== null) {
        const ct = timeValue(typeof c.fields['fixture_time'] === 'string' ? c.fields['fixture_time'] : null);
        if (ct === null) uncertain.push(c);
        else if (ct <= windowEnd) inWindow.push(c);
      } else {
        inWindow.push(c);
      }
    }

    const supporting = [t, ...inWindow, ...(closing ? [closing] : [])];
    const windowText = closing ? `window closed by ${at(closing)}` : closed ? 'window closed' : 'window open';
    const eventsText = (label: string) => (inWindow.length ? `${inWindow.length} ${label} (${inWindow.map(at).join(', ')})` : `no ${label}`);

    if (uncertain.length > 0) {
      return {
        ...base,
        verdict: 'inconclusive',
        reason: 'ordering_unknown',
        detail: `${entityPrefix(entity)}trigger ${at(t)}; cannot place ${uncertain.map(at).join(', ')} relative to it without fixture_time`,
        supporting: [...supporting, ...uncertain],
      };
    }

    if (clause.mode === 'forbid') {
      const verdict: Verdict = inWindow.length > 0 ? 'violated' : closed ? 'satisfied' : 'pending';
      return { ...base, verdict, reason: null, detail: `${entityPrefix(entity)}trigger ${at(t)}, ${eventsText('forbidden event')}, ${windowText}`, supporting };
    }

    const cmp = clause.comparator ?? { op: 'gte' as const, value: 1 };
    const countDistinct = clause.count_distinct;
    const count =
      countDistinct === null
        ? inWindow.length
        : new Set(inWindow.map((c) => getPath(c.fields, countDistinct)).filter((v) => v !== null).map(canonicalJson)).size;
    const countText = countDistinct === null ? `${count} required event(s)` : `count_distinct ${countDistinct} ${count}`;
    const detail = `${entityPrefix(entity)}trigger ${at(t)}, ${countText} (needs ${cmp.op} ${cmp.value}), ${windowText}`;
    const overflow = (cmp.op === 'equals' || cmp.op === 'lte') && count > cmp.value;
    if (overflow) return { ...base, verdict: 'violated', reason: null, detail, supporting };
    if (compareCount(cmp.op, count, cmp.value)) return { ...base, verdict: 'satisfied', reason: null, detail, supporting };
    if (!closed) return { ...base, verdict: 'pending', reason: null, detail, supporting };
    if (def.evidence.completeness === 'required') {
      const gaps = eventSources(clause.event, ctx.definitions.projections)
        .map((s) => ctx.statuses.get(s))
        .filter((s): s is SourceStatus => s !== undefined && !s.complete);
      if (gaps.length > 0) {
        return {
          ...base,
          verdict: 'inconclusive',
          reason: 'incomplete_through_window_end',
          detail: `${detail}; cannot rule out the required event: ${gaps.map((g) => g.detail).join('; ')}`,
          supporting,
        };
      }
    }
    return { ...base, verdict: 'violated', reason: null, detail, supporting };
  });
}

// ---------------------------------------------------------------------------
// Evidence contracts (spec §6) and roll-up (spec §5)

function rangeOf(supporting: KEvent[]): { refs: string[]; range: Record<string, SeqRange> } {
  const refs = uniqueSorted(supporting.flatMap((e) => e.records));
  const range: Record<string, SeqRange> = {};
  for (const ref of refs) {
    const { source, seq } = parseRecordRef(ref);
    const r = range[source];
    if (!r) range[source] = { from: seq, to: seq };
    else {
      r.from = Math.min(r.from, seq);
      r.to = Math.max(r.to, seq);
    }
  }
  return { refs, range };
}

function referencedEvents(def: ExpectationDef): string[] {
  switch (def.kind) {
    case 'transition':
    case 'invariant':
      return [def.over];
    case 'obligation':
      return [def.when.event, def.clause.event, ...(def.window.kind === 'until' ? [def.window.event] : [])];
  }
}

function summarize(def: ExpectationDef, instances: InstanceVerdict[], verdict: Verdict): string {
  if (instances.length === 0) return 'no instances';
  if (verdict === 'not_applicable') return `${instances.length} instance${instances.length === 1 ? '' : 's'}, none applicable`;
  const of = (v: Verdict) => instances.filter((i) => i.verdict === v);
  const worst = of(verdict);
  const first = worst[0];
  if (verdict !== 'satisfied' && first) {
    return `${first.detail}${worst.length > 1 ? ` (+${worst.length - 1} more ${verdict})` : ''}`;
  }
  const noun = def.kind === 'transition' ? 'transition' : def.kind === 'obligation' ? 'trigger' : 'instance';
  const applicable = instances.length - of('not_applicable').length;
  return `${applicable} ${noun}${applicable === 1 ? '' : 's'} ${verdict}`;
}

export function evaluateExpectation(def: ExpectationDef, ctx: EvalContext): EvaluatedExpectation {
  const raw =
    def.kind === 'transition' ? evaluateTransition(def, ctx) : def.kind === 'invariant' ? evaluateInvariant(def, ctx) : evaluateObligation(def, ctx);

  const required = def.evidence.completeness === 'required';
  const gaps = required
    ? uniqueSorted(def.evidence.required)
        .map((s) => ctx.statuses.get(s))
        .filter((s): s is SourceStatus => s !== undefined && !s.complete)
    : [];
  const gapReason = gaps.length ? (gaps.find((g) => g.reason === 'stream_reset') ?? gaps[0])?.reason ?? null : null;
  const gapDetail = gaps.map((g) => g.detail).join('; ');

  const consulted = { events: new Set<string>(), records: new Set<string>() };
  const instances: InstanceVerdict[] = raw.map((r) => {
    const { refs, range } = rangeOf(r.supporting);
    if (r.verdict !== 'not_applicable') {
      for (const e of r.supporting) {
        consulted.events.add(e.id);
        for (const u of e.events) consulted.events.add(u);
      }
      for (const ref of refs) consulted.records.add(ref);
    }
    let verdict = r.verdict;
    let reason = r.reason;
    let detail = r.detail;
    if (gaps.length > 0) {
      verdict = 'inconclusive';
      reason = gapReason;
      detail = `${r.detail}; ${gapDetail}`;
    } else if (required && verdict !== 'inconclusive') {
      const unclaimed = refs
        .map(parseRecordRef)
        .filter(({ source, seq }) => {
          const ct = ctx.statuses.get(source)?.complete_through;
          return ct !== null && ct !== undefined && seq > ct;
        });
      if (unclaimed.length > 0) {
        verdict = 'inconclusive';
        reason = 'unclaimed_record';
        detail = `${r.detail}; consulted ${unclaimed.map((u) => `${u.source} seq ${u.seq} (complete_through ${ctx.statuses.get(u.source)?.complete_through})`).join(', ')}`;
      }
    }
    return {
      locator: { event: r.primary.id, seq: eventSeq(r.primary), source: eventSource(r.primary), entity: r.entity },
      verdict,
      reason,
      detail,
      evidence_range: range,
    };
  });

  // With a required source incomplete or unreliable there is nothing to judge
  // on, including the absence of instances: an emptied source yields no
  // events, and "no instances" must not read as not_applicable.
  const verdict: Verdict = gaps.length > 0 ? 'inconclusive' : rollUp(instances.map((i) => i.verdict));
  const reason = gaps.length > 0 ? gapReason : (instances.find((i) => i.verdict === verdict)?.reason ?? null);
  const detail = gaps.length > 0 ? gapDetail : summarize(def, instances, verdict);

  const projections = uniqueSorted(referencedEvents(def).flatMap((e) => lineage(e, ctx.definitions.projections).map((p) => p.id))).map((id) => ({
    id,
    version: ctx.definitions.projections.find((p) => p.id === id)?.version ?? 0,
  }));
  const sources: ExpectationVerdict['sources'] = {};
  for (const s of [...ctx.statuses.keys()].sort()) {
    const st = ctx.statuses.get(s) as SourceStatus;
    sources[s] = { high_water_mark: st.high_water_mark, complete_through: st.complete_through, reliable: st.reliable };
  }

  return {
    verdict: {
      expectation: def.id,
      version: def.version,
      kind: def.kind,
      verdict,
      best_effort: !required,
      reason,
      detail,
      instances,
      projections,
      sources,
    },
    consulted,
  };
}

// For runs that never reached a horizon (or failed a step): nothing is judged.
export function unjudged(def: ExpectationDef, reason: string, detail: string): ExpectationVerdict {
  return {
    expectation: def.id,
    version: def.version,
    kind: def.kind,
    verdict: 'inconclusive',
    best_effort: def.evidence.completeness !== 'required',
    reason,
    detail,
    instances: [],
    projections: [],
    sources: {},
  };
}
