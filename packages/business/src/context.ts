import type {
  BusinessProfile,
  CompanyContextSection,
  CompanyContextSnapshot,
  IsoTimestamp,
} from '@melonoffice/domain';

/**
 * The business profile as the first real source of the Company Context (ADR-0048, ADR-0029).
 * There is still no Context Engine: this module turns the stored profile into
 *
 * - `companyContextSnapshotOf`: the versioned reference an execution records (which company facts
 *   it ran with), pointing at the profile, never copying it;
 * - `businessFactsOf`: the facts themselves, for GIA to answer with. Only what the owner wrote
 *   in the profile and the organization's name: nothing is inferred or completed.
 */

/** The sections of the Company Context the profile fills in today. */
export const PROFILE_CONTEXT_SECTIONS = [
  'identity',
  'industry',
  'markets',
  'preferences',
  'products',
  'priorities',
] as const satisfies readonly CompanyContextSection[];

export function companyContextSnapshotOf(profile: BusinessProfile): CompanyContextSnapshot {
  const pointer = Object.freeze({ type: 'business_profile', id: profile.organizationId });
  const sections: Partial<Record<CompanyContextSection, typeof pointer>> = {};
  for (const section of PROFILE_CONTEXT_SECTIONS) {
    // Products and priorities come only from what the owner chose to write.
    if (section === 'products' && profile.offering === undefined) continue;
    if (section === 'priorities' && profile.needs === undefined) continue;
    sections[section] = pointer;
  }
  return Object.freeze({
    schemaVersion: 1,
    organizationId: profile.organizationId,
    ref: Object.freeze({
      kind: 'company_context',
      id: `business_profile:${profile.organizationId}`,
      version: String(profile.revision),
    }),
    createdAt: profile.updatedAt as IsoTimestamp,
    sections: Object.freeze(sections),
  });
}

/** What GIA knows about the business, exactly as stored. Optional facts are absent, not guessed. */
export interface BusinessFacts {
  readonly name: string;
  readonly businessType: string;
  readonly country: string;
  readonly currency: string;
  readonly city: string;
  readonly timeZone: string;
  readonly employees?: string;
  readonly salesChannels?: readonly string[];
  readonly offering?: string;
  readonly needs?: string;
}

export function businessFactsOf(organizationName: string, profile: BusinessProfile): BusinessFacts {
  return Object.freeze({
    name: organizationName,
    businessType: profile.businessType,
    country: profile.country,
    currency: profile.currency,
    city: profile.city,
    timeZone: profile.timeZone,
    ...(profile.employees === undefined ? {} : { employees: profile.employees }),
    ...(profile.salesChannels === undefined
      ? {}
      : { salesChannels: Object.freeze([...profile.salesChannels]) }),
    ...(profile.offering === undefined ? {} : { offering: profile.offering }),
    ...(profile.needs === undefined ? {} : { needs: profile.needs }),
  });
}
