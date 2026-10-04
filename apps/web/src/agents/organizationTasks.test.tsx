import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

/**
 * Every agent's tasks (ADR-0148): the API's tasks as it gives them, newest first, a page at a
 * time, with details on demand. Read only: the page offers nothing that changes a task.
 */

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  agent: { id: 'spec_ana', name: 'Sales agent', status: 'active' },
  request: `Pedido ${id}`,
  status: 'running',
  failure: null,
  createdAt: '2026-10-04T10:00:00.000Z',
  updatedAt: '2026-10-04T10:01:00.000Z',
  startedAt: '2026-10-04T10:00:01.000Z',
  completedAt: null,
  progress: { done: 1, total: 3 },
  steps: [
    {
      type: 'agent',
      status: 'completed',
      startedAt: null,
      completedAt: '2026-10-04T10:00:30.000Z',
      failure: null,
    },
    { type: 'verification', status: 'running', startedAt: null, completedAt: null, failure: null },
    { type: 'tool', status: 'pending', startedAt: null, completedAt: null, failure: null },
  ],
  plan: null,
  handedFrom: null,
  result: null,
  ...extra,
});

const TASKS = [
  task('t3', {
    agent: { id: 'spec_leo', name: 'Paused agent', status: 'paused' },
    request: 'Revisa el stock',
    status: 'completed',
    createdAt: '2026-10-04T12:00:00.000Z',
    completedAt: '2026-10-04T12:02:00.000Z',
    progress: { done: 3, total: 3 },
    result: { summary: 'Quedan 12 pollos.', truncated: true, missing: 2 },
    plan: { id: 'plan-1' },
  }),
  task('t2', {
    status: 'failed',
    failure: 'approval_rejected',
    createdAt: '2026-10-04T11:00:00.000Z',
  }),
  task('t1', { request: 'Resume las ventas' }),
];

