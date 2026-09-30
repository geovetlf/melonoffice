import { buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import type { UserDirectory } from '@melonoffice/auth';
import { AGENT_TASK_POLICY_REF, CONVERSATION_AGENT_POLICY_REF } from '@melonoffice/ai-vertex';
import type { DepartmentCatalogue } from '@melonoffice/departments';
import type { IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import { HARNESS_CONVERSATION_POLICY_REF, HARNESS_TASK_POLICY_REF } from '@melonoffice/harness';
import { reviseSpecialist, type SpecialistWrite } from '@melonoffice/specialists';
import { isOrganizationId } from '@melonoffice/tenancy';
import type {
  DepartmentMigrationState,
  DepartmentMigrationStore,
  DepartmentMigrationWrite,
} from './department-migration.js';
import { OperatorError } from './operator.js';

/**
 * The agent policy migration (ADR-0100, Geovet 2026-09-30 09:09Z): every agent made before the
 * Melon Agent Harness routed its calls names a model policy that pins Gemini 2.5 Flash-Lite
 * (`agent_task@1`, `conversation_agent@1`). This moves each one that is not archived to the
 * Harness's version of the same policy (`agent_task@2`, `conversation_agent@2`), which pins no
 * provider or model: the data policy, the router, the budget and the limits then decide each call.
 *
 * For each organization, in one transaction:
 *
 * 1. each such agent gets a new configuration version naming the new policy, and nothing else
 *    changes (skills, tools, permissions, department, status stay as they are);
 * 2. one audit event per agent, in the same transaction.
 *
 * Nothing is deleted: earlier versions, and executions that ran under them, keep naming the old
 * policy, which stays registered. Running it again changes nothing.
 */

/** Old policy → the Harness's policy. Only these move; any other policy is left as it is. */
export const HARNESS_POLICY_MOVES: readonly {
  readonly from: { readonly id: string; readonly version: number };
  readonly to: { readonly id: string; readonly version: number };
}[] = Object.freeze([
  Object.freeze({ from: AGENT_TASK_POLICY_REF, to: HARNESS_TASK_POLICY_REF }),
  Object.freeze({ from: CONVERSATION_AGENT_POLICY_REF, to: HARNESS_CONVERSATION_POLICY_REF }),
]);

export type AgentPolicyOutcome =
  | {
      readonly organizationId: OrganizationId;
      readonly status: 'migrated' | 'planned';
      readonly agentsMoved: number;
    }
  | { readonly organizationId: OrganizationId; readonly status: 'unchanged' };

/**
 * What the migration changes in one organization. Pure: it decides from `state` alone, so the
 * same plan runs as a dry run and inside the transaction.
 */
export function planAgentPolicyMigration(
  state: DepartmentMigrationState,
  input: {
    readonly organizationId: OrganizationId;
    readonly by: UserId;
    readonly at: IsoTimestamp;
  },
): DepartmentMigrationWrite {
  const { organizationId, by, at } = input;
  const moves: Required<Omit<SpecialistWrite, 'events'>>[] = [];
  const events: AuditEvent[] = [];
  const actor = { type: 'user', userId: by, via: 'direct' } as const;
  // Only this organization's records are ever considered, whatever the store returned.
  for (const specialist of state.specialists) {
    if (specialist.organizationId !== organizationId || specialist.status === 'archived') continue;
    const current = specialist.configuration.policies.model;
    const move = HARNESS_POLICY_MOVES.find(
      (m) => current?.id === m.from.id && current.version === m.from.version,
    );
    if (move === undefined) continue;
    const write = reviseSpecialist(
      specialist,
      {
        fromVersion: specialist.version,
        configuration: {
          ...specialist.configuration,
          policies: { ...specialist.configuration.policies, model: { ...move.to } },
        },
      },
      by,
      at,
    );
    moves.push(write);
    events.push(
      buildAuditEvent(
        {
          action: 'specialist.model_policy_changed',
          result: 'success',
          actor,
          organizationId,
          target: { type: 'specialist', id: specialist.identity.id },
          targetVersion: write.version.version,
          reference: `policy:${move.to.id}:${move.to.version}`,
          reason: 'harness_policy_migration',
          source: 'api',
        },
        new Date(at),
      ),
    );
  }
  return Object.freeze({
    departments: Object.freeze([]),
    specialists: Object.freeze(moves),
    events: Object.freeze(events),
  });
}

/**
 * Runs the migration over every organization (every organization has departments, so the
 * department catalogue finds them all). A dry run (the default) only reads and reports; `apply`
 * writes, one organization per transaction. `approvedBy` must be a MelonOffice user: the events
 * and the new versions name them.
 */
export async function migrateAgentPolicies(input: {
  readonly catalogue: DepartmentCatalogue;
  readonly store: DepartmentMigrationStore;
  readonly users: Pick<UserDirectory, 'findById'>;
  readonly approvedBy: unknown;
  readonly apply: boolean;
  readonly organizationId?: unknown;
  readonly now?: () => Date;
}): Promise<readonly AgentPolicyOutcome[]> {
  if (
    typeof input.approvedBy !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.approvedBy)
  ) {
    throw new OperatorError('invalid_input');
  }
  if (input.organizationId !== undefined && !isOrganizationId(input.organizationId)) {
    throw new OperatorError('invalid_input');
  }
  const approver = await input.users.findById(input.approvedBy as UserId);
  if (approver === undefined) throw new OperatorError('approver_not_found');
  const types = [...input.catalogue.types, ...input.catalogue.retired].map((t) => t.id);
  const found = await input.store.organizationsWith(types);
  const organizations =
    input.organizationId === undefined ? found : found.filter((id) => id === input.organizationId);

  const outcomes: AgentPolicyOutcome[] = [];
  for (const organizationId of [...new Set(organizations)].sort()) {
    const at = (input.now ?? (() => new Date()))().toISOString() as IsoTimestamp;
    const plan = (state: DepartmentMigrationState) =>
      planAgentPolicyMigration(state, { organizationId, by: approver.id, at });
    const write = input.apply
      ? await input.store.apply(organizationId, plan)
      : plan(await input.store.read(organizationId));
    outcomes.push(
      write.specialists.length === 0
        ? { organizationId, status: 'unchanged' }
        : {
            organizationId,
            status: input.apply ? 'migrated' : 'planned',
            agentsMoved: write.specialists.length,
          },
    );
  }
  return Object.freeze(outcomes);
}
