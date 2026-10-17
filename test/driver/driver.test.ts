import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ConfigurationError, detectConfiguration, expectedFor } from '../../src/driver/configuration.js';
import { defaultDeps, runExperiment, runId } from '../../src/driver/runner.js';
import { substitute, substituteJson, TemplateError, type TemplateVars } from '../../src/driver/template.js';
import { evaluate } from '../../src/kernel/evaluate.js';
import { parseExperiment, type Experiment } from '../../src/language/schemas.js';
import { enveloped, MockTarget } from '../support/mock-target.js';

test('templating: built-ins, fresh uuid per use, captured variables, nothing evaluated', () => {
  let n = 0;
  const vars: TemplateVars = { run: 'xp-1', seed: 7, uuid: () => `u${++n}`, captured: new Map([['id', 'o-9']]) };
  assert.equal(substitute('/a/{{id}}/b?r={{run}}&s={{seed}}', vars), '/a/o-9/b?r=xp-1&s=7');
  assert.equal(substitute('{{uuid}} {{uuid}}', vars), 'u1 u2');
  assert.equal(substitute('{{ run }}', vars), 'xp-1');
  assert.equal(substitute('{{1+1}} {run} ${run}', vars), '{{1+1}} {run} ${run}');
  assert.throws(() => substitute('{{nope}}', vars), TemplateError);
  assert.deepEqual(substituteJson({ a: ['{{id}}', 1, null, { b: '{{run}}' }], 'k{{id}}': true }, vars), { a: ['o-9', 1, null, { b: 'xp-1' }], 'k{{id}}': true });
});

test('run id: <experiment-id>-<iso-timestamp>-<4 hex>', () => {
  assert.equal(runId('xp-a', new Date('2026-10-17T19:30:05.123Z'), 'beef'), 'xp-a-20261017T193005Z-beef');
});

let target: MockTarget;
before(async () => {
  target = await new MockTarget().start();
});
after(() => target.stop());
beforeEach(() => {
  target.sources.clear();
  target.routes.clear();
  target.log = [];
  target.flags = [];
  target.quiesceStatus = 200;
  target.maxConcurrentEvidenceReads = 0;
  target.addSource('http');
});

function experiment(raw: Record<string, unknown>): Experiment {
  const r = parseExperiment({
    id: 'xp-t',
    hypothesis: 'h',
    investigates: ['exp-x'],
    target: 'mock',
    seed: 3,
    setup: { reset: ['svc'] },
    horizon: 'quiesce',
    steps: [],
    expected: { default: { 'exp-x': 'satisfied' } },
    ...raw,
  });
  if (!r.ok) throw new Error(r.issues.join('\n'));
  return r.value;
}

const deps = { ...defaultDeps, hex4: () => 'abcd', uuid: () => 'uuid-1' };
const clean = { name: 'clean', flags: [], git_sha: 'abc123' };

test('configuration: zero flags is clean, one flag names it, more than one is refused', async () => {
  const cfg = target.config();
  assert.equal((await detectConfiguration(fetch, cfg)).name, 'clean');
  target.flags = ['F2'];
  assert.deepEqual(await detectConfiguration(fetch, cfg), { name: 'F2', flags: ['F2'], git_sha: 'abc123' });
  target.flags = ['F1', 'F2'];
  await assert.rejects(detectConfiguration(fetch, cfg), (e: Error) => e instanceof ConfigurationError && /not a supported configuration/.test(e.message));
  target.flags = ['F9'];
  await assert.rejects(detectConfiguration(fetch, cfg), /not listed/);
});

test('configuration: a flag block is merged over default', () => {
  const xp = experiment({ investigates: ['exp-x', 'exp-y'], expected: { default: { 'exp-x': 'satisfied', 'exp-y': 'satisfied' }, F1: { 'exp-y': 'violated' } } });
  assert.deepEqual(expectedFor(xp, 'clean'), { 'exp-x': 'satisfied', 'exp-y': 'satisfied' });
  assert.deepEqual(expectedFor(xp, 'F1'), { 'exp-x': 'satisfied', 'exp-y': 'violated' });
  assert.deepEqual(expectedFor(xp, 'F2'), { 'exp-x': 'satisfied', 'exp-y': 'satisfied' });
});

