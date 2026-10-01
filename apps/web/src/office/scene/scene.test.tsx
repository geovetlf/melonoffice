import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App.js';
import { createServices } from '../../identity/services.js';
import { REFRESH_KEY } from '../../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../../identity/testing.js';
import type { AgentTaskView } from '../agentTasksClient.js';
import type { DepartmentView } from '../officeClient.js';
import { workStateOf } from './agentWork.js';
import { buildingFloors, MIN_FLOORS } from './layout.js';
import { handOffs } from './motor.js';

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

function open(configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
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

const department = (typeId: string): DepartmentView => ({
  id: `org_1_${typeId}`,
  origin: 'catalog',
  typeId,
  nameKey: `department.${typeId}.name`,
  shortNameKey: `department.${typeId}.short`,
  name: null,
  status: 'active',
  description: null,
});

const task = (status: string, extra: Partial<AgentTaskView> = {}): AgentTaskView =>
  ({
    id: `t-${status}`,
    specialistId: 'a',
    request: 'Review this week’s leads',
    createdAt: '2026-09-30T10:00:00Z',
    status,
    failure: null,
    completedAt: null,
    answer: null,
    ...extra,
  }) as AgentTaskView;

describe('the building (Home V4)', () => {
  it('puts the departments either side of Consejo, GIA and MelonMotor, in the reference order', () => {
    const floors = buildingFloors(
      ['operations', 'sales', 'marketing', 'research', 'finance'].map(department),
    );
    expect(floors).toHaveLength(MIN_FLOORS);
    expect(floors.map((floor) => floor.centre)).toEqual(['headquarters', 'gia', 'motor']);
    expect(
      floors.flatMap((floor) =>
        [floor.left, floor.right].map((room) =>
          room.kind === 'department' ? room.department.typeId : room.kind,
        ),
      ),
    ).toEqual(['sales', 'operations', 'marketing', 'finance', 'research', 'meeting']);
  });

  it('grows a floor for every two more departments, so no department is left out', () => {
    const many = Array.from({ length: 9 }, (_, i) => department(`custom_${i}`));
    const floors = buildingFloors(many);
    expect(floors).toHaveLength(5);
    expect(floors.slice(3).every((floor) => floor.centre === 'lounge')).toBe(true);
    expect(
      floors.flatMap((f) => [f.left, f.right]).filter((r) => r.kind === 'department'),
    ).toHaveLength(9);
    // An office with no departments still has Consejo's room, GIA and MelonMotor.
    expect(buildingFloors([]).map((floor) => floor.centre)).toEqual([
      'headquarters',
      'gia',
      'motor',
    ]);
  });
});

describe('an agent’s state (Home V4)', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const active = { status: 'active' as const };

  it('comes from its record first: paused, offline, archived', () => {
    expect(workStateOf({ status: 'paused' }, task('running'), now)).toBe('paused');
    expect(workStateOf({ status: 'draft' }, undefined, now)).toBe('offline');
    expect(workStateOf({ status: 'disabled' }, undefined, now)).toBe('offline');
    expect(workStateOf({ status: 'archived' }, undefined, now)).toBeUndefined();
  });

  it('then from its latest task, never invented: no task is simply available', () => {
    expect(workStateOf(active, undefined, now)).toBe('available');
    expect(workStateOf(active, null, now)).toBe('available');
    for (const status of ['planning', 'running', 'verifying', 'retrying']) {
      expect(workStateOf(active, task(status), now), status).toBe('working');
    }
    expect(workStateOf(active, task('pending'), now)).toBe('waiting');
    expect(workStateOf(active, task('waiting_approval'), now)).toBe('attention');
    expect(workStateOf(active, task('completed'), now)).toBe('available');
    expect(workStateOf(active, task('cancelled'), now)).toBe('available');
  });

  it('asks for attention when a follow-up it proposed waits, or it failed in the last day', () => {
    const waiting = task('completed', {
      answer: {
        answer: 'Done',
        missing: [],
        followUp: {
          contactId: null,
          contactName: null,
          type: 'call',
          title: 'Call',
          date: '2026-10-01',
          time: '10:00',
          state: 'waiting_approval',
          approvalId: 'ap1',
        },
      },
    });
    expect(workStateOf(active, waiting, now)).toBe('attention');
    expect(workStateOf(active, task('failed', { completedAt: '2026-09-30T08:00:00Z' }), now)).toBe(
      'attention',
    );
    expect(workStateOf(active, task('failed', { completedAt: '2026-09-27T08:00:00Z' }), now)).toBe(
      'available',
    );
  });
});

