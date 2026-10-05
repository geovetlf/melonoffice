import { ROLES } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { isPlanningError } from './errors.js';
import {
  ALICE,
  answer,
  fake,
  proposal,
  specialistStep,
  toolStep,
  world,
  type WorldOptions,
} from './testkit.js';

async function setup(options: WorldOptions = {}) {
  const w = await world(options);
  const owner = await w.seed(w.orgA, ALICE, { type: 'leadership', role: 'chief_of_staff' });
  const researcher = await w.seed(w.orgA, ALICE, { toolIds: ['lookup', 'private_records'] });
  const execution = await w.planning(w.tenantA, owner);
  const plan = (objective = 'Study the melon market.') =>
    w.planner.plan(w.tenantA, { executionId: execution.id, requestId: 'plan-1', objective });
  return { ...w, owner, researcher, execution, plan };
}

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (isPlanningError(error)) return error.code;
    if (error instanceof Error && 'code' in error) return String(error.code);
    throw error;
  }
  return 'accepted';
};

describe('planner', () => {
  it('turns the model proposal into a validated plan, through the AI Gateway only', async () => {
    const w = await setup();
    w.answers.push(
      answer(
        proposal([
          specialistStep('research', w.researcher),
          toolStep('search', 'research', 'lookup'),
        ]),
      ),
    );
    const outcome = await w.plan();
    if (outcome.status !== 'planned') throw new Error(outcome.status);
    expect(outcome.plan.status).toBe('ready');
    expect(outcome.version.source).toEqual({
      kind: 'planner',
      model: { provider: 'alpha', id: 'alpha-large', version: '2026-09-01' },
      policy: { id: 'default_model', version: 1 },
    });
    // One model call, asked for structured output, with ids and codes only as context.
    expect(w.calls).toHaveLength(1);
    const [call] = w.calls;
    expect(call?.capability).toBe('text_generation');
    expect(call?.structuredOutput).toBe(true);
    const context = JSON.stringify(call?.messages);
    expect(context).toContain(w.researcher.identity.id);
    const part = call?.messages[0]?.content[1];
    const candidates = JSON.parse(part?.type === 'text' ? part.text : '{}').candidates;
    expect(candidates).toContainEqual(
      expect.objectContaining({ departmentType: 'research', roleId: 'market_researcher' }),
    );
    expect(context).not.toContain(w.orgA);
    // The gateway charged the call once; creating the plan consumed nothing more.
    expect(w.consumed).toEqual([3]);
    expect(w.events('plan.created')).toHaveLength(1);
    expect((await w.executions.get(w.tenantA, w.execution.id)).status).toBe('planning');
  });

  it('never approves its own plan: a plan that needs approval waits for a user', async () => {
    const w = await setup();
    w.answers.push(
      answer(
        proposal([
          specialistStep('research', w.researcher),
          toolStep('notify', 'research', 'private_records', { approvalRequired: false }),
        ]),
      ),
    );
    const outcome = await w.plan();
    expect(outcome.status === 'planned' && outcome.plan.status).toBe('approval_required');
    expect((await w.executions.get(w.tenantA, w.execution.id)).status).toBe('waiting_approval');
    expect(w.events('plan.approved')).toHaveLength(0);
  });

  it('refuses a malformed model output and fails the planning execution', async () => {
    const w = await setup();
    w.answers.push(() => ({
      status: 'success',
      output: { text: 'Here is a plan: research.' },
      usage: { inputTokens: 10, outputTokens: 10 },
      finishReason: 'stop',
    }));
    const outcome = await w.plan();
    expect(outcome).toEqual(
      expect.objectContaining({ status: 'refused', reason: 'invalid_proposal' }),
    );
    const after = await w.executions.get(w.tenantA, w.execution.id);
    expect(after.status).toBe('failed');
    expect(after.failure?.code).toBe('invalid_proposal');
    expect(w.events('plan.proposal_refused')).toHaveLength(1);
    expect(await codeOf(w.plans.get(w.tenantA, w.execution.id))).toBe('plan_not_found');
  });

  it('refuses a model that claims authority', async () => {
    const w = await setup();
    w.answers.push(
      answer(proposal([specialistStep('research', w.researcher)], { approved: true })),
    );
    const outcome = await w.plan();
    expect(outcome).toEqual(
      expect.objectContaining({ status: 'refused', reason: 'authority_in_proposal' }),
    );
  });

  it('refuses a model that invents or moves a specialist', async () => {
    const w = await setup();
    w.answers.push(
      answer(
        proposal([
          specialistStep('research', w.researcher, {
            specialistId: '99999999-9999-4999-8999-999999999999',
          }),
        ]),
      ),
    );
    expect(await w.plan()).toEqual(
      expect.objectContaining({ status: 'refused', reason: 'specialist_not_eligible' }),
    );
  });

  it('fails when the gateway cannot serve the call: provider unavailable', async () => {
    const w = await setup();
    w.answers.push(
      () => ({ status: 'error', kind: 'unavailable' }),
      () => ({ status: 'error', kind: 'unavailable' }),
      () => ({ status: 'error', kind: 'unavailable' }),
    );
    const outcome = await w.plan();
    expect(outcome).toEqual({ status: 'failed', reason: 'unavailable' });
    const after = await w.executions.get(w.tenantA, w.execution.id);
    expect(after.status).toBe('failed');
    expect(after.failure?.code).toBe('unavailable');
  });

  it('fails without calling any model when credits do not cover the call', async () => {
    const w = await setup({ balance: 0 });
    const outcome = await w.plan();
    expect(outcome).toEqual({ status: 'failed', reason: 'credits_insufficient' });
    expect(w.calls).toHaveLength(0);
  });

  it('fails without calling any model when policy denies it (unknown environment)', async () => {
    const w = await setup({ environment: undefined });
    expect(await w.plan()).toEqual({ status: 'failed', reason: 'environment_unknown' });
    expect(w.calls).toHaveLength(0);
  });

  it('never sends a secret to a model', async () => {
    const w = await setup();
    const outcome = await w.plan(`Use key ${fake('sk', '-abcdefghijklmnopqrstuvwxyz123456')}`);
    expect(outcome).toEqual({ status: 'failed', reason: 'secret_in_input' });
    expect(w.calls).toHaveLength(0);
  });

  it('needs plan.create, before any model call', async () => {
    const w = await setup({ roles: { owner: ROLES.owner.filter((p) => p !== 'plan.create') } });
    expect(await codeOf(w.plan())).toBe('permission_denied');
    expect(w.calls).toHaveLength(0);
  });

  it('plans only in a planning execution of its own organization', async () => {
    const w = await setup();
    const running = await w.executions.changeStatus(w.tenantA, w.execution.id, {
      from: 'planning',
      to: 'running',
    });
    expect(
      await codeOf(
        w.planner.plan(w.tenantA, { executionId: running.id, requestId: 'r', objective: 'x' }),
      ),
    ).toBe('execution_not_plannable');
    expect(
      await codeOf(
        w.planner.plan(w.tenantB, { executionId: running.id, requestId: 'r', objective: 'x' }),
      ),
    ).toBe('execution_not_found');
  });
});