test('steps: substitution, capture, and a mark sample after every step', async () => {
  target.routes.set('GET /things/t-3', () => ({ status: 200, body: {} }));
  const xp = experiment({
    steps: [
      { id: 'create', http: { service: 'svc', method: 'POST', path: '/things', headers: { 'Idempotency-Key': '{{run}}-k' }, body: { n: '{{seed}}' } }, capture: { tid: '$.id' }, expect_status: 201 },
      { id: 'read', http: { service: 'svc', method: 'GET', path: '/things/{{tid}}' }, expect_status: 200 },
      { id: 'mark', evidence_mark: true },
    ],
  });
  // {{seed}} substitutes into a string, so the body field is "3".
  target.routes.set('POST /things', (req) => {
    target.append('http', enveloped('http.request', { route: '/things', status: 201 }));
    return { status: 201, body: { id: `t-${(req.body as { n: string }).n}` } };
  });
  const run = await runExperiment(target.config(), xp, clean, deps);
  assert.equal(run.evidence.run_error, null);
  assert.equal(run.run_id.startsWith('xp-t-'), true);
  const create = target.log.find((l) => l.path === '/things');
  assert.equal(create?.headers['idempotency-key'], `${run.run_id}-k`);
  assert.deepEqual(create?.body, { n: '3' });
  assert.ok(target.log.some((l) => l.path === '/things/t-3'));
  assert.deepEqual(run.evidence.samples.map((s) => s.label), ['start', 'create', 'read', 'mark']);
  assert.deepEqual(run.evidence.samples.map((s) => s.marks['http']), [0, 1, 1, 1].map((n) => ({ high_water_mark: n, complete_through: n })));
  assert.equal(run.evidence.horizon.reached, true);
  assert.equal(run.evidence.horizon.fixture_time, target.clockNow);
  assert.equal(run.evidence.sources['http']?.records.length, 1);
});

test('starting marks are taken after setup and exclude earlier records', async () => {
  target.routes.set('POST /__control/reset', () => ({ status: 200 }));
  for (let i = 0; i < 4; i++) target.append('http', enveloped('http.request'));
  target.routes.set('POST /x', () => {
    target.append('http', enveloped('http.request', { n: 'mine' }));
    return { status: 200, body: {} };
  });
  const xp = experiment({ setup: { reset: [] }, steps: [{ id: 'x', http: { service: 'svc', method: 'POST', path: '/x' } }] });
  const run = await runExperiment(target.config(), xp, clean, deps);
  assert.equal(run.evidence.sources['http']?.start_mark, 4);
  assert.deepEqual(run.evidence.sources['http']?.records.map((r) => r.data['n']), ['mine']);
});

test('parallel: lanes run concurrently, steps within a lane in sequence, samples never overlap', async () => {
  target.routes.set('POST /a1', async () => {
    await new Promise((r) => setTimeout(r, 150));
    return { status: 200, body: {} };
  });
  for (const p of ['/a2', '/b1']) target.routes.set(`POST ${p}`, () => ({ status: 200, body: {} }));
  const xp = experiment({
    steps: [
      {
        id: 'race',
        parallel: [
          [
            { id: 'a1', http: { service: 'svc', method: 'POST', path: '/a1' } },
            { id: 'a2', http: { service: 'svc', method: 'POST', path: '/a2' } },
          ],
          [
            { id: 'wait', sleep_ms: 20 },
            { id: 'b1', http: { service: 'svc', method: 'POST', path: '/b1' } },
          ],
        ],
      },
    ],
  });
  const run = await runExperiment(target.config(), xp, clean, deps);
  assert.equal(run.evidence.run_error, null);
  const at = (p: string) => target.log.find((l) => l.path === p) as NonNullable<(typeof target.log)[number]>;
  assert.ok(at('/b1').arrived < at('/a1').finished, 'lane b ran while a1 was in flight');
  assert.ok(at('/a2').arrived >= at('/a1').finished, 'a2 waited for a1');
  assert.deepEqual([...run.evidence.samples.map((s) => s.label)].sort(), ['a1', 'a2', 'b1', 'race', 'start', 'wait']);
  assert.equal(run.evidence.samples.at(-1)?.label, 'race');
  assert.equal(target.maxConcurrentEvidenceReads, 1);
});

