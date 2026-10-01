import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { giaEngagements } from './presence.js';

afterEach(() => {
  cleanup();
  giaEngagements.reset();
});

function open(configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
  globalThis.history.replaceState(null, '', '/gia');
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const answer = (proposal: unknown) => ({
  answer: 'Le preparé la tarea a Lucía. Confírmala para enviársela.',
  department: 'sales',
  screen: null,
  proposedAction: null,
  proposedFacts: 0,
  links: [],
  proposedFollowUp: null,
  proposedAgentTask: proposal,
  context: { facts: 1, activity: true, agents: true, missing: [] },
  replayed: false,
  generatedBy: 'ai',
});

const PROPOSAL = {
  agentId: 'spec_lucia',
  agentName: 'Lucía',
  department: 'sales',
  request: 'Prepara una propuesta de catering para 50 personas.',
};

async function ask() {
  const chat = await screen.findByRole('region', { name: 'Talk to GIA' });
  fireEvent.change(within(chat).getByRole('textbox', { name: 'Your message to GIA' }), {
    target: { value: 'Pídele a Lucía una propuesta de catering' },
  });
  fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
  return within(chat);
}

const taskPosts = (backend: ReturnType<typeof fakeBackend>) =>
  backend
    .apiCalls()
    .filter((c) => c.method === 'POST' && /\/specialists\/[^/]+\/tasks$/.test(c.url))
    .map((c) => ({ url: c.url, body: JSON.parse(String(c.body)) as Record<string, unknown> }));

describe('GIA prepares a task for an agent (AE-3)', () => {
  it('sends nothing until the person confirms, then sends it once, as edited', async () => {
    const backend = open((b) => {
      b.options.permissions.push('specialist.task');
      b.options.gia = answer(PROPOSAL);
    });
    const chat = await ask();
    expect(
      await chat.findByText(
        'I prepared this task for Lucía. Nothing is sent until you confirm it.',
      ),
    ).toBeTruthy();
    expect(taskPosts(backend)).toEqual([]);
    const request = chat.getByRole('textbox', { name: 'What Lucía will be asked' });
    expect((request as HTMLTextAreaElement).value).toBe(PROPOSAL.request);
    fireEvent.change(request, {
      target: { value: 'Prepara una propuesta de catering para 60 personas.' },
    });
    fireEvent.click(chat.getByRole('button', { name: 'Confirm and send' }));
    expect(
      await chat.findByText("Task sent to Lucía. Its answer will appear in the agent's place.", {
        exact: false,
      }),
    ).toBeTruthy();
    const sent = taskPosts(backend);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain('/v1/organizations/org_1/specialists/spec_lucia/tasks');
    expect(sent[0]?.body).toMatchObject({
      request: 'Prepara una propuesta de catering para 60 personas.',
      idempotencyKey: expect.stringMatching(/^web-[0-9a-f-]{36}$/),
    });
    expect(chat.getByRole('link', { name: "See Lucía's tasks" }).getAttribute('href')).toBe(
      '/office/sales/agent/spec_lucia',
    );
    // GIA goes to Lucía while the task is in her hands (gia/presence.ts).
    expect(giaEngagements.list()).toEqual([
      expect.objectContaining({ agentId: 'spec_lucia', taskId: expect.any(String) }),
    ]);
  });

  it('discarding sends nothing', async () => {
    const backend = open((b) => {
      b.options.permissions.push('specialist.task');
      b.options.gia = answer(PROPOSAL);
    });
    const chat = await ask();
    fireEvent.click(await chat.findByRole('button', { name: 'Discard' }));
    expect(chat.getByText('Task discarded. Nothing was sent.')).toBeTruthy();
    expect(giaEngagements.list()).toEqual([]);
    expect(taskPosts(backend)).toEqual([]);
  });

  it('a role that may not give tasks sees no form, and a refusal is said as such', async () => {
    const denied = open((b) => {
      b.options.gia = answer(PROPOSAL);
    });
    const chat = await ask();
    expect(await chat.findByText('Your role cannot give tasks to agents.')).toBeTruthy();
    expect(chat.queryByRole('button', { name: 'Confirm and send' })).toBeNull();
    expect(taskPosts(denied)).toEqual([]);
    cleanup();

    // The API refuses (the permission was removed meanwhile): the card says so and stays open.
    const refused = open((b) => {
      b.options.permissions.push('specialist.task');
      b.options.gia = answer(PROPOSAL);
    });
    const again = await ask();
    await again.findByRole('button', { name: 'Confirm and send' });
    refused.options.permissions.splice(refused.options.permissions.indexOf('specialist.task'), 1);
    fireEvent.click(again.getByRole('button', { name: 'Confirm and send' }));
    expect((await again.findByRole('alert')).textContent).toBe(
      'You do not have permission to ask this agent for tasks.',
    );
    expect(again.getByRole('button', { name: 'Confirm and send' })).toBeTruthy();
  });

  it('ignores a malformed proposal', async () => {
    open((b) => {
      b.options.permissions.push('specialist.task');
      b.options.gia = answer({ ...PROPOSAL, department: 'Ventas!' });
    });
    const chat = await ask();
    await chat.findByText('Le preparé la tarea a Lucía. Confírmala para enviársela.');
    expect(chat.queryByRole('form', { name: 'agent task proposal' })).toBeNull();
    expect(chat.queryByRole('button', { name: 'Confirm and send' })).toBeNull();
  });
});
