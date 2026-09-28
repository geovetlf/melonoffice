import { Firestore } from '@google-cloud/firestore';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createConversationService } from '@melonoffice/conversations';
import {
  FirestoreConversationRepository,
  FirestoreDepartmentRepository,
  FirestoreSpecialistRepository,
  FirestoreTenancyStore,
} from '@melonoffice/firestore';
import { createConversationAgentCheck } from '@melonoffice/integrations';
import { loadConfig } from './config.js';
import { seedTestAgent } from './operator.js';

/**
 * Seeds the test conversation agent in one organization and makes it that organization's agent
 * (CV-6C, ADR-0044). DEV only, while `specialist.manage` is deferred. Run by the project's owner
 * in Cloud Shell, with their own Google credentials (no key):
 *
 *   DEPLOYMENT_ENVIRONMENT=dev IDENTITY_PLATFORM_PROJECT_ID=<dev project> \
 *     ORGANIZATION_ID=<id> AGENT_AUTONOMY=supervised|autonomous \
 *     node apps/api/dist/seed-test-agent.js
 *
 * Prints ids only.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const projectId = config.identityProjectId;
  if (projectId === undefined) throw new Error('IDENTITY_PLATFORM_PROJECT_ID is required');
  const firestore = new Firestore({ projectId });
  const tenancy = new FirestoreTenancyStore(firestore);
  const departments = new FirestoreDepartmentRepository(firestore);
  const specialists = new FirestoreSpecialistRepository(firestore);
  const result = await seedTestAgent({
    environment: config.deploymentEnvironment,
    organizationId: process.env.ORGANIZATION_ID,
    autonomy: process.env.AGENT_AUTONOMY,
    tenancy,
    departments,
    specialists,
    conversations: createConversationService({
      repository: new FirestoreConversationRepository(firestore),
      agents: createConversationAgentCheck(specialists),
      organizations: tenancy,
      departments,
      authorization: createAuthorizationService(),
    }),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  // A code only: never a stack, a credential or a document.
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : 'seed_failed';
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exit(1);
});
