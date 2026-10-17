import type { Condition, Json, ValueExpr } from '../kernel/types.js';

// Conditions are parsed by hand rather than by a zod union so that an unknown
// or misspelled operator is reported as exactly that.

export type Issues = string[];

const COMPARE = ['equals', 'not_equals', 'lt', 'lte', 'gt', 'gte'] as const;
const LISTS = ['in', 'not_in'] as const;
const ARRAYS = ['any', 'all'] as const;
const PATH_OPS = [...COMPARE, ...LISTS, ...ARRAYS, 'exists'];

const REF = /^\$(trigger|left|right)?\.(.+)$/;

export function parseValue(raw: unknown): ValueExpr {
  if (typeof raw === 'string') {
    const m = REF.exec(raw);
    if (m) {
      const scope = m[1] === undefined ? 'self' : (m[1] as 'trigger' | 'left' | 'right');
      return { kind: 'ref', scope, path: m[2] as string };
    }
  }
  return { kind: 'literal', value: raw as Json };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPath(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !v.startsWith('$');
}

export function parseCondition(raw: unknown, at: string, issues: Issues): Condition | null {
  if (!isPlainObject(raw)) {
    issues.push(`${at}: a condition must be an object`);
    return null;
  }
  const keys = Object.keys(raw);
  for (const combinator of ['all_of', 'any_of'] as const) {
    if (combinator in raw) {
      if (keys.length !== 1) issues.push(`${at}: ${combinator} takes no sibling keys (found ${keys.join(', ')})`);
      const items = raw[combinator];
      if (!Array.isArray(items)) {
        issues.push(`${at}.${combinator}: must be a list of conditions`);
        return null;
      }
      return { op: combinator, items: parseConditionList(items, `${at}.${combinator}`, issues) };
    }
  }
  if ('not' in raw) {
    if (keys.length !== 1) issues.push(`${at}: not takes no sibling keys (found ${keys.join(', ')})`);
    const item = parseCondition(raw['not'], `${at}.not`, issues);
    return item && { op: 'not', item };
  }
  if (!('path' in raw)) {
    issues.push(`${at}: unknown condition (keys: ${keys.join(', ') || 'none'}); expected path, all_of, any_of or not`);
    return null;
  }
  const path = raw['path'];
  if (!isPath(path)) {
    issues.push(`${at}.path: must be a non-empty dotted path`);
    return null;
  }
  const ops = keys.filter((k) => k !== 'path');
  const unknown = ops.filter((k) => !PATH_OPS.includes(k));
  if (unknown.length > 0) {
    issues.push(`${at}: unknown operator ${unknown.join(', ')}`);
    return null;
  }
  if (ops.length !== 1) {
    issues.push(`${at}: exactly one operator is required next to path (found ${ops.join(', ') || 'none'})`);
    return null;
  }
  const op = ops[0] as string;
  const arg = raw[op];
  if ((COMPARE as readonly string[]).includes(op)) {
    return { op: op as (typeof COMPARE)[number], path, value: parseValue(arg) };
  }
  if ((LISTS as readonly string[]).includes(op)) {
    if (!Array.isArray(arg)) {
      issues.push(`${at}.${op}: must be a list`);
      return null;
    }
    return { op: op as (typeof LISTS)[number], path, values: arg.map(parseValue) };
  }
  if ((ARRAYS as readonly string[]).includes(op)) {
    const item = parseCondition(arg, `${at}.${op}`, issues);
    return item && { op: op as (typeof ARRAYS)[number], path, item };
  }
  if (typeof arg !== 'boolean') {
    issues.push(`${at}.exists: must be true or false`);
    return null;
  }
  return { op: 'exists', path, value: arg };
}

export function parseConditionList(raw: unknown, at: string, issues: Issues): Condition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push(`${at}: must be a list of conditions`);
    return [];
  }
  return raw.flatMap((c, i) => {
    const parsed = parseCondition(c, `${at}[${i}]`, issues);
    return parsed ? [parsed] : [];
  });
}

// `assert` takes one condition or a list (an implicit all_of).
export function parseAssert(raw: unknown, at: string, issues: Issues): Condition {
  if (Array.isArray(raw)) {
    const items = parseConditionList(raw, at, issues);
    return items.length === 1 ? (items[0] as Condition) : { op: 'all_of', items };
  }
  return parseCondition(raw, at, issues) ?? { op: 'all_of', items: [] };
}
