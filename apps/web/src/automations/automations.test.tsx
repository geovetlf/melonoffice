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
    expect(
      await screen.findByText(
        'The plan did not pass validation (tool_not_available). Nothing was created to run.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
    expect(posts(backend, '/approve')).toHaveLength(0);
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
