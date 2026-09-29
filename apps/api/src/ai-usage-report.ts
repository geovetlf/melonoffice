import { Firestore } from '@google-cloud/firestore';
import { createAIUsageLedger } from '@melonoffice/ai-usage';
import { FirestoreAIUsageStore } from '@melonoffice/firestore';
import { loadConfig } from './config.js';

/**
 * All of MelonOffice's AI usage and cost between two UTC days (ADR-0074): in total and by every
 * organization, capability, provider, model, agent, department, workflow and task. An operator
 * tool, never a route: run by the project's owner in Cloud Shell with their own Google
 * credentials (no key):
 *
 *   IDENTITY_PLATFORM_PROJECT_ID=<project> node apps/api/dist/ai-usage-report.js 2026-09-01 2026-09-30
 *
 * Prints the summary as JSON: codes, ids and amounts only, never content.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const projectId = config.identityProjectId;
  if (projectId === undefined) throw new Error('IDENTITY_PLATFORM_PROJECT_ID is required');
  const from = process.argv[2];
  if (from === undefined) throw Object.assign(new Error('usage'), { code: 'invalid_input' });
  const to = process.argv[3] ?? from;
  const firestore = new Firestore({ projectId });
  const ledger = createAIUsageLedger(new FirestoreAIUsageStore(firestore));
  const days = await new FirestoreAIUsageStore(firestore).allDays(from, to);
  const byOrganization: Record<
    string,
    { operations: number; costMicroUsd: number; credits: number }
  > = {};
  for (const day of days) {
    const own = (byOrganization[day.organizationId] ??= {
      operations: 0,
      costMicroUsd: 0,
      credits: 0,
    });
    own.operations += day.totals.operations;
    own.costMicroUsd += day.totals.costMicroUsd;
    own.credits += day.totals.credits;
  }
  const summary = await ledger.platformSummary(from, to);
  process.stdout.write(`${JSON.stringify({ ...summary, byOrganization })}\n`);
}

main().catch((error: unknown) => {
  // A code only: never a stack, a credential or a document.
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : 'report_failed';
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exit(1);
});
