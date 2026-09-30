import { Firestore } from '@google-cloud/firestore';
import { DEFAULT_DEPARTMENT_CATALOGUE } from '@melonoffice/departments';
import { FirestoreDepartmentMigrationStore, FirestoreUserDirectory } from '@melonoffice/firestore';
import { migrateAgentPolicies } from './agent-policy-migration.js';
import { loadConfig } from './config.js';

/**
 * The agent policy migration (ADR-0100): every existing agent through the Melon Agent Harness.
 * Run by the project's owner in Cloud Shell, with their own Google credentials (no key). A dry run
 * by default: it only reads and prints what it would change. `MIGRATION_APPLY=yes` writes, one
 * organization per transaction.
 *
 *   IDENTITY_PLATFORM_PROJECT_ID=<project> APPROVED_BY=<user id> \
 *     [ORGANIZATION_ID=<id>] [MIGRATION_APPLY=yes] \
 *     node apps/api/dist/migrate-agent-policies.js
 *
 * Prints one line per organization: its id and how many agents moved. Never a name, an
 * instruction or any other record content.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const projectId = config.identityProjectId;
  if (projectId === undefined) throw new Error('IDENTITY_PLATFORM_PROJECT_ID is required');
  const apply = process.env.MIGRATION_APPLY === 'yes';
  const firestore = new Firestore({ projectId });
  const outcomes = await migrateAgentPolicies({
    catalogue: DEFAULT_DEPARTMENT_CATALOGUE,
    store: new FirestoreDepartmentMigrationStore(firestore),
    users: new FirestoreUserDirectory(firestore),
    approvedBy: process.env.APPROVED_BY,
    apply,
    ...(process.env.ORGANIZATION_ID === undefined
      ? {}
      : { organizationId: process.env.ORGANIZATION_ID }),
  });
  process.stdout.write(`${JSON.stringify({ mode: apply ? 'apply' : 'dry_run' })}\n`);
  for (const outcome of outcomes) process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

main().catch((error: unknown) => {
  // A code only: never a stack, a credential or a document.
  const raw = (error as { code?: unknown } | null)?.code;
  const code =
    typeof raw === 'string' || typeof raw === 'number' ? String(raw) : 'migration_failed';
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exit(1);
});