function open(configure?: (backend: ReturnType<typeof fakeBackend>) => void, at = '/agents/tasks') {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.specialists.org_1 = [
    { id: 'spec_ana', name: 'Sales agent', type: 'sales', status: 'active' },
    { id: 'spec_leo', name: 'Paused agent', type: 'sales', status: 'paused' },
  ];
  backend.options.organizationTasks = { org_1: TASKS.map((t) => ({ ...t })) };
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const listCalls = (backend: ReturnType<typeof fakeBackend>) =>
  backend.apiCalls().filter((c) => c.url.includes('/agent-tasks'));

describe("Every agent's tasks (ADR-0148)", () => {
  it('lists the tasks newest first with agent, state, date and progress', async () => {
    open();
    expect(
      await screen.findByRole('heading', { level: 1, name: "Every agent's tasks" }),
    ).toBeTruthy();
    const list = await screen.findByRole('list', { name: "Every agent's tasks" });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent?.split(/ (Completed|Failed|In progress)/)[0])).toEqual([
      'Revisa el stock',
      'Pedido t2',
      'Resume las ventas',
    ]);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('Completed')).toBeTruthy();
    expect(first.getByText(/Paused agent/)).toBeTruthy();
    expect(first.getByText(/3 of 3 steps/)).toBeTruthy();
    expect(first.getByText('Quedan 12 pollos.…')).toBeTruthy();
    const second = within(rows[1] as HTMLElement);
    expect(second.getByText('Failed')).toBeTruthy();
    expect(second.getByText('Ended because a person rejected the approval')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('In progress')).toBeTruthy();
  });

  it('shows one task, and says so when there are none', async () => {
    open((b) => {
      b.options.organizationTasks = { org_1: [task('t1')] };
    });
    const list = await screen.findByRole('list', { name: "Every agent's tasks" });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    cleanup();
    open((b) => {
      b.options.organizationTasks = {};
    });
    expect(await screen.findByText('No tasks match.')).toBeTruthy();
  });

  it('opens a task’s details on demand: state, dates, steps, plan and missing data', async () => {
    open();
    const list = await screen.findByRole('list', { name: "Every agent's tasks" });
    const row = within(within(list).getAllByRole('listitem')[0] as HTMLElement);
    expect(row.queryByText('Steps')).toBeNull();
    fireEvent.click(row.getByRole('button', { name: 'Details' }));
    expect(row.getByText('Steps')).toBeTruthy();
    expect(row.getByText(/Agent work: done/)).toBeTruthy();
    expect(row.getByText(/Verification: running/)).toBeTruthy();
    expect(row.getByRole('link', { name: 'Open Automations' })).toBeTruthy();
    expect(row.getByText('2 items the agent asked for')).toBeTruthy();
    fireEvent.click(row.getByRole('button', { name: 'Hide details' }));
    expect(row.queryByText('Steps')).toBeNull();
  });

  it('pages with the API’s cursor without loading everything', async () => {
    const backend = open((b) => {
      b.options.organizationTasksPageSize = 2;
    });
    const list = await screen.findByRole('list', { name: "Every agent's tasks" });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Show older tasks' }));
    expect(await screen.findByText('Resume las ventas')).toBeTruthy();
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(listCalls(backend).at(-1)?.url).toContain('cursor=2');
    expect(screen.queryByRole('button', { name: 'Show older tasks' })).toBeNull();
  });

  it('offers the agents and states the API lists, and sends the filters for the server to check', async () => {
    const backend = open();
    await screen.findByRole('list', { name: "Every agent's tasks" });
    const agent = screen.getByRole('combobox', { name: 'Agent' });
    expect(
      within(agent)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All', 'Sales agent', 'Paused agent']);
    const state = screen.getByRole('combobox', { name: 'State' });
    expect(within(state).getByRole('option', { name: 'Waiting for approval' })).toBeTruthy();
    fireEvent.change(agent, { target: { value: 'spec_ana' } });
    fireEvent.change(state, { target: { value: 'failed' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('Pedido t2')).toBeTruthy();
    expect(screen.queryByText('Revisa el stock')).toBeNull();
    const url = listCalls(backend).at(-1)?.url ?? '';
    for (const part of ['agent=spec_ana', 'status=failed', 'from=2026-10-01', 'to=2026-10-04']) {
      expect(url).toContain(part);
    }
  });

  it('is read only: nothing on it stops, retries or changes a task', async () => {
    const backend = open((b) => {
      b.options.permissions.push('execution.cancel', 'specialist.task', 'specialist.manage');
    });
    const list = await screen.findByRole('list', { name: "Every agent's tasks" });
    for (const row of within(list).getAllByRole('listitem')) {
      expect(
        within(row)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Details']);
    }
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(
      backend.apiCalls().some((c) => c.method !== 'GET' && c.url.includes('/agent-tasks')),
    ).toBe(false);
  });

  it('shows only the fields it knows, never anything else the answer carries', async () => {
    open((b) => {
      b.options.organizationTasks = {
        org_1: [
          task('t1', {
            model: 'gemini-secret-model',
            token: 'tok-abc-123',
            requestedBy: 'user_42',
          }),
        ],
      };
    });
    await screen.findByRole('list', { name: "Every agent's tasks" });
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const text = document.body.textContent ?? '';
    for (const hidden of ['gemini-secret-model', 'tok-abc-123', 'user_42']) {
      expect(text).not.toContain(hidden);
    }
  });

  it('is linked from the Agents page, and not shown to a role that cannot read agents', async () => {
    open(undefined, '/agents');
    fireEvent.click(await screen.findByRole('button', { name: "Every agent's tasks" }));
    expect(
      await screen.findByRole('heading', { level: 1, name: "Every agent's tasks" }),
    ).toBeTruthy();
    expect(globalThis.location.pathname).toBe('/agents/tasks');
    cleanup();
    const backend = open((b) => {
      b.options.permissions = ['organization.read', 'department.read'];
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('list', { name: "Every agent's tasks" })).toBeNull();
    expect(listCalls(backend)).toHaveLength(0);
  });

  it('says what went wrong when the API refuses or fails', async () => {
    open((b) => {
      b.options.organizationTasksFails = { status: 403, body: { error: 'permission_denied' } };
    });
    expect(
      await screen.findByText("You don't have permission to read agents' tasks."),
    ).toBeTruthy();
    cleanup();
    open((b) => {
      b.options.organizationTasksFails = {
        status: 400,
        body: { error: 'invalid_task', field: 'period' },
      };
    });
    expect(await screen.findByText(/Those days are not a valid period/)).toBeTruthy();
    cleanup();
    open((b) => {
      b.options.organizationTasksFails = { status: 500, body: { error: 'unexpected' } };
    });
    expect(await screen.findByText("Tasks can't be read right now. Try again later.")).toBeTruthy();
  });
});
