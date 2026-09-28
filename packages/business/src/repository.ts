import type { AuditEvent } from '@melonoffice/audit';
import type { BusinessProfile, OrganizationId } from '@melonoffice/domain';
import { checkStoredProfile } from './profile.js';

/** A profile to store, with the audit events that record it: both, or neither. */
export interface ProfileWrite {
  readonly profile: BusinessProfile;
  readonly events: readonly AuditEvent[];
}

/**
 * Where business profiles live: `businessProfiles/{organizationId}` in Firestore (ADR-0048),
 * memory in tests. One per organization; another organization's is absent.
 */
export interface BusinessProfileRepository {
  find(organizationId: OrganizationId): Promise<BusinessProfile | undefined>;
  /**
   * Reads the current profile and stores what `change` returns, with its events, in one
   * transaction. `change` returning `undefined` stores nothing.
   */
  save(
    organizationId: OrganizationId,
    change: (current: BusinessProfile | undefined) => ProfileWrite | undefined,
  ): Promise<BusinessProfile | undefined>;
}

/** For tests and local runs only. */
export class InMemoryBusinessProfileRepository implements BusinessProfileRepository {
  readonly #profiles = new Map<string, BusinessProfile>();

  constructor(private readonly audit: { append(events: readonly AuditEvent[]): Promise<void> }) {}

  async find(organizationId: OrganizationId): Promise<BusinessProfile | undefined> {
    const profile = this.#profiles.get(organizationId);
    return profile?.organizationId === organizationId ? checkStoredProfile(profile) : undefined;
  }

  async save(
    organizationId: OrganizationId,
    change: (current: BusinessProfile | undefined) => ProfileWrite | undefined,
  ): Promise<BusinessProfile | undefined> {
    const current = await this.find(organizationId);
    const write = change(current);
    if (write === undefined) return current;
    if (write.profile.organizationId !== organizationId) throw new Error('profile organization');
    if (write.profile.revision !== (current?.revision ?? 0) + 1) {
      throw new Error('profile_concurrency_conflict');
    }
    await this.audit.append(write.events);
    this.#profiles.set(organizationId, checkStoredProfile(write.profile));
    return write.profile;
  }
}
