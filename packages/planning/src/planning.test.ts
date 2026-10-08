import { ROLES } from '@melonoffice/rbac';
import type { IsoTimestamp, Plan, Specialist, WorkflowId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { isPlanningError, PlanningError } from './errors.js';
import { canChangePlanStatus, isPlanTerminal, PLAN_STATUSES } from './lifecycle.js';
import { checkProposal, MAX_STEPS } from './proposal.js';
import { checkStepStructure } from './validate.js';
import {
  ALICE,
  BOB,
  fake,
  must,
  proposal,
  specialistStep,
  toolStep,
  world,
  type World,
  type WorldOptions,
} from './testkit.js';

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

/** A world with a planning specialist (Dirección) and a researcher that lists every tool. */
async function setup(options: WorldOptions = {}) {
  const w = await world(options);
  const planner = await w.seed(w.orgA, ALICE, { type: 'leadership', role: 'chief_of_staff' });
  const researcher = await w.seed(w.orgA, ALICE, {
    toolIds: [
      'lookup',
      'send_email',
      'wipe_data',
      'private_records',
      'remote_lookup',
      'keyed_lookup',
      'finance_report',
      'billing_lookup',
      'staging_only',
      'retired',
      'person_only',
      'ranked_lookup',
      'count_lookup',
      'plan_write',
    ],
  });
  const marketer = await w.seed(w.orgA, ALICE, { type: 'marketing', role: 'campaign_manager' });
  return { ...w, owner: planner, researcher, marketer };
}

const validate = (w: World, value: unknown) => w.validator.validate(w.tenantA, value);

const refusal = async (w: World, value: unknown) => {
  const result = await validate(w, value);
  return result.ok ? 'accepted' : `${result.stage}:${result.reason}`;
};

async function propose(w: Awaited<ReturnType<typeof setup>>, steps: Record<string, unknown>[]) {
  const execution = await w.planning(w.tenantA, w.owner);
  const outcome = await w.plans.propose(w.tenantA, {
    executionId: execution.id,
    proposal: proposal(steps),
    source: {
      kind: 'planner',
      model: { provider: 'alpha', id: 'alpha-large', version: 'v' },
      policy: { id: 'default_model', version: 1 },
    },
  });
  if (outcome.status !== 'planned') throw new Error(`refused: ${outcome.reason}`);
  return { execution, ...outcome };
}

describe('plan lifecycle', () => {
  it('allows only the listed moves and keeps terminal statuses terminal', () => {
    expect(canChangePlanStatus('approval_required', 'approved')).toBe(true);
    expect(canChangePlanStatus('ready', 'approved')).toBe(false);
    expect(canChangePlanStatus('approval_required', 'executing')).toBe(false);
    expect(canChangePlanStatus('draft', 'executing')).toBe(false);
    for (const status of PLAN_STATUSES) {
      expect(isPlanTerminal(status)).toBe(
        ['rejected', 'completed', 'failed', 'cancelled'].includes(status),
      );
      if (!isPlanTerminal(status)) expect(canChangePlanStatus(status, 'cancelled')).toBe(true);
    }
  });
});

describe('proposal schema', () => {
  const s = { identity: { id: '33333333-3333-4333-8333-333333333333' } } as Specialist;

  it('accepts a closed proposal and returns only known fields', () => {
    const result = checkProposal(proposal([specialistStep('research', s)]));
    expect(result.ok).toBe(true);
  });

  it('refuses authority fields anywhere as authority, not as a malformed field', () => {
    for (const bad of [
      proposal([specialistStep('research', s)], { organizationId: 'x' }),
      proposal([specialistStep('research', s, { approved: true })]),
      proposal([specialistStep('research', s, { permissions: ['approval.approve'] })]),
      proposal([specialistStep('research', s, { tenantId: 'x' })]),
      proposal([
        { ...specialistStep('research', s), label: 5 },
        specialistStep('b', s, { role: 'owner' }),
      ]),
    ]) {
      const result = checkProposal(bad);
      expect(result.ok ? 'accepted' : result.reason).toBe('authority_in_proposal');
    }
  });

  it('refuses other unknown fields, such as credits or a policy, as invalid', () => {
    for (const bad of [
      proposal([specialistStep('research', s, { credits: 100 })]),
      proposal([specialistStep('research', s)], { policy: 'lenient' }),
    ]) {
      const result = checkProposal(bad);
      expect(result.ok ? 'accepted' : result.reason).toBe('invalid_proposal');
    }
  });

  it('refuses credentials anywhere, even in a label', () => {
    const leaked = fake('sk', '-abcdefghijklmnopqrstuvwxyz123456');
    const result = checkProposal(
      proposal([specialistStep('research', s, { label: `use ${leaked}` })]),
    );
    expect(result.ok ? 'accepted' : result.reason).toBe('secret_in_proposal');
  });

  it('refuses malformed shapes and too many steps', () => {
    const many = Array.from({ length: MAX_STEPS + 1 }, (_, i) => specialistStep(`s${i}`, s));
    for (const bad of [
      null,
      'plan',
      proposal([]),
      proposal(many),
      proposal([specialistStep('Bad-Id', s)]),
      proposal([specialistStep('a', s, { kind: 'agent' })]),
      proposal([specialistStep('a', s, { dependsOn: ['b', 'b'] })]),
      proposal([
        specialistStep('a', s, {
          inputContract: {
            type: 'object',
            properties: { token: { type: 'string', maxLength: 5 } },
          },
        }),
      ]),
    ]) {
      const result = checkProposal(bad);
      expect(result.ok).toBe(false);
    }
  });
});

describe('decision conditions (WF-4)', () => {
  const s = { identity: { id: '33333333-3333-4333-8333-333333333333' } } as Specialist;
  const gate = (decision: unknown, extra: Record<string, unknown> = {}) =>
    proposal([
      specialistStep('research', s),
      { id: 'gate', kind: 'condition', label: 'Gate', dependsOn: ['research'], decision, ...extra },
    ]);
  const ok = {
    decision: 'action.policy_check',
    continueOn: ['allowed'],
    input: { action: 'opportunity.offer_discount', discountPercent: 10, strict: true },
  };

  it('accepts a decision type, its outcomes and a small fixed input', () => {
    const result = checkProposal(gate(ok));
    expect(result.ok && result.proposal.steps[1]?.decision).toEqual(ok);
  });

  it('refuses authority and credentials in the input, and malformed conditions', () => {
    const authority = checkProposal(gate({ ...ok, input: { organizationId: 'x' } }));
    expect(authority.ok ? 'accepted' : authority.reason).toBe('authority_in_proposal');
    const leaked = checkProposal(
      gate({ ...ok, input: { note: fake('sk', '-abcdefghijklmnopqrstuvwxyz123456') } }),
    );
    expect(leaked.ok ? 'accepted' : leaked.reason).toBe('secret_in_proposal');
    for (const bad of [
      { ...ok, decision: 'policy' },
      { ...ok, decision: 'Action.Policy' },
      { ...ok, continueOn: [] },
      { ...ok, continueOn: ['allowed', 'allowed'] },
      { ...ok, continueOn: ['Allowed!'] },
      { ...ok, input: { nested: { a: 1 } } },
      { ...ok, input: { list: [1] } },
      { ...ok, input: { text: 'x'.repeat(101) } },
      { ...ok, input: { 'bad-key': 'x' } },
      { ...ok, input: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i])) },
      { ...ok, extra: true },
    ]) {
      const result = checkProposal(gate(bad));
      expect(result.ok ? 'accepted' : result.reason).toBe('invalid_proposal');
    }
  });
});

