import type { AIDataPolicy, AIDataPolicyEntry, DataSensitivity } from '@melonoffice/domain';

/**
 * What a task's data is (ADR-0100, Geovet 2026-09-30). The data policy is applied before routing:
 * the AI Gateway never considers a provider the data may not reach.
 *
 * - `public`, `synthetic` and `test`: data anyone may see, made up, or made for testing;
 * - `company_private`: anything of an organization (its CRM, customers, finances, documents,
 *   team, and the owner's own words about the business).
 *
 * Every task a person or an agent gives today is `company_private`: the Harness never lowers a
 * task's data on what the request says, so private data can never be sent where it may not go by
 * being described as public.
 */
export type HarnessDataClass = 'public' | 'synthetic' | 'test' | 'company_private';

const SENSITIVITY: Readonly<Record<HarnessDataClass, DataSensitivity>> = Object.freeze({
  public: 'public',
  synthetic: 'public',
  test: 'public',
  company_private: 'confidential',
});

/** The sensitivity the AI Gateway routes a data class at. */
export const sensitivityOfData = (data: HarnessDataClass): DataSensitivity => SENSITIVITY[data];

/** The data policy's id and version, recorded with each server's configuration. */
export const HARNESS_DATA_POLICY_REF = Object.freeze({ id: 'ai_data', version: 1 });

/**
 * A data policy from its entries: which providers may receive which data, per environment. The
 * entries are configuration given by each server (and `AI_DATA_POLICY`), never a branch in code.
 */
export const harnessDataPolicy = (entries: readonly AIDataPolicyEntry[]): AIDataPolicy =>
  Object.freeze({
    id: HARNESS_DATA_POLICY_REF.id,
    version: HARNESS_DATA_POLICY_REF.version,
    entries: Object.freeze(entries.map((e) => Object.freeze({ ...e }))),
  });
