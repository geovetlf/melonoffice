import { actorOf, buildAuditEvent } from '@melonoffice/audit';
import type {
  BusinessProfile,
  DepartmentTypeId,
  IsoTimestamp,
  OrganizationId,
} from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { DEFAULT_BUSINESS_TYPE_CATALOGUE, type BusinessTypeCatalogue } from './catalogue.js';
import { BusinessError } from './errors.js';
import { checkProfileContent, nextProfile, sameContent } from './profile.js';
import type { BusinessProfileRepository } from './repository.js';

/** The organization's profile as the app reads it. */
export interface BusinessProfileRead {
  /** Absent until someone in the organization fills it in. */
  readonly profile?: BusinessProfile;
  /** The order its departments are suggested in: its business type's, or the general one. */
  readonly departmentPriority: readonly DepartmentTypeId[];
}

export interface BusinessProfileService {
  /** `organization.read`: anyone who can see the organization, GIA included. */
  get(tenant: TenantContext): Promise<BusinessProfileRead>;
  /**
   * `organization.update`, by a person acting directly. Creates or replaces the whole profile;
   * the same content again changes nothing and records nothing.
   */
  save(tenant: TenantContext, input: unknown): Promise<BusinessProfileRead>;
}

export interface BusinessProfileServiceOptions {
  readonly repository: BusinessProfileRepository;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly catalogue?: BusinessTypeCatalogue;
  readonly now?: () => Date;
  readonly requestId?: string;
}

/** The order for a profile's type; the general order when there is none. */
export function departmentPriorityOf(
  profile: BusinessProfile | undefined,
  catalogue: BusinessTypeCatalogue = DEFAULT_BUSINESS_TYPE_CATALOGUE,
): readonly DepartmentTypeId[] {
  const type = profile === undefined ? undefined : catalogue.find(profile.businessType);
  return (type ?? catalogue.find('other'))?.departmentPriority ?? [];
}

export function createBusinessProfileService(
  options: BusinessProfileServiceOptions,
): BusinessProfileService {
  const {
    repository,
    organizations,
    authorization,
    catalogue = DEFAULT_BUSINESS_TYPE_CATALOGUE,
    now = () => new Date(),
    requestId,
  } = options;

  async function organizationOf(
    tenant: TenantContext,
    permission: string,
    direct: boolean,
  ): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new BusinessError('unresolved_tenant');
    if (!authorization.authorize(tenant, permission).allowed) {
      throw new BusinessError('permission_denied');
    }
    if (direct && tenant.actor !== 'user') throw new BusinessError('requires_user');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new BusinessError('organization_inactive');
    }
    return organization.id;
  }

  const read = (profile: BusinessProfile | undefined): BusinessProfileRead =>
    Object.freeze({
      ...(profile === undefined ? {} : { profile }),
      departmentPriority: departmentPriorityOf(profile, catalogue),
    });

  const service: BusinessProfileService = {
    async get(tenant) {
      const organizationId = await organizationOf(tenant, 'organization.read', false);
      return read(await repository.find(organizationId));
    },

    async save(tenant, input) {
      const organizationId = await organizationOf(tenant, 'organization.update', true);
      const content = checkProfileContent(input, catalogue);
      const at = now();
      const saved = await repository.save(organizationId, (current) => {
        if (current !== undefined && sameContent(current, content)) return undefined;
        const profile = nextProfile(
          organizationId,
          current,
          content,
          tenant.userId,
          at.toISOString() as IsoTimestamp,
        );
        // Which kind of business it is, never what the owner wrote about it.
        const event = buildAuditEvent(
          {
            action: 'organization.profile_updated',
            result: 'success',
            actor: actorOf(tenant),
            organizationId,
            target: { type: 'organization', id: organizationId },
            reference: `business_type:${content.businessType}`,
            reason: current === undefined ? 'created' : 'updated',
            ...(requestId === undefined ? {} : { requestId }),
            source: 'api',
          },
          at,
        );
        return { profile, events: [event] };
      });
      return read(saved);
    },
  };
  return Object.freeze(service);
}
