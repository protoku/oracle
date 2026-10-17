import type { Fetch } from '../evidence/collector.js';
import type { Verdict } from '../kernel/types.js';
import type { Experiment, OracleConfig } from '../language/schemas.js';
import { httpCall } from './http.js';

export const CLEAN = 'clean';

export interface DetectedConfiguration {
  name: string;
  flags: string[];
  git_sha: string | null;
}

export class ConfigurationError extends Error {}

// control.version reports the active flags under `defects`, the
// fixture-style control API this milestone supports (docs/decisions.md).
export async function detectConfiguration(fetchImpl: Fetch, config: OracleConfig): Promise<DetectedConfiguration> {
  const ep = config.control.version;
  const base = config.services[ep.service]?.base_url as string;
  let res;
  try {
    res = await httpCall(fetchImpl, base, 'GET', ep.path, [], undefined);
  } catch (e) {
    throw new ConfigurationError(`control.version could not be read: ${(e as Error).message}`);
  }
  if (res.status !== 200 || typeof res.body !== 'object' || res.body === null || Array.isArray(res.body)) {
    throw new ConfigurationError(`control.version answered ${res.status} without a JSON object`);
  }
  const flags = res.body['defects'];
  if (!Array.isArray(flags) || !flags.every((f) => typeof f === 'string')) {
    throw new ConfigurationError('control.version did not report a list of active flags under "defects"');
  }
  const sorted = [...(flags as string[])].sort();
  const gitSha = typeof res.body['git_sha'] === 'string' ? res.body['git_sha'] : null;
  if (sorted.length > 1) {
    throw new ConfigurationError(`not a supported configuration: ${sorted.length} flags active (${sorted.join(', ')}); at most one is supported`);
  }
  const flag = sorted[0];
  if (flag !== undefined && !config.defect_flags.includes(flag)) {
    throw new ConfigurationError(`not a supported configuration: flag ${flag} is not listed in oracle.yaml defect_flags`);
  }
  return { name: flag ?? CLEAN, flags: sorted, git_sha: gitSha };
}

export function expectedFor(xp: Experiment, configuration: string): Record<string, Verdict> {
  const base = xp.expected['default'] ?? {};
  const override = configuration === CLEAN ? {} : (xp.expected[configuration] ?? {});
  return { ...base, ...override };
}

export function commitMismatch(detected: DetectedConfiguration, config: OracleConfig): string | null {
  if (detected.git_sha !== null && config.target.commit.startsWith(detected.git_sha)) return null;
  if (detected.git_sha !== null && detected.git_sha.startsWith(config.target.commit)) return null;
  return `target reports git_sha ${detected.git_sha ?? 'null'}, oracle.yaml pins ${config.target.commit}; applicability by commit is not evaluated in this milestone`;
}
