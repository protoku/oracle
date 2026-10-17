import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { EvidenceClient } from '../../src/evidence/collector.js';
import { toEnvelope } from '../../src/evidence/envelope.js';
import { sourceStatus } from '../../src/kernel/completeness.js';
import type { EvidenceSet, MarkSample } from '../../src/kernel/types.js';
import { enveloped, MockTarget } from '../support/mock-target.js';

const flatCfg = (kind: { prefix: string; from: string } | { literal: string }) =>
  ({ service: 's', path: '/x', paging: { param: 'since' }, fixture_time: 'unknown', shape: 'flat', envelope: { kind, data: 'all' } }) as const;

test('envelope: flat source with a prefixed kind puts the whole record under data', () => {
  const raw = { seq: 3, recorded_at: 'r', trace_id: 't', type: 'thing', id: 'x1', fixture_time: 'ignored' };
  assert.deepEqual(toEnvelope('ext', flatCfg({ prefix: 'ext.', from: 'type' }), raw), {
    source: 'ext',
    seq: 3,
    recorded_at: 'r',
    fixture_time: null,
    trace_id: 't',
    ids: {},
    kind: 'ext.thing',
    data: raw,
  });
});

test('envelope: flat source with a literal kind', () => {
  assert.equal(toEnvelope('ext', flatCfg({ literal: 'ext.request' }), { seq: 1 }).kind, 'ext.request');
});

test('envelope: enveloped source keeps ids and data; fixture_time only when known', () => {
  const cfg = { service: 's', path: '/x', paging: { param: 'since' }, fixture_time: 'known', shape: 'enveloped' } as const;
  const r = toEnvelope('db', cfg, { seq: 2, kind: 'db.insert', ids: { txid: 4 }, data: { a: 1 }, fixture_time: 'ft', recorded_at: 'ra', trace_id: null });
  assert.deepEqual(r, { source: 'db', seq: 2, recorded_at: 'ra', fixture_time: 'ft', trace_id: null, ids: { txid: 4 }, kind: 'db.insert', data: { a: 1 } });
  assert.equal(toEnvelope('db', { ...cfg, fixture_time: 'unknown' }, { seq: 2, kind: 'k', fixture_time: 'ft' }).fixture_time, null);
  assert.deepEqual(toEnvelope('db', cfg, { seq: 2, kind: 'k' }).ids, {});
});

test('envelope: records without an integer seq or a kind are rejected', () => {
  const cfg = { service: 's', path: '/x', paging: { param: 'since' }, fixture_time: 'known', shape: 'enveloped' } as const;
  assert.throws(() => toEnvelope('db', cfg, { kind: 'k' }), /seq/);
  assert.throws(() => toEnvelope('db', cfg, { seq: 1.5, kind: 'k' }), /seq/);
  assert.throws(() => toEnvelope('db', cfg, { seq: 1 }), /kind/);
  assert.throws(() => toEnvelope('ext', flatCfg({ prefix: 'p.', from: 'type' }), { seq: 1 }), /type/);
});

let target: MockTarget;
before(async () => {
  target = await new MockTarget().start();
});
after(() => target.stop());
beforeEach(() => {
  target.sources.clear();
  target.log = [];
  target.evidenceStatus = 200;
  target.maxConcurrentEvidenceReads = 0;
  target.addSource('db');
  target.addSource('ext', true);
});

test('paging: reads from the starting mark until a page is empty and keeps the last page marks', async () => {
  for (let i = 0; i < 25; i++) target.append('db', enveloped('db.insert', { i }));
  target.sources.get('db')!.completeThrough = 24;
  const client = new EvidenceClient(target.config());
  const ev = await client.readAll('db', 3);
  assert.equal(ev.read_error, null);
  assert.deepEqual(ev.records.map((r) => r.seq), Array.from({ length: 22 }, (_, i) => i + 4));
  assert.deepEqual(ev.horizon, { high_water_mark: 25, complete_through: 24 });
  assert.deepEqual(
    target.log.map((l) => l.query),
    [
      { since: '3', limit: '10' },
      { since: '13', limit: '10' },
      { since: '23', limit: '10' },
      { since: '25', limit: '10' },
    ],
  );
  assert.ok(Object.isFrozen(ev.records[0]) && Object.isFrozen(ev.records[0]?.data), 'collected evidence is immutable');
});