describe('plan validation pipeline', () => {
  it('validates a multi-specialist plan and decides approval itself', async () => {
    const w = await setup();
    const result = await validate(
      w,
      proposal([
        specialistStep('research', w.researcher),
        toolStep('search', 'research', 'lookup'),
        // The model says no approval is needed; the tool's risk decides otherwise.
        toolStep('notify', 'research', 'private_records', {
          dependsOn: ['search'],
          approvalRequired: false,
        }),
        specialistStep('campaign', w.marketer, { dependsOn: ['research'] }),
      ]),
    );
    if (!result.ok) throw new Error(result.reason);
    const { plan } = result;
    expect(plan.riskLevel).toBe('high');
    expect(plan.approvalRequired).toBe(true);
    const step = (id: string) => must(plan.steps.find((s) => s.id === id));
    expect(step('notify').approvalRequired).toBe(true);
    expect(step('search').approvalRequired).toBe(false);
    // Department and version come from eligibility, never from the proposal.
    expect(step('campaign').specialist).toEqual({
      id: w.marketer.identity.id,
      version: 1,
      departmentId: w.marketer.configuration.departmentId,
    });
    // Tool contracts are the tool's own schemas.
    expect(step('search').inputContract).toEqual(expect.objectContaining({ type: 'object' }));
  });

  it('refuses the steps no plan can run, as the conductor would (ADR-0168)', async () => {
    const w = await setup();
    const r = w.researcher;
    const verification = { policy: 'human_review', expectedOutput: 'report', requiredChecks: [] };
    for (const step of [
      { id: 'x', kind: 'approval', label: 'OK', dependsOn: ['a'] },
      { id: 'x', kind: 'verification', label: 'Check', dependsOn: ['a'], verification },
      { id: 'x', kind: 'parallel', label: 'Both', dependsOn: ['a'] },
      {
        id: 'x',
        kind: 'condition',
        label: 'If',
        dependsOn: ['a'],
        condition: { step: 'a', outcome: 'completed' },
      },
    ]) {
      const result = await validate(w, proposal([specialistStep('a', r), step]));
      expect(result).toEqual({
        ok: false,
        stage: 'schema',
        reason: 'step_not_runnable',
        detail: 'steps.1',
      });
    }
    // What the conductor runs is accepted: specialist, tool, decision and wait steps.
    const runnable = await validate(
      w,
      proposal([
        specialistStep('a', r),
        toolStep('t', 'a', 'lookup'),
        {
          id: 'gate',
          kind: 'condition',
          label: 'Allowed?',
          dependsOn: ['a'],
          decision: { decision: 'action.policy_check', continueOn: ['allowed'] },
        },
        { id: 'pause', kind: 'wait', label: 'Wait', dependsOn: ['gate'], wait: { seconds: 60 } },
        specialistStep('b', r, { dependsOn: ['pause'] }),
      ]),
    );
    expect(runnable.ok).toBe(true);
  });

  it('lets the model raise risk, never lower it; critical is denied', async () => {
    const w = await setup();
    const one = [specialistStep('research', w.researcher)];
    const low = await validate(w, proposal(one));
    expect(low.ok && low.plan.approvalRequired).toBe(false);
    const raised = await validate(w, proposal(one, { riskLevel: 'high' }));
    expect(raised.ok && raised.plan.approvalRequired).toBe(true);
    const lowered = await validate(
      w,
      proposal([...one, toolStep('notify', 'research', 'private_records')], { riskLevel: 'low' }),
    );
    expect(lowered.ok && lowered.plan.riskLevel).toBe('high');
    expect(await refusal(w, proposal(one, { riskLevel: 'critical' }))).toBe(
      'policy:plan_denied_by_policy',
    );
  });

  it('refuses cycles, unknown and self dependencies through the X1 graph check', async () => {
    const w = await setup();
    const r = w.researcher;
    expect(
      await refusal(
        w,
        proposal([
          specialistStep('a', r, { dependsOn: ['b'] }),
          specialistStep('b', r, { dependsOn: ['a'] }),
        ]),
      ),
    ).toBe('plan:plan_cycle');
    expect(await refusal(w, proposal([specialistStep('a', r, { dependsOn: ['ghost'] })]))).toBe(
      'plan:unknown_dependency',
    );
    expect(await refusal(w, proposal([specialistStep('a', r, { dependsOn: ['a'] })]))).toBe(
      'plan:self_dependency',
    );
    expect(await refusal(w, proposal([specialistStep('a', r), specialistStep('a', r)]))).toBe(
      'plan:duplicate_step',
    );
  });

  it('refuses specialists that are missing, inactive, of another organization or moved', async () => {
    const w = await setup();
    const paused = await w.seed(w.orgA, ALICE, { status: 'paused' });
    const other = await w.seed(w.orgB, BOB);
    expect(await refusal(w, proposal([specialistStep('a', paused)]))).toBe(
      'permission:specialist_not_eligible',
    );
    expect(await refusal(w, proposal([specialistStep('a', other)]))).toBe(
      'permission:specialist_not_eligible',
    );
    const financeDepartment = w.researcher.configuration.departmentId.replace(
      'research',
      'finance',
    );
    expect(
      await refusal(
        w,
        proposal([specialistStep('a', w.researcher, { departmentId: financeDepartment })]),
      ),
    ).toBe('permission:department_mismatch');
    const needy = await w.seed(w.orgA, ALICE, { permissions: ['billing.read'] });
    const w2 = await setup({ roles: { owner: ROLES.owner.filter((p) => p !== 'billing.read') } });
    const needy2 = await w2.seed(w2.orgA, ALICE, { permissions: ['billing.read'] });
    expect(needy.status).toBe('active');
    expect(await refusal(w2, proposal([specialistStep('a', needy2)]))).toBe(
      'permission:specialist_not_eligible',
    );
  });

  it('refuses tools that are not listed, unknown, inactive, denied, restricted or elsewhere', async () => {
    const w = await setup();
    const r = w.researcher;
    const withTool = (toolId: string, performer: Specialist = r) =>
      proposal([specialistStep('work', performer), toolStep('use', 'work', toolId)]);
    expect(await refusal(w, withTool('lookup', w.marketer))).toBe('permission:tool_not_assigned');
    expect(await refusal(w, withTool('no_such_tool'))).toBe('policy:tool_not_found');
    expect(await refusal(w, withTool('retired'))).toBe('policy:tool_not_active');
    expect(await refusal(w, withTool('wipe_data'))).toBe('policy:tool_denied_by_policy');
    // ADR-0159: a tool step only reads, inside MelonOffice.
    expect(await refusal(w, withTool('send_email'))).toBe('policy:tool_not_read_only');
    expect(await refusal(w, withTool('remote_lookup'))).toBe('policy:tool_not_read_only');
    expect(await refusal(w, withTool('keyed_lookup'))).toBe('policy:tool_not_read_only');
    expect(await refusal(w, withTool('finance_report'))).toBe('policy:department_not_allowed');
    expect(await refusal(w, withTool('staging_only'))).toBe('policy:environment_not_allowed');
    expect(await refusal(w, withTool('person_only'))).toBe('policy:tool_not_runtime_invocable');
    const version2 = proposal([
      specialistStep('work', r),
      toolStep('use', 'work', 'lookup', { tool: { id: 'lookup', version: 2 } }),
    ]);
    expect(await refusal(w, version2)).toBe('policy:tool_not_found');
  });

  it('ADR-0184: takes a write built for plans, with fixed input, always approved by a person', async () => {
    const w = await setup();
    const r = w.researcher;
    const ok = await validate(
      w,
      proposal([
        specialistStep('work', r),
        toolStep('write', 'work', 'plan_write', { input: { query: 'Llamar a Ana' } }),
        specialistStep('after', r, { dependsOn: ['work'] }),
      ]),
    );
    if (!ok.ok) throw new Error(ok.reason);
    const write = must(ok.plan.steps.find((s) => s.id === 'write'));
    // Whatever the risk policy says for a low risk: a person approves this exact input.
    expect(write.approvalRequired).toBe(true);
    expect(write.input).toEqual({ query: 'Llamar a Ana' });
    // Its input is never read from an earlier step: a person approves what is fixed.
    expect(
      await refusal(
        w,
        proposal([
          specialistStep('work', r),
          toolStep('write', 'work', 'plan_write', { inputFrom: { query: { step: 'work' } } }),
        ]),
      ),
    ).toBe('policy:input_ref_needs_fixed_input');
    expect(w.validator.toolUse({ id: 'plan_write', version: 1 })).toEqual({
      usable: true,
      riskLevel: 'low',
      approvalRequired: true,
    });
    // Every other write is still refused (ADR-0159).
    expect(w.validator.toolUse({ id: 'send_email', version: 1 })).toMatchObject({
      usable: false,
      reason: 'tool_not_read_only',
    });
  });

  it('ADR-0161: takes tool input from earlier results it names, checked when the plan is made', async () => {
    const w = await setup();
    const r = w.researcher;
    const plan = (...steps: Record<string, unknown>[]) =>
      proposal([
        specialistStep('scan', r),
        toolStep('count', 'scan', 'count_lookup'),
        specialistStep('work', r, { dependsOn: ['scan'] }),
        ...steps,
      ]);
    const ok = await validate(
      w,
      plan(
        toolStep('use', 'work', 'lookup', {
          inputFrom: { query: { step: 'count', field: 'topic' } },
        }),
      ),
    );
    if (!ok.ok) throw new Error(ok.reason);
    const use = must(ok.plan.steps.find((s) => s.id === 'use'));
    expect(use.inputFrom).toEqual({ query: { step: 'count', field: 'topic' } });
    expect(use.input).toEqual({});
    // Its own agent's answer, or an earlier one's, reaches a text input of a low-risk tool.
    for (const step of ['work', 'scan']) {
      const answer = await validate(
        w,
        plan(toolStep('use', 'work', 'lookup', { inputFrom: { query: { step } } })),
      );
      expect(answer.ok).toBe(true);
    }
    // A model never writes the arguments of a riskier tool (D3).
    expect(
      await refusal(
        w,
        plan(toolStep('use', 'work', 'ranked_lookup', { inputFrom: { query: { step: 'work' } } })),
      ),
    ).toBe('policy:tool_input_from_model');
    // A tool's own result is fine for it: it is not model text.
    expect(
      (
        await validate(
          w,
          plan(
            toolStep('use', 'work', 'ranked_lookup', {
              inputFrom: { query: { step: 'count', field: 'topic' } },
            }),
          ),
        )
      ).ok,
    ).toBe(true);
    // An input the tool has, of the type it reads; a field the result has.
    const refused = async (inputFrom: unknown, extra: Record<string, unknown> = {}) =>
      refusal(w, plan(toolStep('use', 'work', 'lookup', { inputFrom, ...extra })));
    expect(await refused({ other: { step: 'count', field: 'topic' } })).toBe(
      'policy:invalid_tool_input_ref',
    );
    expect(await refused({ query: { step: 'count', field: 'count' } })).toBe(
      'policy:invalid_tool_input_ref',
    );
    expect(await refused({ query: { step: 'count', field: 'names' } })).toBe(
      'policy:invalid_tool_input_ref',
    );
    expect(await refused({ query: { step: 'count', field: 'missing' } })).toBe(
      'policy:invalid_tool_input_ref',
    );
    // Results that exist before it runs, never later ones or ones of a branch it does not wait on.
    expect(await refused({ query: { step: 'later' } })).toBe('plan:invalid_input_ref');
    expect(await refused({ query: { step: 'count' } })).toBe('plan:invalid_input_ref');
    expect(
      await refusal(
        w,
        proposal([
          specialistStep('scan', r),
          toolStep('count', 'scan', 'count_lookup'),
          specialistStep('work', r),
          toolStep('use', 'work', 'lookup', { inputFrom: { query: { step: 'scan' } } }),
        ]),
      ),
    ).toBe('plan:invalid_input_ref');
    expect(
      await refusal(
        w,
        proposal([
          specialistStep('work', r),
          toolStep('count', 'work', 'count_lookup'),
          toolStep('use', 'work', 'lookup', {
            inputFrom: { query: { step: 'count', field: 'topic' } },
          }),
        ]),
      ),
    ).toBe('plan:invalid_input_ref');
    expect(
      (
        await validate(
          w,
          proposal([
            specialistStep('work', r),
            toolStep('count', 'work', 'count_lookup'),
            toolStep('use', 'work', 'lookup', {
              dependsOn: ['count'],
              inputFrom: { query: { step: 'count', field: 'topic' } },
            }),
          ]),
        )
      ).ok,
    ).toBe(true);
    // A key is fixed or referenced, never both.
    expect(await refused({ query: { step: 'work' } }, { input: { query: 'melons' } })).toBe(
      'plan:invalid_input_ref',
    );
    // A person approves a tool call with its exact input: such a step takes fixed input only.
    expect(await refused({ query: { step: 'work' } }, { approvalRequired: true })).toBe(
      'policy:input_ref_needs_fixed_input',
    );
    expect(
      await refusal(
        w,
        plan(
          toolStep('use', 'work', 'private_records', {
            inputFrom: { query: { step: 'count', field: 'topic' } },
          }),
        ),
      ),
    ).toBe('policy:input_ref_needs_fixed_input');
    // Names only: no authority, no values, nothing else.
    expect(await refused({ organizationId: { step: 'work' } })).toBe(
      'schema:authority_in_proposal',
    );
    expect(await refused({ query: { step: 'count', field: 'apiKey' } })).toBe(
      'schema:authority_in_proposal',
    );
    expect(await refused({ query: { step: 'work', value: 'x' } })).toBe('schema:invalid_proposal');
    expect(await refused({ query: 'work' })).toBe('schema:invalid_proposal');
    expect(await refused({})).toBe('schema:invalid_proposal');
    expect(
      await refusal(
        w,
        proposal([specialistStep('work', r, { inputFrom: { query: { step: 'work' } } })]),
      ),
    ).toBe('schema:invalid_proposal');
  });

  it('fixes a tool step’s input in the plan, checked against the tool’s own schema (ADR-0151)', async () => {
    const w = await setup();
    const r = w.researcher;
    const withInput = (input: unknown, kind = 'tool') =>
      proposal([
        specialistStep('work', r),
        kind === 'tool'
          ? toolStep('use', 'work', 'lookup', { input })
          : specialistStep('use', r, { input }),
      ]);
    const result = await validate(w, withInput({ query: 'melon prices' }));
    if (!result.ok) throw new Error(result.reason);
    expect(must(result.plan.steps.find((s) => s.id === 'use')).input).toEqual({
      query: 'melon prices',
    });
    // No input is an empty one, which the tool's schema decides about too.
    const none = await validate(
      w,
      proposal([specialistStep('work', r), toolStep('use', 'work', 'lookup')]),
    );
    expect(none.ok && must(none.plan.steps.find((s) => s.id === 'use')).input).toEqual({});
    // Not what the tool takes: refused before anything is planned.
    expect(await refusal(w, withInput({ query: 7 }))).toBe('policy:invalid_tool_input');
    expect(await refusal(w, withInput({ other: 'x' }))).toBe('policy:invalid_tool_input');
    expect(await refusal(w, withInput({ query: 'x'.repeat(101) }))).toBe(
      'policy:invalid_tool_input',
    );
    // Data, never authority or credentials, at any depth.
    expect(await refusal(w, withInput({ organizationId: 'org_b' }))).toBe(
      'schema:authority_in_proposal',
    );
    expect(await refusal(w, withInput({ nested: [{ apiKey: 'x' }] }))).toBe(
      'schema:authority_in_proposal',
    );
    expect(await refusal(w, withInput({ query: 'Bearer abcdefghijklmnop' }))).toBe(
      'schema:secret_in_proposal',
    );
    // Plain JSON only, small, and only on tool steps.
    expect(await refusal(w, withInput('melons'))).toBe('schema:invalid_proposal');
    expect(await refusal(w, withInput({ query: 'x'.repeat(16_001) }))).toBe(
      'schema:invalid_proposal',
    );
    let deep: unknown = 'x';
    for (let i = 0; i < 10; i += 1) deep = { a: deep };
    expect(await refusal(w, withInput(deep))).toBe('schema:invalid_proposal');
    expect(await refusal(w, withInput({ query: 'x' }, 'specialist'))).toBe(
      'schema:invalid_proposal',
    );
  });

  it('refuses a tool whose permissions the user does not hold', async () => {
    const w = await setup({ roles: { owner: ROLES.owner.filter((p) => p !== 'billing.read') } });
    const withTool = proposal([
      specialistStep('work', w.researcher),
      toolStep('use', 'work', 'billing_lookup'),
    ]);
    expect(await refusal(w, withTool)).toBe('permission:permission_not_held');
    const noExecute = await setup({
      roles: { owner: ROLES.owner.filter((p) => p !== 'tool.execute') },
    });
    const lookup = proposal([
      specialistStep('work', noExecute.researcher),
      toolStep('use', 'work', 'lookup'),
    ]);
    expect(await refusal(noExecute, lookup)).toBe('permission:permission_not_held');
  });

  it('refuses no tool step at all when the environment is unknown', async () => {
    const w = await setup({ environment: undefined });
    const withTool = proposal([
      specialistStep('work', w.researcher),
      toolStep('use', 'work', 'lookup'),
    ]);
    expect(await refusal(w, withTool)).toBe('policy:environment_not_allowed');
  });

  it('requires verification and consistent dependencies', async () => {
    const w = await setup();
    const r = w.researcher;
    const noCheck = { ...specialistStep('a', r) };
    delete noCheck.verification;
    expect(await refusal(w, proposal([noCheck]))).toBe('policy:verification_missing');
    const onOutcome = [
      specialistStep('a', r),
      specialistStep('b', r),
      {
        id: 'c',
        kind: 'condition',
        label: 'If',
        dependsOn: ['a'],
        condition: { step: 'b', outcome: 'completed' },
      },
    ];
    // The structure still refuses a condition on a step it does not wait for…
    const checked = checkProposal(proposal(onOutcome));
    if (!checked.ok) throw new Error(checked.reason);
    expect(checkStepStructure(checked.proposal.steps)).toEqual({
      ok: false,
      reason: 'invalid_condition',
      detail: 'steps.2',
    });
    // …and a plan never proposes one: no plan can run a condition on how a step ended yet.
    expect(await refusal(w, proposal(onOutcome))).toBe('schema:step_not_runnable');
    // A condition is either how a step ended or a decision, never both nor neither, and a
    // decision waits on at least one step.
    const decision = { decision: 'action.policy_check', continueOn: ['allowed'] };
    for (const step of [
      { id: 'c', kind: 'condition', label: 'If', dependsOn: ['a'] },
      {
        id: 'c',
        kind: 'condition',
        label: 'If',
        dependsOn: ['a'],
        condition: { step: 'a', outcome: 'completed' },
        decision,
      },
      { id: 'c', kind: 'condition', label: 'If', dependsOn: [], decision },
    ]) {
      expect(await refusal(w, proposal([specialistStep('a', r), step]))).toMatch(
        /^schema:invalid_proposal$/,
      );
    }
    // A decision only belongs on a condition step.
    expect(await refusal(w, proposal([specialistStep('a', r, { decision })]))).toBe(
      'schema:invalid_proposal',
    );
    expect(
      await refusal(
        w,
        proposal([
          specialistStep('a', r),
          specialistStep('b', r),
          toolStep('t', 'a', 'lookup', { dependsOn: ['b'] }),
        ]),
      ),
    ).toBe('plan:invalid_tool_dependency');
    expect(
      await refusal(
        w,
        proposal([
          specialistStep('a', r),
          toolStep('t', 'a', 'lookup'),
          specialistStep('b', r, { dependsOn: ['t'] }),
        ]),
      ),
    ).toBe('plan:invalid_dependency');
    expect(
      await refusal(
        w,
        proposal([
          specialistStep('a', r),
          { id: 'x', kind: 'wait', label: 'Wait', dependsOn: ['a'], wait: { seconds: 60 } },
          toolStep('t', 'x', 'lookup'),
        ]),
      ),
    ).toBe('plan:invalid_performer');
    // A kind carries only its own fields: a tool on a specialist step is refused.
    expect(
      await refusal(w, proposal([specialistStep('a', r, { tool: { id: 'lookup', version: 1 } })])),
    ).toBe('schema:invalid_proposal');
  });

  it('estimates only from known prices and a configured rate, never inventing a cost', async () => {
    const budget = { inputTokens: 1_000, outputTokens: 1_000 };
    const noRate = await setup();
    const unknown = await validate(
      noRate,
      proposal([specialistStep('a', noRate.researcher, { budget })]),
    );
    expect(unknown.ok && unknown.plan.estimate).toEqual({
      status: 'unknown',
      costMicroUsd: null,
      credits: null,
    });
    expect(unknown.ok && unknown.plan.steps[0]?.estimate).toEqual({
      status: 'unknown',
      costMicroUsd: 5_000,
      credits: null,
    });
    const rated = await setup({ rate: 1_000 });
    const known = await validate(
      rated,
      proposal([
        specialistStep('a', rated.researcher, { budget }),
        specialistStep('b', rated.researcher, { budget }),
      ]),
    );
    expect(known.ok && known.plan.estimate).toEqual({
      status: 'estimated',
      costMicroUsd: 10_000,
      credits: 10,
    });
    const noBudget = await validate(rated, proposal([specialistStep('a', rated.researcher)]));
    expect(noBudget.ok && noBudget.plan.estimate.status).toBe('unknown');
  });
});

