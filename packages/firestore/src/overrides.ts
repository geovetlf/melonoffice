import type { Firestore } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import type { IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import {
  checkOverride,
  isEntitlementKey,
  type EntitlementOverride,
  type OverrideSource,
} from '@melonoffice/entitlements';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `entitlementOverrides/{organizationId}`: the values a platform operator set for one
 * organization (ADR-0007, wired in ADR-0044), one entry per entitlement key. Written only by an
 * operator's tool with its audit event in the same transaction; no API route writes here.
 */
export const ENTITLEMENT_OVERRIDES = 'entitlementOverrides';

interface StoredOverride {
  readonly valueJson: string;
  readonly reason: string;
  readonly approvedBy: string;
  readonly expiresAt: string | null;
  readonly setAt: string;
}

function toOverride(key: string, stored: StoredOverride): EntitlementOverride {
  if (!isEntitlementKey(key)) throw new Error('invalid override key');
  return checkOverride({
    key,
    value: JSON.parse(stored.valueJson) as EntitlementOverride['value'],
    reason: stored.reason,
    approvedBy: stored.approvedBy as UserId,
    ...(stored.expiresAt === null ? {} : { expiresAt: stored.expiresAt as IsoTimestamp }),
  });
}

export class FirestoreEntitlementOverrideStore implements OverrideSource {
  constructor(private readonly db: Firestore) {}

  /** Every override of the organization; an unreadable one throws, so entitlements deny. */
  async overridesOf(organizationId: OrganizationId): Promise<readonly EntitlementOverride[]> {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db.collection(ENTITLEMENT_OVERRIDES).doc(organizationId).get();
    const data = snapshot.data();
    if (data === undefined) return [];
    if (data.organizationId !== organizationId) throw new Error('invalid override record');
    const entries = (data.overrides ?? {}) as Record<string, StoredOverride>;
    return Object.entries(entries).map(([key, stored]) => toOverride(key, stored));
  }

  /** Sets one key's override for the organization, with its audit event, in one transaction. */
  async set(
    organizationId: OrganizationId,
    override: EntitlementOverride,
    event: AuditEvent,
    at: Date,
  ): Promise<void> {
    if (!isOrganizationId(organizationId)) throw new Error('invalid organization');
    checkOverride(override);
    const doc = this.db.collection(ENTITLEMENT_OVERRIDES).doc(organizationId);
    await this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data();
      const revision = typeof data?.revision === 'number' ? data.revision : 0;
      const entry: StoredOverride = {
        valueJson: JSON.stringify(override.value),
        reason: override.reason.trim(),
        approvedBy: override.approvedBy,
        expiresAt: override.expiresAt ?? null,
        setAt: at.toISOString(),
      };
      t.set(doc, {
        organizationId,
        overrides: { ...((data?.overrides ?? {}) as object), [override.key]: entry },
        revision: revision + 1,
      });
      t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    });
  }
}
