import type {
  AgentAutonomy,
  OrganizationId,
  ToolVersion,
  UserId,
  IsoTimestamp,
} from '@melonoffice/domain';
import { SpecialistError } from './errors.js';
import { AGENT_WORK_AUTONOMY, isAgentAutonomy } from './model.js';

/**
 * Which actions are sensitive (AE-4.4, ADR-0116): one policy, read by the Agent Engine before an
 * agent's action runs. A sensitive action always waits on a person, whatever the agent's level of
 * autonomy. The policy reads what each tool declares in the catalogue (ADR-0026): whether it
 * changes anything, where, its category, its action, its risk and its approval policy. Nothing is
 * decided by a tool's name, and no screen or model can make an action less sensitive.
 */

/** Why an action is sensitive: what a person should know before approving it. */
export type SensitiveActionKind =
  | 'irreversible'
  | 'external_action'
  | 'external_communication'
  | 'external_publication'
  | 'financial'
  | 'purchase'
  | 'deletion'
  | 'permission_change'
  | 'configuration_change'
  | 'legal'
  | 'critical_change'
  | 'organization_defined';

/** The catalogue's sensitive categories and actions, as codes a tool declares. */
export interface SensitiveActionCatalogue {
  readonly categories: Readonly<Record<string, SensitiveActionKind>>;
  readonly actions: Readonly<Record<string, SensitiveActionKind>>;
}

/**
 * MelonOffice's own list (Geovet, AE-4.4): money, purchases, deletions, permissions, company
 * settings, publishing, legal acts and anything sent outside. An organization can only add to it.
 */
export const SENSITIVE_ACTIONS: SensitiveActionCatalogue = Object.freeze({
  categories: Object.freeze({
    finance: 'financial',
    payments: 'financial',
    billing: 'financial',
    purchasing: 'purchase',
    legal: 'legal',
    permissions: 'permission_change',
    access: 'permission_change',
    settings: 'configuration_change',
    publishing: 'external_publication',
  }),
  actions: Object.freeze({
    send: 'external_communication',
    publish: 'external_publication',
    pay: 'financial',
    charge: 'financial',
    refund: 'financial',
    purchase: 'purchase',
    delete: 'deletion',
    erase: 'deletion',
    grant: 'permission_change',
    revoke: 'permission_change',
    sign: 'legal',
  }),
});

/**
 * An organization's own rules for its agents (AE-4.4): what it also counts as sensitive, and the
 * furthest any of its agents may act on its own. It only ever adds care: it cannot make an action
 * less sensitive than MelonOffice's list, nor let an agent go further than its own level.
 */
export interface OrganizationAgentPolicy {
  readonly organizationId: OrganizationId;
  /** Tool categories this organization counts as sensitive, e.g. `crm`. */
  readonly sensitiveCategories: readonly string[];
  /** Tool actions this organization counts as sensitive, e.g. `schedule`. */
  readonly sensitiveActions: readonly string[];
  /** Tools this organization counts as sensitive, by id. */
  readonly sensitiveTools: readonly string[];
  /** The furthest any of its agents acts on its own. */
  readonly maxAutonomy: AgentAutonomy;
  readonly revision: number;
  readonly updatedAt: IsoTimestamp;
  readonly updatedBy: UserId;
}

/** What an organization that never set a policy gets: MelonOffice's list, every level allowed. */
export const defaultOrganizationAgentPolicy = (
  organizationId: OrganizationId,
): Pick<
  OrganizationAgentPolicy,
  'organizationId' | 'sensitiveCategories' | 'sensitiveActions' | 'sensitiveTools' | 'maxAutonomy'
> =>
  Object.freeze({
    organizationId,
    sensitiveCategories: Object.freeze([]),
    sensitiveActions: Object.freeze([]),
    sensitiveTools: Object.freeze([]),
    maxAutonomy: 'within_policy',
  });

/** The rules the classification reads from an organization's policy. */
export type SensitivityRules = Pick<
  OrganizationAgentPolicy,
  'sensitiveCategories' | 'sensitiveActions' | 'sensitiveTools'
>;

