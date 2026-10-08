import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

/**
 * A workflow's schedule on its card (ADR-0185): a person with the three permissions of a standing
 * approval sets, changes and turns it off; anyone else only reads how it runs. The approval is
 * said plainly where it is given, and a schedule for an older version asks to be confirmed again.
 */

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const OWNER = ['workflow.read', 'plan.read', 'plan.create', 'approval.approve'];
const MANAGER = [...OWNER, 'workflow.manage'];

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
  permissions: readonly string[] = MANAGER,
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

/** The schedule as the API shows it, for the launch workflow at version 2. */
const DAILY_ON = {
  workflowId: 'wf-launch',
  status: 'on',
  recurrence: { frequency: 'daily', time: '09:00' },
  timeZone: 'America/Lima',
  workflowVersion: 2,
  confirmedBy: 'user-1',
  confirmedAt: '2026-10-05T12:00:00Z',
  nextRunAt: '2026-10-06T14:00:00.000Z',
  last: {
    occurrence: '2026-10-05T14:00:00.000Z',
    outcome: 'awaiting_person',
    at: '2026-10-05T14:00:01.000Z',
    planId: 'plan-1',
  },
  revision: 1,
  updatedAt: '2026-10-05T12:00:00Z',
};

const must = <T,>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
};
const card = (id: string) => within(must(document.getElementById(`workflow-${id}`)));

describe('A workflow schedule (ADR-0185)', () => {
  it('says a workflow never repeats, and a person with the approval permissions sets one', async () => {
    const backend = open();
    await screen.findByText('Lanzamiento');
    expect(await card('wf-launch').findByText(/It never repeats/)).toBeTruthy();

    fireEvent.click(card('wf-launch').getByRole('button', { name: 'Schedule' }));
    const form = within(document.querySelector('form.automations__schedule-form') as HTMLElement);
    // A weekly run on Monday and Thursday, at 18:30 of the business's time.
    fireEvent.change(form.getByLabelText('How often'), { target: { value: 'weekly' } });
    fireEvent.change(form.getByLabelText('Time'), { target: { value: '18:30' } });
    // Monday is the day a new weekly schedule starts with; Thursday is added.
    expect((form.getByRole('checkbox', { name: 'Monday' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(form.getByRole('checkbox', { name: 'Thursday' }));
    expect(form.getByText(/Saving it means this workflow is planned/)).toBeTruthy();
    fireEvent.click(form.getByRole('button', { name: 'Save schedule' }));

    expect(
      await card('wf-launch').findByText('Runs on Monday and Thursday at 18:30.', { exact: false }),
    ).toBeTruthy();
    const [saved] = backend.apiCalls().filter((c) => c.method === 'PUT');
    expect(saved?.url).toBe(`${API}/v1/organizations/org_1/workflows/wf-launch/schedule`);
    expect(JSON.parse(saved?.body ?? '{}')).toEqual({
      recurrence: { frequency: 'weekly', time: '18:30', weekdays: [1, 4] },
    });
    expect(
      screen.getByText('The schedule is saved. The workflow runs at the times shown.'),
    ).toBeTruthy();
  });

  it('shows what the last run did, and turns the schedule off', async () => {
    const backend = open((b) => {
      b.options.schedules.org_1 = { 'wf-launch': { ...DAILY_ON } };
    });
    await screen.findByText('Lanzamiento');
    expect(
      await card('wf-launch').findByText('Runs every day at 09:00.', { exact: false }),
    ).toBeTruthy();
    expect(
      card('wf-launch').getByText('The plan waits for your approval.', { exact: false }),
    ).toBeTruthy();

    fireEvent.click(card('wf-launch').getByRole('button', { name: 'Turn schedule off' }));
    expect(
      await card('wf-launch').findByText('Its schedule is off. Nothing runs on its own.'),
    ).toBeTruthy();
    expect(
      screen.getByText('The schedule is off. Nothing runs on its own until you turn it on again.'),
    ).toBeTruthy();
    expect(
      backend.apiCalls().filter((c) => c.method === 'POST' && c.url.endsWith('/schedule/off')),
    ).toHaveLength(1);
  });

  it('shows the schedule to a person who may not set it, without any control', async () => {
    open((b) => {
      b.options.schedules.org_1 = { 'wf-launch': { ...DAILY_ON } };
    }, OWNER);
    await screen.findByText('Lanzamiento');
    expect(
      await card('wf-launch').findByText('Runs every day at 09:00.', { exact: false }),
    ).toBeTruthy();
    expect(card('wf-launch').queryByRole('button', { name: 'Schedule' })).toBeNull();
    expect(card('wf-launch').queryByRole('button', { name: 'Change schedule' })).toBeNull();
    expect(card('wf-launch').queryByRole('button', { name: 'Turn schedule off' })).toBeNull();
  });

  it('asks for a schedule to be confirmed again when its version has changed', async () => {
    open((b) => {
      b.options.schedules.org_1 = { 'wf-launch': { ...DAILY_ON, workflowVersion: 1 } };
    });
    await screen.findByText('Lanzamiento');
    expect(
      await card('wf-launch').findByText(
        'It was confirmed for version 1. Save it again to confirm this version.',
      ),
    ).toBeTruthy();
  });

  it('marks a plan that a schedule made, and not one a person made', async () => {
    open((b) => {
      b.options.plans.org_1 = [
        {
          id: 'plan-scheduled',
          key: 'schedule-0000',
          status: 'completed',
          version: 1,
          createdAt: '2026-10-05T14:00:02.000Z',
          updatedAt: '2026-10-05T14:01:00.000Z',
          workflow: { id: 'wf-launch', version: 2, occurrence: '2026-10-05T14:00:00.000Z' },
          decision: {
            decision: 'approved',
            decidedBy: 'user-1',
            decidedAt: '2026-10-05T14:00:02.000Z',
            via: 'schedule',
          },
          current: {
            version: 1,
            digest: 'b'.repeat(64),
            request: { summary: 'Lanzamiento', objective: 'Lanzamiento' },
            steps: [],
            riskLevel: 'low',
            source: { kind: 'workflow', workflowId: 'wf-launch', workflowVersion: 2 },
          },
        },
      ];
    });
    const plans = within(await screen.findByRole('region', { name: 'Plans' }));
    expect(await plans.findByText(/Scheduled run/)).toBeTruthy();
  });

  it('says why a schedule was not saved, and keeps the form open', async () => {
    open();
    await screen.findByText('Borrador de ventas');
    const draft = card('wf-draft');
    fireEvent.click(await draft.findByRole('button', { name: 'Schedule' }));
    const form = within(document.querySelector('form.automations__schedule-form') as HTMLElement);
    fireEvent.click(form.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByText('This workflow is not active.')).toBeTruthy();
    expect(form.getByRole('button', { name: 'Save schedule' })).toBeTruthy();
  });
});