describe('plans', () => {
  it('stores a validated plan, runs nothing, and audits plan.created', async () => {
    const w = await setup();
    const { plan, version, execution } = await propose(w, [
      specialistStep('research', w.researcher),
    ]);
    expect(plan.status).toBe('ready');
    expect(plan.id).toBe(execution.id);
    expect(version.digest).toMatch(/^[0-9a-f]{64}$/);
    // Creating a plan executes nothing: no nodes, no child executions, no status change.
    const after = await w.executions.get(w.tenantA, execution.id);
    expect(after.status).toBe('planning');
    expect(after.nodes).toHaveLength(0);
    expect(w.events('execution.created')).toHaveLength(1);
    expect(w.events('plan.created')).toEqual([
      expect.objectContaining({ result: 'success', target: { type: 'plan', id: plan.id } }),
    ]);
    expect(
      await codeOf(
        w.plans.propose(w.tenantA, {
          executionId: execution.id,
          proposal: proposal([specialistStep('x', w.researcher)]),
          source: version.source,
        }),
      ),
    ).toBe('plan_concurrency_conflict');
  });

  it('moves the execution to waiting_approval when the plan needs a human', async () => {
    const w = await setup();
    const { plan, execution } = await propose(w, [
      specialistStep('research', w.researcher),
      toolStep('notify', 'research', 'private_records'),
    ]);
    expect(plan.status).toBe('approval_required');
    expect((await w.executions.get(w.tenantA, execution.id)).status).toBe('waiting_approval');
  });

  it('records a refused proposal and stores nothing', async () => {
    const w = await setup();
    const execution = await w.planning(w.tenantA, w.owner);
    const outcome = await w.plans.propose(w.tenantA, {
      executionId: execution.id,
      proposal: proposal([specialistStep('a', w.researcher, { approved: true })]),
      source: {
        kind: 'planner',
        model: { provider: 'alpha', id: 'm', version: 'v' },
        policy: { id: 'p', version: 1 },
      },
    });
    expect(outcome).toEqual({
      status: 'refused',
      stage: 'schema',
      reason: 'authority_in_proposal',
      detail: 'steps.0.approved',
    });
    expect(w.events('plan.proposal_refused')).toEqual([
      expect.objectContaining({
        result: 'denied',
        reason: 'authority_in_proposal',
        target: { type: 'execution', id: execution.id },
      }),
    ]);
    expect(await codeOf(w.plans.get(w.tenantA, execution.id))).toBe('plan_not_found');
  });

  it('refuses executions that are not planning, or a workflow source that does not match', async () => {
    const w = await setup();
    const execution = await w.planning(w.tenantA, w.owner);
    const running = await w.executions.changeStatus(w.tenantA, execution.id, {
      from: 'planning',
      to: 'running',
    });
    const input = {
      executionId: running.id,
      proposal: proposal([specialistStep('a', w.researcher)]),
      source: {
        kind: 'planner' as const,
        model: { provider: 'a', id: 'm', version: 'v' },
        policy: { id: 'p', version: 1 },
      },
    };
    expect(await codeOf(w.plans.propose(w.tenantA, input))).toBe('execution_not_plannable');
    const fresh = await w.planning(w.tenantA, w.owner);
    expect(
      await codeOf(
        w.plans.propose(w.tenantA, {
          ...input,
          executionId: fresh.id,
          source: { kind: 'workflow', workflowId: 'wf' as never, workflowVersion: 1 },
        }),
      ),
    ).toBe('execution_not_plannable');
  });

  it('keeps tenants apart: another organization sees no plan', async () => {
    const w = await setup();
    const { plan } = await propose(w, [specialistStep('research', w.researcher)]);
    expect(await codeOf(w.plans.get(w.tenantB, plan.id))).toBe('plan_not_found');
    expect(await w.plans.list(w.tenantB)).toEqual([]);
    expect(await w.plans.list(w.tenantA)).toHaveLength(1);
    expect(await codeOf(w.plans.get(w.tenantA, 'not-a-uuid'))).toBe('plan_not_found');
    const fromB = await w.planning(w.tenantB, await w.seed(w.orgB, BOB));
    expect(
      await codeOf(
        w.plans.propose(w.tenantA, {
          executionId: fromB.id,
          proposal: proposal([specialistStep('a', w.researcher)]),
          source: {
            kind: 'planner',
            model: { provider: 'a', id: 'm', version: 'v' },
            policy: { id: 'p', version: 1 },
          },
        }),
      ),
    ).toBe('execution_not_found');
  });

  it('ADR-0180: a workflow’s plan names its workflow for good, and lists by workflow stay in their organization', async () => {
    const w = await setup();
    const workflowId = '11111111-1111-4111-8111-111111111111' as WorkflowId;
    // A planning execution that recorded the workflow's version, as the workflow service makes.
    const execution = await w.executions.create(w.tenantA, {
      mode: 'plan',
      input: { type: 'task', id: 'task-1' },
      specialistId: w.owner.identity.id,
      specialistVersion: w.owner.version,
      departmentId: w.owner.configuration.departmentId,
      workflowId,
      versionSnapshot: {
        schemaVersion: 1,
        components: [
          { kind: 'specialist', id: w.owner.identity.id, version: String(w.owner.version) },
          { kind: 'workflow', id: workflowId, version: '3' },
        ],
      },
    });
    await w.executions.changeStatus(w.tenantA, execution.id, { from: 'pending', to: 'planning' });
    const fromWorkflow = await w.plans.propose(w.tenantA, {
      executionId: execution.id,
      proposal: proposal([specialistStep('research', w.researcher)]),
      source: { kind: 'workflow', workflowId, workflowVersion: 3 },
    });
    if (fromWorkflow.status !== 'planned') throw new Error(fromWorkflow.status);
    expect(fromWorkflow.plan.workflow).toEqual({ id: workflowId, version: 3 });
    const { plan: fromPlanner } = await propose(w, [specialistStep('research', w.researcher)]);
    expect(fromPlanner.workflow).toBeUndefined();

    expect((await w.plans.listForWorkflow(w.tenantA, workflowId)).map((p) => p.id)).toEqual([
      fromWorkflow.plan.id,
    ]);
    expect(await w.plans.listForWorkflow(w.tenantB, workflowId)).toEqual([]);
    // A page of it (ADR-0182): the same plans, in the same organization only.
    expect(await w.plans.pageForWorkflow(w.tenantA, workflowId, { limit: 1 })).toEqual({
      items: [fromWorkflow.plan],
      hasMore: false,
    });
    expect(
      await w.plans.pageForWorkflow(w.tenantA, workflowId, {
        after: { at: fromWorkflow.plan.createdAt, id: fromWorkflow.plan.id },
        limit: 1,
      }),
    ).toEqual({ items: [], hasMore: false });
    expect(await w.plans.pageForWorkflow(w.tenantB, workflowId, { limit: 1 })).toEqual({
      items: [],
      hasMore: false,
    });

    // An update that changes or drops it is refused, as a concurrent change would be.
    for (const workflow of [undefined, { id: workflowId, version: 4 }]) {
      expect(
        await codeOf(
          w.planRepository.update(w.orgA, fromWorkflow.plan.id, (current) => ({
            plan: { ...current, workflow, revision: current.revision + 1 } as Plan,
            events: [],
          })),
        ),
      ).toBe('plan_concurrency_conflict');
    }
  });

  it('ADR-0185: a standing approval decides only its own schedule’s occurrence, up to medium risk', async () => {
    const w = await setup();
    const workflowId = '11111111-1111-4111-8111-111111111111' as WorkflowId;
    const occurrence = '2026-10-05T14:00:00.000Z' as IsoTimestamp;
    async function planned(risk?: 'high', occurrenceOf: IsoTimestamp | null = occurrence) {
      const execution = await w.executions.create(w.tenantA, {
        mode: 'plan',
        input: { type: 'task', id: 'task-1' },
        specialistId: w.owner.identity.id,
        specialistVersion: w.owner.version,
        departmentId: w.owner.configuration.departmentId,
        workflowId,
        versionSnapshot: {
          schemaVersion: 1,
          components: [
            { kind: 'specialist', id: w.owner.identity.id, version: String(w.owner.version) },
            { kind: 'workflow', id: workflowId, version: '3' },
          ],
        },
      });
      await w.executions.changeStatus(w.tenantA, execution.id, { from: 'pending', to: 'planning' });
      const outcome = await w.plans.propose(w.tenantA, {
        executionId: execution.id,
        proposal: proposal(
          [specialistStep('research', w.researcher)],
          risk === undefined ? {} : { riskLevel: risk },
        ),
        source: {
          kind: 'workflow',
          workflowId,
          workflowVersion: 3,
          ...(occurrenceOf === null ? {} : { occurrence: occurrenceOf }),
        },
      });
      if (outcome.status !== 'planned') throw new Error(outcome.status);
      return outcome.plan;
    }
    const standing = { workflowId, workflowVersion: 3 };

    const plan = await planned();
    expect(plan.workflow).toEqual({ id: workflowId, version: 3, occurrence });
    // Never a person's own decision, nor GIA's: only the runtime of the plan's person.
    expect(await codeOf(w.plans.approveScheduled(w.tenantA, plan.id, standing))).toBe(
      'permission_denied',
    );
    expect(await codeOf(w.plans.approveScheduled(w.giaA, plan.id, standing))).toBe(
      'permission_denied',
    );
    // Another workflow or version is not what the person approved.
    for (const other of [
      { workflowId: '22222222-2222-4222-8222-222222222222' as WorkflowId, workflowVersion: 3 },
      { workflowId, workflowVersion: 4 },
    ]) {
      expect(await codeOf(w.plans.approveScheduled(w.runtimeA, plan.id, other))).toBe(
        'permission_denied',
      );
    }
    const approved = await w.plans.approveScheduled(w.runtimeA, plan.id, standing);
    expect(approved.status).toBe('approved');
    expect(approved.decision).toMatchObject({ decidedBy: ALICE, via: 'schedule' });
    // Decided once: again, it is a change someone else already made.
    expect(await codeOf(w.plans.approveScheduled(w.runtimeA, plan.id, standing))).toBe(
      'plan_concurrency_conflict',
    );

    // A plan a person made by hand, or one of high risk, waits for a person.
    const byHand = await planned(undefined, null);
    const risky = await planned('high');
    for (const [p, reason] of [
      [byHand, 'not_standing'],
      [risky, 'risk_needs_person'],
    ] as const) {
      expect(await codeOf(w.plans.approveScheduled(w.runtimeA, p.id, standing))).toBe(
        'permission_denied',
      );
      expect((await w.plans.get(w.tenantA, p.id)).status).toBe('approval_required');
      expect(
        w.events('plan.approved').some((e) => e.target?.id === p.id && e.reason === reason),
      ).toBe(true);
    }
    // Another organization's runtime finds nothing.
    expect(await codeOf(w.plans.approveScheduled(w.tenantB, plan.id, standing))).toBe(
      'plan_not_found',
    );
  });

  it('refuses a stored version whose content no longer matches its digest', async () => {
    const w = await setup();
    const { plan, version } = await propose(w, [specialistStep('research', w.researcher)]);
    w.planRepository.putVersion({
      ...version,
      riskLevel: 'low',
      approvalRequired: false,
      steps: [{ ...must(version.steps[0]), label: 'Changed' }],
    });
    expect(await codeOf(w.plans.getVersion(w.tenantA, plan.id, 1))).toBe('invalid_plan');
    expect(await codeOf(w.delegation.delegate(w.tenantA, plan.id))).toBe('invalid_plan');
  });
});

