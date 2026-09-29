import { catalogs, I18nProvider, pseudoLocalizeCatalog } from '@melonoffice/i18n';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { REFRESH_KEY } from '../identity/session.js';
import { parseRoute, paths } from '../shell/routes.js';
import { agentsOf, lookOf, officeDepartments, officeSlug, DEFAULT_LOOK } from './departments.js';
import type { DepartmentView, SpecialistView } from './officeClient.js';
import { navigateInto, ROOM_TRANSITION } from './transition.js';
import {
  agentAt,
  arrangeSeats,
  layoutOf,
  MAX_SEATS,
  presenceOf,
  roomSeats,
  seatAgents,
} from './workstations.js';

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const path = () => globalThis.location.pathname;

/** A signed-in session (resumed after a reload), opened at `at`. */
function open(
  at = '/',
  configure?: (backend: ReturnType<typeof fakeBackend>) => void,
  pseudo = false,
) {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en" {...(pseudo ? { messages: pseudoLocalizeCatalog(catalogs.en) } : {})}>
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const rooms = async () => within(await screen.findByLabelText("Your office's departments"));
const back = () =>
  act(() => {
    globalThis.history.back();
  });

const department = (
  typeId: string | null,
  extra: Partial<DepartmentView> = {},
): DepartmentView => ({
  id: `org_1_${typeId ?? 'custom'}`,
  origin: typeId === null ? 'custom' : 'catalog',
  typeId,
  nameKey: typeId === null ? null : `department.${typeId}.name`,
  shortNameKey: typeId === null ? null : `department.${typeId}.short`,
  name: typeId === null ? 'Legal' : null,
  status: 'active',
  description: null,
  ...extra,
});

describe('routes (ADR-0040)', () => {
  it.each([
    ['/', { kind: 'home' }],
    ['/home', { kind: 'home' }],
    ['/conversations', { kind: 'conversations' }],
    ['/gia', { kind: 'gia' }],
    ['/settings/connections', { kind: 'connections' }],
    ['/settings', { kind: 'not_found' }],
    ['/office/marketing', { kind: 'office', slug: 'marketing' }],
    ['/office/design-video/', { kind: 'office', slug: 'design-video' }],
    ['/office/marketing/agent/spec_1', { kind: 'agent', slug: 'marketing', agentId: 'spec_1' }],
    ['/office', { kind: 'not_found' }],
    ['/office/Marketing', { kind: 'not_found' }],
    ['/office/marketing/tasks', { kind: 'not_found' }],
    ['/office/marketing/agent/', { kind: 'not_found' }],
    ['/office/../admin', { kind: 'not_found' }],
    ['/anything', { kind: 'not_found' }],
  ])('%s is %j', (at, route) => {
    expect(parseRoute(at)).toEqual(route);
  });

  it('builds every path from one place', () => {
    expect(paths.office('design-video')).toBe('/office/design-video');
    expect(paths.agent('marketing', 'spec 1')).toBe('/office/marketing/agent/spec%201');
  });
});

describe('the departments of the office', () => {
  it('come from the catalogue: headquarters on top, archived ones left out, unknown ones kept', () => {
    const { headquarters, floor } = officeDepartments([
      department('marketing'),
      department('leadership'),
      department('finance', { status: 'archived' }),
      department('legal_and_hr'),
      department(null),
    ]);
    expect(headquarters.map((d) => d.typeId)).toEqual(['leadership']);
    expect(floor.map((d) => d.typeId)).toEqual(['marketing', 'legal_and_hr', null]);
    expect(lookOf(department('legal_and_hr'))).toBe(DEFAULT_LOOK);
    expect(officeSlug(department('design_video'))).toBe('design-video');
    expect(officeSlug(department(null))).toBe('custom-org-1-custom');
  });

  it('say only what the agents’ records say: active, paused, or nobody', () => {
    const marketing = department('marketing');
    const spec = (status: string, departmentId = marketing.id) =>
      ({ id: status, departmentId, displayName: status, status }) as never;
    expect(agentsOf(marketing, [])).toEqual({ active: 0, paused: 0, state: undefined });
    expect(agentsOf(marketing, [spec('active'), spec('paused'), spec('draft')])).toEqual({
      active: 1,
      paused: 1,
      state: 'available',
    });
    expect(agentsOf(marketing, [spec('paused'), spec('active', 'other')]).state).toBe('paused');
  });
});

describe('the Home (ADR-0040)', () => {
  it('shows the six departments as rooms (ADR-0047): Board on top, Finance on its own, no Design', async () => {
    open('/');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your office is ready to work' }),
    ).toBeTruthy();
    const office = await rooms();
    const links = await office.findAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/office/leadership',
      '/office/operations',
      '/office/sales',
      '/office/marketing',
      '/office/research',
      '/office/finance',
    ]);
    expect(
      office.getByRole('link', {
        name: 'Enter Board. No agents yet. 0 of 4 workstations taken',
      }),
    ).toBeTruthy();
    expect(
      office.getByRole('link', { name: 'Enter Finance. No agents yet. 0 of 4 workstations taken' }),
    ).toBeTruthy();
    // The sidebar lists the same rooms apart from the tools.
    const officeNav = screen.getByRole('navigation', { name: 'Office' });
    expect(
      within(officeNav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Home',
      'GIA',
      'Company memory',
      'Board',
      'Operations',
      'Commercial',
      'Marketing',
      'Research',
      'Finance',
    ]);
    // The tools: Communications, the AI Command Center and Agents; the rest are coming. The business lives in the company
    // memory, next to the rooms (ADR-0056).
    expect(
      within(screen.getByRole('navigation', { name: 'Tools' }))
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/conversations', '/command-center', '/agents']);
  });

  it('enters a department’s office on click, and comes back by the breadcrumb or the browser', async () => {
    open('/');
    fireEvent.click((await rooms()).getByRole('link', { name: /^Enter Marketing/ }));
    const title = await screen.findByRole('heading', { level: 1, name: 'Marketing' });
    expect(path()).toBe('/office/marketing');
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(screen.getByRole('navigation', { name: 'Where you are' })).toBeTruthy();
    expect(
      screen.getByText('This department has no agents yet. They appear here once they are set up.'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('navigation', { name: 'Office' }))
        .getByRole('link', { name: 'Marketing' })
        .getAttribute('aria-current'),
    ).toBe('page');

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Where you are' })).getByRole('link', {
        name: 'Office',
      }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your office is ready to work' }),
    ).toBeTruthy();
    expect(path()).toBe('/');

    fireEvent.click((await rooms()).getByRole('link', { name: /^Enter Finance/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Finance' })).toBeTruthy();
    back();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your office is ready to work' }),
    ).toBeTruthy();
  });

  it('opens a department’s office directly, as after a refresh, and refuses one that does not exist', async () => {
    open('/office/marketing');
    expect(await screen.findByRole('heading', { level: 1, name: 'Marketing' })).toBeTruthy();
    cleanup();
    // Design & Video is retired into Marketing (ADR-0047): a new organization has no such room.
    open('/office/design-video');
    expect(await screen.findByRole('heading', { name: 'This place does not exist' })).toBeTruthy();
    cleanup();
    open('/office/legal');
    expect(await screen.findByRole('heading', { name: 'This place does not exist' })).toBeTruthy();
  });

  it('shows real agents only: counts, states and their places, from their records', async () => {
    open('/', (backend) => {
      backend.options.specialists.org_1 = [
        { id: 'spec_ana', name: 'Ana Campañas', type: 'marketing', status: 'active' },
        { id: 'spec_leo', name: 'Leo Contenidos', type: 'marketing', status: 'active' },
        { id: 'spec_eva', name: 'Eva Cuentas', type: 'finance', status: 'paused' },
        { id: 'spec_old', name: 'Old Draft', type: 'finance', status: 'draft' },
      ];
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your office is already working' }),
    ).toBeTruthy();
    const office = await rooms();
    expect(
      office.getByRole('link', {
        name: 'Enter Marketing. 2 active agents. 2 of 6 workstations taken',
      }),
    ).toBeTruthy();
    // The draft agent has a workstation too: it is part of the team, offline.
    expect(
      office.getByRole('link', {
        name: 'Enter Finance. 1 paused agent. 2 of 4 workstations taken',
      }),
    ).toBeTruthy();
    expect(document.querySelector('.topbar__agents')?.textContent).toBe('2 active agents');

    fireEvent.click(office.getByRole('link', { name: /^Enter Marketing/ }));
    const agent = await screen.findByRole('link', {
      name: 'Ana Campañas. Available. Workstation 1',
    });
    expect(agent.getAttribute('href')).toBe('/office/marketing/agent/spec_ana');
    expect(screen.queryByText('Eva Cuentas')).toBeNull();
    fireEvent.click(agent);
    expect(await screen.findByRole('heading', { level: 1, name: 'Ana Campañas' })).toBeTruthy();
    expect(screen.getByText("Coming to this agent's workspace")).toBeTruthy();
    // An agent is only found in its own department.
    cleanup();
    open('/office/finance/agent/spec_ana', (backend) => {
      backend.options.specialists.org_1 = [
        { id: 'spec_ana', name: 'Ana', type: 'marketing', status: 'active' },
      ];
    });
    expect(await screen.findByRole('heading', { name: 'This place does not exist' })).toBeTruthy();
  });

  it('shows the real credit balance and plan, offers no upgrade, and shows no example data', async () => {
    open('/');
    const credits = await screen.findByRole('region', { name: 'Credit use' });
    expect(await within(credits).findByText('498')).toBeTruthy();
    expect(within(credits).queryByText('Example')).toBeNull();
    expect(await screen.findByText('Entrepreneur plan')).toBeTruthy();
    expect(screen.getByText('498 credits available')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /upgrade|improve/i })).toBeNull();
    // No panel shows example data: meetings wait for a calendar connection.
    expect(screen.queryByText('Example')).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Upcoming meetings' })).getByText(
        /No calendar is connected yet/,
      ),
    ).toBeTruthy();
    // Activity is the audit trail's (ADR-0049), never an example.
    expect(
      within(screen.getByRole('region', { name: 'Recent activity' })).queryByText('Example'),
    ).toBeNull();
  });

  it('reads nothing the role does not allow', async () => {
    const backend = open('/', (b) => {
      b.options.permissions = ['organization.read', 'department.read'];
    });
    await rooms();
    expect(screen.queryByRole('region', { name: 'Credit use' })).toBeNull();
    const reads = backend.apiCalls().map((call) => call.url);
    expect(reads.some((url) => /specialists|credits|billing|activity/.test(url))).toBe(false);
  });

  it('sends the bar to GIA and continues the chat in her Workplace (ADR-0052)', async () => {
    const backend = open('/');
    await rooms();
    fireEvent.change(screen.getByRole('textbox', { name: 'Tell GIA what you need…' }), {
      target: { value: '¿Qué pasó hoy?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to GIA' }));
    expect(await screen.findByText('Hoy no hubo actividad en tu oficina.')).toBeTruthy();
    expect(globalThis.location.pathname).toBe('/gia');
    const call = backend.apiCalls().find((c) => c.url.endsWith('/gia/messages'));
    expect(JSON.parse(call?.body ?? '{}')).toMatchObject({
      message: '¿Qué pasó hoy?',
      locale: 'en',
      history: [],
    });
  });

  it('keeps GIA honest: without permission the bar says so and calls nothing', async () => {
    const backend = open('/', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'gia.ask');
    });
    await rooms();
    const before = backend.apiCalls().length;
    fireEvent.change(screen.getByRole('textbox', { name: 'Tell GIA what you need…' }), {
      target: { value: 'Prepara el informe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to GIA' }));
    expect(screen.getByRole('status').textContent).toBe('GIA is not available for your role.');
    expect(backend.apiCalls().length).toBe(before);
  });

  it('searches the office and goes where the person chose', async () => {
    open('/');
    await rooms();
    const search = screen.getByRole('searchbox', { name: 'Search for a department or agent…' });
    fireEvent.change(search, { target: { value: 'fin' } });
    expect(
      within(screen.getByRole('list', { name: 'Search results' }))
        .getByRole('link', { name: /Finance/ })
        .getAttribute('href'),
    ).toBe('/office/finance');
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Finance' })).toBeTruthy();
  });

  it('shows no hard-coded text on the Home: every word comes from the catalog', async () => {
    open('/', undefined, true);
    await screen.findAllByRole('link');
    await waitFor(() => expect(document.querySelectorAll('.zone').length).toBe(6));
    const home = document.querySelector('.home');
    const texts = [...(home?.querySelectorAll('h1, h2, p, label, button, .zone__name') ?? [])]
      .map((element) => element.textContent?.trim() ?? '')
      .filter((text) => text !== '' && !/^[\d.,]+$/.test(text));
    expect(texts.length).toBeGreaterThan(10);
    for (const text of texts) expect(text, text).toMatch(/^\[.*\]$/);
  });
});

