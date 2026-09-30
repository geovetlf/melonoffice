import type {
  BrandConfig,
  BrandLevel,
  CommercialAccountId,
  DomainTarget,
  Organization,
  OrganizationId,
} from '@melonoffice/domain';
import {
  isCommercialAccountId,
  isOrganizationId,
  type CommercialRepository,
} from '@melonoffice/tenancy';
import { parseHostname } from './domains.js';
import type { BrandRepository } from './repository.js';

/**
 * MelonOffice's own presentation: the first level, in code. It names only what the product
 * already shows (its name, GIA, its colors); links, contacts and a default language are left to
 * whoever has them, never invented.
 */
export const PLATFORM_BRAND: BrandConfig = Object.freeze({
  brandName: 'MelonOffice',
  productName: 'MelonOffice',
  assistantName: 'GIA',
  primaryColor: '#a8431e',
  secondaryColor: '#f2784b',
});

const GROUPS = new Set<keyof BrandConfig>([
  'agentNaming',
  'login',
  'email',
  'notifications',
  'supportContact',
  'company',
  'links',
]);

/** Each level fills or replaces what the one before it set; groups merge key by key. */
export function mergeBrand(...levels: readonly BrandConfig[]): BrandConfig {
  const out: Record<string, unknown> = {};
  for (const level of levels) {
    for (const [key, value] of Object.entries(level)) {
      if (value === undefined) continue;
      out[key] =
        GROUPS.has(key as keyof BrandConfig) && typeof out[key] === 'object'
          ? Object.freeze({ ...(out[key] as object), ...(value as object) })
          : value;
    }
  }
  return Object.freeze(out) as BrandConfig;
}

/** A resolved brand and the stored levels it came from, in order. */
export interface EffectiveBrand {
  readonly brand: BrandConfig;
  readonly levels: readonly BrandLevel[];
}

export interface BrandResolutionDependencies {
  readonly brands: BrandRepository;
  readonly commercial: Pick<CommercialRepository, 'findAccount' | 'relationshipsOfOrganization'>;
  readonly organizations: {
    findOrganization(id: OrganizationId): Promise<Organization | undefined>;
  };
  /** The customer's facts from its business profile (ADR-0048), under its own brand. */
  readonly businessFacts?: (
    organizationId: OrganizationId,
  ) => Promise<Pick<BrandConfig, 'timeZone' | 'currency' | 'country'> | undefined>;
}

/**
 * An organization's brand (ADR-0087): platform, then its partner's brand when it is that
 * partner's white-label customer (a white label, or a reseller under one: the white label's brand,
 * then the reseller's, ADR-0098), then its own (its business profile's facts, then its brand
 * configuration), then what the partner set for it while it grants the `branding` scope.
 *
 * Only an active white-label relationship with an active partner brings a partner's levels, and
 * only when it is the organization's one such relationship: with two, neither applies. Nothing
 * here reads another organization's configuration: every level is looked up by this
 * organization's own id or by its own relationship.
 */
