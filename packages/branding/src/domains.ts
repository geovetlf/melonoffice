import type { DomainBindingStatus, DomainTarget } from '@melonoffice/domain';
import { isCommercialAccountId, isOrganizationId } from '@melonoffice/tenancy';
import { BrandingError } from './errors.js';

export const DOMAIN_BINDING_STATUSES: readonly DomainBindingStatus[] = Object.freeze([
  'pending_verification',
  'verified',
  'active',
  'disabled',
]);

const TRANSITIONS: Readonly<Record<DomainBindingStatus, readonly DomainBindingStatus[]>> = {
  pending_verification: ['verified', 'disabled'],
  verified: ['active', 'disabled'],
  active: ['disabled'],
  disabled: ['pending_verification'],
};

/** Whether a binding may move between these statuses. Only a verified domain becomes active. */
export const canChangeDomainStatus = (
  from: DomainBindingStatus,
  to: DomainBindingStatus,
): boolean => TRANSITIONS[from].includes(to);

export const isDomainBindingStatus = (value: unknown): value is DomainBindingStatus =>
  (DOMAIN_BINDING_STATUSES as readonly unknown[]).includes(value);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A hostname in its one form: lowercase, no port, no trailing dot, at least two labels, a top
 * label that is not a number (so never an IP address). Anything else is refused, not repaired,
 * except letter case.
 */
export function parseHostname(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    throw new BrandingError('invalid_hostname');
  }
  const hostname = value.toLowerCase();
  const labels = hostname.split('.');
  if (
    labels.length < 2 ||
    !labels.every((label) => LABEL.test(label)) ||
    /^[0-9]+$/.test(labels.at(-1) ?? '')
  ) {
    throw new BrandingError('invalid_hostname');
  }
  return hostname;
}

/** Whether a value is a hostname in its one form. */
export function isHostname(value: unknown): value is string {
  try {
    return parseHostname(value) === value;
  } catch {
    return false;
  }
}

/** A domain's target as sent by the platform administrator: exactly one account or organization. */
export function parseDomainTarget(value: unknown): DomainTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BrandingError('invalid_domain_target');
  }
  const { type, commercialAccountId, organizationId } = value as Record<string, unknown>;
  if (
    type === 'commercial_account' &&
    isCommercialAccountId(commercialAccountId) &&
    organizationId === undefined
  ) {
    return Object.freeze({ type, commercialAccountId });
  }
  if (
    type === 'organization' &&
    isOrganizationId(organizationId) &&
    commercialAccountId === undefined
  ) {
    return Object.freeze({ type, organizationId });
  }
  throw new BrandingError('invalid_domain_target');
}
