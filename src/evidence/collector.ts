import type { OracleConfig, EvidenceSourceConfig } from '../language/schemas.js';
import { deepFreeze, toEnvelope, type EvidenceRecord, type MarkSample, type SampleReading, type SourceEvidence, type SourceMarks } from './envelope.js';

export type Fetch = typeof fetch;

const READ_TIMEOUT_MS = 30_000;

interface Page {
  records: unknown[];
  marks: SourceMarks;
}

function errorText(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${e.message}: ${cause.message}` : e.message;
  }
  return String(e);
}

// The milestone's one collector: fixture-style control endpoints that return
// { records, high_water_mark, complete_through } and page by `since`.
export class EvidenceClient {
  constructor(
    private readonly config: OracleConfig,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  sourceNames(): string[] {
    return Object.keys(this.config.evidence.sources).sort();
  }

  private source(name: string): EvidenceSourceConfig {
    const s = this.config.evidence.sources[name];
    if (!s) throw new Error(`unknown evidence source "${name}"`);
    return s;
  }

  private async page(name: string, since: number, limit: number | undefined): Promise<Page> {
    const cfg = this.source(name);
    const base = this.config.services[cfg.service]?.base_url;
    if (!base) throw new Error(`source ${name}: unknown service ${cfg.service}`);
    const url = new URL(cfg.path, base);
    url.searchParams.set(cfg.paging.param, String(since));
    if (limit !== undefined && cfg.paging.limit_param) url.searchParams.set(cfg.paging.limit_param, String(limit));
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GET ${url.pathname}${url.search} answered ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const hwm = body['high_water_mark'];
    const ct = body['complete_through'];
    if (!Array.isArray(body['records']) || typeof hwm !== 'number' || typeof ct !== 'number') {
      throw new Error(`GET ${url.pathname}: not an evidence page (records, high_water_mark, complete_through)`);
    }
    return { records: body['records'], marks: { high_water_mark: hwm, complete_through: ct } };
  }

  // One cheap read for the current marks: the smallest page if the source
  // takes a limit, otherwise a read from the current mark.
  async sample(name: string, since: number): Promise<SampleReading> {
    try {
      const cfg = this.source(name);
      const p = await this.page(name, since, cfg.paging.limit_param ? 1 : undefined);
      return p.marks;
    } catch (e) {
      return { error: errorText(e) };
    }
  }

  // Sources are sampled one at a time, never concurrently, so that samples
  // form a single sequence in which a decrease means a reset.
  async sampleAll(label: string, since: (name: string) => number): Promise<MarkSample> {
    const marks: Record<string, SampleReading> = {};
    for (const name of this.sourceNames()) marks[name] = await this.sample(name, since(name));
    return { label, marks };
  }

  // Pages from the starting mark until a page is empty; keeps the last
  // page's marks. A failed read is reported, not retried.
  async readAll(name: string, startMark: number): Promise<SourceEvidence> {
    const cfg = this.source(name);
    const records: EvidenceRecord[] = [];
    let since = startMark;
    try {
      for (;;) {
        const p = await this.page(name, since, cfg.paging.limit);
        if (p.records.length === 0) {
          return deepFreeze({ start_mark: startMark, records, horizon: p.marks, read_error: null });
        }
        for (const raw of p.records) records.push(toEnvelope(name, cfg, raw));
        const last = records[records.length - 1] as EvidenceRecord;
        if (last.seq <= since) throw new Error(`page after since=${since} did not advance (last seq ${last.seq})`);
        since = last.seq;
      }
    } catch (e) {
      return deepFreeze({ start_mark: startMark, records, horizon: null, read_error: errorText(e) });
    }
  }
}
