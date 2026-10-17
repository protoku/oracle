import { z } from 'zod';
import type {
  Aggregate,
  ExpectationDef,
  JoinExpr,
  Json,
  MapExpr,
  ObligationWindow,
  ProjectionDef,
  ProjectionExample,
  ProjectionInput,
} from '../kernel/types.js';
import { parseAssert, parseConditionList, parseValue, type Issues } from './conditions.js';

// Every object is strict: an unknown key is an error, so a typo in `forbid`
// cannot silently become "no obligation".

const name = z.string().min(1);
const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const endpoint = z.strictObject({ service: name, method, path: name });
const readEndpoint = z.strictObject({ service: name, path: name });

const evidenceSource = z
  .strictObject({
    service: name,
    path: name,
    paging: z.strictObject({
      param: name,
      limit_param: name.optional(),
      limit: z.number().int().positive().optional(),
    }),
    fixture_time: z.enum(['known', 'unknown']),
    shape: z.enum(['enveloped', 'flat']).default('enveloped'),
    envelope: z
      .strictObject({
        kind: z.union([z.strictObject({ prefix: z.string(), from: name }), z.strictObject({ literal: name })]),
        data: z.literal('all'),
      })
      .optional(),
    notes: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    if (s.shape === 'flat' && !s.envelope) ctx.addIssue({ code: 'custom', message: 'shape flat requires an envelope block', path: ['envelope'] });
    if (s.shape === 'enveloped' && s.envelope) ctx.addIssue({ code: 'custom', message: 'envelope is only allowed with shape flat', path: ['envelope'] });
    if (s.paging.limit !== undefined && s.paging.limit_param === undefined) {
      ctx.addIssue({ code: 'custom', message: 'paging.limit needs paging.limit_param', path: ['paging'] });
    }
  });

export const oracleConfigSchema = z.strictObject({
  language_version: z.literal(0),
  target: z.strictObject({ name, repo: z.string().optional(), commit: name, notes: z.string().optional() }),
  services: z.record(name, z.strictObject({ base_url: z.url() })),
  control: z.strictObject({
    reset: z.array(endpoint),
    quiesce: endpoint,
    clock: readEndpoint.optional(),
    version: readEndpoint,
    jobs: z.record(name, endpoint).optional(),
    faults: z.record(name, endpoint).optional(),
  }),
  evidence: z.strictObject({ sources: z.record(name, evidenceSource) }),
  defect_flags: z.array(name).default([]),
});
export type OracleConfig = z.infer<typeof oracleConfigSchema>;
export type EvidenceSourceConfig = OracleConfig['evidence']['sources'][string];

// ---------------------------------------------------------------------------
// Projections

const exampleRow = z.record(z.string(), z.json());
const projectionSchema = z
  .strictObject({
    id: name,
    version: z.number().int().positive(),
    emits: name,
    description: z.string(),
    from: z.strictObject({ source: name.optional(), event: name.optional(), where: z.unknown().optional() }).optional(),
    group: z.strictObject({ source: name.optional(), event: name.optional(), where: z.unknown().optional(), by: name }).optional(),
    join: z
      .strictObject({
        left: z.strictObject({ event: name, key: name }),
        right: z.strictObject({ event: name, key: name }),
        type: z.enum(['inner', 'left']),
      })
      .optional(),
    map: z.record(name, z.unknown()),
    keep: z.unknown().optional(),
    examples: z
      .array(
        z.strictObject({
          name,
          input: z.union([z.array(exampleRow), z.record(name, z.array(exampleRow))]),
          output: z.array(exampleRow),
        }),
      )
      .default([]),
  })
  .superRefine((p, ctx) => {
    const shapes = (['from', 'group', 'join'] as const).filter((k) => p[k] !== undefined);
    if (shapes.length !== 1) ctx.addIssue({ code: 'custom', message: `exactly one of from, group, join is required (found ${shapes.join(', ') || 'none'})` });
    for (const k of ['from', 'group'] as const) {
      const input = p[k];
      if (input && (input.source === undefined) === (input.event === undefined)) {
        ctx.addIssue({ code: 'custom', message: 'exactly one of source, event is required', path: [k] });
      }
    }
    if (p.keep !== undefined && p.from === undefined) ctx.addIssue({ code: 'custom', message: 'keep is only allowed on a map (from) projection', path: ['keep'] });
  });