test('paging: a flat source without a limit is read with since only and mapped into the envelope', async () => {
  target.append('ext', { type: 'charge', id: 'c1' });
  target.append('ext', { type: 'refund', id: 'r1' });
  const ev = await new EvidenceClient(target.config()).readAll('ext', 0);
  assert.deepEqual(ev.records.map((r) => [r.seq, r.kind, r.data['id']]), [
    [1, 'flat.charge', 'c1'],
    [2, 'flat.refund', 'r1'],
  ]);
  assert.deepEqual(target.log.map((l) => l.query), [{ since: '0' }, { since: '2' }]);
});

test('a failed read is reported, not retried', async () => {
  target.evidenceStatus = 500;
  const ev = await new EvidenceClient(target.config()).readAll('db', 0);
  assert.equal(ev.horizon, null);
  assert.match(ev.read_error ?? '', /answered 500/);
  assert.equal(target.log.length, 1);
});

test('samples: the smallest page for limit sources, since-at-mark otherwise; one read at a time', async () => {
  target.append('db', enveloped('k'));
  target.append('ext', { type: 't' });
  const s = await new EvidenceClient(target.config()).sampleAll('step', (name) => (name === 'ext' ? 1 : 0));
  assert.deepEqual(s.marks, { db: { high_water_mark: 1, complete_through: 1 }, ext: { high_water_mark: 1, complete_through: 1 } });
  assert.deepEqual(target.log.map((l) => [l.path, l.query]), [
    ['/__control/evidence/db', { since: '0', limit: '1' }],
    ['/flat/ext', { since: '1' }],
  ]);
  assert.equal(target.maxConcurrentEvidenceReads, 1);
});

test('sample regression: a source whose mark decreases between samples is unreliable (stream_reset)', async () => {
  const client = new EvidenceClient(target.config());
  const samples: MarkSample[] = [];
  samples.push(await client.sampleAll('start', () => 0));
  target.append('ext', { type: 't' });
  target.append('ext', { type: 't' });
  samples.push(await client.sampleAll('grow', () => 0));
  target.sources.get('ext')!.records = [];
  samples.push(await client.sampleAll('lost', () => 2));
  const evidence: EvidenceSet = {
    sources: { db: await client.readAll('db', 0), ext: await client.readAll('ext', 0) },
    samples,
    horizon: { reached: true, reason: null, fixture_time: null },
    run_error: null,
  };
  const ext = sourceStatus(evidence, 'ext');
  assert.equal(ext.reason, 'stream_reset');
  assert.deepEqual(ext.regression, { before: { label: 'grow', high_water_mark: 2 }, after: { label: 'lost', high_water_mark: 0 } });
  // At the horizon the emptied source claims to be complete; only the samples show otherwise.
  assert.deepEqual(evidence.sources['ext']?.horizon, { high_water_mark: 0, complete_through: 0 });
  assert.equal(sourceStatus(evidence, 'db').complete, true);
});

test('completeness: complete_through below high_water_mark is incomplete; absence of records is not completeness', async () => {
  target.append('db', enveloped('k'));
  target.append('db', enveloped('k'));
  target.sources.get('db')!.completeThrough = 1;
  const client = new EvidenceClient(target.config());
  const evidence: EvidenceSet = {
    sources: { db: await client.readAll('db', 2) },
    samples: [],
    horizon: { reached: true, reason: null, fixture_time: null },
    run_error: null,
  };
  assert.equal(evidence.sources['db']?.records.length, 0);
  const s = sourceStatus(evidence, 'db');
  assert.equal(s.complete, false);
  assert.equal(s.reason, 'incomplete');
  assert.match(s.detail, /complete_through 1 < high_water_mark 2/);
});
