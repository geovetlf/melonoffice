import type {
  AIDataPolicy,
  AIDataPolicyEntry,
  DataSensitivity,
  DeploymentEnvironment,
} from '@melonoffice/domain';
import { isDeploymentEnvironment } from '@melonoffice/tools';
import { AIConfigError } from './errors.js';
import { sensitivityRank } from './registry.js';
import { SENSITIVITIES } from './request.js';

const ID = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,63}$/;

const invalid = (detail: string): never => {
  throw new AIConfigError(`data_policy.${detail}`);
};

/**
 * Checks a data policy when it is loaded (ADR-0100): known providers' ids, environments and
 * sensitivities, and one entry per provider and environment, so no two entries can disagree.
 */
export function checkDataPolicy(policy: AIDataPolicy): AIDataPolicy {
  if (!ID.test(policy.id)) invalid('id');
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) invalid('version');
  if (!Array.isArray(policy.entries)) invalid('entries');
  const seen = new Set<string>();
  for (const entry of policy.entries) {
    if (typeof entry.provider !== 'string' || !PROVIDER.test(entry.provider)) invalid('provider');
    if (!isDeploymentEnvironment(entry.environment)) invalid('environment');
    if (!(SENSITIVITIES as readonly string[]).includes(entry.maxSensitivity)) {
      invalid('maxSensitivity');
    }
    const key = `${entry.provider}@${entry.environment}`;
    if (seen.has(key)) invalid(`duplicate:${key}`);
    seen.add(key);
  }
  return Object.freeze({
    id: policy.id,
    version: policy.version,
    entries: Object.freeze(policy.entries.map((e) => Object.freeze({ ...e }))),
  });
}

/**
 * Whether the data policy lets `sensitivity` reach `provider` in `environment`. A provider with no
 * entry is left to its recorded terms, which the router checks next in any case.
 */
export function dataPolicyAllows(
  policy: AIDataPolicy | undefined,
  provider: string,
  environment: DeploymentEnvironment,
  sensitivity: DataSensitivity,
): boolean {
  const entry = policy?.entries.find(
    (e) => e.provider === provider && e.environment === environment,
  );
  return (
    entry === undefined || sensitivityRank(sensitivity) <= sensitivityRank(entry.maxSensitivity)
  );
}

/**
 * A server's data policy: its defaults, with the entries of `AI_DATA_POLICY` for this environment
 * in place of the defaults for the same providers. The variable is `provider:sensitivity` pairs,
 * comma separated (`nvidia:public,deepseek:internal`). A malformed value refuses to start the
 * server rather than guess.
 */
export function dataPolicyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  environment: DeploymentEnvironment,
  defaults: AIDataPolicy,
): AIDataPolicy {
  const raw = env.AI_DATA_POLICY?.trim();
  if (raw === undefined || raw === '') return checkDataPolicy(defaults);
  const given: AIDataPolicyEntry[] = raw.split(',').map((pair) => {
    const [provider, maxSensitivity, extra] = pair.trim().split(':');
    if (extra !== undefined || provider === undefined || maxSensitivity === undefined) {
      return invalid('env');
    }
    return { provider, environment, maxSensitivity: maxSensitivity as DataSensitivity };
  });
  const replaced = new Set(given.map((e) => e.provider));
  return checkDataPolicy({
    id: defaults.id,
    version: defaults.version,
    entries: [
      ...defaults.entries.filter(
        (e) => !(e.environment === environment && replaced.has(e.provider)),
      ),
      ...given,
    ],
  });
}
