import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Json, JsonObject } from '../../src/kernel/types.js';
import { parseOracleConfig, type OracleConfig } from '../../src/language/schemas.js';

// An in-process stand-in for a target with fixture-style control endpoints.
// Enveloped sources live under /__control/evidence/<name> (paged with
// since/limit); flat sources under /flat/<name> (since only).

export interface LoggedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Json | undefined;
  arrived: number;
  finished: number;
}

export type Handler = (req: LoggedRequest) => Promise<{ status: number; body?: Json }> | { status: number; body?: Json };

export class MockTarget {
  flags: string[] = [];
  gitSha: string | null = 'abc123';
  quiesceStatus = 200;
  clockNow = '2026-01-01T00:00:00.000Z';
  evidenceStatus = 200;
  sources = new Map<string, { flat: boolean; records: JsonObject[]; completeThrough: number | null }>();
  routes = new Map<string, Handler>();
  log: LoggedRequest[] = [];
  maxConcurrentEvidenceReads = 0;
  private evidenceInFlight = 0;
  private server: Server;
  baseUrl = '';

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  addSource(name: string, flat = false): void {
    this.sources.set(name, { flat, records: [], completeThrough: null });
  }

  append(name: string, record: JsonObject): number {
    const s = this.sources.get(name);
    if (!s) throw new Error(`no source ${name}`);
    const seq = (s.records.at(-1)?.['seq'] as number | undefined ?? 0) + 1;
    s.records.push({ ...record, seq });
    return seq;
  }

  hwm(name: string): number {
    return (this.sources.get(name)?.records.at(-1)?.['seq'] as number | undefined) ?? 0;
  }

  config(extra: Partial<Record<string, unknown>> = {}): OracleConfig {
    const sources: Record<string, unknown> = {};
    for (const [name, s] of this.sources) {
      sources[name] = s.flat
        ? { service: 'svc', path: `/flat/${name}`, paging: { param: 'since' }, fixture_time: 'unknown', shape: 'flat', envelope: { kind: { prefix: 'flat.', from: 'type' }, data: 'all' } }
        : { service: 'svc', path: `/__control/evidence/${name}`, paging: { param: 'since', limit_param: 'limit', limit: 10 }, fixture_time: 'known' };
    }
    const r = parseOracleConfig({
      language_version: 0,
      target: { name: 'mock', commit: 'abc123' },
      services: { svc: { base_url: this.baseUrl }, dead: { base_url: 'http://127.0.0.1:1' } },
      control: {
        reset: [{ service: 'svc', method: 'POST', path: '/__control/reset' }],
        quiesce: { service: 'svc', method: 'POST', path: '/__control/quiesce' },
        clock: { service: 'svc', path: '/__control/clock' },
        version: { service: 'svc', path: '/__control/version' },
      },
      evidence: { sources },
      defect_flags: ['F1', 'F2'],
      ...extra,
    });
    if (!r.ok) throw new Error(r.issues.join('\n'));
    return r.value;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const arrived = performance.now();
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const entry: LoggedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      body: text ? (JSON.parse(text) as Json) : undefined,
      arrived,
      finished: 0,
    };
    this.log.push(entry);
    const send = (status: number, body?: Json) => {
      entry.finished = performance.now();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    const p = url.pathname;
    if (p === '/__control/version') return send(200, { git_sha: this.gitSha, defects: this.flags });
    if (p === '/__control/reset') {
      for (const s of this.sources.values()) s.records = [];
      return send(200, { ok: true });
    }
    if (p === '/__control/quiesce') return send(this.quiesceStatus, {});
    if (p === '/__control/clock') return send(200, { now: this.clockNow, mode: 'frozen', offset_ms: null });

    const ev = /^\/(?:__control\/evidence|flat)\/(.+)$/.exec(p);
    if (ev) {
      this.evidenceInFlight++;
      this.maxConcurrentEvidenceReads = Math.max(this.maxConcurrentEvidenceReads, this.evidenceInFlight);
      await new Promise((r) => setTimeout(r, 1));
      this.evidenceInFlight--;
      const s = this.sources.get(ev[1] as string);
      if (!s) return send(404, { error: 'unknown source' });
      if (this.evidenceStatus !== 200) return send(this.evidenceStatus, { error: 'broken' });
      const since = Number(url.searchParams.get('since') ?? 0);
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : Infinity;
      const records = s.records.filter((r) => (r['seq'] as number) > since).slice(0, limit);
      const hwm = this.hwm(ev[1] as string);
      return send(200, { records, high_water_mark: hwm, complete_through: s.completeThrough ?? hwm });
    }

    const handler = this.routes.get(`${entry.method} ${p}`);
    if (!handler) return send(404, { error: 'not_found' });
    const r = await handler(entry);
    return send(r.status, r.body);
  }
}

export function enveloped(kind: string, data: JsonObject = {}): JsonObject {
  return { recorded_at: '2026-01-01T00:00:00.000Z', fixture_time: '2026-01-01T00:00:00.000Z', trace_id: null, ids: {}, kind, data };
}
