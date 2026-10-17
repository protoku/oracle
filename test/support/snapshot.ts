import { canonicalJson } from '../../src/kernel/json.js';
import type { Evaluation, Json } from '../../src/kernel/types.js';

// The committed form of a kernel result: canonical key order, two-space indent.
export function snapshotOf(evaluation: Evaluation): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(evaluation as unknown as Json)), null, 2)}\n`;
}