describe('the phone menu', () => {
  it('opens the sidebar as a drawer and closes it with Escape or by going somewhere', async () => {
    open('/');
    await rooms();
    const menu = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('app-sidebar')?.className).toContain('sidebar--open');
    fireEvent.keyDown(globalThis.window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Open menu' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Office' })).getByRole('link', {
        name: 'Research',
      }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Research' })).toBeTruthy();
    expect(document.getElementById('app-sidebar')?.className).not.toContain('sidebar--open');
  });
});

describe('entering a room', () => {
  it('uses a view transition, naming the room so it grows into the office', () => {
    const update: (() => void)[] = [];
    const start = vi.fn((fn: () => void) => update.push(fn));
    Object.assign(document, { startViewTransition: start });
    const room = document.createElement('span');
    navigateInto('/office/marketing', room);
    expect(start).toHaveBeenCalledTimes(1);
    expect(room.style.viewTransitionName).toBe(ROOM_TRANSITION);
    update[0]?.();
    expect(path()).toBe('/office/marketing');
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });

  it('just navigates when the person asked for reduced motion', () => {
    const start = vi.fn();
    Object.assign(document, { startViewTransition: start });
    const matchMedia = vi.fn(() => ({ matches: true }));
    vi.stubGlobal('matchMedia', matchMedia);
    navigateInto('/office/finance');
    expect(start).not.toHaveBeenCalled();
    expect(path()).toBe('/office/finance');
    vi.unstubAllGlobals();
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });
});

