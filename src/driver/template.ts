import type { Json } from '../kernel/types.js';

// Substitution of {{name}} only (spec §8). Nothing is evaluated.
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface TemplateVars {
  run: string;
  seed: number;
  uuid: () => string;
  captured: Map<string, string>;
}

export class TemplateError extends Error {}

export function substitute(text: string, vars: TemplateVars): string {
  return text.replace(PLACEHOLDER, (_, name: string) => {
    if (name === 'run') return vars.run;
    if (name === 'seed') return String(vars.seed);
    if (name === 'uuid') return vars.uuid();
    const v = vars.captured.get(name);
    if (v === undefined) throw new TemplateError(`{{${name}}} is not a built-in and was not captured by an earlier step`);
    return v;
  });
}

export function substituteJson(value: Json, vars: TemplateVars): Json {
  if (typeof value === 'string') return substitute(value, vars);
  if (Array.isArray(value)) return value.map((v) => substituteJson(v, vars));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteJson(v, vars);
    return out;
  }
  return value;
}
