import type {
  KnowledgeDomain,
  KnowledgeSensitivity,
  KnowledgeSubjectType,
} from '@melonoffice/domain';

/**
 * What Company Brain knows how to hold, as data (ADR-0051): the domains, how sensitive each is,
 * which facts a person must confirm, who may read what, and what GIA should learn first. Adding a
 * domain, a key or a department's access is a change here, not in the service.
 */

export interface DomainDefinition {
  /** The sensitivity of its items unless a key says otherwise. */
  readonly sensitivity: KnowledgeSensitivity;
  /** Every item needs a person's confirmation before it counts as confirmed. */
  readonly critical: boolean;
}

export const KNOWLEDGE_DOMAINS: Readonly<Record<KnowledgeDomain, DomainDefinition>> = Object.freeze(
  {
    identity: { sensitivity: 'internal', critical: false },
    business_model: { sensitivity: 'internal', critical: false },
    products: { sensitivity: 'internal', critical: false },
    customers: { sensitivity: 'confidential', critical: false },
    commercial: { sensitivity: 'internal', critical: false },
    marketing: { sensitivity: 'internal', critical: false },
    brand: { sensitivity: 'internal', critical: false },
    operations: { sensitivity: 'internal', critical: false },
    finance: { sensitivity: 'restricted', critical: true },
    team: { sensitivity: 'confidential', critical: false },
    policies: { sensitivity: 'internal', critical: true },
    goals: { sensitivity: 'internal', critical: false },
    documents: { sensitivity: 'internal', critical: false },
    integrations: { sensitivity: 'internal', critical: false },
    decisions: { sensitivity: 'confidential', critical: true },
  },
);

export const DOMAIN_IDS = Object.freeze(Object.keys(KNOWLEDGE_DOMAINS) as KnowledgeDomain[]);

export const isKnowledgeDomain = (value: unknown): value is KnowledgeDomain =>
  typeof value === 'string' && Object.hasOwn(KNOWLEDGE_DOMAINS, value);

/** Keys that differ from their domain's defaults: `domain.key`. */
export const KEY_OVERRIDES: Readonly<
  Record<string, { readonly sensitivity?: KnowledgeSensitivity; readonly critical?: boolean }>
> = Object.freeze({
  'identity.legal_name': { critical: true },
  'identity.tax_id': { sensitivity: 'confidential', critical: true },
  'identity.jurisdiction': { critical: true },
  'products.price': { critical: true },
  'products.cost': { sensitivity: 'restricted', critical: true },
  'products.margin': { sensitivity: 'restricted', critical: true },
  // A segment describes a group, not a person: marketing may read it.
  'customers.segment': { sensitivity: 'internal' },
  'customers.target_segment': { sensitivity: 'internal' },
  'finance.currency': { sensitivity: 'internal', critical: false },
  'team.size': { sensitivity: 'internal' },
  'team.departments': { sensitivity: 'internal' },
  'team.agents': { sensitivity: 'internal' },
});

export function classify(
  domain: KnowledgeDomain,
  key: string,
): { readonly sensitivity: KnowledgeSensitivity; readonly critical: boolean } {
  const base = KNOWLEDGE_DOMAINS[domain];
  const override = KEY_OVERRIDES[`${domain}.${key}`];
  return {
    sensitivity: override?.sensitivity ?? base.sensitivity,
    critical: override?.critical ?? base.critical,
  };
}

export const SUBJECT_TYPES: readonly KnowledgeSubjectType[] = Object.freeze([
  'product',
  'service',
  'segment',
  'campaign',
  'location',
  'supplier',
  'process',
  'policy',
  'goal',
  'decision',
  'channel',
  'competitor',
  'document',
]);

const SENSITIVITY_ORDER: readonly KnowledgeSensitivity[] = [
  'internal',
  'confidential',
  'restricted',
];

export const sensitivityAllows = (
  ceiling: KnowledgeSensitivity,
  sensitivity: KnowledgeSensitivity,
): boolean => SENSITIVITY_ORDER.indexOf(sensitivity) <= SENSITIVITY_ORDER.indexOf(ceiling);

/**
 * Who a piece of context is for. `gia` coordinates, so it may see every domain the person may
 * see; a department's agents see only what their work needs (least privilege).
 */
export type ContextPurpose = 'gia' | (string & {});

export interface PurposeAccess {
  readonly domains: readonly KnowledgeDomain[];
  readonly maxSensitivity: KnowledgeSensitivity;
}

/**
 * What each department's agents may read. A department not listed here reads nothing: a new one
 * gets its access by a decision, here, never by default.
 */
export const DEPARTMENT_ACCESS: Readonly<Record<string, PurposeAccess>> = Object.freeze({
  leadership: { domains: DOMAIN_IDS, maxSensitivity: 'restricted' },
  sales: {
    domains: [
      'identity',
      'business_model',
      'products',
      'customers',
      'commercial',
      'brand',
      'policies',
      'goals',
      'integrations',
    ],
    maxSensitivity: 'confidential',
  },
  marketing: {
    domains: [
      'identity',
      'business_model',
      'products',
      'customers',
      'marketing',
      'brand',
      'goals',
      'documents',
    ],
    maxSensitivity: 'internal',
  },
  operations: {
    domains: [
      'identity',
      'business_model',
      'products',
      'operations',
      'team',
      'policies',
      'goals',
      'integrations',
    ],
    maxSensitivity: 'confidential',
  },
  finance: {
    domains: [
      'identity',
      'business_model',
      'products',
      'finance',
      'goals',
      'policies',
      'decisions',
      'integrations',
    ],
    maxSensitivity: 'restricted',
  },
  research: {
    domains: ['identity', 'business_model', 'products', 'customers', 'marketing', 'brand', 'goals'],
    maxSensitivity: 'internal',
  },
});

/**
 * What GIA should learn first, in order, one question at a time during normal use. A question
 * whose key already holds an active item is not asked again (it may be confirmed instead).
 */
export const ONBOARDING_QUESTIONS: readonly {
  readonly id: string;
  readonly domain: KnowledgeDomain;
  readonly key: string;
}[] = Object.freeze([
  { id: 'what_you_do', domain: 'business_model', key: 'description' },
  { id: 'main_products', domain: 'products', key: 'main_products' },
  { id: 'customers', domain: 'customers', key: 'target_segment' },
  { id: 'areas', domain: 'business_model', key: 'service_areas' },
  { id: 'goals', domain: 'goals', key: 'main_goal' },
  { id: 'tone', domain: 'brand', key: 'tone_of_voice' },
]);

/** Hard bounds that keep one call cheap, whatever the plan. */
export const LIMITS = Object.freeze({
  keyLength: 48,
  subjectIdLength: 64,
  labelLength: 100,
  textLength: 1000,
  listItems: 30,
  listItemLength: 120,
  relations: 20,
  batch: 50,
  /** The most facts one context retrieval returns. */
  contextFacts: 40,
  /** The most items read from storage for one retrieval or list. */
  readWindow: 1000,
  documentCharacters: 60_000,
  documentName: 200,
});
