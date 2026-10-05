import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

/**
 * Automations (WF-3, ADR-0071): the owner plans an active workflow, reads the plan it gave and
 * approves that exact version; each step's answer shows once the API has it. Nothing is shown
 * that the API did not give, and nothing is offered to a role that may not do it.
 */

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const OWNER = ['workflow.read', 'plan.read', 'plan.create', 'approval.approve'];

const WORKFLOWS = [
  {
    id: 'wf-launch',
    name: 'Lanzamiento',
    status: 'active',
    version: 2,
    createdAt: '2026-09-29T10:00:00Z',
    createdBy: 'user-1',
    updatedAt: '2026-09-29T10:00:00Z',
  },
  {
    id: 'wf-draft',
    name: 'Borrador de ventas',
    status: 'draft',
    version: 1,
    createdAt: '2026-09-29T10:00:00Z',
    createdBy: 'user-1',
    updatedAt: '2026-09-29T10:00:00Z',
  },
];

function open(
  configure?: (backend: ReturnType<typeof fakeBackend>) => void,
  permissions: readonly string[] = OWNER,
) {
  globalThis.history.replaceState(null, '', '/automations');
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push(...permissions);
  backend.options.workflows.org_1 = WORKFLOWS.map((w) => ({ ...w }));
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const posts = (backend: ReturnType<typeof fakeBackend>, suffix: string) =>
  backend.apiCalls().filter((c) => c.method === 'POST' && c.url.endsWith(suffix));

describe('Automations (WF-3)', () => {
  it('plans an active workflow once, shows the plan waiting, and approves that exact version', async () => {
    const backend = open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Automations' })).toBeTruthy();
    const workflows = within(screen.getByRole('region', { name: 'Workflows' }));
    expect(await workflows.findByText('Lanzamiento')).toBeTruthy();
    // Only an active workflow can be planned.
    const buttons = workflows.getAllByRole('button', { name: 'Prepare a plan' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);

    const plan = await screen.findByRole('article', { name: 'Lanzamiento' });
    expect(within(plan).getByText(/Waiting for your approval/)).toBeTruthy();
    expect(within(plan).getByText('Research')).toBeTruthy();
    const [planned] = posts(backend, '/workflows/wf-launch/plans');
    expect(planned?.url).toBe(`${API}/v1/organizations/org_1/workflows/wf-launch/plans`);
    expect(JSON.parse(planned?.body ?? '{}')).toEqual({
      requestKey: expect.stringMatching(/^web-[0-9a-f-]{36}$/),
    });

    backend.options.planSteps['plan-1'] = [
      {
        stepId: 'research',
        label: 'Research',
        executionId: 'ex-1',
        status: 'completed',
        failure: null,
        answer: 'El mercado de melón crece.',
        missing: ['precios del competidor'],
      },
    ];
    fireEvent.click(within(plan).getByRole('button', { name: 'Approve and start' }));
    expect(await within(plan).findByText('El mercado de melón crece.')).toBeTruthy();
    expect(within(plan).getByText('Missing to answer fully: precios del competidor')).toBeTruthy();
    expect(within(plan).getByText(/Running/)).toBeTruthy();
    const [approved] = posts(backend, '/plans/plan-1/approve');
    expect(JSON.parse(approved?.body ?? '{}')).toEqual({ version: 1, digest: 'a'.repeat(64) });
    expect(within(plan).queryByRole('button', { name: 'Approve and start' })).toBeNull();
  });

  it('says why a plan was refused and opens nothing', async () => {
    const backend = open((b) => {
      b.options.planRefusal = 'tool_not_available';
    });
    const workflows = within(await screen.findByRole('region', { name: 'Workflows' }));
    fireEvent.click(await workflows.findByRole('button', { name: 'Prepare a plan' }));
    // A reason with no plain wording still says what to do; its code is folded away (ADR-0167).
    const refusal = (await screen.findByText(/Something did not pass the checks\./)).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(refusal.textContent).toContain('The plan could not be prepared.');
    expect(refusal.textContent).toContain('share the technical detail with support');
    expect(within(refusal).getByText('Technical detail')).toBeTruthy();
    expect(refusal.querySelector('code')?.textContent).toContain('tool_not_available');
    expect(screen.queryByRole('article')).toBeNull();
    expect(posts(backend, '/approve')).toHaveLength(0);
  });

  it('says plainly why a plan was refused when the reason is one a person can act on', async () => {
    open((b) => {
      b.options.planRefusal = 'specialist_not_eligible';
    });
    const workflows = within(await screen.findByRole('region', { name: 'Workflows' }));
    fireEvent.click(await workflows.findByRole('button', { name: 'Prepare a plan' }));
    const refusal = (
      await screen.findByText(/No active agent has the role one of the steps needs\./)
    ).closest('[role="alert"]') as HTMLElement;
    expect(refusal.textContent).toContain(
      'Create or activate one in Agents and prepare the plan again.',
    );
  });

  it('ADR-0167: a tool the agent does not have is refused in words, with the step and what to do', async () => {
    open((b) => {
      b.options.planRefusal = 'tool_not_assigned';
    });
    const workflows = within(await screen.findByRole('region', { name: 'Workflows' }));
    fireEvent.click(await workflows.findByRole('button', { name: 'Prepare a plan' }));
    const refusal = (
      await screen.findByText(/A step uses a tool the agent that would do it does not have\./)
    ).closest('[role="alert"]') as HTMLElement;
    expect(refusal.textContent).toContain('Give that agent the skill that allows it, in Agents');
    // The code is there for support, folded away.
    expect(refusal.querySelector('details code')?.textContent).toContain('tool_not_assigned');
  });

  it('shows the estimate before approval, what each check decided, and the steps it skipped', async () => {
    const check = {
      decision: 'action.policy_check',
      continueOn: ['allowed'],
      input: { action: 'opportunity.offer_discount', discountPercent: 20 },
    };
    const planOf = (status: string) => ({
      id: 'plan-5',
      status,
      version: 1,
      createdAt: '2026-09-29T09:00:00Z',
      current: {
        version: 1,
        digest: 'd'.repeat(64),
        request: { summary: 'Descuentos', objective: 'Ofrecer un descuento' },
        steps: [
          { id: 'offer', kind: 'specialist', label: 'Offer', dependsOn: [] },
          {
            id: 'policy',
            kind: 'condition',
            label: 'Policy',
            dependsOn: ['offer'],
            decision: check,
          },
          { id: 'send', kind: 'specialist', label: 'Send', dependsOn: ['policy'] },
          { id: 'log', kind: 'specialist', label: 'Log', dependsOn: ['offer'] },
        ],
        riskLevel: 'low',
        estimate: { status: 'estimated', credits: 3 },
        source: { kind: 'workflow', workflowId: 'wf-launch', workflowVersion: 2 },
      },
    });
    const progress = (
      stepId: string,
      kind: string,
      state: string,
      status: string | null,
      outcome: string | null = null,
    ) => ({
      stepId,
      kind,
      label: stepId,
      state,
      outcome,
      executionId: status === null ? null : `exec-${stepId}`,
      status,
      failure: null,
      answer: null,
      missing: [],
    });
    open((b) => {
      b.options.plans.org_1 = [planOf('approval_required')];
    });
    let plans = within(await screen.findByRole('region', { name: 'Plans' }));
    fireEvent.click(await plans.findByRole('button', { name: /Waiting for your approval/ }));
    let plan = await screen.findByRole('article', { name: 'Descuentos' });
    expect(
      within(plan).getByText(
        "Estimated cost: 3 credits. An estimate, not a charge. Approving makes it this plan's credit limit: a step that would go over it does not run.",
      ),
    ).toBeTruthy();
    expect(
      within(plan).getByText(/checks company policy for a discount on an opportunity/),
    ).toBeTruthy();

    cleanup();
    open((b) => {
      b.options.plans.org_1 = [planOf('completed')];
      b.options.planSteps['plan-5'] = [
        progress('offer', 'specialist', 'completed', 'completed'),
        progress('policy', 'condition', 'stopped', null, 'approval_required'),
        // Its child was never started: without the skip it would read "Waiting" for ever.
        progress('send', 'specialist', 'skipped', 'pending'),
        progress('log', 'specialist', 'completed', 'completed'),
      ];
    });
    plans = within(await screen.findByRole('region', { name: 'Plans' }));
    fireEvent.click(await plans.findByRole('button', { name: /Completed/ }));
    plan = await screen.findByRole('article', { name: 'Descuentos' });
    expect(
      await within(plan).findByText(
        /Not allowed without approval: the steps after it were skipped/,
      ),
    ).toBeTruthy();
    expect(within(plan).getByText(/Skipped: an earlier step ended this branch/)).toBeTruthy();
    expect(within(plan).getAllByText(/Done/)).toHaveLength(2);
    // Once decided, no estimate is shown: it was only for deciding.
    expect(within(plan).queryByText(/Estimated cost/)).toBeNull();
  });

  it('ADR-0162, ADR-0163: says a plan without an estimate has no credit limit, which step the limit stopped and which branch failed', async () => {
    const planOf = (status: string, credits: number | null) => ({
      id: 'plan-6',
      status,
      version: 1,
      createdAt: '2026-09-29T09:00:00Z',
      ...(status === 'completed'
        ? {
            budgetBlocks: [
              {
                stepId: 'report',
                usedCredits: 12,
                neededCredits: 5,
                capCredits: 15,
                blockedAt: '2026-09-29T10:00:00Z',
              },
            ],
          }
        : {}),
      current: {
        version: 1,
        digest: 'e'.repeat(64),
        request: { summary: 'Informe', objective: 'Preparar el informe' },
        steps: [
          { id: 'research', kind: 'specialist', label: 'Research', dependsOn: [] },
          { id: 'draft', kind: 'specialist', label: 'Draft', dependsOn: [] },
          { id: 'report', kind: 'specialist', label: 'Report', dependsOn: ['research'] },
        ],
        riskLevel: 'low',
        estimate:
          credits === null
            ? { status: 'unknown', credits: null }
            : { status: 'estimated', credits },
        source: { kind: 'planner' },
      },
    });
    open((b) => {
      b.options.plans.org_1 = [planOf('approval_required', null)];
    });
    let plans = within(await screen.findByRole('region', { name: 'Plans' }));
    fireEvent.click(await plans.findByRole('button', { name: /Waiting for your approval/ }));
    let plan = await screen.findByRole('article', { name: 'Informe' });
    expect(
      within(plan).getByText('No credit estimate for this plan, so it has no credit limit.'),
    ).toBeTruthy();

    cleanup();
    const step = (stepId: string, state: string, failure: string | null) => ({
      stepId,
      kind: 'specialist',
      label: stepId,
      state,
      executionId: `exec-${stepId}`,
      status: state,
      failure,
      answer: null,
      missing: [],
    });
    open((b) => {
      b.options.plans.org_1 = [planOf('completed', 15)];
      b.options.planSteps['plan-6'] = [
        step('research', 'completed', null),
        step('draft', 'failed', 'agent_failed'),
        step('report', 'failed', 'budget_exceeded'),
      ];
    });
    plans = within(await screen.findByRole('region', { name: 'Plans' }));
    fireEvent.click(await plans.findByRole('button', { name: /Completed/ }));
    plan = await screen.findByRole('article', { name: 'Informe' });
    expect(
      await within(plan).findByText(
        /Not run: it needed 5 credits and the plan had used 12 of its 15-credit limit/,
      ),
    ).toBeTruthy();
    // Said once, in the failed step's own box (ADR-0167), never twice.
    expect(
      within(plan).getByText(
        /The steps that depend on this one are skipped; the other branches go on/,
      ),
    ).toBeTruthy();
    expect(
      within(plan).queryByText(
        /Failed: the steps that depend on it are skipped; other branches go on/,
      ),
    ).toBeNull();
  });

  it('ADR-0146: a step that asked a person waits for them, links to Approvals, and a rejection skips only its branch', async () => {
    const plan = {
      id: 'plan-6',
      status: 'executing',
      version: 1,
      createdAt: '2026-09-29T09:00:00Z',
      current: {
        version: 1,
        digest: 'd'.repeat(64),
        request: { summary: 'Campaña', objective: 'Lanzar la campaña' },
        steps: [
          { id: 'research', kind: 'specialist', label: 'Research', dependsOn: [] },
          { id: 'campaign', kind: 'specialist', label: 'Campaign', dependsOn: ['research'] },
          {
            id: 'launch',
            kind: 'specialist',
            label: 'Launch',
            dependsOn: ['campaign'],
            approvalRequired: true,
          },
          { id: 'brief', kind: 'specialist', label: 'Brief', dependsOn: ['research'] },
        ],
        riskLevel: 'low',
        estimate: { status: 'not_estimated' },
        source: { kind: 'workflow', workflowId: 'wf-launch', workflowVersion: 2 },
      },
    };
    const progress = (
      stepId: string,
      state: string,
      status: string,
      failure: string | null = null,
    ) => ({
      stepId,
      kind: 'specialist',
      label: stepId,
      state,
      outcome: null,
      executionId: `exec-${stepId}`,
      status,
      approvalId: stepId === 'campaign' ? 'appr-1' : null,
      failure,
      answer: null,
      missing: [],
    });
    open((b) => {
      b.options.plans.org_1 = [plan];
      b.options.planSteps['plan-6'] = [
        progress('research', 'completed', 'completed'),
        progress('campaign', 'awaiting_approval', 'pending'),
        progress('launch', 'waiting', 'pending'),
        progress('brief', 'running', 'running'),
      ];
    });
    let plans = within(await screen.findByRole('region', { name: 'Plans' }));
    fireEvent.click(await plans.findByRole('button', { name: /Running/ }));
    let shown = await screen.findByRole('article', { name: 'Campaña' });
    const campaign = within(shown).getByText('Campaign').closest('li') as HTMLElement;
    expect(await within(campaign).findByText('Waiting for approval')).toBeTruthy();
    // What, who and why, plainly (ADR-0167); without approval.read it is decided in Approvals.
    const ask = within(campaign).getByRole('group', { name: 'Campaign' });
    expect(within(ask).getByText('Needs your approval')).toBeTruthy();
    expect(ask.textContent).toContain('“Campaign”, done by an agent.');
    expect(ask.textContent).toContain('The company policy asks for a person');
    expect(within(ask).getByRole('link', { name: 'Decide in Approvals' })).toBeTruthy();
    expect(within(ask).queryByRole('button', { name: 'Approve' })).toBeNull();
    // A step that will ask says so before its turn (ADR-0167).
    const launch = within(shown).getByText('Launch').closest('li') as HTMLElement;
    expect(launch.textContent).toContain('will ask for your approval before it starts');
    expect(campaign.textContent).not.toContain('will ask for your approval');

    cleanup();
    open((b) => {
      b.options.plans.org_1 = [{ ...plan, status: 'completed' }];
      b.options.planSteps['plan-6'] = [
        progress('research', 'completed', 'completed'),
        progress('campaign', 'declined', 'pending', 'rejected'),
        progress('launch', 'skipped', 'pending'),
        progress('brief', 'completed', 'completed'),
      ];
    });
    plans = within(await screen.findByRole('region', { name: 'Plans' }));
    fireEvent.click(await plans.findByRole('button', { name: /Completed/ }));
    shown = await screen.findByRole('article', { name: 'Campaña' });
    expect(
      await within(shown).findByText(/Rejected: this branch was skipped, the rest goes on/),
    ).toBeTruthy();
    expect(within(shown).getByText(/Skipped: an earlier step ended this branch/)).toBeTruthy();
    expect(within(shown).getAllByText(/Done/)).toHaveLength(2);
    expect(within(shown).queryByRole('link', { name: 'Decide in Approvals' })).toBeNull();
    expect(shown.textContent).not.toContain('will ask for your approval');
  });

  it('ADR-0167: a person decides a step waiting for them on the plan, through Approvals’ own call', async () => {
    const plan = {
      id: 'plan-8',
      status: 'executing',
      version: 1,
      createdAt: '2026-09-29T09:00:00Z',
      current: {
        version: 1,
        digest: 'd'.repeat(64),
        request: { summary: 'Envío', objective: 'Enviar el resumen' },
        steps: [
          {
            id: 'send',
            kind: 'specialist',
            label: 'Send',
            dependsOn: [],
            approvalRequired: true,
          },
        ],
        riskLevel: 'low',
        estimate: { status: 'unknown', credits: null },
        source: { kind: 'workflow', workflowId: 'wf-launch', workflowVersion: 2 },
      },
    };
    const backend = open(
      (b) => {
        b.options.plans.org_1 = [plan];
        b.options.approvals.org_1 = [{ id: 'appr-8', status: 'pending' }];
        b.options.planSteps['plan-8'] = [
          {
            stepId: 'send',
            kind: 'specialist',
            label: 'Send',
            state: 'awaiting_approval',
            outcome: null,
            executionId: 'exec-send',
            status: 'pending',
            approvalId: 'appr-8',
            failure: null,
            answer: null,
            missing: [],
          },
        ];
      },
      [...OWNER, 'approval.read'],
    );
    const plans = within(await screen.findByRole('region', { name: 'Plans' }));
    fireEvent.click(await plans.findByRole('button', { name: /Running/ }));
    const shown = await screen.findByRole('article', { name: 'Envío' });
    const ask = await within(shown).findByRole('group', { name: 'Send' });
    expect(ask.textContent).toContain('You asked to approve this step before it is done.');
    fireEvent.click(within(ask).getByRole('button', { name: 'Approve' }));
    await vi.waitFor(() => expect(posts(backend, '/approvals/appr-8/approve')).toHaveLength(1));
  });

  it('shows plans without the plan button or approval to a role that may only read', async () => {
    const backend = open(
      (b) => {
        b.options.plans.org_1 = [
          {
            id: 'plan-9',
            status: 'approval_required',
            version: 1,
            createdAt: '2026-09-29T09:00:00Z',
            current: {
              version: 1,
              digest: 'b'.repeat(64),
              request: { summary: 'Estudio', objective: 'Estudiar el mercado' },
              steps: [{ id: 'research', kind: 'specialist', label: 'Research', dependsOn: [] }],
              riskLevel: 'low',
              source: { kind: 'planner' },
            },
          },
        ];
      },
      ['workflow.read', 'plan.read'],
    );
    const workflows = within(await screen.findByRole('region', { name: 'Workflows' }));
    expect(await workflows.findByText('Lanzamiento')).toBeTruthy();
    expect(workflows.queryByRole('button', { name: 'Prepare a plan' })).toBeNull();
    const plans = within(screen.getByRole('region', { name: 'Plans' }));
    fireEvent.click(await plans.findByRole('button', { name: /Waiting for your approval/ }));
    const plan = await screen.findByRole('article', { name: 'Estudio' });
    expect(within(plan).getByText(/From the planner/)).toBeTruthy();
    expect(within(plan).queryByRole('button', { name: 'Approve and start' })).toBeNull();
    expect(posts(backend, '/approve')).toHaveLength(0);
  });

  it('stops a running plan after the person confirms, and not without execution.cancel', async () => {
    const running = () => [
      {
        id: 'plan-7',
        status: 'executing',
        version: 1,
        createdAt: '2026-09-29T09:00:00Z',
        current: {
          version: 1,
          digest: 'c'.repeat(64),
          request: { summary: 'Campaña', objective: 'Lanzar la campaña' },
          steps: [{ id: 'research', kind: 'specialist', label: 'Research', dependsOn: [] }],
          riskLevel: 'low',
          source: { kind: 'planner' },
        },
      },
    ];
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    const backend = open(
      (b) => {
        b.options.plans.org_1 = running();
      },
      [...OWNER, 'execution.cancel'],
    );
    const plans = within(await screen.findByRole('region', { name: 'Plans' }));
    fireEvent.click(await plans.findByRole('button', { name: /Running/ }));
    const plan = await screen.findByRole('article', { name: 'Campaña' });
    // Declining the confirmation stops nothing.
    fireEvent.click(await within(plan).findByRole('button', { name: 'Stop this plan' }));
    expect(backend.cancelled).toEqual([]);
    confirm.mockReturnValue(true);
    fireEvent.click(within(plan).getByRole('button', { name: 'Stop this plan' }));
    expect(await within(plan).findByText(/Cancelled/)).toBeTruthy();
    expect(backend.cancelled).toEqual(['plan-7']);
    expect(within(plan).queryByRole('button', { name: 'Stop this plan' })).toBeNull();
    confirm.mockRestore();

    cleanup();
    open((b) => {
      b.options.plans.org_1 = running();
    });
    const again = within(await screen.findByRole('region', { name: 'Plans' }));
    fireEvent.click(await again.findByRole('button', { name: /Running/ }));
    const readOnly = await screen.findByRole('article', { name: 'Campaña' });
    expect(within(readOnly).getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(within(readOnly).queryByRole('button', { name: 'Stop this plan' })).toBeNull();
  });

  it('without workflow.read or plan.read, Automations stays a coming tool and nothing is read', async () => {
    const backend = open(undefined, []);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { level: 1, name: 'Automations' })).toBeNull();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).queryByRole('link', { name: /Automations/ })).toBeNull();
    expect(
      backend.apiCalls().filter((c) => c.url.includes('/workflows') || c.url.includes('/plans')),
    ).toHaveLength(0);
  });
});