const agent = (
  id: string,
  departmentId: string,
  status: SpecialistView['status'] = 'active',
): SpecialistView => ({ id, departmentId, displayName: id, status });

describe('workstations (ADR-0041)', () => {
  it('lay out each department from its (provisional) seat count, never more than a room holds', () => {
    expect(layoutOf(department('marketing')).seats).toBe(6);
    expect(layoutOf(department('operations')).seats).toBe(8);
    expect(layoutOf(department(null)).seats).toBe(4);
    for (const count of [1, 4, 5, 6, 10, 11, MAX_SEATS]) {
      const seats = arrangeSeats(count);
      expect(seats).toHaveLength(count);
      for (const { x, y } of seats) {
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(1);
        expect(y).toBeGreaterThan(0.62);
        expect(y).toBeLessThan(1);
      }
    }
    expect(new Set(arrangeSeats(5).map((seat) => seat.row)).size).toBe(1);
    expect(new Set(arrangeSeats(8).map((seat) => seat.row)).size).toBe(2);
  });

  it('keep every seat when nobody sits there: an empty department has only free workstations', () => {
    const seating = seatAgents(department('marketing'), []);
    expect(seating.workstations.map((w) => [w.number, agentAt(w)])).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => [n, null]),
    );
    expect(seating.occupied).toBe(0);
    expect(seating.unseated).toEqual([]);
  });

  it('seat only the department’s own agents, in a stable order, and keep the rest visible', () => {
    const marketing = department('marketing');
    const seating = seatAgents(marketing, [
      agent('b', marketing.id),
      agent('a', marketing.id, 'paused'),
      agent('gone', marketing.id, 'archived'),
      agent('elsewhere', 'org_1_finance'),
      // Another organization's agent, even for a department of the same type, never sits here.
      agent('intruder', 'org_other_marketing'),
    ]);
    expect(seating.workstations.map(agentAt)).toEqual(['a', 'b', null, null, null, null]);
    expect(seating.occupied).toBe(2);
    expect(seating.workstations[0]?.id).toBe('org_1_marketing:seat-1');

    const full = seatAgents(department('research'), [
      ...['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => agent(id, 'org_1_research')),
    ]);
    expect(full.occupied).toBe(4);
    expect(full.unseated.map((a) => a.id)).toEqual(['r5']);
  });

  it('say only what the record says: never working, never an activity', () => {
    expect(presenceOf(agent('a', 'd'), 'd:seat-1')).toEqual({
      agentId: 'a',
      workstationId: 'd:seat-1',
      state: 'available',
      activity: null,
      updatedAt: null,
      source: 'record',
    });
    expect(presenceOf(agent('a', 'd', 'paused'), null).state).toBe('paused');
    expect(presenceOf(agent('a', 'd', 'draft'), null).state).toBe('offline');
    expect(presenceOf(agent('a', 'd', 'disabled'), null).state).toBe('offline');
  });
});