type ProjectionParsed = z.infer<typeof projectionSchema>;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function plainPath(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !v.startsWith('$');
}

function mapExpr(field: string, raw: unknown, issues: Issues): MapExpr | null {
  if (plainPath(raw)) return { kind: 'path', path: raw };
  if (isObj(raw) && Object.keys(raw).length === 1 && 'literal' in raw) return { kind: 'literal', value: raw['literal'] as Json };
  issues.push(`map.${field}: expected a path or { literal: <value> }`);
  return null;
}

function joinExpr(field: string, raw: unknown, issues: Issues): JoinExpr | null {
  if (typeof raw === 'string') {
    const v = parseValue(raw);
    if (v.kind === 'ref' && (v.scope === 'left' || v.scope === 'right')) return { kind: 'ref', side: v.scope, path: v.path };
  }
  if (isObj(raw) && Object.keys(raw).length === 1 && raw['exists'] === 'right') return { kind: 'exists', side: 'right' };
  issues.push(`map.${field}: expected $left.<path>, $right.<path> or { exists: right }`);
  return null;
}

const AGG_OPS = ['key', 'first', 'last', 'count', 'count_distinct', 'sum', 'min', 'max', 'sum_product', 'any'] as const;

function aggregate(field: string, raw: unknown, issues: Issues): Aggregate | null {
  const at = `map.${field}`;
  if (!isObj(raw)) {
    issues.push(`${at}: expected an aggregate object`);
    return null;
  }
  const keys = Object.keys(raw);
  const unknown = keys.filter((k) => k !== 'where' && !(AGG_OPS as readonly string[]).includes(k));
  const ops = keys.filter((k) => (AGG_OPS as readonly string[]).includes(k));
  if (unknown.length > 0 || ops.length !== 1) {
    issues.push(`${at}: expected exactly one of ${AGG_OPS.join(', ')} plus optional where (found ${keys.join(', ')})`);
    return null;
  }
  const op = ops[0] as (typeof AGG_OPS)[number];
  const arg = raw[op];
  const where = parseConditionList(raw['where'], `${at}.where`, issues);
  switch (op) {
    case 'key':
      if (arg !== true) issues.push(`${at}.key: must be true`);
      if (raw['where'] !== undefined) issues.push(`${at}: key takes no where`);
      return { op };
    case 'count':
    case 'any':
      if (arg !== true) issues.push(`${at}.${op}: must be true`);
      return { op, where };
    case 'sum_product':
      if (!Array.isArray(arg) || arg.length !== 2 || !arg.every(plainPath)) {
        issues.push(`${at}.sum_product: must be a list of two paths`);
        return null;
      }
      return { op, paths: [arg[0] as string, arg[1] as string], where };
    default:
      if (!plainPath(arg)) {
        issues.push(`${at}.${op}: must be a path`);
        return null;
      }
      return { op, path: arg, where };
  }
}

function input(i: { source?: string | undefined; event?: string | undefined }): ProjectionInput {
  return i.source !== undefined ? { kind: 'source', source: i.source } : { kind: 'event', event: i.event as string };
}

function entries<T>(map: Record<string, unknown>, parse: (field: string, raw: unknown, issues: Issues) => T | null, issues: Issues): [string, T][] {
  return Object.entries(map).flatMap(([field, raw]) => {
    const parsed = parse(field, raw, issues);
    return parsed === null ? [] : [[field, parsed] as [string, T]];
  });
}

function normalizeProjection(p: ProjectionParsed, issues: Issues): ProjectionDef {
  const header = { id: p.id, version: p.version, emits: p.emits, examples: p.examples as ProjectionExample[] };
  if (p.join) {
    return { ...header, shape: 'join', left: p.join.left, right: p.join.right, type: p.join.type, map: entries(p.map, joinExpr, issues) };
  }
  if (p.group) {
    return {
      ...header,
      shape: 'group',
      input: input(p.group),
      where: parseConditionList(p.group.where, 'group.where', issues),
      by: p.group.by,
      map: entries(p.map, aggregate, issues),
    };
  }
  const from = p.from ?? {};
  return {
    ...header,
    shape: 'map',
    input: input(from),
    where: parseConditionList(from.where, 'from.where', issues),
    map: entries(p.map, mapExpr, issues),
    keep: parseConditionList(p.keep, 'keep', issues),
  };
}