describe('MelonMotor’s flows', () => {
  it('are the hand-offs of a workflow’s steps from one department to another', () => {
    const step = (id: string, department: string | null) => ({
      id,
      kind: 'specialist',
      label: id,
      dependsOn: [],
      assignee: department === null ? null : { departmentTypeId: department, roleId: 'r' },
      approvalRequired: false,
    });
    expect(
      handOffs([
        step('a', 'research'),
        step('b', 'research'),
        step('c', 'marketing'),
        step('d', null),
        step('e', 'sales'),
      ]),
    ).toEqual([
      ['research', 'marketing'],
      ['marketing', 'sales'],
    ]);
    expect(handOffs([])).toEqual([]);
  });
});

describe('the Home’s office (Home V4)', () => {
  const agents = (backend: ReturnType<typeof fakeBackend>) => {
    backend.options.specialists.org_1 = [
      { id: 'spec_ana', name: 'Ana Ventas', type: 'sales', status: 'active', purpose: 'Leads' },
      { id: 'spec_leo', name: 'Leo Campañas', type: 'marketing', status: 'active' },
      { id: 'spec_eva', name: 'Eva Cuentas', type: 'finance', status: 'paused' },
    ];
    backend.options.agentTasks.spec_ana = [
      {
        id: 'task-1',
        specialistId: 'spec_ana',
        request: 'Review this week’s leads',
        createdAt: '2026-09-30T10:00:00Z',
        status: 'running',
        failure: null,
        completedAt: null,
        answer: null,
      },
    ];
  };

  it('shows each agent at its desk with its real state and work, and opens its card', async () => {
    open(agents);
    const ana = await screen.findByRole('button', {
      name: 'Ana Ventas, Working. Review this week’s leads. Open their card',
    });
    expect(
      screen.getByRole('button', {
        name: 'Leo Campañas, Available. No work under way. Open their card',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'Eva Cuentas, Paused. No work under way. Open their card',
      }),
    ).toBeTruthy();
    // The room says what is under way, in the words it was asked.
    expect(
      screen.getByRole('link', {
        name: 'Enter Commercial. 1 active agent. 1 of 5 workstations taken. 1 working. Under way: Review this week’s leads',
      }),
    ).toBeTruthy();
    expect(screen.getByText('1 agent working')).toBeTruthy();

    fireEvent.click(ana);
    const card = screen.getByRole('dialog', { name: 'Ana Ventas' });
    expect(within(card).getByText('Commercial · Leads')).toBeTruthy();
    expect(within(card).getByText('Review this week’s leads')).toBeTruthy();
    expect(within(card).getByRole('list', { name: 'Task progress' })).toBeTruthy();
    // Seeing its work opens its place in the office (level 3).
    fireEvent.click(within(card).getByRole('button', { name: 'See work' }));
    expect(globalThis.location.pathname).toBe('/office/sales/agent/spec_ana');
  });

  it('closes the card with Escape and gives focus back to the agent', async () => {
    open(agents);
    const leo = await screen.findByRole('button', {
      name: 'Leo Campañas, Available. No work under way. Open their card',
    });
    fireEvent.click(leo);
    expect(screen.getByRole('dialog', { name: 'Leo Campañas' })).toBeTruthy();
    fireEvent.keyDown(globalThis.window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Leo Campañas' })).toBeNull();
    expect(document.activeElement).toBe(leo);
  });

  it('gives instructions through the agent’s tasks, only with specialist.task', async () => {
    const backend = open((b) => {
      agents(b);
      b.options.permissions.push('specialist.task');
    });
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Leo Campañas, Available. No work under way. Open their card',
      }),
    );
    const card = screen.getByRole('dialog', { name: 'Leo Campañas' });
    fireEvent.click(within(card).getByRole('button', { name: 'Give instructions' }));
    const box = await within(card).findByRole('textbox');
    fireEvent.change(box, { target: { value: 'Prepare the October campaign' } });
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(
        backend
          .apiCalls()
          .some(
            (call) => call.method === 'POST' && call.url.endsWith('/specialists/spec_leo/tasks'),
          ),
      ).toBe(true),
    );
    cleanup();
    open(agents);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Leo Campañas, Available. No work under way. Open their card',
      }),
    );
    expect(screen.queryByRole('button', { name: 'Give instructions' })).toBeNull();
  });

  it('reads no agent task without specialist.read, and every agent keeps its record state', async () => {
    const backend = open((b) => {
      agents(b);
      b.options.permissions = b.options.permissions.filter((p) => p !== 'specialist.read');
    });
    await screen.findByRole('group', { name: "Your office's departments" });
    expect(backend.apiCalls().some((call) => call.url.includes('/tasks'))).toBe(false);
    expect(screen.queryByRole('button', { name: /Open their card/ })).toBeNull();
  });

  it('opens GIA from her desk in headquarters', async () => {
    open(agents);
    fireEvent.click(
      await screen.findByRole('link', {
        name: 'GIA, online, coordinating 2 active agents. Open GIA',
      }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'GIA' })).toBeTruthy();
    expect(globalThis.location.pathname).toBe('/gia');
  });

  it('shows MelonMotor’s real flows: work under way and plans handing work between departments', async () => {
    open((b) => {
      agents(b);
      b.options.permissions.push('plan.read', 'workflow.read');
      b.options.workflows.org_1 = [
        {
          id: 'wf1',
          name: 'Launch',
          status: 'active',
          version: 1,
          updatedAt: '2026-09-30T10:00:00Z',
          steps: [
            {
              id: 's1',
              kind: 'specialist',
              label: 'Campaign',
              dependsOn: [],
              assignee: { departmentTypeId: 'marketing', roleId: 'r' },
            },
            {
              id: 's2',
              kind: 'specialist',
              label: 'Follow up',
              dependsOn: ['s1'],
              assignee: { departmentTypeId: 'sales', roleId: 'r' },
            },
          ],
        },
      ];
      b.options.plans.org_1 = [
        {
          id: 'plan-1',
          status: 'executing',
          version: 1,
          createdAt: '2026-09-30T10:00:00Z',
          current: {
            version: 1,
            digest: 'a'.repeat(64),
            request: { summary: 'October launch', objective: 'Launch' },
            steps: [],
            riskLevel: 'low',
            source: { kind: 'workflow', workflowId: 'wf1', workflowVersion: 1 },
          },
        },
      ];
    });
    const motor = await screen.findByRole('button', { name: 'MelonMotor: see the active flows' });
    fireEvent.click(motor);
    expect(motor.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('dialog', { name: 'MelonMotor' });
    expect(await within(panel).findByText('October launch')).toBeTruthy();
    expect(within(panel).getByText('1 task under way')).toBeTruthy();
    fireEvent.keyDown(globalThis.window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'MelonMotor' })).toBeNull();
  });

  it('says so when nothing moves, and draws no flow it cannot read', async () => {
    const backend = open();
    fireEvent.click(
      await screen.findByRole('button', { name: 'MelonMotor: see the active flows' }),
    );
    const panel = screen.getByRole('dialog', { name: 'MelonMotor' });
    expect(
      within(panel).getByText('Your role cannot see the plans that pass work between departments.'),
    ).toBeTruthy();
    expect(within(panel).getByText('No agent has a task under way right now.')).toBeTruthy();
    expect(backend.apiCalls().some((call) => call.url.includes('/plans'))).toBe(false);
  });

  it('still seats GIA and MelonMotor when the departments cannot be read', async () => {
    open((b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'department.read');
    });
    expect(await screen.findByRole('link', { name: /^GIA, online/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'MelonMotor: see the active flows' })).toBeTruthy();
    expect(document.querySelectorAll('.b-room--department')).toHaveLength(0);
  });

  it('fills the command box from a suggestion, and sends nothing until the person does', async () => {
    const backend = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Review my sales' }));
    expect(
      (
        screen.getByRole('textbox', {
          name: 'What do you need me to do for your business?',
        }) as HTMLInputElement
      ).value,
    ).toBe('Review my sales');
    expect(backend.apiCalls().some((call) => call.url.endsWith('/gia/messages'))).toBe(false);
  });

  it('on a computer, gives the building the whole width and puts the day below it', () => {
    const css = readFileSync(`${import.meta.dirname}/../../home.css`, 'utf8');
    const start = css.indexOf('@media (min-width: 64rem) {');
    expect(start).toBeGreaterThan(-1);
    const desk = css.slice(start, css.indexOf('/* A tablet', start));
    // One column: the building, then GIA's box, then the day's context in four columns.
    expect(desk).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(desk).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));');
    // The building is never scaled or cut to fit the window.
    expect(desk).not.toMatch(/transform:\s*scale|zoom:|100dvh/);
  });

  it('keeps its motion small and switches it off when the person asks for less', () => {
    const css = readFileSync(`${import.meta.dirname}/../../home.css`, 'utf8');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const name of [
      '.desk__breath',
      '.desk__lines rect',
      '.b-motor__mark',
      '.wall-screen__bar::after',
    ]) {
      expect(reduced).toContain(name);
    }
    // Motion is transform and opacity only.
    const keyframes = [...css.matchAll(/@keyframes[^{]+\{([\s\S]*?)\n\}/g)].map((m) => m[1] ?? '');
    for (const body of keyframes) {
      const properties = [...body.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
      for (const property of properties) {
        expect(['transform', 'opacity', 'filter']).toContain(property);
      }
    }
  });
});
