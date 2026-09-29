import { catalogs, I18nProvider } from '@melonoffice/i18n';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { REFRESH_KEY } from '../identity/session.js';
import { AgentTasks } from './AgentTasks.js';
import { AgentTaskError, type AgentTaskView, type AgentTasksClient } from './agentTasksClient.js';

/**
 * Agent tasks in the agent's place (ADR-0063): the owner asks, the screen shows the task running
 * and then the verified answer, and never shows an answer the API did not give.
 */

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

function open(at: string, configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.specialists.org_1 = [
    { id: 'spec_ana', name: 'Ana Ventas', type: 'sales', status: 'active' },
    { id: 'spec_leo', name: 'Leo Pausado', type: 'sales', status: 'paused' },
  ];
  backend.options.permissions.push('specialist.task');
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const task = (extra: Partial<AgentTaskView> = {}): AgentTaskView => ({
  id: 'task-1',
  specialistId: 'spec_ana',
  request: '¿Qué productos vendemos más?',
  createdAt: '2026-09-29T12:00:00Z',
  status: 'running',
  failure: null,
  completedAt: null,
  answer: null,
  ...extra,
});

describe('agent tasks in the app (ADR-0063)', () => {
  it('asks the agent for a task with one request key, and shows it running', async () => {
    const backend = open('/office/sales/agent/spec_ana');
    const region = within(await screen.findByRole('region', { name: 'Tasks' }));
    expect(await region.findByText('No tasks yet.')).toBeTruthy();
    fireEvent.change(region.getByRole('textbox', { name: 'Ask Ana Ventas for something' }), {
      target: { value: '  Resume nuestras ventas  ' },
    });
    fireEvent.click(region.getByRole('button', { name: 'Ask' }));
    expect(await region.findByText('Resume nuestras ventas')).toBeTruthy();
    expect(region.getByText('In progress')).toBeTruthy();
    const post = backend.apiCalls().find((c) => c.method === 'POST' && c.url.endsWith('/tasks'));
    expect(post?.url).toBe(`${API}/v1/organizations/org_1/specialists/spec_ana/tasks`);
    const sent = JSON.parse(post?.body ?? '{}') as Record<string, string>;
    expect(sent.request).toBe('Resume nuestras ventas');
    expect(sent.idempotencyKey).toMatch(/^web-[0-9a-f-]{36}$/);
  });

  it('shows no form without specialist.task, and none for an agent that is not active', async () => {
    open('/office/sales/agent/spec_ana', (backend) => {
      backend.options.permissions = backend.options.permissions.filter(
        (p) => p !== 'specialist.task',
      );
      backend.options.agentTasks.spec_ana = [
        { ...task(), status: 'completed', answer: { answer: 'Pollo a la brasa.', missing: [] } },
      ];
    });
    const region = within(await screen.findByRole('region', { name: 'Tasks' }));
    expect(await region.findByText('Pollo a la brasa.')).toBeTruthy();
    expect(region.queryByRole('textbox')).toBeNull();
    cleanup();
    open('/office/sales/agent/spec_leo');
    const paused = within(await screen.findByRole('region', { name: 'Tasks' }));
    expect(
      await paused.findByText('This agent takes new tasks only while it is active.'),
    ).toBeTruthy();
    expect(paused.queryByRole('textbox')).toBeNull();
  });

  it('shows no tasks at all to a role that cannot read agents', async () => {
    const backend = open('/office/sales', (b) => {
      b.options.permissions = ['organization.read', 'department.read'];
    });
    await screen.findByRole('heading', { level: 1 });
    expect(backend.apiCalls().some((c) => c.url.includes('/tasks'))).toBe(false);
  });
});

describe('the tasks section (ADR-0063)', () => {
  function fakeClient(pages: AgentTaskView[][] = [[]]) {
    const reads: AgentTaskView[] = [];
    const client: AgentTasksClient & { readonly reads: AgentTaskView[] } = {
      reads,
      list: vi.fn(async () => ({ tasks: pages[0] ?? [], nextCursor: null })),
      assign: vi.fn(async (_agent: string, request: string) => task({ request })),
      get: vi.fn(async () => reads.shift() ?? task()),
    };
    return client;
  }
  const show = (client: AgentTasksClient, extra: { canAsk?: boolean } = {}) =>
    render(
      <I18nProvider locale="en" messages={catalogs.en}>
        <AgentTasks
          client={client}
          agentId="spec_ana"
          agentName="Ana"
          canAsk={extra.canAsk ?? true}
          agentActive
          refreshMs={5}
        />
      </I18nProvider>,
    );

  it('reads an open task again until its verified answer arrives', async () => {
    const client = fakeClient([[task()]]);
    client.reads.push(
      task(),
      task({
        status: 'completed',
        completedAt: '2026-09-29T12:01:00Z',
        answer: { answer: 'Vendemos más el Combo Familiar.', missing: ['Margen por producto'] },
      }),
    );
    show(client);
    expect(await screen.findByText('Vendemos más el Combo Familiar.')).toBeTruthy();
    expect(screen.getByText('Answered')).toBeTruthy();
    expect(screen.getByText('Margen por producto')).toBeTruthy();
    const calls = (client.get as ReturnType<typeof vi.fn>).mock.calls.length;
    // Settled: it is not read again.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect((client.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it('says a failed task failed, and never shows an answer for it', async () => {
    show(fakeClient([[task({ status: 'failed', failure: 'verification_failed' })]]));
    expect(await screen.findByText('Failed')).toBeTruthy();
    expect(
      screen.getByText('The agent could not finish this task. Nothing was done on its behalf.'),
    ).toBeTruthy();
  });

  it('explains a refusal, and retries with the same key after a failure', async () => {
    const client = fakeClient();
    const keys: string[] = [];
    client.assign = vi.fn(async (_agent: string, _request: string, key: string) => {
      keys.push(key);
      if (keys.length === 1) throw new AgentTaskError(409, 'specialist_not_available');
      if (keys.length === 2) throw new Error('network');
      return task();
    });
    show(client);
    const box = await screen.findByRole('textbox', { name: 'Ask Ana for something' });
    fireEvent.change(box, { target: { value: 'Hola' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText('This agent cannot take new tasks right now.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(
      await screen.findByText('Tasks are not available right now. Try again later.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(new Set(keys).size).toBe(1);
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });
});