export async function effectiveBrandOf(
  organizationId: OrganizationId,
  deps: BrandResolutionDependencies,
): Promise<EffectiveBrand> {
  const levels: BrandConfig[] = [PLATFORM_BRAND];
  const names: BrandLevel[] = [];
  const whiteLabel = (await deps.commercial.relationshipsOfOrganization(organizationId)).filter(
    (r) => r.organizationId === organizationId && r.status === 'active' && r.mode === 'white_label',
  );
  const relationship = whiteLabel.length === 1 ? whiteLabel[0] : undefined;
  const partner =
    relationship === undefined
      ? undefined
      : await deps.commercial.findAccount(relationship.commercialAccountId);
  // A reseller under a white label shows the white label's brand first (ADR-0098), and only
  // while that white label is active; a reseller alone never serves in white label.
  const parent =
    partner?.type === 'reseller' && partner.parentAccountId !== undefined
      ? await deps.commercial.findAccount(partner.parentAccountId)
      : undefined;
  const parentApplies =
    parent !== undefined &&
    parent.id === partner?.parentAccountId &&
    parent.type === 'white_label' &&
    parent.status === 'active';
  const partnerApplies =
    relationship !== undefined &&
    partner?.status === 'active' &&
    partner.id === relationship.commercialAccountId &&
    (partner.type === 'partner' ||
      partner.type === 'white_label' ||
      (partner.type === 'reseller' && parentApplies));

  if (partnerApplies) {
    if (parentApplies) {
      const whiteLabel = await deps.brands.findBrand({
        level: 'commercial_account',
        commercialAccountId: parent.id,
      });
      if (whiteLabel !== undefined) {
        levels.push(whiteLabel.config);
        names.push('commercial_account');
      }
    }
    const own = await deps.brands.findBrand({
      level: 'commercial_account',
      commercialAccountId: relationship.commercialAccountId,
    });
    if (own !== undefined) {
      levels.push(own.config);
      names.push('commercial_account');
    }
  }
  const facts = await deps.businessFacts?.(organizationId);
  if (facts !== undefined) levels.push(facts);
  const customer = await deps.brands.findBrand({ level: 'organization', organizationId });
  if (customer !== undefined) {
    levels.push(customer.config);
    names.push('organization');
  }
  if (partnerApplies && relationship.scopes.includes('branding')) {
    const forCustomer = await deps.brands.findBrand({
      level: 'white_label',
      commercialAccountId: relationship.commercialAccountId,
      organizationId,
    });
    if (forCustomer !== undefined) {
      levels.push(forCustomer.config);
      names.push('white_label');
    }
  }
  return Object.freeze({ brand: mergeBrand(...levels), levels: Object.freeze(names) });
}

/** A partner's or agency's own brand: platform, then its own configuration. */
export async function accountBrandOf(
  commercialAccountId: CommercialAccountId,
  deps: Pick<BrandResolutionDependencies, 'brands'>,
): Promise<EffectiveBrand> {
  const own = await deps.brands.findBrand({ level: 'commercial_account', commercialAccountId });
  return own === undefined
    ? Object.freeze({ brand: PLATFORM_BRAND, levels: Object.freeze([]) })
    : Object.freeze({
        brand: mergeBrand(PLATFORM_BRAND, own.config),
        levels: Object.freeze(['commercial_account' as const]),
      });
}

/** What a hostname resolves to. `platform` is every host that has no active binding. */
export interface ResolvedDomain {
  readonly context: { readonly type: 'platform' } | DomainTarget;
  readonly brand: BrandConfig;
}

const PLATFORM: ResolvedDomain = Object.freeze({
  context: Object.freeze({ type: 'platform' as const }),
  brand: PLATFORM_BRAND,
});

/**
 * Domain → context → brand (ADR-0087). Only an `active` binding of exactly this hostname resolves,
 * and only to its own target, while that target is active. Everything else (unknown, pending,
 * verified, disabled, malformed, a target that is suspended) is the platform.
 *
 * The result chooses how the product looks and which context a page starts in. It authorizes
 * nothing: every request still resolves its organization from the signed-in person's own
 * membership (`resolveTenant()`), whatever domain it came through.
 */
export async function resolveDomain(
  host: unknown,
  deps: BrandResolutionDependencies,
): Promise<ResolvedDomain> {
  let hostname: string;
  try {
    hostname = parseHostname(host);
  } catch {
    return PLATFORM;
  }
  const binding = await deps.brands.findDomain(hostname);
  if (binding === undefined || binding.status !== 'active' || binding.hostname !== hostname) {
    return PLATFORM;
  }
  const target = binding.target;
  if (target.type === 'organization') {
    if (!isOrganizationId(target.organizationId)) return PLATFORM;
    const organization = await deps.organizations.findOrganization(target.organizationId);
    if (organization?.status !== 'active' || organization.id !== target.organizationId) {
      return PLATFORM;
    }
    const { brand } = await effectiveBrandOf(organization.id, deps);
    return Object.freeze({
      context: Object.freeze({ type: 'organization', organizationId: organization.id }),
      brand,
    });
  }
  if (!isCommercialAccountId(target.commercialAccountId)) return PLATFORM;
  const account = await deps.commercial.findAccount(target.commercialAccountId);
  if (account?.status !== 'active' || account.id !== target.commercialAccountId) return PLATFORM;
  const { brand } = await accountBrandOf(account.id, deps);
  return Object.freeze({
    context: Object.freeze({ type: 'commercial_account', commercialAccountId: account.id }),
    brand,
  });
}
