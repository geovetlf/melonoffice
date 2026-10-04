import { catalogs, I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { AgentCapabilities } from './AgentCapabilities.js';
import {
  AgentRequestError,
  type AgentAuditView,
  type AgentCapabilitiesView,
  type AgentsClient,
  type AgentHistoryEntryView,
} from './agentsClient.js';
import { TeamReview } from './TeamReview.js';

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
  /** The agents' list on the page, and one agent's row in it. */
  const list = () => screen.findByRole('region', { name: 'Agents' });
  const row = async (name: string) =>
    within(
      (await within(await list()).findByRole('button', { name })).closest('li') as HTMLElement,
    );

  it('lists agents with their status and department', async () => {
    const backend = open('/agents');
    expect(await screen.findByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy();
    const lucia = await row('Lucía');
    expect(lucia.getByText('Active')).toBeTruthy();
    const mateo = await row('Mateo');
    expect(mateo.getByText('Draft')).toBeTruthy();
    expect(mateo.getByRole('button', { name: 'Activate' })).toBeTruthy();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).getByRole('link', { name: /Agents/ })).toBeTruthy();
    // The list is asked for one page at a time (AE-4.3).
    const read = backend.apiCalls().find((c) => /\/specialists\?/.test(c.url));
    expect(read?.url).toContain('limit=25');
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
    expect((await row('Rosa')).getByText('Draft')).toBeTruthy();
    const created = statusCalls(backend).find((c) => c.url.endsWith('/specialists'));
    expect(JSON.parse(created?.body ?? '{}')).toEqual({
      templateId: 'commercial',
      displayName: 'Rosa',
      locale: 'en',
    });
  });

  it('activates an agent through the status route', async () => {
    const backend = open('/agents');
    fireEvent.click((await row('Mateo')).getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText('Mateo is now active.')).toBeTruthy();
    const call = statusCalls(backend).find((c) => c.url.endsWith('/spec_mateo/status'));
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ from: 'draft', to: 'active' });
    expect(await (await row('Mateo')).findByText('Active')).toBeTruthy();
  });

  it('names what an agent lacks when it cannot be activated yet (AE-4.2)', async () => {
    open('/agents', (b) => {
      b.options.activationProblems = {
        spec_mateo: [
          { kind: 'permission_not_held', permission: 'opportunity.read' },
          { kind: 'no_skills' },
        ],
      };
    });
    fireEvent.click((await row('Mateo')).getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText("Mateo can't be activated yet:")).toBeTruthy();
    expect(screen.getByText(/It needs access to .*, which you don't have\./)).toBeTruthy();
    expect((await row('Mateo')).getByText('Draft')).toBeTruthy();
  });

  it('says what pausing does, and pauses with the reason only once confirmed (AE-4.1)', async () => {
    const backend = open('/agents');
    fireEvent.click((await row('Lucía')).getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('heading', { name: 'Pause Lucía' })).toBeTruthy();
    expect(screen.getByText(/the ones in progress stop/)).toBeTruthy();
    expect(statusCalls(backend)).toHaveLength(0);
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason (optional)' }), {
      target: { value: 'Vacaciones' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText('Lucía is paused. Its tasks in progress were stopped.'),
    ).toBeTruthy();
    const call = statusCalls(backend).find((c) => c.url.endsWith('/spec_lucia/status'));
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      from: 'active',
      to: 'paused',
      reason: 'Vacaciones',
    });
  });

  it('disabling cannot be confirmed without a reason (AE-4.1)', async () => {
    const backend = open('/agents');
    fireEvent.click((await row('Lucía')).getByRole('button', { name: 'Disable' }));
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), {
      target: { value: 'Respuestas fuera de tono' },
    });
    fireEvent.click(confirm);
    expect(
      await screen.findByText('Lucía is disabled. Its tasks in progress were stopped.'),
    ).toBeTruthy();
    const call = statusCalls(backend).find((c) => c.url.endsWith('/spec_lucia/status'));
    expect(JSON.parse(call?.body ?? '{}')).toMatchObject({ reason: 'Respuestas fuera de tono' });
  });

  it('archiving does nothing when the person goes back', async () => {
    const backend = open('/agents');
    fireEvent.click((await row('Lucía')).getByRole('button', { name: 'Archive' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('heading', { name: 'Archive Lucía' })).toBeNull();
    expect(statusCalls(backend)).toHaveLength(0);
  });

  it('pages through the agents and filters them on the server (AE-4.3)', async () => {
    const backend = open('/agents', (b) => {
      b.options.pageSize = 25;
      b.options.specialists.org_1 = Array.from({ length: 30 }, (_, i) => ({
        id: `spec_${String(i).padStart(2, '0')}`,
        name: `Agent ${String(i).padStart(2, '0')}`,
        type: 'sales',
        status: i % 2 === 0 ? 'active' : 'draft',
      }));
    });
    expect(await row('Agent 00')).toBeTruthy();
    expect(within(await list()).queryByRole('button', { name: 'Agent 25' })).toBeNull();
    const previous = screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await row('Agent 29')).toBeTruthy();
    expect(screen.getByText('Page 2')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await row('Agent 00')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'draft' },
    });
    expect(await row('Agent 01')).toBeTruthy();
    expect(within(await list()).queryByRole('button', { name: 'Agent 00' })).toBeNull();
    expect(backend.apiCalls().some((c) => c.url.includes('status=draft'))).toBe(true);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by name' }), {
      target: { value: 'nobody' },
    });
    fireEvent.submit(screen.getByRole('searchbox', { name: 'Search by name' }));
    expect(await screen.findByText('No agent matches the search.')).toBeTruthy();
  });

  it('says so when a page cannot be read', async () => {
    open('/agents', (b) => {
      b.options.specialists.org_1 = Array.from({ length: 26 }, (_, i) => ({
        id: `spec_${String(i).padStart(2, '0')}`,
        name: `Agent ${String(i).padStart(2, '0')}`,
        type: 'sales',
        status: 'active',
      }));
      b.options.nextPagesFail = true;
    });
    await row('Agent 00');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('The agents could not be loaded.')).toBeTruthy();
  });

  it('without specialist.manage, lists agents with no create or status buttons', async () => {
    open('/agents', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'specialist.manage');
    });
    await row('Lucía');
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

  it('shows how far an agent acts on its own, and lets an owner change it (AE-4.4)', async () => {
    const backend = open('/office/sales/agent/spec_lucia');
    const section = await screen.findByRole('region', { name: 'What this agent can do' });
    expect(await within(section).findByText('How far it acts on its own')).toBeTruthy();
    expect(within(section).getByText(/Sensitive actions, such as sending outside/)).toBeTruthy();
    const controlled = within(section).getByRole('radio', { name: /Controlled \(recommended\)/ });
    expect((controlled as HTMLInputElement).checked).toBe(true);
    const save = within(section).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(section).getByRole('radio', { name: /Propose/ }));
    fireEvent.click(save);
    expect(await within(section).findByText('Saved. The agent has a new version.')).toBeTruthy();
    const call = backend.apiCalls().find((c) => c.url.endsWith('/spec_lucia/autonomy'));
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ fromVersion: 2, autonomy: 'propose' });
  });

  it('without specialist.manage, only says how far the agent acts on its own', async () => {
    open('/office/sales/agent/spec_lucia', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'specialist.manage');
    });
    const section = await screen.findByRole('region', { name: 'What this agent can do' });
    expect(await within(section).findByText('Controlled (recommended)')).toBeTruthy();
    expect(within(section).queryByRole('radio')).toBeNull();
    expect(within(section).queryByRole('button', { name: 'Save profile' })).toBeNull();
  });

  it('filters the agents by autonomy on the server', async () => {
    const backend = open('/agents');
    await row('Lucía');
    fireEvent.change(screen.getByRole('combobox', { name: 'Autonomy' }), {
      target: { value: 'within_policy' },
    });
    await waitFor(() =>
      expect(backend.apiCalls().some((c) => c.url.includes('autonomy=within_policy'))).toBe(true),
    );
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

  it('warns, before confirming, which workflow would lose a tool (G-2)', async () => {
    const agents = {
      capabilities: vi.fn(async () =>
        view(1, [
          {
            skillId: 'customer_follow_up',
            from: 1,
            to: 2,
            removes: ['follow_up_schedule@2'],
            breaks: [
              {
                workflowId: 'w1',
                name: 'Weekly follow-up',
                step: 's2',
                tool: 'follow_up_schedule@2',
              },
            ],
          },
        ]),
      ),
      upgradeSkill: vi.fn(),
    } as unknown as AgentsClient;
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValueOnce(false);
    show(agents, true);
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('Weekly follow-up');
    fireEvent.click(screen.getByRole('button', { name: 'Update to version 2' }));
    expect(confirm.mock.calls[0]?.[0]).toContain('Weekly follow-up');
    expect(agents.upgradeSkill).not.toHaveBeenCalled();
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

describe('the team review (G-1, ADR-0131)', () => {
  const audit: AgentAuditView = {
    reviewed: { agents: 2, workflows: 1, plans: 0 },
    skipped: ['plans'],
    findings: [
      {
        code: 'instructions_contradict_company_brain',
        severity: 'critical',
        subject: { type: 'agent', id: 'spec_lucia', version: 3, name: 'Lucía' },
        evidence: {
          fact: 'k_1',
          label: 'Combo Familiar',
          recorded: 'PEN 25.00',
          stated: 's/ 30',
          confirmed: true,
        },
        recommendation: 'review_instructions',
      },
      {
        code: 'workflow_tool_missing',
        severity: 'critical',
        subject: { type: 'workflow', id: 'wf_1', version: 1, name: 'Seguimiento' },
        evidence: {
          step: 'send',
          tool: 'knowledge_search@1',
          agent: 'spec_lucia',
          agentVersion: 3,
        },
        recommendation: 'review_workflow',
      },
      {
        code: 'skill_upgrade_available',
        severity: 'info',
        subject: { type: 'agent', id: 'spec_mateo', version: 1, name: 'Mateo' },
        evidence: { skill: 'customer_follow_up', from: 1, to: 3 },
        recommendation: 'upgrade_skill',
      },
    ],
  };

  it('runs only when asked, and says what it found, how serious and what to do', async () => {
    const agents = { audit: vi.fn(async () => audit) } as unknown as AgentsClient;
    render(
      <I18nProvider locale="en" messages={catalogs.en}>
        <TeamReview client={agents} />
      </I18nProvider>,
    );
    expect(agents.audit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review now' }));
    expect(
      await screen.findByText(
        'Its instructions say s/ 30 for “Combo Familiar”, but the company memory records PEN 25.00.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Agent Lucía')).toBeTruthy();
    expect(screen.getByText('Workflow Seguimiento')).toBeTruthy();
    expect(screen.getAllByText('Critical')).toHaveLength(2);
    expect(screen.getByText('Info')).toBeTruthy();
    expect(
      screen.getByText(
        'What to do: correct the instructions or the company memory, whichever is wrong.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Plans were not reviewed: you do not have access to them.'),
    ).toBeTruthy();
    expect(screen.getByText('Reviewed: 2 agents, 1 workflow and 0 pending plans.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review again' })).toBeTruthy();
  });

  it('says so when there is nothing to fix', async () => {
    const agents = {
      audit: vi.fn(async () => ({ ...audit, findings: [], skipped: [] })),
    } as unknown as AgentsClient;
    render(
      <I18nProvider locale="en" messages={catalogs.en}>
        <TeamReview client={agents} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review now' }));
    expect(await screen.findByText('All in order: nothing to fix was found.')).toBeTruthy();
  });
});

describe('editing what an agent is for (ADR-0140)', () => {
  const view = (version: number, purpose: string | null): AgentCapabilitiesView => ({
    version,
    purpose,
    description: null,
    ready: true,
    skills: [],
    tools: [],
    problems: [],
  });
  const show = (agents: AgentsClient, canManage: boolean) =>
    render(
      <I18nProvider locale="en" messages={catalogs.en}>
        <AgentCapabilities client={agents} agentId="spec_lucia" canManage={canManage} />
      </I18nProvider>,
    );

  it('sends only what changed, with the version it read, and shows the new version', async () => {
    let current = view(3, 'Vender');
    const agents = {
      capabilities: vi.fn(async () => current),
      setProfile: vi.fn(async () => {
        current = view(4, 'Vender más');
        return {} as never;
      }),
    } as unknown as AgentsClient;
    show(agents, true);
    const purpose = await screen.findByRole('textbox', { name: 'Purpose' });
    const save = screen.getByRole('button', { name: 'Save profile' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(purpose, { target: { value: 'Vender más ' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(agents.setProfile).toHaveBeenCalledWith('spec_lucia', {
        fromVersion: 3,
        purpose: 'Vender más',
      }),
    );
    expect(await screen.findByText('Saved as a new version of the agent.')).toBeTruthy();
    expect(await screen.findByText(/Version 4/)).toBeTruthy();
  });

  it('says so when someone else changed the agent meanwhile', async () => {
    const agents = {
      capabilities: vi.fn(async () => view(3, null)),
      setProfile: vi.fn(async () => {
        throw new AgentRequestError(409, 'specialist_concurrency_conflict');
      }),
    } as unknown as AgentsClient;
    show(agents, true);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Description' }), {
      target: { value: 'Atiende pedidos' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(
      await screen.findByText(
        'Someone changed this agent meanwhile. Reload the page and try again.',
      ),
    ).toBeTruthy();
  });

  it('without specialist.manage, only shows what it is for', async () => {
    show({ capabilities: vi.fn(async () => view(3, 'Vender')) } as unknown as AgentsClient, false);
    expect(await screen.findByText('Vender')).toBeTruthy();
    expect(screen.getByText('Not written yet')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save profile' })).toBeNull();
  });
});

describe("adding and removing an agent's skills (ADR-0141)", () => {
  const skill = (id: string) => ({
    id,
    version: 1,
    known: true,
    tools: [],
    actions: [],
    reads: ['report.read'],
  });
  const view = (version: number, held: string[]): AgentCapabilitiesView => ({
    version,
    ready: true,
    skills: held.map(skill),
    tools: [],
    problems: [],
    addable: held.includes('finance_review') ? [] : [{ skillId: 'finance_review', version: 1 }],
    removals: held.map((skillId) => ({
      skillId,
      removes: skillId === 'pipeline_analysis' ? ['follow_up_schedule@2'] : [],
      breaks:
        skillId === 'pipeline_analysis'
          ? [
              {
                workflowId: 'w1',
                name: 'Weekly follow-up',
                step: 's2',
                tool: 'follow_up_schedule@2',
              },
            ]
          : [],
    })),
  });
  const show = (agents: AgentsClient, canManage: boolean) =>
    render(
      <I18nProvider locale="en" messages={catalogs.en}>
        <AgentCapabilities client={agents} agentId="spec_lucia" canManage={canManage} />
      </I18nProvider>,
    );

  it('adds a skill the server offers, only after confirming', async () => {
    let current = view(1, ['company_knowledge', 'pipeline_analysis']);
    const agents = {
      capabilities: vi.fn(async () => current),
      addSkill: vi.fn(async () => {
        current = view(2, ['company_knowledge', 'pipeline_analysis', 'finance_review']);
        return {} as never;
      }),
      removeSkill: vi.fn(),
    } as unknown as AgentsClient;
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    show(agents, true);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Add a skill' }), {
      target: { value: 'finance_review' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
    await waitFor(() =>
      expect(agents.addSkill).toHaveBeenCalledWith('spec_lucia', {
        fromVersion: 1,
        skillId: 'finance_review',
        version: 1,
      }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Skill added. The agent has a new version.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Add a skill' })).toBeNull();
  });

  it('warns which workflow would lose a tool before removing, and does nothing on going back', async () => {
    const agents = {
      capabilities: vi.fn(async () => view(1, ['company_knowledge', 'pipeline_analysis'])),
      addSkill: vi.fn(),
      removeSkill: vi.fn(async () => ({}) as never),
    } as unknown as AgentsClient;
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValueOnce(false);
    show(agents, true);
    const buttons = await screen.findAllByRole('button', { name: /^Remove / });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1] as HTMLElement);
    expect(confirm.mock.calls[0]?.[0]).toContain('Weekly follow-up');
    expect(agents.removeSkill).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(buttons[1] as HTMLElement);
    await waitFor(() =>
      expect(agents.removeSkill).toHaveBeenCalledWith('spec_lucia', {
        fromVersion: 1,
        skillId: 'pipeline_analysis',
      }),
    );
    expect(await screen.findByText('Skill removed. The agent has a new version.')).toBeTruthy();
  });

  it('without specialist.manage, neither adds nor removes', async () => {
    show(
      {
        capabilities: vi.fn(async () => view(1, ['company_knowledge', 'pipeline_analysis'])),
        addSkill: vi.fn(),
        removeSkill: vi.fn(),
      } as unknown as AgentsClient,
      false,
    );
    expect(await screen.findByText(/Version 1/)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Add a skill' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
  });
});

describe('moving an agent to another department (ADR-0141)', () => {
  const view = (version: number): AgentCapabilitiesView => ({
    version,
    ready: true,
    skills: [],
    tools: [],
    problems: [],
    moves: [
      { departmentId: 'org_1_marketing', blockedBy: [] },
      { departmentId: 'org_1_finance', blockedBy: ['customer_follow_up'] },
    ],
    moveLeaves: [{ workflowId: 'w1', name: 'Weekly follow-up' }],
  });
  const departments = [
    { id: 'org_1_marketing', name: 'Marketing' },
    { id: 'org_1_finance', name: 'Finance' },
  ];

  it('moves only to a department that allows its skills, after a warning, and goes there', async () => {
    const moved = { id: 'spec_lucia', departmentId: 'org_1_marketing' };
    const agents = {
      capabilities: vi.fn(async () => view(4)),
      change: vi.fn(async () => moved),
    } as unknown as AgentsClient;
    const onMoved = vi.fn();
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    render(
      <I18nProvider locale="en" messages={catalogs.en}>
        <AgentCapabilities
          client={agents}
          agentId="spec_lucia"
          canManage
          departments={departments}
          onMoved={onMoved}
        />
      </I18nProvider>,
    );
    const select = await screen.findByRole('combobox', { name: 'Move to another department' });
    const finance = within(select).getByRole('option', {
      name: 'Finance (first remove Customer follow-up)',
    }) as HTMLOptionElement;
    expect(finance.disabled).toBe(true);
    expect(
      screen.getByText(
        'Each change here creates a new version of the agent; earlier versions are kept.',
      ),
    ).toBeTruthy();
    fireEvent.change(select, { target: { value: 'org_1_marketing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move agent' }));
    await waitFor(() =>
      expect(agents.change).toHaveBeenCalledWith('spec_lucia', {
        fromVersion: 4,
        departmentId: 'org_1_marketing',
      }),
    );
    expect(confirm.mock.calls[0]?.[0]).toContain('Weekly follow-up');
    expect(confirm.mock.calls[0]?.[0]).toContain('Move the agent to Marketing?');
    expect(onMoved).toHaveBeenCalledWith(moved);
  });

  it('says so when someone else changed the agent meanwhile, and changes nothing', async () => {
    const agents = {
      capabilities: vi.fn(async () => view(4)),
      change: vi.fn(async () => {
        throw new AgentRequestError(409, 'specialist_concurrency_conflict');
      }),
    } as unknown as AgentsClient;
    const onMoved = vi.fn();
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    render(
      <I18nProvider locale="en" messages={catalogs.en}>
        <AgentCapabilities
          client={agents}
          agentId="spec_lucia"
          canManage
          departments={departments}
          onMoved={onMoved}
        />
      </I18nProvider>,
    );
    fireEvent.change(await screen.findByRole('combobox', { name: 'Move to another department' }), {
      target: { value: 'org_1_marketing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move agent' }));
    expect(
      await screen.findByText(
        'Someone changed this agent meanwhile. Nothing was changed; try again.',
      ),
    ).toBeTruthy();
    expect(onMoved).not.toHaveBeenCalled();
  });
});

describe("an agent's version history (ADR-0142)", () => {
  const entry = (
    version: number,
    changes: AgentHistoryEntryView['changes'],
    actor: AgentHistoryEntryView['actor'] = 'you',
  ): AgentHistoryEntryView => ({
    version,
    previousVersion: version === 1 ? null : version - 1,
    createdAt: '2026-10-03T20:30:00.000Z',
    actor,
    changes,
  });
  const page1 = [
    entry(5, [{ kind: 'autonomy', before: 'propose', after: 'controlled' }], 'another_person'),
    entry(4, [{ kind: 'department', before: 'org_1_sales', after: 'org_1_marketing' }]),
    entry(3, [
      {
        kind: 'skills',
        added: [{ id: 'finance_review', version: 1 }],
        removed: [{ id: 'customer_follow_up', version: 2 }],
        updated: [],
      },
    ]),
  ];
  const page2 = [
    entry(2, [{ kind: 'purpose', before: 'Antes', after: 'Vender más' }]),
    entry(1, [{ kind: 'created' }]),
  ];
  function show(history: AgentsClient['history']) {
    const agents = {
      capabilities: vi.fn(async () => ({
        version: 5,
        ready: true,
        skills: [],
        tools: [],
        problems: [],
      })),
      history,
    } as unknown as AgentsClient;
    render(
      <I18nProvider locale="en" messages={catalogs.en}>
        <AgentCapabilities
          client={agents}
          agentId="spec_lucia"
          departments={[
            { id: 'org_1_sales', name: 'Sales' },
            { id: 'org_1_marketing', name: 'Marketing' },
          ]}
        />
      </I18nProvider>,
    );
  }

  it('shows each version with who, when, the kind of change and a summary, newest first', async () => {
    const history = vi.fn(async (_id: string, before?: number) =>
      before === undefined
        ? { entries: page1, nextBefore: 3 }
        : { entries: page2, nextBefore: null },
    );
    show(history);
    const list = await screen.findByRole('list', { name: 'Version history' });
    const items = () =>
      within(list)
        .getAllByRole('listitem')
        .filter((li) => li.parentElement === list);
    expect(items().map((li) => li.querySelector('strong')?.textContent)).toEqual([
      'v4 → v5',
      'v3 → v4',
      'v2 → v3',
    ]);
    expect(items()[0]?.textContent).toContain('Another person');
    expect(items()[0]?.textContent).toContain('Autonomy');
    expect(items()[0]?.textContent).toContain('Propose → Controlled (recommended)');
    expect(items()[1]?.textContent).toContain('You');
    expect(within(list).getByText('Sales → Marketing')).toBeTruthy();
    expect(within(list).getByText('+ Finance review')).toBeTruthy();
    expect(within(list).getByText('− Customer follow-up')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show older versions' }));
    await waitFor(() => expect(history).toHaveBeenLastCalledWith('spec_lucia', 3));
    expect(await within(list).findByText('Purpose updated')).toBeTruthy();
    expect(within(list).getByText('Created from its template.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show older versions' })).toBeNull();

    // The detail says what it was before and after; nothing can be changed from here.
    fireEvent.click(screen.getByRole('button', { name: 'See what version 2 changed' }));
    expect(within(list).getByText('Before: Antes. After: Vender más.')).toBeTruthy();
    expect(within(list).queryByRole('textbox')).toBeNull();
  });

  it('says so when the history cannot be read', async () => {
    show(
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    expect(await screen.findByText('Its history could not be read. Try again.')).toBeTruthy();
  });
});

describe('restoring an earlier version (ADR-0143)', () => {
  const entries: AgentHistoryEntryView[] = [
    {
      version: 3,
      previousVersion: 2,
      createdAt: '2026-10-04T10:00:00.000Z',
      actor: 'you',
      restoredFrom: 1,
      changes: [{ kind: 'purpose', before: 'Vender', after: null }],
    },
    {
      version: 2,
      previousVersion: 1,
      createdAt: '2026-10-04T09:00:00.000Z',
      actor: 'you',
      restoredFrom: null,
      changes: [{ kind: 'purpose', before: null, after: 'Vender' }],
    },
    {
      version: 1,
      previousVersion: null,
      createdAt: '2026-10-04T08:00:00.000Z',
      actor: 'you',
      restoredFrom: null,
      changes: [{ kind: 'created' }],
    },
  ];
  function show(agents: AgentsClient, canManage: boolean) {
    render(
      <I18nProvider locale="en" messages={catalogs.en}>
        <AgentCapabilities client={agents} agentId="spec_lucia" canManage={canManage} />
      </I18nProvider>,
    );
  }
  const client = (restore: AgentsClient['restore']) =>
    ({
      capabilities: vi.fn(async () => ({
        version: 3,
        ready: true,
        skills: [],
        tools: [],
        problems: [],
      })),
      history: vi.fn(async () => ({ entries, nextBefore: null })),
      restore,
    }) as unknown as AgentsClient;

  it('restores an earlier version only after confirming, never the current one', async () => {
    const restore = vi.fn(async () => ({}) as never);
    const agents = client(restore);
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValueOnce(false);
    show(agents, true);
    expect(await screen.findByText('Restored from version 1.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore version 3' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 1' }));
    expect(restore).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 1' }));
    await waitFor(() =>
      expect(restore).toHaveBeenCalledWith('spec_lucia', { fromVersion: 3, version: 1 }),
    );
    expect(await screen.findByText('Version restored as a new version of the agent.')).toBeTruthy();
  });

  it('says so on a conflict, and offers nothing without specialist.manage', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    show(
      client(
        vi.fn(async () => {
          throw new AgentRequestError(409, 'specialist_concurrency_conflict');
        }),
      ),
      true,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Restore version 2' }));
    expect(
      await screen.findByText(
        'Someone changed this agent meanwhile. Nothing was changed; try again.',
      ),
    ).toBeTruthy();
    cleanup();
    show(client(vi.fn()), false);
    expect(await screen.findByText('Restored from version 1.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Restore version/ })).toBeNull();
  });
});
