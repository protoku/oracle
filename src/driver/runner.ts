import { randomBytes, randomUUID } from 'node:crypto';
import { EvidenceClient, type Fetch } from '../evidence/collector.js';
import type { EvidenceSet, Horizon, Json, MarkSample, RunError, SourceEvidence } from '../kernel/types.js';
import { getPath } from '../kernel/paths.js';
import type { Experiment, OracleConfig, Step } from '../language/schemas.js';
import type { DetectedConfiguration } from './configuration.js';
import { httpCall } from './http.js';
import { substitute, substituteJson, type TemplateVars } from './template.js';

export interface RunDeps {
  fetch: Fetch;
  now: () => Date;
  uuid: () => string;
  hex4: () => string;
  sleep: (ms: number) => Promise<void>;
}

export const defaultDeps: RunDeps = {
  fetch: globalThis.fetch,
  now: () => new Date(),
  uuid: () => randomUUID(),
  hex4: () => randomBytes(2).toString('hex'),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ExperimentRun {
  run_id: string;
  experiment: string;
  configuration: DetectedConfiguration;
  started_at: string;
  finished_at: string;
  evidence: EvidenceSet;
  steps: { id: string; status: number | null; ms: number }[];
}

class StepFailure extends Error {
  constructor(
    readonly step: string,
    detail: string,
  ) {
    super(detail);
  }
}

export function runId(experiment: string, now: Date, hex4: string): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  return `${experiment}-${iso}-${hex4}`;
}

function baseUrl(config: OracleConfig, service: string): string {
  const url = config.services[service]?.base_url;
  if (!url) throw new Error(`unknown service ${service}`);
  return url;
}

