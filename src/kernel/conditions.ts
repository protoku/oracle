import { jsonEqual } from './json.js';
import { getPath } from './paths.js';
import type { Condition, Json, Scope, ValueExpr } from './types.js';

export type Scopes = Partial<Record<Scope, Json>>;

export interface ConditionContext {
  // What bare paths resolve against: the record, event, or array element.
  subject: Json;
  scopes: Scopes;
}

export function resolveValue(expr: ValueExpr, scopes: Scopes): Json {
  if (expr.kind === 'literal') return expr.value;
  return getPath(scopes[expr.scope], expr.path);
}

function ordered(op: 'lt' | 'lte' | 'gt' | 'gte', a: Json, b: Json): boolean {
  const comparable = (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string');
  if (!comparable) return false;
  switch (op) {
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
  }
}

// Null semantics (spec §2, as pinned in docs/decisions.md): equals and
// not_equals are JSON equality with null as an ordinary value; ordering
// comparisons and in/not_in are false when the path value is null; exists
// tests for null.
export function evaluateCondition(cond: Condition, ctx: ConditionContext): boolean {
  switch (cond.op) {
    case 'equals':
      return jsonEqual(getPath(ctx.subject, cond.path), resolveValue(cond.value, ctx.scopes));
    case 'not_equals':
      return !jsonEqual(getPath(ctx.subject, cond.path), resolveValue(cond.value, ctx.scopes));
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const actual = getPath(ctx.subject, cond.path);
      const expected = resolveValue(cond.value, ctx.scopes);
      if (actual === null || expected === null) return false;
      return ordered(cond.op, actual, expected);
    }
    case 'in':
    case 'not_in': {
      const actual = getPath(ctx.subject, cond.path);
      if (actual === null) return false;
      const member = cond.values.some((v) => jsonEqual(actual, resolveValue(v, ctx.scopes)));
      return cond.op === 'in' ? member : !member;
    }
    case 'exists':
      return (getPath(ctx.subject, cond.path) !== null) === cond.value;
    case 'all_of':
      return cond.items.every((c) => evaluateCondition(c, ctx));
    case 'any_of':
      return cond.items.some((c) => evaluateCondition(c, ctx));
    case 'not':
      return !evaluateCondition(cond.item, ctx);
    case 'any':
    case 'all': {
      const list = getPath(ctx.subject, cond.path);
      if (!Array.isArray(list)) return false;
      const test = (element: Json) => evaluateCondition(cond.item, { subject: element, scopes: ctx.scopes });
      return cond.op === 'any' ? list.some(test) : list.every(test);
    }
  }
}

export function evaluateAll(conds: Condition[], ctx: ConditionContext): boolean {
  return conds.every((c) => evaluateCondition(c, ctx));
}

// Paths a condition reads from its subject, for explaining a verdict.
export function conditionPaths(cond: Condition): string[] {
  switch (cond.op) {
    case 'all_of':
    case 'any_of':
      return cond.items.flatMap(conditionPaths);
    case 'not':
      return conditionPaths(cond.item);
    case 'any':
    case 'all':
    case 'exists':
      return [cond.path];
    case 'in':
    case 'not_in':
      return [cond.path, ...selfRefs(cond.values)];
    default:
      return [cond.path, ...selfRefs([cond.value])];
  }
}

function selfRefs(values: ValueExpr[]): string[] {
  return values.flatMap((v) => (v.kind === 'ref' && v.scope === 'self' ? [v.path] : []));
}
