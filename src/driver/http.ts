import type { Json } from '../kernel/types.js';
import type { Fetch } from '../evidence/collector.js';

export const STEP_TIMEOUT_MS = 30_000;

export interface HttpResult {
  status: number;
  body: Json | undefined;
}

// One attempt, no retries (brief §7, §11). Transport failures throw.
export async function httpCall(
  fetchImpl: Fetch,
  baseUrl: string,
  method: string,
  path: string,
  headers: [string, string][],
  body: Json | undefined,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<HttpResult> {
  const h = new Headers(headers);
  if (body !== undefined && !h.has('content-type')) h.set('content-type', 'application/json');
  const res = await fetchImpl(new URL(path, baseUrl), {
    method,
    headers: h,
    body: body === undefined ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: Json | undefined;
  try {
    parsed = text === '' ? undefined : (JSON.parse(text) as Json);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed };
}