// ---------------------------------------------------------------------------
// Expectations

const header = {
  id: name,
  version: z.number().int().positive(),
  wording: z.string(),
  provenance: z.enum(['human_authored', 'declared', 'inferred']),
  declared_in: z.array(z.strictObject({ file: name, path: name, value: z.json() })).optional(),
  governance: z.strictObject({ status: z.enum(['candidate', 'confirmed', 'rejected', 'deprecated']), decision: name.optional() }),
  owner: z.strictObject({ authority: name, domain: name }),
  applicability: z.strictObject({ target: name, since_commit: name.optional(), until_commit: name.optional() }),
  evidence: z.strictObject({ required: z.array(name), completeness: z.enum(['required', 'best_effort']) }),
  consequence: z.string().optional(),
};

const clause = z.strictObject({
  event: name,
  where: z.unknown().optional(),
  count_distinct: name.optional(),
  equals: z.number().int().nonnegative().optional(),
  gte: z.number().int().nonnegative().optional(),
  lte: z.number().int().nonnegative().optional(),
});

const DURATION = /^(\d+)(ms|s|m|h)$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

const expectationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...header,
    kind: z.literal('transition'),
    over: name,
    entity: name,
    rule: z.strictObject({ allowed: z.array(z.strictObject({ from: z.json(), to: z.json() })).min(1) }),
  }),
  z.strictObject({
    ...header,
    kind: z.literal('invariant'),
    over: name,
    entity: name.optional(),
    where: z.unknown().optional(),
    assert: z.unknown(),
  }),
  z
    .strictObject({
      ...header,
      kind: z.literal('obligation'),
      when: z.strictObject({ event: name, where: z.unknown().optional() }),
      correlate_by: z.record(name, z.string()).default({}),
      require: clause.optional(),
      forbid: clause.optional(),
      window: z.strictObject({
        within: z.string().regex(DURATION, 'duration like 500ms, 30s, 5m or 1h').optional(),
        until: z.strictObject({ event: name, where: z.unknown().optional() }).optional(),
        horizon: z.literal(true).optional(),
      }),
    })
    .superRefine((o, ctx) => {
      if ((o.require === undefined) === (o.forbid === undefined)) ctx.addIssue({ code: 'custom', message: 'exactly one of require, forbid is required' });
      const windows = (['within', 'until', 'horizon'] as const).filter((k) => o.window[k] !== undefined);
      if (windows.length !== 1) ctx.addIssue({ code: 'custom', message: `window needs exactly one of within, until, horizon (found ${windows.join(', ') || 'none'})`, path: ['window'] });
      const c = o.require ?? o.forbid;
      if (c) {
        const cmps = (['equals', 'gte', 'lte'] as const).filter((k) => c[k] !== undefined);
        if (cmps.length > 1) ctx.addIssue({ code: 'custom', message: 'at most one of equals, gte, lte' });
        if (cmps.length === 1 && c.count_distinct === undefined) ctx.addIssue({ code: 'custom', message: `${cmps[0]} needs count_distinct` });
        if (o.forbid && (c.count_distinct !== undefined || cmps.length > 0)) ctx.addIssue({ code: 'custom', message: 'forbid takes no count_distinct or comparator' });
      }
    }),
]);
type ExpectationParsed = z.infer<typeof expectationSchema>;

