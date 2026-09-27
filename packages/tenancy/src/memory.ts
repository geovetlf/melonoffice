import type {
  Department,
  InitialBilling,
  IsoTimestamp,
  Membership,
  Organization,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import type { InMemoryAuditStore } from '@melonoffice/audit';
import { TenancyError } from './errors.js';
import { membershipIdOf, newOrganizationId, OWNER_ROLE } from './ids.js';
import {
  checkInitialBilling,
  checkInitialDepartments,
  type CreatedOrganization,
  type NewOrganization,
  type TenancyStore,
} from './store.js';

/** Where the memory store puts a new organization's billing (the billing package's memory store). */
export interface InitialBillingSink {
  openNow(billing: InitialBilling): void;
}

/** Where the memory store puts a new organization's departments (the departments package's memory store). */
export interface InitialDepartmentsSink {
  openNow(departments: readonly Department[]): void;
}

/** For tests and local runs only: everything is lost on restart and not shared between instances. */
export class InMemoryTenancyStore implements TenancyStore {
  readonly #organizations = new Map<OrganizationId, Organization>();
  readonly #memberships = new Map<string, Membership>();
  readonly #creators = new Set<UserId>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    /** Receives creation audit events in the same step as the data. */
    private readonly audit?: InMemoryAuditStore,
    /** Receives the new organization's billing in the same step. Without it, billing is not kept. */
    private readonly billingSink?: InitialBillingSink,
    /** Receives the new organization's departments in the same step. Without it, they are not kept. */
    private readonly departmentsSink?: InitialDepartmentsSink,
  ) {}

  // No await before the writes, so concurrent calls cannot both pass the creator check.
  async createOrganization({
    name,
    creator,
    billing,
    departments,
    audit,
  }: NewOrganization): Promise<CreatedOrganization> {
    if (this.#creators.has(creator)) throw new TenancyError('organization_limit_reached');
    const at = this.now().toISOString() as IsoTimestamp;
    const organization: Organization = Object.freeze({
      id: newOrganizationId(),
      name,
      status: 'active',
      createdBy: creator,
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
    const initialBilling = billing(organization);
    checkInitialBilling(organization, initialBilling);
    const initialDepartments = departments?.(organization) ?? [];
    checkInitialDepartments(organization, initialDepartments);
    const created = {
      organization,
      membership,
      billing: initialBilling,
      departments: initialDepartments,
    };
    const events = audit?.(created) ?? [];
    if (events.length > 0) {
      if (this.audit === undefined) throw new Error('no audit store for creation events');
      this.audit.appendNow(events);
    }
    this.billingSink?.openNow(initialBilling);
    this.departmentsSink?.openNow(initialDepartments);
    this.#creators.add(creator);
    this.#organizations.set(organization.id, organization);
    this.#memberships.set(membership.id, membership);
    return created;
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