describe('ambient figures (ADR-0042)', () => {
  const kinds = (seating: ReturnType<typeof seatAgents>) =>
    seating.workstations.map((w) => w.occupant?.kind ?? 'free');

  it('fill some desks of an office with no agents, and always leave desks free', () => {
    const seating = seatAgents(department('marketing'), []);
    expect(kinds(seating)).toEqual(['ambient', 'ambient', 'free', 'ambient', 'free', 'free']);
    expect(seating.workstations[0]?.occupant).toEqual({ kind: 'ambient', visualId: 'ambient-1' });
    // An ambient figure is nobody: it seats no agent and counts for nothing.
    expect(seating.workstations.map(agentAt)).toEqual([null, null, null, null, null, null]);
    expect(seating.occupied).toBe(0);
    for (const typeId of ['leadership', 'operations', 'sales', 'research', 'finance', null]) {
      const layout = layoutOf(department(typeId));
      expect(layout.ambient.length).toBeGreaterThan(0);
      expect(layout.ambient.length).toBeLessThan(layout.seats);
    }
  });

  it('give way to a real agent: a desk never shows both', () => {
    const marketing = department('marketing');
    const seating = seatAgents(marketing, [agent('a', marketing.id)]);
    expect(seating.workstations[0]?.occupant).toEqual({ kind: 'agent', agentId: 'a' });
    expect(kinds(seating)).toEqual(['agent', 'ambient', 'free', 'ambient', 'free', 'free']);
    const drawn = roomSeats(seating, [agent('a', marketing.id)]).map((seat) => seat.occupant);
    expect(drawn).toEqual(['present', 'ambient', null, 'ambient', null, null]);
  });

  it('never come from another organization or department', () => {
    const marketing = department('marketing');
    const seating = seatAgents(marketing, [
      agent('elsewhere', 'org_1_finance'),
      agent('intruder', 'org_other_marketing'),
    ]);
    expect(kinds(seating)).toEqual(['ambient', 'ambient', 'free', 'ambient', 'free', 'free']);
  });

  it('are drawn only as decoration, the same on the Home and in the office', async () => {
    open('/');
    await waitFor(() => expect(document.querySelectorAll('.zone').length).toBe(6));
    const marketingZone = [...document.querySelectorAll('.zone')].find((zone) =>
      zone.querySelector('a[href="/office/marketing"]'),
    );
    const onHome = marketingZone?.querySelectorAll('.room__worker--ambient').length;
    expect(onHome).toBe(layoutOf(department('marketing')).ambient.length);
    for (const figure of document.querySelectorAll('.room__worker')) {
      expect(figure.closest('[aria-hidden="true"]')).not.toBeNull();
    }
    cleanup();

    open('/office/marketing');
    const seats = within(await screen.findByRole('list', { name: 'Workstations' }));
    await waitFor(() =>
      expect(document.querySelectorAll('.dept-office__room .room__worker--ambient').length).toBe(
        onHome,
      ),
    );
    // No ambient figure is a link, a name, a state or an activity.
    expect(seats.queryAllByRole('link')).toHaveLength(0);
    expect(document.querySelectorAll('.room__worker--agent')).toHaveLength(0);
    expect(document.querySelectorAll('.seat--ambient')).toHaveLength(onHome ?? -1);
    for (const word of ['Working', 'Analyzing', 'Writing', 'Processing', 'Paused', 'Offline']) {
      expect(seats.queryByText(word)).toBeNull();
    }
    expect(screen.queryByText('Working')).toBeNull();
    // Their desks are still free workstations, with the same options as any other.
    const ambientDesk = seats.getByRole('button', { name: 'Workstation 1. Available workstation' });
    fireEvent.click(ambientDesk);
    expect(screen.getByRole('dialog', { name: 'Workstation 1' })).toBeTruthy();
  });

  it('only breathe when motion is welcome, and phones keep the workstation cards', () => {
    const officeCss = readFileSync(`${import.meta.dirname}/../office.css`, 'utf8');
    const block = (query: string) => {
      const start = officeCss.indexOf(`@media ${query}`);
      expect(start).toBeGreaterThan(-1);
      let depth = 0;
      for (let i = officeCss.indexOf('{', start); i < officeCss.length; i += 1) {
        if (officeCss[i] === '{') depth += 1;
        if (officeCss[i] === '}' && (depth -= 1) === 0) return officeCss.slice(start, i + 1);
      }
      return '';
    };
    const motion = block('(prefers-reduced-motion: no-preference)');
    expect(motion).toContain('.room__breath');
    expect(motion).toContain('.room__presence');
    // Outside that block, nothing animates the figures.
    const rest = officeCss.replace(motion, '');
    expect(rest).not.toMatch(/\.room__(breath|presence|worker)[^{]*\{[^}]*animation/);
    expect(block('(max-width: 40rem)')).toContain('.seat');
  });

  it('count for nothing: the seat counters and the agent counts stay real', async () => {
    const zoneOf = (slug: string) =>
      [...document.querySelectorAll('.zone')].find((zone) =>
        zone.querySelector(`a[href="/office/${slug}"]`),
      );
    open('/');
    await waitFor(() => expect(document.querySelectorAll('.zone').length).toBe(6));
    expect(zoneOf('marketing')?.querySelector('.zone__seats')?.textContent).toBe('0/6');
    cleanup();

    open('/', (backend) => {
      backend.options.specialists.org_1 = [
        { id: 'spec_ana', name: 'Ana Campañas', type: 'marketing', status: 'active' },
      ];
    });
    await waitFor(() =>
      expect(zoneOf('marketing')?.querySelector('.zone__seats')?.textContent).toBe('1/6'),
    );
    // Two figures still decorate the room; neither is counted.
    expect(zoneOf('marketing')?.querySelectorAll('.room__worker--ambient')).toHaveLength(2);
  });

  it('carry no presence, state or focus of their own', async () => {
    open('/office/marketing');
    await screen.findByRole('list', { name: 'Workstations' });
    const figures = document.querySelectorAll('.room__worker--ambient');
    expect(figures.length).toBeGreaterThan(0);
    for (const figure of figures) {
      expect(figure.querySelector('.room__presence')).toBeNull();
      expect(figure.querySelector('a, button, [tabindex], title, text')).toBeNull();
      expect(figure.getAttribute('aria-label')).toBeNull();
    }
  });

  it('are replaced in the office by a real agent, which stays a link to its profile', async () => {
    open('/office/marketing', (backend) => {
      backend.options.specialists.org_1 = [
        { id: 'spec_ana', name: 'Ana Campañas', type: 'marketing', status: 'active' },
      ];
    });
    const link = await screen.findByRole('link', {
      name: 'Ana Campañas. Available. Workstation 1',
    });
    expect(link.closest('.seat')?.classList.contains('seat--ambient')).toBe(false);
    expect(document.querySelectorAll('.dept-office__room .room__worker--agent')).toHaveLength(1);
    expect(document.querySelectorAll('.dept-office__room .room__worker--ambient')).toHaveLength(2);
    fireEvent.click(link);
    await screen.findByRole('heading', { level: 1, name: 'Ana Campañas' });
    expect(path()).toBe('/office/marketing/agent/spec_ana');
  });
});

describe('a department’s workstations (ADR-0041)', () => {
  const team = (backend: ReturnType<typeof fakeBackend>) => {
    backend.options.specialists.org_1 = [
      {
        id: 'spec_ana',
        name: 'Ana Campañas',
        type: 'marketing',
        status: 'active',
        purpose: 'Content lead',
      },
      { id: 'spec_leo', name: 'Leo Contenidos', type: 'marketing', status: 'paused' },
    ];
    backend.options.specialists.org_other = [
      { id: 'spec_zed', name: 'Zed Otro', type: 'marketing', status: 'active' },
    ];
  };

  it('shows every workstation, taken or free, and only this organization’s agents', async () => {
    open('/office/marketing', team);
    const seats = within(await screen.findByRole('list', { name: 'Workstations' }));
    expect(seats.getAllByRole('listitem')).toHaveLength(6);
    expect(
      await seats.findByRole('link', {
        name: 'Ana Campañas. Content lead. Available. Workstation 1',
      }),
    ).toBeTruthy();
    expect(seats.getByRole('link', { name: 'Leo Contenidos. Paused. Workstation 2' })).toBeTruthy();
    expect(
      seats.getAllByRole('button', { name: /^Workstation \d\. Available workstation$/ }),
    ).toHaveLength(4);
    expect(screen.queryByText('Zed Otro')).toBeNull();
    expect(screen.getByText('1 active agent · 2 of 6 workstations taken')).toBeTruthy();
    // Each workstation sits on its desk in the drawing.
    for (const item of seats.getAllByRole('listitem')) {
      const x = Number(item.style.getPropertyValue('--seat-x'));
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('opens a free workstation’s options, all still to come, and closes them with Escape', async () => {
    open('/office/marketing', team);
    const free = await screen.findByRole('button', {
      name: 'Workstation 3. Available workstation',
    });
    expect(free.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(free);
    const panel = screen.getByRole('dialog', { name: 'Workstation 3' });
    expect(free.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(panel).getByRole('heading', { level: 3 })),
    );
    for (const action of ['Assign an agent', 'Move workstation', 'Remove workstation']) {
      const button = within(panel).getByRole('button', { name: new RegExp(`^${action}`) });
      expect(button.getAttribute('aria-disabled')).toBe('true');
    }
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(free));
  });

  it('opens the agent from its workstation: a profile with no invented work', async () => {
    const backend = open('/office/marketing', team);
    fireEvent.click(
      await screen.findByRole('link', {
        name: 'Ana Campañas. Content lead. Available. Workstation 1',
      }),
    );
    const title = await screen.findByRole('heading', { level: 1, name: 'Ana Campañas' });
    expect(path()).toBe('/office/marketing/agent/spec_ana');
    await waitFor(() => expect(document.activeElement).toBe(title));
    const profile = within(screen.getByRole('region', { name: 'Profile' }));
    expect(profile.getByText('Content lead')).toBeTruthy();
    expect(profile.getByText('Workstation 1')).toBeTruthy();
    expect(profile.getByText('Available')).toBeTruthy();
    const work = within(screen.getByRole('region', { name: 'Work' }));
    for (const none of ['No activity available', 'No activity recorded', 'No projects']) {
      expect(work.getByText(none)).toBeTruthy();
    }
    // Its tasks (ADR-0063) are read from the API: none yet, and none invented.
    const tasks = within(screen.getByRole('region', { name: 'Tasks' }));
    expect(await tasks.findByText('No tasks yet.')).toBeTruthy();
    expect(screen.queryByText('Working')).toBeNull();
    // Reading the profile only reads.
    expect(
      backend.apiCalls().every((call) => call.method === 'GET' || call.url.endsWith('/v1/me')),
    ).toBe(true);
  });

  it('keeps agents without a free workstation in the office', async () => {
    open('/office/research', (backend) => {
      backend.options.specialists.org_1 = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => ({
        id,
        name: `Agent ${id}`,
        type: 'research',
        status: 'active',
      }));
    });
    const section = within(
      await screen.findByRole('region', { name: 'Agents without a workstation' }),
    );
    expect(section.getByRole('link', { name: 'Open Agent r5' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Agent r4. Available. Workstation 4' })).toBeTruthy();
  });

  it('shows an agent with no role and no seat for what it is', async () => {
    open('/office/research/agent/r5', (backend) => {
      backend.options.specialists.org_1 = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => ({
        id,
        name: `Agent ${id}`,
        type: 'research',
        status: id === 'r5' ? 'draft' : 'active',
      }));
    });
    const profile = within(await screen.findByRole('region', { name: 'Profile' }));
    expect(profile.getByText('Not defined yet')).toBeTruthy();
    expect(profile.getByText('No workstation')).toBeTruthy();
    expect(profile.getByText('Offline')).toBeTruthy();
  });
});