const WRITER = [...OWNER, 'workflow.manage', 'specialist.read'];

describe('Writing workflows (block 4)', () => {
  it('creates a workflow as a draft: steps in order, each by a role, with an approval asked', async () => {
    const backend = open(undefined, WRITER);
    fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }));
    const editor = within(await screen.findByRole('form', { name: 'New workflow' }));
    const create = await editor.findByRole('button', { name: 'Create as draft' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(editor.getByLabelText('Name'), { target: { value: 'Seguimiento semanal' } });
    fireEvent.change(editor.getByLabelText('Step 1: what to do'), {
      target: { value: 'Revisar clientes' },
    });
    fireEvent.change(editor.getByLabelText('Who does it'), {
      target: { value: 'sales/commercial_agent' },
    });
    fireEvent.click(editor.getByRole('button', { name: 'Add a step' }));
    fireEvent.change(editor.getByLabelText('Step 2: what to do'), {
      target: { value: 'Enviar resumen' },
    });
    fireEvent.change(editor.getAllByLabelText('Who does it')[1] as HTMLElement, {
      target: { value: 'sales/commercial_agent' },
    });
    fireEvent.click(editor.getAllByLabelText('Ask me before this step runs')[1] as HTMLElement);
    fireEvent.click(create);

    expect(
      await screen.findByText('The workflow was created as a draft. Activate it when it is ready.'),
    ).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New workflow' })).toBeNull();
    const workflows = within(screen.getByRole('region', { name: 'Workflows' }));
    expect(await workflows.findByText('Seguimiento semanal')).toBeTruthy();
    const [sent] = posts(backend, '/org_1/workflows');
    const verification = {
      policy: 'output_schema',
      expectedOutput: 'agent_answer',
      requiredChecks: [],
    };
    expect(JSON.parse(sent?.body ?? '{}')).toEqual({
      name: 'Seguimiento semanal',
      steps: [
        {
          id: 'step_1',
          kind: 'specialist',
          label: 'Revisar clientes',
          dependsOn: [],
          assignee: { departmentTypeId: 'sales', roleId: 'commercial_agent' },
          verification,
        },
        {
          id: 'step_2',
          kind: 'specialist',
          label: 'Enviar resumen',
          dependsOn: ['step_1'],
          assignee: { departmentTypeId: 'sales', roleId: 'commercial_agent' },
          verification,
          approvalRequired: true,
        },
      ],
    });
  });

  it('shows a workflow’s steps and saves an edit as a new version', async () => {
    const backend = open(undefined, WRITER);
    const workflows = within(await screen.findByRole('region', { name: 'Workflows' }));
    fireEvent.click((await workflows.findAllByRole('button', { name: 'Steps' }))[0] as HTMLElement);
    expect(await workflows.findByText(/done by: Research agent/)).toBeTruthy();
    fireEvent.click(workflows.getByRole('button', { name: 'Edit (new version)' }));
    const editor = within(await screen.findByRole('form', { name: 'New version' }));
    expect((await editor.findByLabelText('Name')).getAttribute('value')).toBe('Lanzamiento');
    fireEvent.change(editor.getByLabelText('Step 1: what to do'), {
      target: { value: 'Investigar el mercado' },
    });
    fireEvent.click(editor.getByRole('button', { name: 'Save new version' }));
    expect(
      await screen.findByText('The new version was saved. Plans already made keep their version.'),
    ).toBeTruthy();
    expect(await workflows.findByText(/version 3/)).toBeTruthy();
    const [sent] = posts(backend, '/workflows/wf-launch/versions');
    const body = JSON.parse(sent?.body ?? '{}') as { steps: { label: string }[] };
    expect(body.steps.map((s) => s.label)).toEqual(['Investigar el mercado']);
  });

  it('writes a policy check that the steps after it wait for, and a branch that does not', async () => {
    const backend = open(undefined, [...WRITER, 'gia.ask']);
    fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }));
    const editor = within(await screen.findByRole('form', { name: 'New workflow' }));
    fireEvent.change(editor.getByLabelText('Name'), { target: { value: 'Descuentos' } });
    fireEvent.change(editor.getByLabelText('Step 1: what to do'), {
      target: { value: 'Preparar la oferta' },
    });
    fireEvent.change(editor.getByLabelText('Who does it'), {
      target: { value: 'sales/commercial_agent' },
    });
    // Step 2: a policy check, once the catalogue's actions are there.
    fireEvent.click(editor.getByRole('button', { name: 'Add a step' }));
    fireEvent.change(editor.getByLabelText('Step 2: what to do'), {
      target: { value: 'Comprobar el descuento' },
    });
    fireEvent.change((await editor.findAllByLabelText('What this step is'))[1] as HTMLElement, {
      target: { value: 'check' },
    });
    fireEvent.change(editor.getByLabelText('Action to check'), {
      target: { value: 'opportunity.offer_discount' },
    });
    fireEvent.change(editor.getByLabelText('Discount to check, in % (optional)'), {
      target: { value: '15' },
    });
    // Step 3 waits for the check; step 4 waits only for step 1, so it runs whatever the check says.
    for (const [n, label] of [
      [3, 'Enviar la oferta'],
      [4, 'Registrar la oportunidad'],
    ] as const) {
      fireEvent.click(editor.getByRole('button', { name: 'Add a step' }));
      fireEvent.change(editor.getByLabelText(`Step ${n}: what to do`), {
        target: { value: label },
      });
      fireEvent.change(editor.getAllByLabelText('Who does it')[n - 2] as HTMLElement, {
        target: { value: 'sales/commercial_agent' },
      });
    }
    const step4 = within(editor.getAllByRole('group', { name: 'Runs after' })[2] as HTMLElement);
    fireEvent.click(step4.getByLabelText('Step 1: Preparar la oferta'));
    fireEvent.click(step4.getByLabelText('Step 3: Enviar la oferta'));
    fireEvent.click(editor.getByRole('button', { name: 'Create as draft' }));

    expect(
      await screen.findByText('The workflow was created as a draft. Activate it when it is ready.'),
    ).toBeTruthy();
    const [sent] = posts(backend, '/org_1/workflows');
    const steps = (JSON.parse(sent?.body ?? '{}') as { steps: Record<string, unknown>[] }).steps;
    expect(steps.map((s) => [s.id, s.kind, s.dependsOn])).toEqual([
      ['step_1', 'specialist', []],
      ['step_2', 'condition', ['step_1']],
      ['step_3', 'specialist', ['step_2']],
      ['step_4', 'specialist', ['step_1']],
    ]);
    // The check names only the decision, what lets the plan go on and its fixed input.
    expect(steps[1]).toEqual({
      id: 'step_2',
      kind: 'condition',
      label: 'Comprobar el descuento',
      dependsOn: ['step_1'],
      decision: {
        decision: 'action.policy_check',
        continueOn: ['allowed'],
        input: { action: 'opportunity.offer_discount', discountPercent: 15 },
      },
    });
  });

  it('a check cannot be saved until it waits for a step, and moving a step drops waits on later ones', async () => {
    open(undefined, [...WRITER, 'gia.ask']);
    fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }));
    const editor = within(await screen.findByRole('form', { name: 'New workflow' }));
    const create = editor.getByRole('button', { name: 'Create as draft' }) as HTMLButtonElement;
    fireEvent.change(editor.getByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.change(editor.getByLabelText('Step 1: what to do'), { target: { value: 'A' } });
    fireEvent.change(editor.getByLabelText('Who does it'), {
      target: { value: 'sales/commercial_agent' },
    });
    fireEvent.click(editor.getByRole('button', { name: 'Add a step' }));
    fireEvent.change(editor.getByLabelText('Step 2: what to do'), { target: { value: 'B' } });
    fireEvent.change((await editor.findAllByLabelText('What this step is'))[1] as HTMLElement, {
      target: { value: 'check' },
    });
    fireEvent.change(editor.getByLabelText('Action to check'), {
      target: { value: 'follow_up.schedule' },
    });
    expect(create.disabled).toBe(false);
    fireEvent.click(editor.getByLabelText('Step 1: A'));
    expect(create.disabled).toBe(true);
    fireEvent.click(editor.getByLabelText('Step 1: A'));
    // Moved first, the check has nothing before it to wait for.
    fireEvent.click(editor.getByRole('button', { name: 'Move step 2 up' }));
    expect(create.disabled).toBe(true);
    const after = within(editor.getByRole('group', { name: 'Runs after' }));
    expect((after.getByLabelText('Step 1: B') as HTMLInputElement).checked).toBe(false);
  });

  it('ADR-0158: writes a wait between two steps, shows a saved one and keeps it on an edit', async () => {
    const backend = open(undefined, WRITER);
    fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }));
    const editor = within(await screen.findByRole('form', { name: 'New workflow' }));
    const create = await editor.findByRole('button', { name: 'Create as draft' });
    fireEvent.change(editor.getByLabelText('Name'), { target: { value: 'Seguimiento' } });
    fireEvent.change(editor.getByLabelText('Step 1: what to do'), {
      target: { value: 'Enviar la oferta' },
    });
    fireEvent.change(editor.getByLabelText('Who does it'), {
      target: { value: 'sales/commercial_agent' },
    });
    fireEvent.click(editor.getByRole('button', { name: 'Add a step' }));
    fireEvent.change(editor.getByLabelText('Step 2: what to do'), {
      target: { value: 'Dar tiempo al cliente' },
    });
    fireEvent.change(editor.getAllByLabelText('What this step is').at(-1) as HTMLElement, {
      target: { value: 'wait' },
    });
    fireEvent.click(editor.getByRole('button', { name: 'Add a step' }));
    fireEvent.change(editor.getByLabelText('Step 3: what to do'), {
      target: { value: 'Llamar al cliente' },
    });
    fireEvent.change(editor.getAllByLabelText('Who does it')[1] as HTMLElement, {
      target: { value: 'sales/commercial_agent' },
    });
    // A wait with no length, or longer than the engine takes, is not saved.
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(editor.getByLabelText('In'), { target: { value: 'days' } });
    fireEvent.change(editor.getByLabelText('How long'), { target: { value: '8' } });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(editor.getByLabelText('In'), { target: { value: 'hours' } });
    fireEvent.change(editor.getByLabelText('How long'), { target: { value: '2' } });
    expect((create as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(create);

    expect(
      await screen.findByText('The workflow was created as a draft. Activate it when it is ready.'),
    ).toBeTruthy();
    const [sent] = posts(backend, '/org_1/workflows');
    const steps = (JSON.parse(sent?.body ?? '{}') as { steps: Record<string, unknown>[] }).steps;
    expect(steps.map((s) => [s.id, s.kind, s.dependsOn])).toEqual([
      ['step_1', 'specialist', []],
      ['step_2', 'wait', ['step_1']],
      ['step_3', 'specialist', ['step_2']],
    ]);
    expect(steps[1]).toEqual({
      id: 'step_2',
      kind: 'wait',
      label: 'Dar tiempo al cliente',
      dependsOn: ['step_1'],
      wait: { seconds: 7_200 },
    });
  });

  it('ADR-0158: shows a saved wait in its largest whole unit and saves it unchanged', async () => {
    const backend = open((b) => {
      const launch = b.options.workflows.org_1?.find((w) => w.id === 'wf-launch');
      if (launch === undefined) return;
      launch.steps = [
        {
          id: 'offer',
          kind: 'specialist',
          label: 'Offer',
          dependsOn: [],
          assignee: { departmentTypeId: 'sales', roleId: 'commercial_agent' },
        },
        {
          id: 'pause',
          kind: 'wait',
          label: 'Pause',
          dependsOn: ['offer'],
          wait: { seconds: 172_800 },
        },
      ];
    }, WRITER);
    const workflows = within(await screen.findByRole('region', { name: 'Workflows' }));
    fireEvent.click((await workflows.findAllByRole('button', { name: 'Steps' }))[0] as HTMLElement);
    expect(await workflows.findByText(/waits before the next steps/)).toBeTruthy();
    fireEvent.click(workflows.getByRole('button', { name: 'Edit (new version)' }));
    const editor = within(await screen.findByRole('form', { name: 'New version' }));
    expect(((await editor.findByLabelText('How long')) as HTMLInputElement).value).toBe('2');
    expect((editor.getByLabelText('In') as HTMLSelectElement).value).toBe('days');
    fireEvent.click(editor.getByRole('button', { name: 'Save new version' }));
    expect(
      await screen.findByText('The new version was saved. Plans already made keep their version.'),
    ).toBeTruthy();
    const [sent] = posts(backend, '/workflows/wf-launch/versions');
    const steps = (JSON.parse(sent?.body ?? '{}') as { steps: Record<string, unknown>[] }).steps;
    expect(steps[1]).toEqual({
      id: 'step_2',
      kind: 'wait',
      label: 'Pause',
      dependsOn: ['step_1'],
      wait: { seconds: 172_800 },
    });
  });

  const READ_TOOLS = [
    {
      id: 'knowledge_search',
      status: 'active',
      versions: [
        {
          version: 1,
          nameKey: 'tools.knowledge_search.name',
          descriptionKey: 'tools.knowledge_search.description',
          category: 'knowledge',
          action: 'search',
          mutating: false,
          riskLevel: 'low',
          approvalPolicy: 'auto',
          environments: ['dev'],
          step: {
            input: [
              { name: 'query', type: 'string', required: true, maxLength: 200, minLength: 2 },
            ],
            output: [
              { name: 'available', type: 'boolean', required: true },
              { name: 'facts', type: 'array', required: true },
            ],
          },
        },
      ],
    },
  ];
  const withTools = (b: ReturnType<typeof fakeBackend>) => {
    b.options.moreTools = READ_TOOLS;
    b.options.assignees = {
      org_1: [
        {
          departmentTypeId: 'sales',
          roleId: 'commercial_agent',
          agent: { id: 'agent-sales', displayName: 'Lucía' },
          tools: [{ id: 'knowledge_search', version: 1 }],
        },
      ],
    };
  };

  it('ADR-0165: writes a tool step for an earlier agent step, from a fixed value or its answer', async () => {
    const backend = open(withTools, [...WRITER, 'tool.read']);
    fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }));
    const editor = within(await screen.findByRole('form', { name: 'New workflow' }));
    const create = await editor.findByRole('button', { name: 'Create as draft' });
    fireEvent.change(editor.getByLabelText('Name'), { target: { value: 'Estudio' } });
    fireEvent.change(editor.getByLabelText('Step 1: what to do'), {
      target: { value: 'Investigar' },
    });
    fireEvent.change(editor.getByLabelText('Who does it'), {
      target: { value: 'sales/commercial_agent' },
    });
    fireEvent.click(editor.getByRole('button', { name: 'Add a step' }));
    fireEvent.change(editor.getByLabelText('Step 2: what to do'), {
      target: { value: 'Buscar en la memoria' },
    });
    const kinds = () => editor.getAllByLabelText('What this step is');
    await vi.waitFor(() =>
      expect(
        within(kinds().at(-1) as HTMLElement).queryByRole('option', {
          name: 'An agent uses a lookup tool',
        }),
      ).toBeTruthy(),
    );
    // The first step has no earlier agent step, so it is never offered a tool.
    expect(
      within(kinds()[0] as HTMLElement).queryByRole('option', {
        name: 'An agent uses a lookup tool',
      }),
    ).toBeNull();
    fireEvent.change(kinds().at(-1) as HTMLElement, { target: { value: 'tool' } });
    expect((editor.getByLabelText('Used by the agent of') as HTMLSelectElement).value).toBe(
      'new_1',
    );
    // Only tools a plan may run as a step: `message_send` changes data and is not offered.
    const tool = editor.getByLabelText('Tool') as HTMLSelectElement;
    expect([...tool.options].map((o) => o.textContent)).toEqual([
      'Choose…',
      'Search the company memory',
    ]);
    fireEvent.change(tool, { target: { value: 'knowledge_search@1' } });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(editor.getByLabelText('Words to search'), { target: { value: 'melón' } });
    expect((create as HTMLButtonElement).disabled).toBe(false);

    // A later step can wait for the agent step, never for the tool step that ends it.
    fireEvent.click(editor.getByRole('button', { name: 'Add a step' }));
    fireEvent.change(editor.getByLabelText('Step 3: what to do'), {
      target: { value: 'Resumir' },
    });
    fireEvent.change(editor.getAllByLabelText('Who does it')[1] as HTMLElement, {
      target: { value: 'sales/commercial_agent' },
    });
    const after = within(
      editor.getAllByRole('group', { name: 'Runs after' }).at(-1) as HTMLElement,
    );
    expect(after.getByLabelText('Step 1: Investigar')).toBeTruthy();
    expect(after.queryByLabelText('Step 2: Buscar en la memoria')).toBeNull();
    // A new step waits for the last step that is not a tool step.
    expect((after.getByLabelText('Step 1: Investigar') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(create);
    expect(
      await screen.findByText('The workflow was created as a draft. Activate it when it is ready.'),
    ).toBeTruthy();
    let [sent] = posts(backend, '/org_1/workflows');
    let steps = (JSON.parse(sent?.body ?? '{}') as { steps: Record<string, unknown>[] }).steps;
    expect(steps[1]).toEqual({
      id: 'step_2',
      kind: 'tool',
      label: 'Buscar en la memoria',
      dependsOn: ['step_1'],
      performedBy: 'step_1',
      tool: { id: 'knowledge_search', version: 1 },
      input: { query: 'melón' },
    });
    expect(steps[2]).toMatchObject({ id: 'step_3', dependsOn: ['step_1'] });

    // The same words can come from the agent step's answer instead (ADR-0161).
    fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }));
    const again = within(await screen.findByRole('form', { name: 'New workflow' }));
    fireEvent.change(again.getByLabelText('Name'), { target: { value: 'Estudio 2' } });
    fireEvent.change(again.getByLabelText('Step 1: what to do'), {
      target: { value: 'Investigar' },
    });
    fireEvent.change(again.getByLabelText('Who does it'), {
      target: { value: 'sales/commercial_agent' },
    });
    fireEvent.click(again.getByRole('button', { name: 'Add a step' }));
    fireEvent.change(again.getByLabelText('Step 2: what to do'), {
      target: { value: 'Buscar' },
    });
    await vi.waitFor(() =>
      expect(
        within(again.getAllByLabelText('What this step is').at(-1) as HTMLElement).queryByRole(
          'option',
          { name: 'An agent uses a lookup tool' },
        ),
      ).toBeTruthy(),
    );
    fireEvent.change(again.getAllByLabelText('What this step is').at(-1) as HTMLElement, {
      target: { value: 'tool' },
    });
    fireEvent.change(again.getByLabelText('Tool'), { target: { value: 'knowledge_search@1' } });
    fireEvent.change(again.getByLabelText('Where Words to search comes from'), {
      target: { value: 'answer:new_1' },
    });
    expect(again.queryByLabelText('Words to search')).toBeNull();
    fireEvent.click(again.getByRole('button', { name: 'Create as draft' }));
    await vi.waitFor(() => expect(posts(backend, '/org_1/workflows')).toHaveLength(2));
    [, sent] = posts(backend, '/org_1/workflows');
    steps = (JSON.parse(sent?.body ?? '{}') as { steps: Record<string, unknown>[] }).steps;
    expect(steps[1]).toEqual({
      id: 'step_2',
      kind: 'tool',
      label: 'Buscar',
      dependsOn: ['step_1'],
      performedBy: 'step_1',
      tool: { id: 'knowledge_search', version: 1 },
      inputFrom: { query: { step: 'step_1' } },
    });
  });

  it('ADR-0165: shows a saved tool step and saves it unchanged', async () => {
    const backend = open(
      (b) => {
        withTools(b);
        const launch = b.options.workflows.org_1?.find((w) => w.id === 'wf-launch');
        if (launch === undefined) return;
        launch.steps = [
          {
            id: 'offer',
            kind: 'specialist',
            label: 'Offer',
            dependsOn: [],
            assignee: { departmentTypeId: 'sales', roleId: 'commercial_agent' },
          },
          {
            id: 'search',
            kind: 'tool',
            label: 'Search',
            dependsOn: ['offer'],
            assignee: null,
            performedBy: 'offer',
            tool: { id: 'knowledge_search', version: 1 },
            input: null,
            inputFrom: { query: { step: 'offer' } },
          },
        ];
      },
      [...WRITER, 'tool.read'],
    );
    const workflows = within(await screen.findByRole('region', { name: 'Workflows' }));
    fireEvent.click((await workflows.findAllByRole('button', { name: 'Steps' }))[0] as HTMLElement);
    expect(await workflows.findByText(/uses a tool/)).toBeTruthy();
    fireEvent.click(workflows.getByRole('button', { name: 'Edit (new version)' }));
    const editor = within(await screen.findByRole('form', { name: 'New version' }));
    await vi.waitFor(() =>
      expect((editor.getByLabelText('Tool') as HTMLSelectElement).value).toBe('knowledge_search@1'),
    );
    expect(
      (editor.getByLabelText('Where Words to search comes from') as HTMLSelectElement).value,
    ).toBe('answer:offer');
    fireEvent.click(editor.getByRole('button', { name: 'Save new version' }));
    expect(
      await screen.findByText('The new version was saved. Plans already made keep their version.'),
    ).toBeTruthy();
    const [sent] = posts(backend, '/workflows/wf-launch/versions');
    const steps = (JSON.parse(sent?.body ?? '{}') as { steps: Record<string, unknown>[] }).steps;
    expect(steps[1]).toEqual({
      id: 'step_2',
      kind: 'tool',
      label: 'Search',
      dependsOn: ['step_1'],
      performedBy: 'step_1',
      tool: { id: 'knowledge_search', version: 1 },
      inputFrom: { query: { step: 'step_1' } },
    });
  });

  it('ADR-0167: a tool the step’s agent has no skill for is shown unavailable, with why, and is not saved', async () => {
    const backend = open(
      (b) => {
        withTools(b);
        // The same agent the plan would pick, without the tool among its skills' tools.
        for (const a of b.options.assignees?.org_1 ?? []) a.tools = [];
      },
      [...WRITER, 'tool.read'],
    );
    fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }));
    const editor = within(await screen.findByRole('form', { name: 'New workflow' }));
    const create = await editor.findByRole('button', { name: 'Create as draft' });
    fireEvent.change(editor.getByLabelText('Name'), { target: { value: 'Estudio' } });
    fireEvent.change(editor.getByLabelText('Step 1: what to do'), {
      target: { value: 'Investigar' },
    });
    fireEvent.change(editor.getByLabelText('Who does it'), {
      target: { value: 'sales/commercial_agent' },
    });
    expect(await editor.findByText('Lucía will do it.')).toBeTruthy();
    fireEvent.click(editor.getByRole('button', { name: 'Add a step' }));
    fireEvent.change(editor.getByLabelText('Step 2: what to do'), {
      target: { value: 'Buscar' },
    });
    const kinds = () => editor.getAllByLabelText('What this step is');
    await vi.waitFor(() =>
      expect(
        within(kinds().at(-1) as HTMLElement).queryByRole('option', {
          name: 'An agent uses a lookup tool',
        }),
      ).toBeTruthy(),
    );
    fireEvent.change(kinds().at(-1) as HTMLElement, { target: { value: 'tool' } });
    const tool = editor.getByLabelText('Tool') as HTMLSelectElement;
    const option = [...tool.options].find((o) => o.value === 'knowledge_search@1');
    expect(option?.textContent).toBe('Search the company memory: not available to this agent');
    expect(option?.disabled).toBe(true);
    expect(
      editor.getByText('Lucía has no skill that lets it use “Search the company memory”.'),
    ).toBeTruthy();
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect(posts(backend, '/org_1/workflows')).toHaveLength(0);
  });

  it('shows a saved check and edits a branching workflow without changing its shape', async () => {
    const backend = open(
      (b) => {
        const launch = b.options.workflows.org_1?.find((w) => w.id === 'wf-launch');
        if (launch === undefined) return;
        launch.steps = [
          {
            id: 'offer',
            kind: 'specialist',
            label: 'Offer',
            dependsOn: [],
            assignee: { departmentTypeId: 'sales', roleId: 'commercial_agent' },
          },
          {
            id: 'policy',
            kind: 'condition',
            label: 'Policy',
            dependsOn: ['offer'],
            assignee: null,
            decision: {
              decision: 'action.policy_check',
              continueOn: ['allowed'],
              input: { action: 'opportunity.offer_discount', discountPercent: 20 },
            },
          },
          {
            id: 'send',
            kind: 'specialist',
            label: 'Send',
            dependsOn: ['policy'],
            assignee: { departmentTypeId: 'sales', roleId: 'commercial_agent' },
          },
        ];
      },
      [...WRITER, 'gia.ask'],
    );
    const workflows = within(await screen.findByRole('region', { name: 'Workflows' }));
    fireEvent.click((await workflows.findAllByRole('button', { name: 'Steps' }))[0] as HTMLElement);
    expect(
      await workflows.findByText(/checks company policy for a discount on an opportunity/),
    ).toBeTruthy();
    fireEvent.click(workflows.getByRole('button', { name: 'Edit (new version)' }));
    const editor = within(await screen.findByRole('form', { name: 'New version' }));
    expect(
      ((await editor.findByLabelText('Discount to check, in % (optional)')) as HTMLInputElement)
        .value,
    ).toBe('20');
    fireEvent.click(editor.getByRole('button', { name: 'Save new version' }));
    expect(
      await screen.findByText('The new version was saved. Plans already made keep their version.'),
    ).toBeTruthy();
    const [sent] = posts(backend, '/workflows/wf-launch/versions');
    const steps = (JSON.parse(sent?.body ?? '{}') as { steps: Record<string, unknown>[] }).steps;
    expect(steps.map((s) => [s.id, s.kind, s.dependsOn])).toEqual([
      ['step_1', 'specialist', []],
      ['step_2', 'condition', ['step_1']],
      ['step_3', 'specialist', ['step_2']],
    ]);
    expect(steps[1]?.decision).toEqual({
      decision: 'action.policy_check',
      continueOn: ['allowed'],
      input: { action: 'opportunity.offer_discount', discountPercent: 20 },
    });
  });

  it('leaves a workflow with steps the editor cannot write to the API', async () => {
    open((b) => {
      const launch = b.options.workflows.org_1?.find((w) => w.id === 'wf-launch');
      if (launch === undefined) return;
      launch.steps = [
        {
          id: 'offer',
          kind: 'specialist',
          label: 'Offer',
          dependsOn: [],
          assignee: { departmentTypeId: 'sales', roleId: 'commercial_agent' },
        },
        {
          id: 'gate',
          kind: 'condition',
          label: 'Gate',
          dependsOn: ['offer'],
          assignee: null,
          // Another decision type: the worker would not decide it, so the editor never rewrites it.
          decision: { decision: 'commercial.priorities', continueOn: ['high'], input: {} },
        },
      ];
    }, WRITER);
    const workflows = within(await screen.findByRole('region', { name: 'Workflows' }));
    fireEvent.click((await workflows.findAllByRole('button', { name: 'Steps' }))[0] as HTMLElement);
    expect(await workflows.findByText(/a condition/)).toBeTruthy();
    expect(
      workflows.getByText('This workflow has steps that can only be changed through the API.'),
    ).toBeTruthy();
  });

  it('activates a draft and archives only after the person confirms', async () => {
    const backend = open(undefined, WRITER);
    const workflows = within(await screen.findByRole('region', { name: 'Workflows' }));
    fireEvent.click(await workflows.findByRole('button', { name: 'Activate' }));
    expect(
      await screen.findByText('The workflow is active. You can prepare plans from it.'),
    ).toBeTruthy();
    const [moved] = posts(backend, '/workflows/wf-draft/status');
    expect(JSON.parse(moved?.body ?? '{}')).toEqual({ from: 'draft', to: 'active' });
    expect(await workflows.findAllByRole('button', { name: 'Prepare a plan' })).toHaveLength(2);

    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    fireEvent.click(workflows.getAllByRole('button', { name: 'Archive' })[0] as HTMLElement);
    expect(confirm).toHaveBeenCalledOnce();
    expect(posts(backend, '/workflows/wf-launch/status')).toHaveLength(0);
    confirm.mockRestore();
  });

  it('says a workflow changed meanwhile and reloads it', async () => {
    const backend = open(undefined, WRITER);
    const workflows = within(await screen.findByRole('region', { name: 'Workflows' }));
    const activate = await workflows.findByRole('button', { name: 'Activate' });
    const draft = backend.options.workflows.org_1?.find((w) => w.id === 'wf-draft');
    if (draft !== undefined) draft.status = 'archived';
    fireEvent.click(activate);
    expect(
      await screen.findByText('This workflow changed meanwhile. The list was reloaded; try again.'),
    ).toBeTruthy();
  });

  it('offers no writing to a role without workflow.manage', async () => {
    open();
    const workflows = within(await screen.findByRole('region', { name: 'Workflows' }));
    expect(await workflows.findByText('Lanzamiento')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New workflow' })).toBeNull();
    expect(workflows.queryByRole('button', { name: 'Activate' })).toBeNull();
    fireEvent.click(workflows.getAllByRole('button', { name: 'Steps' })[0] as HTMLElement);
    expect(await workflows.findByText(/done by: Research agent/)).toBeTruthy();
    expect(workflows.queryByRole('button', { name: 'Edit (new version)' })).toBeNull();
  });
});
