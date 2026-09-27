import { Firestore } from '@google-cloud/firestore';
import { createCreditService } from '@melonoffice/credits';
import type { Organization, OrganizationId } from '@melonoffice/domain';
import { FirestoreCreditStore, FirestoreTenancyStore, ORGANIZATIONS } from '@melonoffice/firestore';
import { loadConfig } from './config.js';
import { DEV_TEST_GRANT, DevTestGrantError, grantDevTestCredits } from './dev-credits.js';

/**
 * Makes the DEV test grant (ADR-0038): 500 credits to MOpruebas, once. Run by the DEV project's
 * owner in Cloud Shell, with their own Google credentials (no key):
 *
 *   DEPLOYMENT_ENVIRONMENT=dev IDENTITY_PLATFORM_PROJECT_ID=<dev project> \
 *     node apps/api/dist/grant-dev-credits.js
 *
 * It refuses anything but `dev`. Staging and production have no Firestore database, so there is
 * nothing it could reach there. Prints the organization id and its new balance, nothing else.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const projectId = config.identityProjectId;
  if (projectId === undefined) throw new Error('IDENTITY_PLATFORM_PROJECT_ID is required');
  if (config.deploymentEnvironment !== 'dev') throw new DevTestGrantError('not_dev');
  const firestore = new Firestore({ projectId });
  const tenancy = new FirestoreTenancyStore(firestore);
  const result = await grantDevTestCredits({
    environment: config.deploymentEnvironment,
    organizationsNamed: async (name) => {
      const snapshot = await firestore.collection(ORGANIZATIONS).where('name', '==', name).get();
      const found = await Promise.all(
        snapshot.docs.map((doc) => tenancy.findOrganization(doc.id as OrganizationId)),
      );
      return found.filter((o): o is Organization => o !== undefined);
    },
    tenancy,
    credits: createCreditService({
      store: new FirestoreCreditStore(firestore),
      organizations: tenancy,
    }),
  });
  process.stdout.write(
    `${JSON.stringify({
      organization: DEV_TEST_GRANT.organizationName,
      organizationId: result.organizationId,
      granted: DEV_TEST_GRANT.amount,
      balance: result.balance,
      alreadyGranted: result.replayed,
    })}\n`,
  );
}

main().catch((error: unknown) => {
  // A code only: never a stack, a credential or a document.
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : 'grant_failed';
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exit(1);
});
