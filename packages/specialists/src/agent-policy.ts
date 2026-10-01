import { actorOf, buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import { activeOrganizationOf, isDepartmentError } from '@melonoffice/departments';
import type { IsoTimestamp, OrganizationId } from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import {
  checkAgentPolicyChange,
  checkStoredAgentPolicy,
  defaultOrganizationAgentPolicy,
  type OrganizationAgentPolicy,
} from './action-policy.js';
import { SpecialistError } from './errors.js';

/**
 * An organization's rules for its agents (AE-4.4, ADR-0116): `agentPolicies/{organizationId}`,
 * one per organization, written only by the API with its audit event in the same transaction.
 * An organization that never set one has MelonOffice's defaults, and nothing is stored for it.
 */

export interface AgentPolicyWrite {
  readonly policy: OrganizationAgentPolicy;
  readonly events: readonly AuditEvent[];
}

export interface AgentPolicyRepository {
  find(organizationId: OrganizationId): Promise<OrganizationAgentPolicy | undefined>;
  /**
   * Reads the current policy and stores what `change` returns, with its events, in one
   * transaction. The new revision must be the current one plus one.
   */
  save(
    organizationId: OrganizationId,
    change: (current: OrganizationAgentPolicy | undefined) => AgentPolicyWrite,
  ): Promise<OrganizationAgentPolicy>;
}

export class InMemoryAgentPolicyRepository implements AgentPolicyRepository {
  readonly #policies = new Map<string, OrganizationAgentPolicy>();

  constructor(private readonly audit?: { append(events: readonly AuditEvent[]): Promise<void> }) {}

  async find(organizationId: OrganizationId): Promise<OrganizationAgentPolicy | undefined> {
    const found = this.#policies.get(organizationId);
    return found?.organizationId === organizationId ? checkStoredAgentPolicy(found) : undefined;
  }

  async save(
    organizationId: OrganizationId,
    change: (current: OrganizationAgentPolicy | undefined) => AgentPolicyWrite,
  ): Promise<OrganizationAgentPolicy> {
    const current = await this.find(organizationId);
    const write = change(current);
    if (write.policy.organizationId !== organizationId) throw new Error('policy organization');
    if (write.policy.revision !== (current?.revision ?? 0) + 1) {
      throw new SpecialistError('specialist_concurrency_conflict');
    }
    await this.audit?.append(write.events);
    this.#policies.set(organizationId, checkStoredAgentPolicy(write.policy));
    return write.policy;
  }
}

/** The policy as a screen shows it: the stored one, or the defaults at revision 0. */
export type AgentPolicyView = Omit<OrganizationAgentPolicy, 'updatedAt' | 'updatedBy'> & {
  readonly updatedAt: IsoTimestamp | null;
};

export interface AgentPolicyService {
  /** `specialist.read`: the organization's rules for its agents. */
  read(tenant: TenantContext): Promise<AgentPolicyView>;
  /**
   * `specialist.manage`, a person directly: replaces the organization's rules. `{ revision,
   * sensitiveCategories?, sensitiveActions?, sensitiveTools?, maxAutonomy? }`; `revision` is the
   * one read, so two people never overwrite each other.
   */
  change(tenant: TenantContext, input: unknown): Promise<AgentPolicyView>;
}

/** Where the Agent Engine reads an organization's rules before an agent acts (no person needed). */
export interface AgentPolicySource {
  forOrganization(
    organizationId: OrganizationId,
  ): Promise<
    Pick<
      OrganizationAgentPolicy,
      'sensitiveCategories' | 'sensitiveActions' | 'sensitiveTools' | 'maxAutonomy'
    >
  >;
}

export function createAgentPolicySource(
  repository: Pick<AgentPolicyRepository, 'find'>,
): AgentPolicySource {
  return Object.freeze({
    async forOrganization(organizationId: OrganizationId) {
      return (
        (await repository.find(organizationId)) ?? defaultOrganizationAgentPolicy(organizationId)
      );
    },
  });
}

const viewOf = (
  organizationId: OrganizationId,
  policy: OrganizationAgentPolicy | undefined,
): AgentPolicyView =>
  policy === undefined
    ? Object.freeze({
        ...defaultOrganizationAgentPolicy(organizationId),
        revision: 0,
        updatedAt: null,
      })
    : Object.freeze({
        organizationId: policy.organizationId,
        sensitiveCategories: policy.sensitiveCategories,
        sensitiveActions: policy.sensitiveActions,
        sensitiveTools: policy.sensitiveTools,
        maxAutonomy: policy.maxAutonomy,
        revision: policy.revision,
        updatedAt: policy.updatedAt,
      });

export function createAgentPolicyService(options: {
  readonly repository: AgentPolicyRepository;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly now?: () => Date;
  readonly requestId?: string;
}): AgentPolicyService {
  const { repository, organizations, authorization, requestId } = options;
  const now = options.now ?? (() => new Date());

  async function organizationOf(
    tenant: TenantContext,
    permission: 'specialist.read' | 'specialist.manage',
  ): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new SpecialistError('unresolved_tenant');
    if (!authorization.authorize(tenant, permission).allowed) {
      throw new SpecialistError('permission_denied');
    }
    // Changing the rules is a person's decision: never GIA, never the runtime.
    if (permission === 'specialist.manage' && tenant.actor !== 'user') {
      throw new SpecialistError('permission_denied');
    }
    try {
      return await activeOrganizationOf(tenant, organizations);
    } catch (error) {
      if (!isDepartmentError(error)) throw error;
      throw new SpecialistError(
        error.code === 'unresolved_tenant' ? 'unresolved_tenant' : 'organization_inactive',
      );
    }
  }

  const service: AgentPolicyService = {
    async read(tenant) {
      const organizationId = await organizationOf(tenant, 'specialist.read');
      return viewOf(organizationId, await repository.find(organizationId));
    },

    async change(tenant, input) {
      const organizationId = await organizationOf(tenant, 'specialist.manage');
      if (!isResolvedTenant(tenant)) throw new SpecialistError('unresolved_tenant');
      const { revision, policy } = checkAgentPolicyChange(input);
      const at = now();
      const saved = await repository.save(organizationId, (current) => {
        if ((current?.revision ?? 0) !== revision) {
          throw new SpecialistError('specialist_concurrency_conflict');
        }
        const next: OrganizationAgentPolicy = Object.freeze({
          organizationId,
          ...policy,
          revision: revision + 1,
          updatedAt: at.toISOString() as IsoTimestamp,
          updatedBy: tenant.userId,
        });
        const before = current?.maxAutonomy ?? 'within_policy';
        return {
          policy: next,
          events: [
            buildAuditEvent(
              {
                action: 'agent_policy.changed',
                result: 'success',
                actor: actorOf(tenant),
                organizationId,
                target: { type: 'agent_policy', id: organizationId },
                targetVersion: next.revision,
                permission: 'specialist.manage',
                transition: { from: before, to: next.maxAutonomy },
                ...(requestId === undefined ? {} : { requestId }),
                source: 'api',
              },
              at,
            ),
          ],
        };
      });
      return viewOf(organizationId, saved);
    },
  };
  return Object.freeze(service);
}
