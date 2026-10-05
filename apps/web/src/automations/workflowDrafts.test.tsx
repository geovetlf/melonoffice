import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { giaEngagements } from '../gia/presence.js';

/**
 * GIA drafts a workflow from a person's words (Block 3 F2, ADR-0171): the card says what the
 * server checked (who, which tool, what changes data, what asks first, when it runs, how it
 * ends), never shows a refused draft as valid, and saves only when the person says so.
 */

afterEach(() => {
  cleanup();
  giaEngagements.reset();
});
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const WRITER = [
  'workflow.read',
  'plan.read',
  'plan.create',
  'workflow.manage',
  'specialist.read',
  'gia.ask',
];

const VERIFICATION = {
  policy: 'output_schema',
  expectedOutput: 'agent_answer',
  requiredChecks: [],
};

const STEPS = [
  {
    id: 'research',
    kind: 'specialist',
    label: 'Revisar a los clientes inactivos',
    dependsOn: [],
    assignee: { departmentTypeId: 'sales', roleId: 'commercial_agent' },
    verification: VERIFICATION,
  },
  {
    id: 'search',
    kind: 'tool',
    label: 'Buscar lo que sabemos',
    dependsOn: ['research'],
    performedBy: 'research',
    tool: { id: 'knowledge_search', version: 1 },
    input: { query: 'clientes inactivos' },
  },
  {
    id: 'pause',
    kind: 'wait',
    label: 'Esperar un día',
    dependsOn: ['research'],
    wait: { seconds: 86_400 },
  },
  {
    id: 'offer',
    kind: 'specialist',
    label: 'Preparar la oferta',
    dependsOn: ['pause'],
    assignee: { departmentTypeId: 'sales', roleId: 'commercial_agent' },
    verification: VERIFICATION,
    approvalRequired: true,
  },
];

const LUCIA = {
  id: 'spec_lucia',
  displayName: 'Lucía',
  departmentTypeId: 'sales',
  roleId: 'commercial_agent',
};

const READY = {
  status: 'ready',
  name: 'Recuperar clientes inactivos',
  steps: STEPS,
  summary: {
    steps: [
      {
        id: 'research',
        kind: 'specialist',
        label: STEPS[0]?.label,
        dependsOn: [],
        approvalRequired: false,
        agent: LUCIA,
      },
      {
        id: 'search',
        kind: 'tool',
        label: STEPS[1]?.label,
        dependsOn: ['research'],
        approvalRequired: false,
        agent: LUCIA,
        tool: { id: 'knowledge_search', version: 1, changesData: false, riskLevel: 'low' },
      },
      {
        id: 'pause',
        kind: 'wait',
        label: STEPS[2]?.label,
        dependsOn: ['research'],
        approvalRequired: false,
        waitSeconds: 86_400,
      },
      {
        id: 'offer',
        kind: 'specialist',
        label: STEPS[3]?.label,
        dependsOn: ['pause'],
        approvalRequired: true,
        agent: LUCIA,
      },
    ],
    riskLevel: 'medium',
    approvalRequired: true,
    changesData: false,
    schedule: 'manual',
    results: ['search', 'offer'],
  },
};