describe('plan approval', () => {
  const needsApproval = async (options: WorldOptions = {}) => {
    const w = await setup(options);
    const made = await propose(w, [
      specialistStep('research', w.researcher),
      toolStep('notify', 'research', 'private_records'),
    ]);
    return { w, ...made, seen: { version: made.version.version, digest: made.version.digest } };
  };

  it('lets a user approve exactly the version they saw', async () => {
    const { w, plan, seen } = await needsApproval();
    const approved = await w.plans.approve(w.tenantA, plan.id, seen);
    expect(approved.status).toBe('approved');
    expect(approved.decision).toEqual(
      expect.objectContaining({
        decision: 'approved',
        version: 1,
        digest: seen.digest,
        decidedBy: ALICE,
      }),
    );
    expect(w.events('plan.approved')).toEqual([
      expect.objectContaining({
        result: 'success',
        transition: { from: 'approval_required', to: 'approved' },
      }),
    ]);
    expect(await codeOf(w.plans.approve(w.tenantA, plan.id, seen))).toBe(
      'plan_concurrency_conflict',
    );
  });

  it('never lets GIA decide, and records the refusal', async () => {
    const { w, plan, seen } = await needsApproval();
    expect(await codeOf(w.plans.approve(w.giaA, plan.id, seen))).toBe('gia_cannot_decide');
    expect(await codeOf(w.plans.reject(w.giaA, plan.id, seen))).toBe('gia_cannot_decide');
    expect(w.events('plan.approved')).toEqual([
      expect.objectContaining({
        result: 'denied',
        reason: 'gia_cannot_decide',
        actor: { type: 'user', userId: ALICE, via: 'gia' },
      }),
    ]);
    expect((await w.plans.get(w.tenantA, plan.id)).status).toBe('approval_required');
  });

  it('3. never lets the runtime take a human decision on a plan (ADR-0029)', async () => {
    const { w, plan, seen } = await needsApproval();
    expect(await codeOf(w.plans.approve(w.runtimeA, plan.id, seen))).toBe('runtime_cannot_decide');
    expect(await codeOf(w.plans.reject(w.runtimeA, plan.id, seen))).toBe('runtime_cannot_decide');
    expect(w.events('plan.approved')).toEqual([
      expect.objectContaining({
        result: 'denied',
        reason: 'runtime_cannot_decide',
        actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
      }),
    ]);
    expect((await w.plans.get(w.tenantA, plan.id)).status).toBe('approval_required');
  });

  it('requires approval.approve', async () => {
    const { w, plan, seen } = await needsApproval({
      roles: { owner: ROLES.owner.filter((p) => p !== 'approval.approve') },
    });
    expect(await codeOf(w.plans.approve(w.tenantA, plan.id, seen))).toBe('permission_denied');
  });

  it('refuses an approval for another version or digest', async () => {
    const { w, plan, seen } = await needsApproval();
    expect(
      await codeOf(w.plans.approve(w.tenantA, plan.id, { ...seen, digest: '0'.repeat(64) })),
    ).toBe('plan_version_mismatch');
    expect(await codeOf(w.plans.approve(w.tenantA, plan.id, { ...seen, version: 2 }))).toBe(
      'plan_version_mismatch',
    );
    expect(await codeOf(w.plans.approve(w.tenantA, plan.id, { ...seen, digest: 'nope' }))).toBe(
      'plan_version_mismatch',
    );
  });

  it('has no approval path for a plan that needs none, and none across tenants', async () => {
    const w = await setup();
    const { plan, version } = await propose(w, [specialistStep('research', w.researcher)]);
    const seen = { version: 1, digest: version.digest };
    expect(await codeOf(w.plans.approve(w.tenantA, plan.id, seen))).toBe(
      'plan_concurrency_conflict',
    );
    const other = await needsApproval();
    expect(await codeOf(other.w.plans.approve(other.w.tenantB, other.plan.id, other.seen))).toBe(
      'plan_not_found',
    );
  });

  it('ends the work of a rejected plan', async () => {
    const { w, plan, execution, seen } = await needsApproval();
    const rejected = await w.plans.reject(w.tenantA, plan.id, seen);
    expect(rejected.status).toBe('rejected');
    const after = await w.executions.get(w.tenantA, execution.id);
    expect(after.status).toBe('cancelled');
    expect(after.cancellation?.reason).toBe('plan_rejected');
    expect(await codeOf(w.delegation.delegate(w.tenantA, plan.id))).toBe('invalid_plan_transition');
  });
});