/**
 * Why a tool's use is sensitive, or nothing when it is not. A tool that changes nothing (a read) is
 * never sensitive. In order: what the catalogue declares irreversible, then MelonOffice's list,
 * then the organization's own, then anything outside MelonOffice or of high risk.
 */
export function sensitivityOf(
  tool: Pick<
    ToolVersion,
    'toolId' | 'category' | 'action' | 'mutating' | 'riskLevel' | 'approvalPolicy' | 'provider'
  >,
  rules?: SensitivityRules,
  catalogue: SensitiveActionCatalogue = SENSITIVE_ACTIONS,
): SensitiveActionKind | undefined {
  if (!tool.mutating) return undefined;
  if (tool.approvalPolicy === 'denied' || tool.riskLevel === 'critical') return 'irreversible';
  const own = catalogue.actions[tool.action] ?? catalogue.categories[tool.category];
  if (own !== undefined) return own;
  if (
    rules !== undefined &&
    (rules.sensitiveTools.includes(tool.toolId) ||
      rules.sensitiveActions.includes(tool.action) ||
      rules.sensitiveCategories.includes(tool.category))
  ) {
    return 'organization_defined';
  }
  if (tool.provider.kind === 'external') return 'external_action';
  if (tool.riskLevel === 'high') return 'critical_change';
  return undefined;
}

const LEVEL_ORDER: Readonly<Record<AgentAutonomy, number>> = Object.freeze({
  propose: 0,
  controlled: 1,
  within_policy: 2,
});

/** The stricter of two levels: an organization's maximum always wins over an agent's own. */
export const stricterAgentAutonomy = (a: AgentAutonomy, b: AgentAutonomy): AgentAutonomy =>
  LEVEL_ORDER[a] <= LEVEL_ORDER[b] ? a : b;

/** The most entries one list of an organization's policy holds. */
export const MAX_POLICY_ENTRIES = 50;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

const bad = (field: string): never => {
  throw new SpecialistError('invalid_specialist', field);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function codes(value: unknown, field: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_POLICY_ENTRIES) return bad(field);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !CODE.test(entry) || seen.has(entry)) bad(field);
    seen.add(entry as string);
  }
  return Object.freeze([...seen].sort());
}

/**
 * Checks a person's change to the organization's policy: `{ revision, sensitiveCategories?,
 * sensitiveActions?, sensitiveTools?, maxAutonomy? }`, each list of plain codes. `revision` is the
 * one the person read (0 when there was none), so two people never overwrite each other.
 */
export function checkAgentPolicyChange(input: unknown): {
  readonly revision: number;
  readonly policy: SensitivityRules & { readonly maxAutonomy: AgentAutonomy };
} {
  if (!isRecord(input)) return bad('body');
  const keys = [
    'revision',
    'sensitiveCategories',
    'sensitiveActions',
    'sensitiveTools',
    'maxAutonomy',
  ];
  for (const key of Object.keys(input)) if (!keys.includes(key)) bad(key);
  const { revision, maxAutonomy } = input;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    bad('revision');
  }
  if (maxAutonomy !== undefined && !isAgentAutonomy(maxAutonomy)) bad('maxAutonomy');
  return Object.freeze({
    revision: revision as number,
    policy: Object.freeze({
      sensitiveCategories: codes(input.sensitiveCategories, 'sensitiveCategories'),
      sensitiveActions: codes(input.sensitiveActions, 'sensitiveActions'),
      sensitiveTools: codes(input.sensitiveTools, 'sensitiveTools'),
      maxAutonomy: (maxAutonomy as AgentAutonomy | undefined) ?? 'within_policy',
    }),
  });
}

/** A stored policy, checked, not trusted: a malformed record is refused, never repaired. */
export function checkStoredAgentPolicy(value: OrganizationAgentPolicy): OrganizationAgentPolicy {
  const { policy } = checkAgentPolicyChange({
    revision: value.revision,
    sensitiveCategories: value.sensitiveCategories,
    sensitiveActions: value.sensitiveActions,
    sensitiveTools: value.sensitiveTools,
    maxAutonomy: value.maxAutonomy,
  });
  if (value.revision < 1 || !AGENT_WORK_AUTONOMY.includes(policy.maxAutonomy)) {
    bad('stored_policy');
  }
  return Object.freeze({ ...value, ...policy });
}