function open(
  path: string,
  configure?: (backend: ReturnType<typeof fakeBackend>) => void,
  permissions: readonly string[] = WRITER,
) {
  globalThis.history.replaceState(null, '', path);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.splice(0, backend.options.permissions.length, ...permissions);
  backend.options.workflows.org_1 = [];
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

async function askOnAutomations(words = 'Recupera a los clientes inactivos') {
  fireEvent.click(await screen.findByRole('button', { name: 'Create with GIA' }));
  const panel = within(
    await screen.findByRole('region', { name: 'Create an automation with GIA' }),
  );
  fireEvent.change(panel.getByLabelText('What you want to automate'), { target: { value: words } });
  fireEvent.click(panel.getByRole('button', { name: 'Prepare with GIA' }));
  return panel;
}

describe('GIA drafts a workflow on Automations (ADR-0171)', () => {
  it('shows what the server checked, and saves exactly those steps only when asked', async () => {
    const backend = open('/automations', (b) => {
      b.options.workflowDrafts = [READY];
    });
    const panel = await askOnAutomations();
    const card = within(await panel.findByRole('region', { name: 'Recuperar clientes inactivos' }));
    expect(card.getByText('Can run')).toBeTruthy();
    expect(card.getByText('Asks for your approval')).toBeTruthy();
    expect(card.getByText('Looks things up only')).toBeTruthy();
    expect(card.getByText('1. Revisar a los clientes inactivos')).toBeTruthy();
    expect(card.getAllByText(/Done by Lucía/)).toHaveLength(2);
    expect(card.getByText('Lucía looks up: Search the company memory.')).toBeTruthy();
    expect(card.getByText('Waits 1 day before going on.')).toBeTruthy();
    expect(card.getByText('Asks for your approval first')).toBeTruthy();
    expect(card.getByText('It looks up: Search the company memory.')).toBeTruthy();
    expect(card.getByText('Nothing: it only looks things up and prepares.')).toBeTruthy();
    expect(card.getByText(/When you start it from Automations/)).toBeTruthy();
    expect(card.getByText('Buscar lo que sabemos and Preparar la oferta')).toBeTruthy();
    // The person's words went to the server once; nothing was saved.
    expect(posts(backend, '/workflows/draft').map((c) => JSON.parse(c.body ?? '{}'))).toEqual([
      { intent: 'Recupera a los clientes inactivos' },
    ]);
    expect(posts(backend, '/org_1/workflows')).toHaveLength(0);

    fireEvent.click(card.getByRole('button', { name: 'Save draft' }));
    expect(
      await panel.findByText(/“Recuperar clientes inactivos” was saved as a draft/),
    ).toBeTruthy();
    const [saved] = posts(backend, '/org_1/workflows');
    expect(JSON.parse(saved?.body ?? '{}')).toEqual({ name: READY.name, steps: STEPS });
    const workflows = within(screen.getByRole('region', { name: 'Workflows' }));
    expect(await workflows.findByText('Recuperar clientes inactivos')).toBeTruthy();
  });

  it('never offers to save a draft planning would refuse, says why, and opens it in the editor', async () => {
    const backend = open('/automations', (b) => {
      b.options.workflowDrafts = [
        {
          status: 'invalid',
          name: 'Campaña por correo',
          steps: STEPS.slice(0, 2),
          problem: { stage: 'permission', reason: 'tool_not_assigned', detail: 'steps.1' },
        },
      ];
    });
    const panel = await askOnAutomations('Envía una campaña');
    const warning = (await panel.findByText("GIA's draft can't run as it is.")).closest(
      '[role="status"]',
    ) as HTMLElement;
    expect(warning.textContent).toContain('Step 2: “Buscar lo que sabemos”.');
    expect(warning.textContent).toContain("It can't be saved like this");
    expect(warning.querySelector('code')?.textContent).toBe(
      'permission · tool_not_assigned · steps.1',
    );
    expect(within(warning).queryByRole('button', { name: 'Save draft' })).toBeNull();

    fireEvent.click(within(warning).getByRole('button', { name: 'Adjust in advanced mode' }));
    const editor = within(await screen.findByRole('form', { name: 'New workflow' }));
    expect((await editor.findByLabelText('Name')).getAttribute('value')).toBe('Campaña por correo');
    expect((editor.getByLabelText('Step 1: what to do') as HTMLInputElement).value).toBe(
      'Revisar a los clientes inactivos',
    );
    expect(screen.queryByRole('region', { name: 'Create an automation with GIA' })).toBeNull();
    expect(posts(backend, '/org_1/workflows')).toHaveLength(0);
  });

  it('answers GIA’s question with the person’s words added, then shows the draft', async () => {
    const backend = open('/automations', (b) => {
      b.options.workflowDrafts = [
        { status: 'needs_clarification', question: '¿Qué clientes?' },
        READY,
      ];
    });
    const panel = await askOnAutomations('Gestiona mis clientes');
    expect(await panel.findByText('GIA: ¿Qué clientes?')).toBeTruthy();
    fireEvent.change(panel.getByLabelText('Your answer'), {
      target: { value: 'Los que no compran hace 3 meses' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Reply' }));
    expect(await panel.findByRole('region', { name: 'Recuperar clientes inactivos' })).toBeTruthy();
    expect(posts(backend, '/workflows/draft').map((c) => JSON.parse(c.body ?? '{}'))).toEqual([
      { intent: 'Gestiona mis clientes' },
      { intent: 'Gestiona mis clientes\nLos que no compran hace 3 meses' },
    ]);
  });

  it('says plainly when it cannot be done, when credits ran out, or when drafting is unavailable', async () => {
    open('/automations', (b) => {
      b.options.workflowDrafts = [
        { status: 'not_possible', reason: 'No hay una herramienta de correo.' },
      ];
    });
    let panel = await askOnAutomations('Envía una campaña por email');
    expect(await panel.findByText("This can't be automated with your agents today.")).toBeTruthy();
    expect(panel.getByText('GIA: No hay una herramienta de correo.')).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Save draft' })).toBeNull();
    fireEvent.click(panel.getByRole('button', { name: 'Discard' }));
    expect(panel.queryByText('GIA: No hay una herramienta de correo.')).toBeNull();
    cleanup();

    open('/automations', (b) => {
      b.options.workflowDrafts = [{ status: 'failed', code: 'insufficient_credits' }];
    });
    panel = await askOnAutomations();
    const failed = (await panel.findByText("GIA couldn't prepare the draft.")).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(failed.querySelector('code')?.textContent).toBe('insufficient_credits');
    expect(within(failed).queryByRole('button', { name: 'Try again' })).toBeNull();
    cleanup();

    open('/automations');
    panel = await askOnAutomations();
    expect(
      await panel.findByText("Preparing automations with GIA isn't available in this environment."),
    ).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('is not offered to a role that may not ask GIA or plan', async () => {
    open(
      '/automations',
      undefined,
      WRITER.filter((p) => p !== 'gia.ask'),
    );
    expect(await screen.findByRole('button', { name: 'New workflow' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create with GIA' })).toBeNull();
    cleanup();
    open(
      '/automations',
      undefined,
      WRITER.filter((p) => p !== 'plan.create'),
    );
    expect(await screen.findByRole('button', { name: 'New workflow' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create with GIA' })).toBeNull();
  });
});

describe('GIA drafts a workflow in her chat (ADR-0171)', () => {
  it('prepares it from the message, and opens it in the advanced editor on Automations', async () => {
    const backend = open('/gia', (b) => {
      b.options.workflowDrafts = [READY];
    });
    const chat = within(await screen.findByRole('region', { name: 'Talk to GIA' }));
    fireEvent.change(chat.getByRole('textbox', { name: 'Your message to GIA' }), {
      target: { value: 'Recupera a los clientes inactivos' },
    });
    fireEvent.click(chat.getByRole('button', { name: 'Prepare as an automation' }));
    const card = within(await chat.findByRole('region', { name: 'Recuperar clientes inactivos' }));
    expect(card.getByText('Can run')).toBeTruthy();
    // Her chat was not asked: the draft is its own call.
    expect(posts(backend, '/gia/ask')).toHaveLength(0);
    expect(posts(backend, '/workflows/draft')).toHaveLength(1);

    fireEvent.click(card.getByRole('button', { name: 'Adjust in advanced mode' }));
    const editor = within(await screen.findByRole('form', { name: 'New workflow' }));
    expect((await editor.findByLabelText('Name')).getAttribute('value')).toBe(
      'Recuperar clientes inactivos',
    );
    expect(globalThis.location.pathname).toBe('/automations');
    expect(posts(backend, '/org_1/workflows')).toHaveLength(0);
  });

  it('offers no automation draft to a role that may not write workflows', async () => {
    open('/gia', undefined, ['gia.ask']);
    const chat = within(await screen.findByRole('region', { name: 'Talk to GIA' }));
    expect(chat.getByRole('button', { name: 'Send' })).toBeTruthy();
    expect(chat.queryByRole('button', { name: 'Prepare as an automation' })).toBeNull();
  });
});
