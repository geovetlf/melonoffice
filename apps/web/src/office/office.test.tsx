import { catalogs, I18nProvider, pseudoLocalizeCatalog } from '@melonoffice/i18n';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { REFRESH_KEY } from '../identity/session.js';
import { parseRoute, paths } from '../shell/routes.js';
import { agentsOf, lookOf, officeDepartments, officeSlug, DEFAULT_LOOK } from './departments.js';
import type { DepartmentView } from './officeClient.js';
import { navigateInto, ROOM_TRANSITION } from './transition.js';

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
  it('shows the seven D-11 departments as rooms: one Board & Management, Finance on its own', async () => {
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
      '/office/design-video',
      '/office/research',
      '/office/finance',
    ]);
    expect(
      office.getByRole('link', { name: 'Enter Board & Management. No agents yet' }),
    ).toBeTruthy();
    expect(office.getByRole('link', { name: 'Enter Finance. No agents yet' })).toBeTruthy();
    // The sidebar lists the same rooms apart from the tools.
    const officeNav = screen.getByRole('navigation', { name: 'Office' });
    expect(
      within(officeNav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Home',
      'GIA',
      'Board & Management',
      'Operations',
      'Commercial',
      'Marketing',
      'Design',
      'Research',
      'Finance',
    ]);
    expect(
      within(screen.getByRole('navigation', { name: 'Tools' })).getAllByRole('link'),
    ).toHaveLength(1);
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
    open('/office/design-video');
    expect(await screen.findByRole('heading', { level: 1, name: 'Design & Video' })).toBeTruthy();
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
    expect(office.getByRole('link', { name: 'Enter Marketing. 2 active agents' })).toBeTruthy();
    expect(office.getByRole('link', { name: 'Enter Finance. 1 paused agent' })).toBeTruthy();
    expect(document.querySelector('.topbar__agents')?.textContent).toBe('2 active agents');

    fireEvent.click(office.getByRole('link', { name: /^Enter Marketing/ }));
    const agent = await screen.findByRole('link', { name: 'Open Ana Campañas' });
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

  it('shows the real credit balance and plan, offers no upgrade, and marks examples as examples', async () => {
    open('/');
    const credits = await screen.findByRole('region', { name: 'Credit use' });
    expect(await within(credits).findByText('498')).toBeTruthy();
    expect(within(credits).queryByText('Example')).toBeNull();
    expect(await screen.findByText('Entrepreneur plan')).toBeTruthy();
    expect(screen.getByText('498 credits available')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /upgrade|improve/i })).toBeNull();
    for (const name of ["Today's tasks", 'Recent activity', 'Upcoming meetings']) {
      expect(within(screen.getByRole('region', { name })).getByText('Example')).toBeTruthy();
    }
  });

  it('reads nothing the role does not allow', async () => {
    const backend = open('/', (b) => {
      b.options.permissions = ['organization.read', 'department.read'];
    });
    await rooms();
    expect(screen.queryByRole('region', { name: 'Credit use' })).toBeNull();
    const reads = backend.apiCalls().map((call) => call.url);
    expect(reads.some((url) => /specialists|credits|billing/.test(url))).toBe(false);
  });

  it('keeps GIA honest: the bar says GIA is not connected yet and calls nothing', async () => {
    const backend = open('/');
    await rooms();
    const before = backend.apiCalls().length;
    fireEvent.change(screen.getByRole('textbox', { name: 'Tell GIA what you need…' }), {
      target: { value: 'Prepara el informe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to GIA' }));
    expect(screen.getByRole('status').textContent).toBe(
      'GIA is not connected to this bar yet. It arrives in a coming phase.',
    );
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
    await waitFor(() => expect(document.querySelectorAll('.zone').length).toBe(7));
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
