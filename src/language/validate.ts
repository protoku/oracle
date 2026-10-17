import { projectionSequence, inputEvents, inputSources } from '../kernel/dag.js';
import { runExample } from '../kernel/projections.js';
import type { ExpectationDef } from '../kernel/types.js';
import { loadTarget, type LoadedTarget } from './loader.js';
import type { Step } from './schemas.js';

export interface ValidationResult {
  target: LoadedTarget | null;
  errors: string[];
  examples: { passed: number; failed: number };
}

function expectationEvents(def: ExpectationDef): string[] {
  switch (def.kind) {
    case 'transition':
    case 'invariant':
      return [def.over];
    case 'obligation':
      return [def.when.event, def.clause.event, ...(def.window.kind === 'until' ? [def.window.event] : [])];
  }
}

function flatSteps(steps: Step[]): Step[] {
  return steps.flatMap((s) => (s.kind === 'parallel' ? [s, ...s.lanes.flatMap(flatSteps)] : [s]));
}

function crossReferences(t: LoadedTarget, errors: string[]): void {
  const cfg = t.config;
  const sources = new Set(Object.keys(cfg.evidence.sources));
  const services = new Set(Object.keys(cfg.services));
  const flags = new Set(cfg.defect_flags);

  const endpoints = [
    ...cfg.control.reset.map((e) => ['control.reset', e.service] as const),
    ['control.quiesce', cfg.control.quiesce.service] as const,
    ['control.version', cfg.control.version.service] as const,
    ...(cfg.control.clock ? [['control.clock', cfg.control.clock.service] as const] : []),
    ...Object.entries(cfg.control.jobs ?? {}).map(([k, e]) => [`control.jobs.${k}`, e.service] as const),
    ...Object.entries(cfg.control.faults ?? {}).map(([k, e]) => [`control.faults.${k}`, e.service] as const),
    ...Object.entries(cfg.evidence.sources).map(([k, s]) => [`evidence.sources.${k}`, s.service] as const),
  ];
  for (const [where, service] of endpoints) {
    if (!services.has(service)) errors.push(`oracle.yaml: ${where} names unknown service "${service}"`);
  }

  // Projections: inputs exist, each event has exactly one producer, no cycle.
  const producers = new Map<string, string[]>();
  for (const p of t.projections) producers.set(p.value.def.emits, [...(producers.get(p.value.def.emits) ?? []), p.file]);
  for (const [event, files] of producers) {
    if (files.length > 1) errors.push(`${files.join(', ')}: event "${event}" is emitted by more than one projection`);
  }
  for (const p of t.projections) {
    for (const s of inputSources(p.value.def)) {
      if (!sources.has(s)) errors.push(`${p.file}: source "${s}" is not declared in oracle.yaml`);
    }
    for (const e of inputEvents(p.value.def)) {
      if (!producers.has(e)) errors.push(`${p.file}: event "${e}" is not emitted by any projection`);
    }
  }
  const dag = projectionSequence(t.projections.map((p) => p.value.def));
  if (!dag.ok) {
    const files = t.projections.filter((p) => dag.cycle.includes(p.value.def.id)).map((p) => p.file);
    errors.push(`${files.join(', ')}: projection graph has a cycle among ${dag.cycle.join(', ')}`);
  }

  // Expectations: events and sources exist; decisions point back.
  const decisions = new Map(t.decisions.map((d) => [d.value.id, d]));
  const expectationIds = new Set(t.expectations.map((e) => e.value.def.id));
  for (const e of t.expectations) {
    const def = e.value.def;
    for (const ev of expectationEvents(def)) {
      if (!producers.has(ev)) errors.push(`${e.file}: event "${ev}" is not emitted by any projection`);
    }
    for (const s of def.evidence.required) {
      if (!sources.has(s)) errors.push(`${e.file}: required evidence source "${s}" is not declared in oracle.yaml`);
    }
    if (e.value.target !== cfg.target.name) errors.push(`${e.file}: applicability.target "${e.value.target}" is not "${cfg.target.name}"`);
    if (def.status !== 'candidate') {
      const id = e.value.decision;
      if (id === null) errors.push(`${e.file}: governance.decision is required when status is ${def.status}`);
      else {
        const d = decisions.get(id);
        if (!d) errors.push(`${e.file}: decision "${id}" does not exist`);
        else if (d.value.expectation !== def.id) {
          errors.push(`${e.file}: decision "${id}" belongs to "${d.value.expectation}", not to this expectation`);
        }
      }
    }
  }
  for (const d of t.decisions) {
    if (!expectationIds.has(d.value.expectation)) errors.push(`${d.file}: expectation "${d.value.expectation}" does not exist`);
  }

  // Experiments.
  for (const x of t.experiments) {
    const xp = x.value;
    if (xp.target !== cfg.target.name) errors.push(`${x.file}: target "${xp.target}" is not "${cfg.target.name}"`);
    for (const id of xp.investigates) {
      if (!expectationIds.has(id)) errors.push(`${x.file}: investigates unknown expectation "${id}"`);
    }
    const investigated = new Set(xp.investigates);
    const defaults = xp.expected['default'] ?? {};
    for (const id of xp.investigates) {
      if (!(id in defaults)) errors.push(`${x.file}: expected.default does not cover "${id}"`);
    }
    for (const [block, verdicts] of Object.entries(xp.expected)) {
      if (block !== 'default' && !flags.has(block)) errors.push(`${x.file}: expected.${block} is not a defect flag listed in oracle.yaml`);
      for (const id of Object.keys(verdicts)) {
        if (!investigated.has(id)) errors.push(`${x.file}: expected.${block} names "${id}", which the experiment does not investigate`);
      }
    }
    for (const service of xp.setup.reset) {
      if (!cfg.control.reset.some((r) => r.service === service)) errors.push(`${x.file}: setup.reset names "${service}", which has no control.reset entry`);
    }
    if (xp.setup.clock_set !== null && !cfg.control.clock) errors.push(`${x.file}: setup.clock needs control.clock in oracle.yaml`);
    const ids = new Set<string>();
    for (const s of flatSteps(xp.steps)) {
      if (ids.has(s.id)) errors.push(`${x.file}: step id "${s.id}" is used twice`);
      ids.add(s.id);
      if (s.kind === 'http' && !services.has(s.service)) errors.push(`${x.file}: step "${s.id}" names unknown service "${s.service}"`);
      if (s.kind === 'clock' && !cfg.control.clock) errors.push(`${x.file}: step "${s.id}" needs control.clock in oracle.yaml`);
    }
  }
}

export function validateTarget(dir: string): ValidationResult {
  const { target, errors } = loadTarget(dir);
  const examples = { passed: 0, failed: 0 };
  if (!target) return { target, errors, examples };
  crossReferences(target, errors);
  for (const p of target.projections) {
    for (const ex of p.value.def.examples) {
      const r = runExample(p.value.def, ex);
      if (r.passed) examples.passed++;
      else {
        examples.failed++;
        errors.push(`${p.file}: example "${ex.name}" fails; actual output ${JSON.stringify(r.actual)}`);
      }
    }
  }
  return { target, errors, examples };
}