function errorText(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${e.message}: ${cause.message}` : e.message;
  }
  return String(e);
}

// Steps 2–4 of brief §7: setup, starting marks, steps with a mark sample after
// each, horizon. Evaluation is the caller's.
export async function runExperiment(
  config: OracleConfig,
  xp: Experiment,
  configuration: DetectedConfiguration,
  deps: RunDeps = defaultDeps,
): Promise<ExperimentRun> {
  const started = deps.now();
  const id = runId(xp.id, started, deps.hex4());
  const client = new EvidenceClient(config, deps.fetch);
  const sources = client.sourceNames();
  const samples: MarkSample[] = [];
  const startMarks: Record<string, number> = {};
  const lastMark: Record<string, number> = {};
  const stepLog: ExperimentRun['steps'] = [];
  let runError: RunError | null = null;
  let horizon: Horizon = { reached: false, reason: 'not attempted', fixture_time: null };
  const evidence: Record<string, SourceEvidence> = {};

  const post = async (step: string, service: string, method: string, path: string, body: Json | undefined) => {
    let res;
    try {
      res = await httpCall(deps.fetch, baseUrl(config, service), method, path, [], body);
    } catch (e) {
      throw new StepFailure(step, `${method} ${path}: ${errorText(e)}`);
    }
    if (res.status < 200 || res.status > 299) throw new StepFailure(step, `${method} ${path} answered ${res.status}`);
    return res;
  };

  // Samples are serialized through one chain so that concurrent lanes cannot
  // interleave reads and fake a decrease.
  let sampling: Promise<void> = Promise.resolve();
  const sample = (label: string) => {
    sampling = sampling.then(async () => {
      const s = await client.sampleAll(label, (name) => {
        const cfg = config.evidence.sources[name];
        return cfg?.paging.limit_param ? (startMarks[name] ?? 0) : (lastMark[name] ?? startMarks[name] ?? 0);
      });
      for (const [name, r] of Object.entries(s.marks)) if ('high_water_mark' in r) lastMark[name] = r.high_water_mark;
      samples.push(s);
    });
    return sampling;
  };

  const vars: TemplateVars = { run: id, seed: xp.seed, uuid: deps.uuid, captured: new Map() };

  const runStep = async (step: Step): Promise<void> => {
    const t0 = deps.now().getTime();
    let status: number | null = null;
    switch (step.kind) {
      case 'http': {
        let path: string;
        let headers: [string, string][];
        let body;
        try {
          path = substitute(step.path, vars);
          headers = step.headers.map(([k, v]) => [k, substitute(v, vars)]);
          body = step.body === undefined ? undefined : substituteJson(step.body, vars);
        } catch (e) {
          throw new StepFailure(step.id, errorText(e));
        }
        let res;
        try {
          res = await httpCall(deps.fetch, baseUrl(config, step.service), step.method, path, headers, body);
        } catch (e) {
          throw new StepFailure(step.id, `${step.method} ${path}: ${errorText(e)}`);
        }
        status = res.status;
        if (step.expect_status !== null && res.status !== step.expect_status) {
          throw new StepFailure(step.id, `${step.method} ${path} answered ${res.status}, expected ${step.expect_status}`);
        }
        for (const [name, jsonPath] of step.capture) {
          const value = getPath(res.body ?? null, jsonPath.slice(2));
          if (value === null || typeof value === 'object') {
            throw new StepFailure(step.id, `capture ${name} (${jsonPath}) found no scalar in the response body`);
          }
          vars.captured.set(name, String(value));
        }
        break;
      }
      case 'sleep':
        await deps.sleep(step.ms);
        break;
      case 'clock': {
        const ep = config.control.clock;
        if (!ep) throw new StepFailure(step.id, 'no control.clock in oracle.yaml');
        await post(step.id, ep.service, 'POST', ep.path, { advance: step.advance_ms });
        break;
      }
      case 'mark':
        break;
      case 'parallel': {
        const lanes = await Promise.allSettled(step.lanes.map((lane) => runSteps(lane)));
        const failed = lanes.find((l): l is PromiseRejectedResult => l.status === 'rejected');
        if (failed) throw failed.reason;
        break;
      }
    }
    stepLog.push({ id: step.id, status, ms: deps.now().getTime() - t0 });
    await sample(step.id);
  };

  const runSteps = async (steps: Step[]): Promise<void> => {
    for (const s of steps) await runStep(s);
  };

  try {
    for (const service of xp.setup.reset) {
      const ep = config.control.reset.find((r) => r.service === service);
      if (!ep) throw new StepFailure(`setup.reset.${service}`, 'no control.reset entry');
      await post(`setup.reset.${service}`, ep.service, ep.method, ep.path, undefined);
    }
    if (xp.setup.clock_set !== null) {
      const ep = config.control.clock;
      if (!ep) throw new StepFailure('setup.clock', 'no control.clock in oracle.yaml');
      await post('setup.clock', ep.service, 'POST', ep.path, { set: xp.setup.clock_set });
    }

    // Starting marks come after setup: a reset restarts sequences, and marks
    // from before it would hide this run's records (docs/decisions.md).
    const start = await client.sampleAll('start', () => 0);
    for (const name of sources) {
      const r = start.marks[name];
      if (!r || !('high_water_mark' in r)) throw new StepFailure('start', `starting mark for ${name} could not be read${r && 'error' in r ? `: ${r.error}` : ''}`);
      startMarks[name] = r.high_water_mark;
      lastMark[name] = r.high_water_mark;
    }
    samples.push(start);

    await runSteps(xp.steps);
    await sampling;

    const q = config.control.quiesce;
    try {
      const res = await httpCall(deps.fetch, baseUrl(config, q.service), q.method, q.path, [], undefined);
      horizon = res.status >= 200 && res.status <= 299 ? { reached: true, reason: null, fixture_time: null } : { reached: false, reason: `quiesce answered ${res.status}`, fixture_time: null };
    } catch (e) {
      horizon = { reached: false, reason: `quiesce failed: ${errorText(e)}`, fixture_time: null };
    }

    if (horizon.reached) {
      const clock = config.control.clock;
      if (clock) {
        try {
          const res = await httpCall(deps.fetch, baseUrl(config, clock.service), 'GET', clock.path, [], undefined);
          const now = res.body && typeof res.body === 'object' && !Array.isArray(res.body) ? res.body['now'] : null;
          horizon = { ...horizon, fixture_time: typeof now === 'string' ? now : null };
        } catch {
          // An unknown fixture time leaves `within` windows open; it never closes them.
        }
      }
      for (const name of sources) evidence[name] = await client.readAll(name, startMarks[name] ?? 0);
    }
  } catch (e) {
    await sampling.catch(() => undefined);
    if (!(e instanceof StepFailure)) throw e;
    runError = { reason: 'step_failed', step: e.step, detail: e.message };
  }

  return {
    run_id: id,
    experiment: xp.id,
    configuration,
    started_at: started.toISOString(),
    finished_at: deps.now().toISOString(),
    evidence: { sources: evidence, samples, horizon, run_error: runError },
    steps: stepLog,
  };
}
