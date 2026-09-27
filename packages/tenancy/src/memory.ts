import type {
  IsoTimestamp,
  Membership,
  Organization,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import type { InMemoryAuditStore } from '@melonoffice/audit';
import { TenancyError } from './errors.js';
import { membershipIdOf, newOrganizationId, OWNER_ROLE } from './ids.js';
import type { CreatedOrganization, NewOrganization, TenancyStore } from './store.js';

/** For tests and local runs only: everything is lost on restart and not shared between instances. */
export class InMemoryTenancyStore implements TenancyStore {
  readonly #organizations = new Map<OrganizationId, Organization>();
  readonly #memberships = new Map<string, Membership>();
  readonly #creators = new Set<UserId>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    /** Receives creation audit events in the same step as the data. */
    private readonly audit?: InMemoryAuditStore,
  ) {}

  // No await before the writes, so concurrent calls cannot both pass the creator check.
  async createOrganization({
    name,
    creator,
    plan,
    audit,
  }: NewOrganization): Promise<CreatedOrganization> {
    if (this.#creators.has(creator)) throw new TenancyError('organization_limit_reached');
    const at = this.now().toISOString() as IsoTimestamp;
    const organization: Organization = Object.freeze({
      id: newOrganizationId(),
      name,
      status: 'active',
      createdBy: creator,
      plan: Object.freeze({ id: plan.id, version: plan.version }),
      createdAt: at,
      updatedAt: at,
    });
    const membership: Membership = Object.freeze({
      id: membershipIdOf(organization.id, creator),
      organizationId: organization.id,
      userId: creator,
      status: 'active',
      role: OWNER_ROLE,
      createdAt: at,
      updatedAt: at,
    });
    const events = audit?.({ organization, membership }) ?? [];
    if (events.length > 0) {
      if (this.audit === undefined) throw new Error('no audit store for creation events');
      this.audit.appendNow(events);
    }
    this.#creators.add(creator);
    this.#organizations.set(organization.id, organization);
    this.#memberships.set(membership.id, membership);
    return { organization, membership };
  }

  async findOrganization(id: OrganizationId): Promise<Organization | undefined> {
    return this.#organizations.get(id);
  }

  async findMembership(
    organizationId: OrganizationId,
    userId: UserId,
  ): Promise<Membership | undefined> {
    return this.#memberships.get(membershipIdOf(organizationId, userId));
  }

  async membershipsOfUser(userId: UserId): Promise<readonly Membership[]> {
    return [...this.#memberships.values()].filter((m) => m.userId === userId);
  }

  /** Test hook: stores a membership or organization as given, e.g. suspended or for a second user. */
  put(record: Organization | Membership): void {
    if ('userId' in record) this.#memberships.set(record.id, Object.freeze({ ...record }));
    else this.#organizations.set(record.id, Object.freeze({ ...record }));
  }
}
