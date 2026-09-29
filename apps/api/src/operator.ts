import { buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import type { UserDirectory } from '@melonoffice/auth';
import { isConversationError, type ConversationService } from '@melonoffice/conversations';
import { departmentIdOf, type DepartmentRepository } from '@melonoffice/departments';
import type {
  DepartmentTypeId,
  DeploymentEnvironment,
  IsoTimestamp,
  Organization,
  OrganizationId,
  SkillId,
  Specialist,
  UserId,
} from '@melonoffice/domain';
import { CONVERSATION_AGENT_POLICY_REF } from '@melonoffice/ai-vertex';
import {
  checkOverride,
  isEntitlementKey,
  type EntitlementOverride,
} from '@melonoffice/entitlements';
import {
  applySpecialistStatus,
  newSpecialist,
  reviseSpecialist,
  type SpecialistRepository,
} from '@melonoffice/specialists';
import {
  isOrganizationId,
  OWNER_ROLE,
  resolveTenant,
  type TenancyStore,
  type TenantContext,
} from '@melonoffice/tenancy';

/**
 * Operator tools (ADR-0044): run from Cloud Shell by the project's owner, with their own Google
 * credentials (no key), never by an API route. Each goes through the same model and services as
 * the product, is audited, and names its organization explicitly: no organization, plan or
 * environment is special-cased in code.
 */

export class OperatorError extends Error {
  override readonly name = 'OperatorError';

  constructor(
    readonly code:
      | 'invalid_input'
      | 'organization_not_found'
      | 'organization_inactive'
      | 'approver_not_found'
      | 'owner_not_active'
      | 'not_dev',
  ) {
    super(code);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function activeOrganization(
  tenancy: Pick<TenancyStore, 'findOrganization'>,
  id: unknown,
): Promise<Organization> {
  if (!isOrganizationId(id)) throw new OperatorError('invalid_input');
  const organization = await tenancy.findOrganization(id);
  if (organization === undefined) throw new OperatorError('organization_not_found');
  if (organization.status !== 'active') throw new OperatorError('organization_inactive');
  return organization;
}

/** Where overrides are written: with their audit event, in one transaction. */
export interface OverrideWriter {
  set(
    organizationId: OrganizationId,
    override: EntitlementOverride,
    event: AuditEvent,
    at: Date,
  ): Promise<void>;
}

/**
 * Sets one audited entitlement override for one organization (ADR-0044): a value applied after
 * its plan, for that organization only. The plan itself, and every other organization on it,
 * stays as it is. The approver must be a MelonOffice user; the event names them.
 */
export async function setEntitlementOverride(input: {
  readonly organizationId: unknown;
  readonly key: unknown;
  /** The value as JSON, e.g. `1` or `["messaging"]`. */
  readonly value: unknown;
  readonly reason: unknown;
  readonly approvedBy: unknown;
  readonly expiresAt?: unknown;
  readonly tenancy: Pick<TenancyStore, 'findOrganization'>;
  readonly users: Pick<UserDirectory, 'findById'>;
  readonly store: OverrideWriter;
  readonly now?: () => Date;
}): Promise<{ readonly organizationId: OrganizationId; readonly key: string }> {
  const organization = await activeOrganization(input.tenancy, input.organizationId);
  if (typeof input.key !== 'string' || !isEntitlementKey(input.key)) {
    throw new OperatorError('invalid_input');
  }
  if (typeof input.approvedBy !== 'string' || !UUID.test(input.approvedBy)) {
    throw new OperatorError('invalid_input');
  }
  const approver = await input.users.findById(input.approvedBy as UserId);
  if (approver === undefined) throw new OperatorError('approver_not_found');
  let value: unknown;
  try {
    value = JSON.parse(String(input.value));
  } catch {
    throw new OperatorError('invalid_input');
  }
  if (
    input.expiresAt !== undefined &&
    (typeof input.expiresAt !== 'string' || Number.isNaN(Date.parse(input.expiresAt)))
  ) {
    throw new OperatorError('invalid_input');
  }
  let override: EntitlementOverride;
  try {
    override = checkOverride({
      key: input.key,
      value: value as EntitlementOverride['value'],
      reason: String(input.reason ?? ''),
      approvedBy: approver.id,
      ...(input.expiresAt === undefined
        ? {}
        : { expiresAt: new Date(input.expiresAt as string).toISOString() as IsoTimestamp }),
    });
  } catch {
    throw new OperatorError('invalid_input');
  }
  const at = (input.now ?? (() => new Date()))();
  const event = buildAuditEvent(
    {
      action: 'entitlements.override_set',
      result: 'success',
      actor: { type: 'user', userId: approver.id, via: 'direct' },
      organizationId: organization.id,
      target: { type: 'organization', id: organization.id },
      reference: `entitlement:${override.key}`,
      source: 'api',
    },
    at,
  );
  await input.store.set(organization.id, override, event, at);
  return { organizationId: organization.id, key: override.key };
}

/**
 * A test conversation agent's profile (CV-6C): the fixture an environment without
 * `specialist.manage` (deferred) uses to try agents. Generic: nothing in it names an
 * organization.
 */
/** The skill that grants the conversation agent its reply and hand-off (SK-1, ADR-0069). */
const REPLY_SKILL = Object.freeze({ id: 'conversation_reply' as SkillId, version: 1 });

export const TEST_AGENT = Object.freeze({
  displayName: 'Agente de prueba',
  departmentType: 'sales' as DepartmentTypeId,
  mainRoleId: 'sales_assistant',
  instructions:
    'Eres el agente de prueba de MelonOffice. Saluda, entiende qué necesita el cliente y responde con brevedad. No des precios, plazos, stock ni datos de pedidos: si los piden, o si el cliente quiere hablar con una persona, pasa la conversación a una persona.',
  maxRepliesPerConversation: 5,
});

export type TestAgentAutonomy = 'supervised' | 'autonomous';

export interface TestAgentSetup {
  readonly organizationId: OrganizationId;
  readonly specialistId: string;
  readonly autonomy: TestAgentAutonomy;
  /** False when an agent of this level already existed: it was reused, not created. */
  readonly created: boolean;
}

/**
 * Seeds the test conversation agent in one organization and chooses it, at `autonomy`, as that
 * organization's agent. DEV only: elsewhere specialists are made through `specialist.manage`,
 * which is deferred, so there is no other way in yet. It writes through the specialists' own
 * model and repository, and chooses the agent and level through the conversations service as
 * the organization's creator, who must still be its active owner. Idempotent.
 */
export async function seedTestAgent(input: {
  readonly environment: DeploymentEnvironment | undefined;
  readonly organizationId: unknown;
  readonly autonomy: unknown;
  readonly tenancy: TenancyStore;
  readonly departments: DepartmentRepository;
  readonly specialists: SpecialistRepository;
  readonly conversations: Pick<ConversationService, 'changeAgent' | 'changeAutonomy'>;
  readonly now?: () => Date;
}): Promise<TestAgentSetup> {
  if (input.environment !== 'dev') throw new OperatorError('not_dev');
  const autonomy = input.autonomy ?? 'supervised';
  if (autonomy !== 'supervised' && autonomy !== 'autonomous') {
    throw new OperatorError('invalid_input');
  }
  const organization = await activeOrganization(input.tenancy, input.organizationId);
  let tenant: TenantContext;
  try {
    tenant = await resolveTenant(
      { actor: 'user', userId: organization.createdBy, emailVerified: false },
      organization.id,
      input.tenancy,
    );
  } catch {
    throw new OperatorError('owner_not_active');
  }
  if (tenant.role !== OWNER_ROLE) throw new OperatorError('owner_not_active');
  const now = input.now ?? (() => new Date());
  const existing = (await input.specialists.list(organization.id)).find(
    (s) =>
      s.identity.displayName === TEST_AGENT.displayName &&
      s.status === 'active' &&
      s.configuration.conversation?.autonomy === autonomy,
  );
  let specialist: Specialist;
  if (existing !== undefined) {
    specialist = existing;
    // Seeded before SK-1 (ADR-0069): its tools came from no skill, and the tool gate now refuses
    // them (ADR-0083). Its next version carries the skill that grants them; nothing else changes.
    const skills = existing.configuration.skills;
    if (!skills.some((s) => s.id === REPLY_SKILL.id && s.version === REPLY_SKILL.version)) {
      const at = now().toISOString() as IsoTimestamp;
      specialist = await input.specialists.update(organization.id, existing.identity.id, (s) =>
        reviseSpecialist(
          s,
          {
            fromVersion: s.version,
            configuration: { ...s.configuration, skills: [...skills, REPLY_SKILL] },
          },
          organization.createdBy,
          at,
        ),
      );
    }
  } else {
    const departmentId = departmentIdOf(organization.id, TEST_AGENT.departmentType);
    const department = await input.departments.find(organization.id, departmentId);
    if (department === undefined) throw new OperatorError('organization_not_found');
    const at = now().toISOString() as IsoTimestamp;
    const write = newSpecialist(
      {
        organizationId: organization.id,
        displayName: TEST_AGENT.displayName,
        configuration: {
          departmentId,
          mainRoleId: TEST_AGENT.mainRoleId,
          roleVersion: 1,
          capabilities: ['answer_customers'],
          // Its tools come from its skill (SK-1, ADR-0069): the reply at its level, and the
          // hand-off (ADR-0043).
          skills: [REPLY_SKILL],
          tools: [
            { id: 'message_send', version: autonomy === 'supervised' ? 2 : 3 },
            { id: 'conversation_handoff', version: 1 },
          ],
          permissions: ['conversation.manage', 'conversation.read', 'conversation.send'],
          policies: { model: CONVERSATION_AGENT_POLICY_REF },
          conversation: {
            instructions: TEST_AGENT.instructions,
            channels: ['whatsapp'],
            autonomy,
            maxRepliesPerConversation: TEST_AGENT.maxRepliesPerConversation,
          },
        },
      },
      department,
      organization.createdBy,
      at,
    );
    await input.specialists.create(write);
    specialist = await input.specialists.update(
      organization.id,
      write.specialist.identity.id,
      (s) => applySpecialistStatus(s, { from: s.status, to: 'active' }, at),
    );
  }
  // Already set to the same agent or level: nothing to change (the service refuses a no-op).
  const unlessUnchanged = async (change: Promise<unknown>) => {
    try {
      await change;
    } catch (error) {
      if (!isConversationError(error) || error.code !== 'invalid_transition') throw error;
    }
  };
  await unlessUnchanged(input.conversations.changeAgent(tenant, specialist.identity.id));
  await unlessUnchanged(input.conversations.changeAutonomy(tenant, autonomy));
  return {
    organizationId: organization.id,
    specialistId: specialist.identity.id,
    autonomy,
    created: existing === undefined,
  };
}