function normalizeExpectation(e: ExpectationParsed, issues: Issues): ExpectationDef {
  const base = { id: e.id, version: e.version, status: e.governance.status, evidence: e.evidence };
  switch (e.kind) {
    case 'transition':
      return { ...base, kind: 'transition', over: e.over, entity: e.entity, allowed: e.rule.allowed.map((a) => ({ from: a.from ?? null, to: a.to ?? null })) };
    case 'invariant':
      return {
        ...base,
        kind: 'invariant',
        over: e.over,
        entity: e.entity ?? null,
        where: parseConditionList(e.where, 'where', issues),
        assert: parseAssert(e.assert, 'assert', issues),
      };
    case 'obligation': {
      const c = (e.require ?? e.forbid) as z.infer<typeof clause>;
      const cmpOp = (['equals', 'gte', 'lte'] as const).find((k) => c[k] !== undefined);
      let window: ObligationWindow;
      if (e.window.within !== undefined) {
        const m = DURATION.exec(e.window.within) as RegExpExecArray;
        window = { kind: 'within', ms: Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS], raw: e.window.within };
      } else if (e.window.until !== undefined) {
        window = { kind: 'until', event: e.window.until.event, where: parseConditionList(e.window.until.where, 'window.until.where', issues) };
      } else {
        window = { kind: 'horizon' };
      }
      const correlate = Object.entries(e.correlate_by).map(([field, raw]): [string, ReturnType<typeof parseValue>] => {
        const v = parseValue(raw);
        if (v.kind !== 'ref' || v.scope !== 'trigger') issues.push(`correlate_by.${field}: must be $trigger.<path>`);
        return [field, v];
      });
      return {
        ...base,
        kind: 'obligation',
        when: { event: e.when.event, where: parseConditionList(e.when.where, 'when.where', issues) },
        correlate_by: correlate,
        clause: {
          mode: e.require ? 'require' : 'forbid',
          event: c.event,
          where: parseConditionList(c.where, e.require ? 'require.where' : 'forbid.where', issues),
          count_distinct: c.count_distinct ?? null,
          comparator: cmpOp ? { op: cmpOp, value: c[cmpOp] as number } : null,
        },
        window,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Decisions

export const decisionSchema = z.strictObject({
  id: name,
  expectation: name,
  version: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date (YYYY-MM-DD)'),
  authority: name,
  question: z.string(),
  answer: z.enum(['confirm', 'reject', 'deprecate', 'resolve']),
  reasoning: z.string(),
  // Free-form references; YAML may turn an unquoted 'x (a: b)' into a map.
  independent_sources: z.array(z.json()).optional(),
  confirmation: z.string().optional(),
});
export type Decision = z.infer<typeof decisionSchema>;

// ---------------------------------------------------------------------------
// Experiments

export const VERDICTS = ['satisfied', 'violated', 'pending', 'inconclusive', 'not_applicable'] as const;
const verdict = z.enum(VERDICTS);

export type Step =
  | {
      kind: 'http';
      id: string;
      service: string;
      method: z.infer<typeof method>;
      path: string;
      headers: [string, string][];
      body: Json | undefined;
      capture: [string, string][];
      expect_status: number | null;
    }
  | { kind: 'sleep'; id: string; ms: number }
  | { kind: 'parallel'; id: string; lanes: Step[][] }
  | { kind: 'clock'; id: string; advance_ms: number }
  | { kind: 'mark'; id: string };

const note = z.string().optional();
const httpStep = z.strictObject({
  id: name,
  http: z.strictObject({
    service: name,
    method,
    path: name,
    headers: z.record(name, z.string()).default({}),
    body: z.json().optional(),
  }),
  capture: z.record(name, z.string().regex(/^\$\..+/, 'a JSON path like $.id')).default({}),
  expect_status: z.number().int().optional(),
  note,
});
const sleepStep = z.strictObject({ id: name, sleep_ms: z.number().int().nonnegative(), note });
const clockStep = z.strictObject({ id: name, clock: z.strictObject({ advance_ms: z.number().int().nonnegative() }), note });
const markStep = z.strictObject({ id: name, evidence_mark: z.literal(true), note });
const parallelStep = z.strictObject({ id: name, parallel: z.array(z.array(z.unknown()).min(1)).min(1), note });

function zodIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${[prefix, ...i.path.map(String)].filter(Boolean).join('.')}: ${i.message}`);
}

export function parseStep(raw: unknown, at: string, issues: Issues): Step | null {
  if (!isObj(raw)) {
    issues.push(`${at}: a step must be an object`);
    return null;
  }
  const kinds = (['http', 'sleep_ms', 'parallel', 'clock', 'evidence_mark'] as const).filter((k) => k in raw);
  if (kinds.length !== 1) {
    issues.push(`${at}: a step needs exactly one of http, sleep_ms, parallel, clock, evidence_mark (found ${kinds.join(', ') || 'none'})`);
    return null;
  }
  const fail = (e: z.ZodError) => {
    issues.push(...zodIssues(at, e));
    return null;
  };
  switch (kinds[0]) {
    case 'http': {
      const r = httpStep.safeParse(raw);
      if (!r.success) return fail(r.error);
      const s = r.data;
      return {
        kind: 'http',
        id: s.id,
        service: s.http.service,
        method: s.http.method,
        path: s.http.path,
        headers: Object.entries(s.http.headers),
        body: s.http.body,
        capture: Object.entries(s.capture),
        expect_status: s.expect_status ?? null,
      };
    }
    case 'sleep_ms': {
      const r = sleepStep.safeParse(raw);
      return r.success ? { kind: 'sleep', id: r.data.id, ms: r.data.sleep_ms } : fail(r.error);
    }
    case 'clock': {
      const r = clockStep.safeParse(raw);
      return r.success ? { kind: 'clock', id: r.data.id, advance_ms: r.data.clock.advance_ms } : fail(r.error);
    }
    case 'evidence_mark': {
      const r = markStep.safeParse(raw);
      return r.success ? { kind: 'mark', id: r.data.id } : fail(r.error);
    }
    default: {
      const r = parallelStep.safeParse(raw);
      if (!r.success) return fail(r.error);
      const lanes = r.data.parallel.map((lane, li) =>
        lane.flatMap((s, si) => {
          const parsed = parseStep(s, `${at}.parallel[${li}][${si}]`, issues);
          return parsed ? [parsed] : [];
        }),
      );
      return { kind: 'parallel', id: r.data.id, lanes };
    }
  }
}

const experimentSchema = z.strictObject({
  id: name,
  hypothesis: z.string(),
  investigates: z.array(name).min(1),
  target: name,
  seed: z.number().int(),
  setup: z.strictObject({
    reset: z.array(name).default([]),
    clock: z.strictObject({ set: z.iso.datetime() }).optional(),
  }),
  steps: z.array(z.unknown()),
  horizon: z.literal('quiesce'),
  expected: z.record(name, z.record(name, verdict)).refine((e) => 'default' in e, 'expected.default is required'),
  coverage_expected: z.array(name).default([]),
});

export interface Experiment {
  id: string;
  investigates: string[];
  target: string;
  seed: number;
  setup: { reset: string[]; clock_set: string | null };
  steps: Step[];
  expected: Record<string, Record<string, (typeof VERDICTS)[number]>>;
  coverage_expected: string[];
}

// ---------------------------------------------------------------------------
// Entry points: raw YAML value in, normalized definition or issues out.

export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function run<P, T>(schema: z.ZodType<P>, raw: unknown, normalize: (p: P, issues: Issues) => T): Parsed<T> {
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, issues: zodIssues('', r.error) };
  const issues: Issues = [];
  const value = normalize(r.data, issues);
  return issues.length ? { ok: false, issues } : { ok: true, value };
}

export const parseOracleConfig = (raw: unknown) => run(oracleConfigSchema, raw, (p) => p);
export const parseDecision = (raw: unknown) => run(decisionSchema, raw, (p) => p);

export interface LoadedProjection {
  def: ProjectionDef;
  description: string;
}
export const parseProjection = (raw: unknown) => run(projectionSchema, raw, (p, issues) => ({ def: normalizeProjection(p, issues), description: p.description }));

export interface LoadedExpectation {
  def: ExpectationDef;
  decision: string | null;
  target: string;
  wording: string;
}
export const parseExpectation = (raw: unknown) =>
  run(expectationSchema, raw, (e, issues): LoadedExpectation => ({
    def: normalizeExpectation(e, issues),
    decision: e.governance.decision ?? null,
    target: e.applicability.target,
    wording: e.wording,
  }));

export const parseExperiment = (raw: unknown) =>
  run(experimentSchema, raw, (x, issues): Experiment => ({
    id: x.id,
    investigates: x.investigates,
    target: x.target,
    seed: x.seed,
    setup: { reset: x.setup.reset, clock_set: x.setup.clock?.set ?? null },
    steps: x.steps.flatMap((s, i) => {
      const parsed = parseStep(s, `steps[${i}]`, issues);
      return parsed ? [parsed] : [];
    }),
    expected: x.expected,
    coverage_expected: x.coverage_expected,
  }));

