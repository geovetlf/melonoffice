import { Firestore } from '@google-cloud/firestore';
import {
  FirestoreEntitlementOverrideStore,
  FirestoreTenancyStore,
  FirestoreUserDirectory,
} from '@melonoffice/firestore';
import { loadConfig } from './config.js';
import { setEntitlementOverride } from './operator.js';

/**
 * Sets one audited entitlement override for one organization (ADR-0044). Run by the project's
 * owner in Cloud Shell, with their own Google credentials (no key):
 *
 *   IDENTITY_PLATFORM_PROJECT_ID=<project> ORGANIZATION_ID=<id> \
 *     ENTITLEMENT_KEY=integrations.connectionsMax ENTITLEMENT_VALUE=1 \
 *     OVERRIDE_REASON="..." APPROVED_BY=<user id> [EXPIRES_AT=<ISO date>] \
 *     node apps/api/dist/set-entitlement-override.js
 *
 * The plan is never changed. Prints the organization and the key, nothing else.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const projectId = config.identityProjectId;
  if (projectId === undefined) throw new Error('IDENTITY_PLATFORM_PROJECT_ID is required');
  const firestore = new Firestore({ projectId });
  const result = await setEntitlementOverride({
    organizationId: process.env.ORGANIZATION_ID,
    key: process.env.ENTITLEMENT_KEY,
    value: process.env.ENTITLEMENT_VALUE,
    reason: process.env.OVERRIDE_REASON,
    approvedBy: process.env.APPROVED_BY,
    ...(process.env.EXPIRES_AT === undefined ? {} : { expiresAt: process.env.EXPIRES_AT }),
    tenancy: new FirestoreTenancyStore(firestore),
    users: new FirestoreUserDirectory(firestore),
    store: new FirestoreEntitlementOverrideStore(firestore),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  // A code only: never a stack, a credential or a document.
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : 'override_failed';
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exit(1);
});
