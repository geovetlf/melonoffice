import { catalogs, I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { AgentCapabilities } from './AgentCapabilities.js';
import type { AgentCapabilitiesView, AgentsClient } from './agentsClient.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

function open(at: string, configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push('specialist.read', 'specialist.manage', 'department.read');
  backend.options.specialists = {
    org_1: [
      { id: 'spec_lucia', name: 'Lucía', type: 'sales', status: 'active', purpose: 'Sells.' },
      { id: 'spec_mateo', name: 'Mateo', type: 'marketing', status: 'draft' },
    ],
  };
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const statusCalls = (backend: ReturnType<typeof fakeBackend>) =>
  backend.apiCalls().filter((c) => c.method === 'POST' && c.url.includes('/specialists'));

describe('Agents (ADR-0025, ADR-0062)', () => {
  it('lists agents by status with their department', async () => {
    open('/agents');
    expect(await screen.findByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy();
    const active = await screen.findByRole('region', { name: /Active/ });
    expect(within(active).getByRole('button', { name: 'Lucía' })).toBeTruthy();
    const drafts = screen.getByRole('region', { name: /Drafts/ });
    expect(within(drafts).getByRole('button', { name: 'Mateo' })).toBeTruthy();
    expect(within(drafts).getByRole('button', { name: 'Activate' })).toBeTruthy();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).getByRole('link', { name: /Agents/ })).toBeTruthy();
  });

  it('creates an agent from a template as a draft', async () => {
    const backend = open('/agents');
    fireEvent.click(await screen.findByRole('button', { name: 'Create agent' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'What kind of agent' }), {
      target: { value: 'commercial' },
    });
    expect(screen.getByText('Serves customers.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Rosa' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create as draft' }));
    expect(await screen.findByText('Rosa was created as a draft.')).toBeTruthy();
    const drafts = screen.getByRole('region', { name: /Drafts/ });
    expect(within(drafts).getByRole('button', { name: 'Rosa' })).toBeTruthy();
    const created = statusCalls(backend).find((c) => c.url.endsWith('/specialists'));
    expect(JSON.parse(created?.body ?? '{}')).toEqual({
      templateId: 'commercial',
      displayName: 'Rosa',
      locale: 'en',
    });
  });

  it('activates and pauses an agent through the status route', async () => {
    const backend = open('/agents');
    const drafts = await screen.findByRole('region', { name: /Drafts/ });
    fireEvent.click(within(drafts).getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('Mateo is now active.')).toBeTruthy();
    const call = statusCalls(backend).find((c) => c.url.endsWith('/spec_mateo/status'));
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ from: 'draft', to: 'active' });
    expect(screen.queryByRole('region', { name: /Drafts/ })).toBeNull();
  });

  it('asks before archiving, and does nothing when the person says no', async () => {
    const backend = open('/agents');
    vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    const active = await screen.findByRole('region', { name: /Active/ });
    fireEvent.click(within(active).getByRole('button', { name: 'Archive' }));
    expect(statusCalls(backend)).toHaveLength(0);
  });

  it('without specialist.manage, lists agents with no create or status buttons', async () => {
    open('/agents', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'specialist.manage');
    });
    await screen.findByRole('region', { name: /Active/ });
    expect(screen.queryByRole('button', { name: 'Create agent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('shows what an agent can do on its page', async () => {
    open('/office/sales/agent/spec_lucia');
    const section = await screen.findByRole('region', { name: 'What this agent can do' });
    expect(await within(section).findByText(/Version 2/)).toBeTruthy();
    expect(within(section).getByText(/Ready to take work/)).toBeTruthy();
    // Each skill at its version, and under it what that version lets the agent do (ADR-0083).
    const skills = within(within(section).getByRole('list', { name: 'Skills' }));
    const reply = within(skills.getByText('Reply to conversations').closest('li') as HTMLElement);
    expect(reply.getByText('v1')).toBeTruthy();
    expect(reply.getByText('Send a message · Risk: medium · needs approval')).toBeTruthy();
    expect(reply.getByText(/Hand a conversation to a person · Risk: low/)).toBeTruthy();
    expect(reply.getByText('Reads: conversations')).toBeTruthy();
    const knowledge = within(skills.getByText('Company knowledge').closest('li') as HTMLElement);
    expect(
      knowledge.getByText('Uses no tools: it works from what the company has recorded.'),
    ).toBeTruthy();
    expect(knowledge.queryByText(/Send a message/)).toBeNull();
  });

  it('shows the skills catalogue, and the tools with their approval policy to tool.read', async () => {
    open('/agents', (b) => b.options.permissions.push('tool.read'));
    const catalogue = await screen.findByRole('region', { name: 'Skills and tools' });
    const skills = within(await within(catalogue).findByRole('list', { name: 'Skills' }));
    expect(skills.getByText('Reply to conversations')).toBeTruthy();
    expect(skills.getByText('Uses: Send a message, Hand a conversation to a person')).toBeTruthy();
    expect(skills.getByText('Reads: conversations')).toBeTruthy();
    expect(skills.getByText('Agents with it: Commercial agent')).toBeTruthy();
    expect(
      skills.getByText('Uses no tools: it works from what the company has recorded.'),
    ).toBeTruthy();
    const tools = within(await within(catalogue).findByRole('list', { name: 'Tools' }));
    expect(tools.getByText('Send a message')).toBeTruthy();
    expect(
      tools.getByText(/Version 2 · changes data · Risk: medium · needs approval/),
    ).toBeTruthy();
  });

  it('does not read the tools without tool.read', async () => {
    const backend = open('/agents');
    const catalogue = await screen.findByRole('region', { name: 'Skills and tools' });
    expect(await within(catalogue).findByText('Reply to conversations')).toBeTruthy();
    expect(within(catalogue).queryByRole('heading', { name: 'Tools' })).toBeNull();
    expect(backend.apiCalls().some((c) => c.url.endsWith('/tools'))).toBe(false);
  });
});

describe('moving a skill to its newer version (ADR-0084)', () => {
  const view = (
    version: number,
    upgrades: NonNullable<AgentCapabilitiesView['upgrades']>,
  ): AgentCapabilitiesView => ({
    version,
    ready: true,
    skills: [
      {
        id: 'customer_follow_up',
        version: upgrades.length > 0 ? 1 : 2,
        known: true,
        tools: [],
        actions: [],
        reads: ['contact.read'],
      },
    ],
    tools: [],
    problems: [],
    upgrades,
  });
  function client(): AgentsClient {
    let current = view(1, [{ skillId: 'customer_follow_up', from: 1, to: 2 }]);
    return {
      templates: vi.fn(),
      skills: vi.fn(),
      tools: vi.fn(),
      create: vi.fn(),
      setStatus: vi.fn(),
      capabilities: vi.fn(async () => current),
      upgradeSkill: vi.fn(async () => {
        current = view(2, []);
        return {} as never;
      }),
    } as unknown as AgentsClient;
  }
  const show = (agents: AgentsClient, canManage: boolean) =>
    render(
      <I18nProvider locale="en" messages={catalogs.en}>
        <AgentCapabilities client={agents} agentId="spec_lucia" canManage={canManage} />
      </I18nProvider>,
    );

  it('says what the newer version allows, and moves the agent only after confirming', async () => {
    const agents = client();
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValueOnce(false);
    show(agents, true);
    expect(
      await screen.findByText(
        'Version 2 lets it propose follow-ups and schedule them, always with your approval.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update to version 2' }));
    expect(agents.upgradeSkill).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Update to version 2' }));
    await waitFor(() =>
      expect(agents.upgradeSkill).toHaveBeenCalledWith('spec_lucia', {
        fromVersion: 1,
        skillId: 'customer_follow_up',
        version: 2,
      }),
    );
    expect(await screen.findByText('Skill updated. The agent has a new version.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update to version 2' })).toBeNull();
  });

  it('without specialist.manage, only says a newer version exists', async () => {
    show(client(), false);
    expect(
      await screen.findByText(
        'Version 2 lets it propose follow-ups and schedule them, always with your approval.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update to version 2' })).toBeNull();
  });
});
