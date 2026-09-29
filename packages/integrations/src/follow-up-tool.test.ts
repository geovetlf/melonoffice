import { ConversationError, FOLLOW_UP_TYPES } from '@melonoffice/conversations';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import {
  FOLLOW_UP_TYPE_CODES,
  type ToolExecutionContext,
  type ToolResult,
} from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';
import {
  createFollowUpScheduleExecutor,
  createGatedFollowUpCreate,
  FOLLOW_UP_SCHEDULE,
  SCHEDULE_NODE,
} from './follow-up-tool.js';

const ORG = '0f8fad5b-d9cb-469f-a165-70867728950e' as OrganizationId;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const FU = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const context = (over: Partial<ToolExecutionContext> = {}): ToolExecutionContext =>
  ({
    organizationId: ORG,
    executionId: 'exec',
    nodeId: SCHEDULE_NODE,
    toolId: FOLLOW_UP_SCHEDULE.toolId,
    toolVersion: 1,
    action: 'schedule',
    actor: { userId: ALICE, via: 'direct' },
    riskLevel: 'low',
    environment: 'dev',
    deadline: new Date(Date.now() + 10_000),
    ...over,
  }) as ToolExecutionContext;

/** A tenancy store where Alice is (or is not) an active member. */
const organizations = (member: boolean) => ({
  findMembership: async () =>
    member
      ? ({ id: 'm1', organizationId: ORG, userId: ALICE, status: 'active', role: 'owner' } as never)
      : undefined,
  findOrganization: async () => ({ id: ORG, status: 'active' }) as never,
});

describe('follow_up_schedule executor (TL-1)', () => {
  it('lists the same follow-up types as the conversations domain', () => {
    expect([...FOLLOW_UP_TYPE_CODES]).toEqual([...FOLLOW_UP_TYPES]);
  });

  it("runs the person's own call as them, and passes the service's refusal code back", async () => {
    const seen: { tenant: TenantContext; input: unknown }[] = [];
    let refuse = false;
    const executor = createFollowUpScheduleExecutor({
      organizations: organizations(true),
      followUps: {
        create: async (tenant, input) => {
          seen.push({ tenant, input });
          if (refuse) throw new ConversationError('contact_not_found');
          return { followUp: { id: FU } as never, created: true };
        },
      },
    });
    expect(await executor.execute(context(), { requestKey: 'key-00000001' })).toEqual({
      status: 'success',
      output: { followUpId: FU, created: true },
    });
    expect(seen[0]?.tenant).toMatchObject({ actor: 'user', userId: ALICE, organizationId: ORG });
    refuse = true;
    expect(await executor.execute(context(), {})).toEqual({
      status: 'failure',
      code: 'contact_not_found',
    });
  });

  it("refuses the runtime, GIA's channel, another version, and a person no longer a member", async () => {
    const create = async () => {
      throw new Error('must not run');
    };
    const executor = createFollowUpScheduleExecutor({
      organizations: organizations(true),
      followUps: { create },
    });
    for (const over of [
      { actor: { userId: ALICE, via: 'runtime' as const } },
      { actor: { userId: ALICE, via: 'gia' as const } },
      { toolVersion: 2 },
    ]) {
      expect(await executor.execute(context(over), {})).toEqual({
        status: 'failure',
        code: 'tool_not_human_invokable',
      });
    }
    const gone = createFollowUpScheduleExecutor({
      organizations: organizations(false),
      followUps: { create },
    });
    expect(await gone.execute(context(), {})).toEqual({
      status: 'failure',
      code: 'permission_denied',
    });
  });
});

describe('a new follow-up through the gate (TL-1)', () => {
  it('refuses a context resolveTenant did not issue, before anything is recorded', async () => {
    const recorded: string[] = [];
    const service = createGatedFollowUpCreate({
      followUps: {
        checkCreate: async () => void recorded.push('check'),
        get: async () => ({ id: FU }) as never,
      },
      authorization: { authorize: () => ({ allowed: true }) as never },
      executions: {
        create: async () => (recorded.push('execution'), { id: 'e', status: 'pending' }) as never,
        start: async () => ({}) as never,
      },
      gate: {
        invoke: async (): Promise<ToolResult> => {
          recorded.push('gate');
          return { status: 'denied', code: 'runtime_only' };
        },
      },
    });
    const forged = {
      actor: 'user',
      userId: ALICE,
      organizationId: ORG,
    } as unknown as TenantContext;
    await expect(service.create(forged, { requestKey: 'key-00000001' })).rejects.toMatchObject({
      code: 'unresolved_tenant',
    });
    expect(recorded).toEqual([]);
  });
});
