import type { DepartmentTypeId, IsoTimestamp, MessageKey, OrganizationId, UserId } from './ids.js';

/** A kind of business from the catalogue, e.g. `restaurant` (ADR-0048). */
export type BusinessTypeId = string & { readonly __brand: 'BusinessTypeId' };

/**
 * A kind of business the product knows. It is data: its departments' order is a suggestion for
 * that kind of business, never a restriction. Departments missing from the list come after it.
 */
export interface BusinessType {
  readonly id: BusinessTypeId;
  readonly nameKey: MessageKey;
  readonly departmentPriority: readonly DepartmentTypeId[];
}

/** Roughly how many people work in the business. */
export type EmployeeRange = '1' | '2_5' | '6_10' | '11_50' | '51_plus';

/** Where the business sells. */
export type SalesChannel =
  | 'physical_store'
  | 'whatsapp'
  | 'social_media'
  | 'website'
  | 'marketplace'
  | 'delivery_apps'
  | 'phone'
  | 'in_person';

/**
 * What the business is, as its owner describes it (ADR-0048). One per organization, at
 * `businessProfiles/{organizationId}`. The business's name is the organization's name.
 *
 * Required: type, country (ISO 3166-1 alpha-2), currency (ISO 4217), city and time zone (IANA), which
 * later features such as Today/Week/Month use. Everything else is optional.
 */
export interface BusinessProfile {
  readonly organizationId: OrganizationId;
  readonly businessType: BusinessTypeId;
  readonly country: string;
  readonly currency: string;
  readonly timeZone: string;
  readonly city: string;
  readonly employees?: EmployeeRange;
  readonly salesChannels?: readonly SalesChannel[];
  /** What it sells, in the owner's words. */
  readonly offering?: string;
  /** What it needs most, in the owner's words. */
  readonly needs?: string;
  /** Anything else the owner wants MelonOffice to know. */
  readonly notes?: string;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly updatedBy: UserId;
}