describe('delegation', () => {
  it('hands each specialist step to its own pending child execution', async () => {
    const w = await setup();
    const { plan, execution } = await propose(w, [
      specialistStep('research', w.researcher),
      toolStep('search', 'research', 'lookup'),
      specialistStep('campaign', w.marketer, { dependsOn: ['research'] }),
      { id: 'pause', kind: 'wait', label: 'Wait', dependsOn: ['campaign'], wait: { seconds: 60 } },
    ]);
    const { plan: delegated, children } = await w.delegation.delegate(w.tenantA, plan.id);
    expect(delegated.status).toBe('executing');
    expect(children).toHaveLength(2);
    const [research, campaign] = children.map(must);
    expect(research).toEqual(
      expect.objectContaining({
        status: 'pending',
        mode: 'execute',
        parentExecutionId: execution.id,
        specialistId: w.researcher.identity.id,
        departmentId: w.researcher.configuration.departmentId,
      }),
    );
    expect(research?.nodes.map((n) => [n.id, n.type, n.status])).toEqual([
      ['research', 'agent', 'pending'],
      ['search', 'tool', 'pending'],
    ]);
    expect(research?.versionSnapshot.components).toEqual(
      expect.arrayContaining([
        { kind: 'specialist', id: w.researcher.identity.id, version: '1' },
        { kind: 'plan', id: plan.id, version: '1' },
      ]),
    );
    expect(campaign?.specialistId).toBe(w.marketer.identity.id);
    expect(delegated.delegations).toEqual([
      { stepId: 'research', executionId: research?.id },
      { stepId: 'campaign', executionId: campaign?.id },
    ]);
    const parent = await w.executions.get(w.tenantA, execution.id);
    expect(parent.status).toBe('running');
    expect(parent.nodes.map((n) => n.id)).toEqual(['research', 'campaign', 'pause']);
    expect(w.events('delegation.created')).toHaveLength(2);
    expect(w.events('plan.state_changed')).toEqual([
      expect.objectContaining({ transition: { from: 'ready', to: 'executing' } }),
    ]);
    // Nothing ran: no tool was invoked and no AI was called.
    expect(w.calls).toHaveLength(0);
    expect(w.events().filter((e) => e.action.startsWith('tool.'))).toHaveLength(0);
    expect(delegated.delegationState).toBe('completed');
    // Delegating again changes nothing and returns the same children.
    const again = await w.delegation.delegate(w.tenantA, plan.id);
    expect(again.children.map((c) => c.id)).toEqual(children.map((c) => c.id));
    expect(w.events('delegation.created')).toHaveLength(2);
  });

  it('delegates a plan that needs approval only after a user approved it', async () => {
    const w = await setup();
    const { plan, version } = await propose(w, [
      specialistStep('research', w.researcher),
      toolStep('notify', 'research', 'private_records'),
    ]);
    expect(await codeOf(w.delegation.delegate(w.tenantA, plan.id))).toBe('invalid_plan_transition');
    await w.plans.approve(w.tenantA, plan.id, { version: 1, digest: version.digest });
    const { children } = await w.delegation.delegate(w.tenantA, plan.id);
    expect(children).toHaveLength(1);
  });

  it('stops before writing anything when a specialist is no longer eligible', async () => {
    const w = await setup();
    const { plan, execution } = await propose(w, [
      specialistStep('research', w.researcher),
      specialistStep('campaign', w.marketer),
    ]);
    await w.pause(w.orgA, w.marketer);
    expect(await codeOf(w.delegation.delegate(w.tenantA, plan.id))).toBe('specialist_not_eligible');
    expect((await w.executions.get(w.tenantA, execution.id)).nodes).toHaveLength(0);
    expect(w.events('execution.created')).toHaveLength(1);
    expect((await w.plans.get(w.tenantA, plan.id)).status).toBe('ready');
  });

  it('refuses another organization, and needs plan.create', async () => {
    const w = await setup();
    const { plan } = await propose(w, [specialistStep('research', w.researcher)]);
    expect(await codeOf(w.delegation.delegate(w.tenantB, plan.id))).toBe('plan_not_found');
    const limited = await setup({
      roles: { owner: ROLES.owner.filter((p) => p !== 'plan.create') },
    });
    expect(await codeOf(limited.delegation.delegate(limited.tenantA, plan.id))).toBe(
      'permission_denied',
    );
  });

  it('refuses a plan whose execution already has the plan graph', async () => {
    const w = await setup();
    const { plan, execution } = await propose(w, [specialistStep('research', w.researcher)]);
    await w.executions.addNodes(w.tenantA, execution.id, [
      { id: 'research', type: 'agent', label: 'Taken' },
    ]);
    expect(await codeOf(w.delegation.delegate(w.tenantA, plan.id))).toBe('delegation_conflict');
  });
});

describe('errors', () => {
  it('carry stable codes', () => {
    const error = new PlanningError('invalid_plan', 'steps');
    expect(error.message).toBe('invalid_plan: steps');
    expect(isPlanningError(error)).toBe(true);
  });
});