test('expect_status mismatch is a run error naming the step; later steps do not run', async () => {
  target.routes.set('POST /a', () => ({ status: 500, body: {} }));
  target.routes.set('POST /b', () => ({ status: 200, body: {} }));
  const xp = experiment({
    steps: [
      { id: 'a', http: { service: 'svc', method: 'POST', path: '/a' }, expect_status: 201 },
      { id: 'b', http: { service: 'svc', method: 'POST', path: '/b' } },
    ],
  });
  const run = await runExperiment(target.config(), xp, clean, deps);
  assert.equal(run.evidence.run_error?.reason, 'step_failed');
  assert.equal(run.evidence.run_error?.step, 'a');
  assert.match(run.evidence.run_error?.detail ?? '', /answered 500, expected 201/);
  assert.ok(!target.log.some((l) => l.path === '/b'));
  const verdicts = evaluate(run.evidence, { sources: ['http'], projections: [], expectations: [] });
  assert.deepEqual(verdicts.verdicts, []);
});

test('a transport failure is a run error, with one attempt and no retry', async () => {
  const xp = experiment({ steps: [{ id: 'gone', http: { service: 'dead', method: 'POST', path: '/x' } }] });
  const run = await runExperiment(target.config(), xp, clean, deps);
  assert.equal(run.evidence.run_error?.step, 'gone');
});

test('a step under test without expect_status records its status and continues', async () => {
  target.routes.set('POST /a', () => ({ status: 409, body: {} }));
  const xp = experiment({ steps: [{ id: 'a', http: { service: 'svc', method: 'POST', path: '/a' } }] });
  const run = await runExperiment(target.config(), xp, clean, deps);
  assert.equal(run.evidence.run_error, null);
  assert.equal(run.steps.find((s) => s.id === 'a')?.status, 409);
});

test('a missing capture is a run error', async () => {
  target.routes.set('POST /a', () => ({ status: 200, body: { other: 1 } }));
  const xp = experiment({ steps: [{ id: 'a', http: { service: 'svc', method: 'POST', path: '/a' }, capture: { id: '$.id' } }] });
  const run = await runExperiment(target.config(), xp, clean, deps);
  assert.match(run.evidence.run_error?.detail ?? '', /capture id/);
});

test('quiesce failing means the horizon was not reached and no evidence is read', async () => {
  target.quiesceStatus = 504;
  const run = await runExperiment(target.config(), experiment({ steps: [] }), clean, deps);
  assert.equal(run.evidence.horizon.reached, false);
  assert.match(run.evidence.horizon.reason ?? '', /504/);
  assert.deepEqual(run.evidence.sources, {});
});

test('clock: setup sets, a step advances', async () => {
  const xp = experiment({ setup: { reset: [], clock: { set: '2026-01-15T10:00:00Z' } }, steps: [{ id: 'tick', clock: { advance_ms: 60000 } }] });
  await runExperiment(target.config(), xp, clean, deps);
  const posts = target.log.filter((l) => l.path === '/__control/clock' && l.method === 'POST').map((l) => l.body);
  assert.deepEqual(posts, [{ set: '2026-01-15T10:00:00Z' }, { advance: 60000 }]);
});
