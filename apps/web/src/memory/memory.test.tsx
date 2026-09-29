import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { keyFor } from './memoryClient.js';

afterEach(cleanup);

const OWNER = ['knowledge.read', 'knowledge.propose', 'knowledge.manage', 'organization.update'];

function open(
  at: string,
  configure?: (backend: ReturnType<typeof fakeBackend>) => void,
  permissions: readonly string[] = OWNER,
) {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push(...permissions);
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const fact = (
  domain: string,
  key: string,
  value: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id: `org_1_${domain}_${key}`,
  domain,
  key,
  subject: null,
  label: null,
  value,
  verification: 'confirmed',
  status: 'active',
  sensitivity: 'internal',
  critical: false,
  needsConfirmation: false,
  source: { type: 'user', id: null, reference: null, recordedBy: 'you', confidence: null },
  effectiveFrom: '2026-09-28T12:00:00Z',
  effectiveUntil: null,
  revision: 1,
  updatedAt: '2026-09-28T12:00:00Z',
  openConflictId: null,
  ...extra,
});

const knowledge = () => screen.findByRole('region', { name: 'What your office knows' });

describe('the company memory (ADR-0056)', () => {
  it('is in the sidebar, and shows what Company Brain knows with its origin and version', async () => {
    open('/', (b) => {
      b.options.knowledge.org_1 = [
        fact(
          'identity',
          'city',
          { type: 'text', text: 'Lima' },
          {
            source: {
              type: 'user',
              id: 'business_profile',
              reference: null,
              recordedBy: 'you',
              confidence: null,
            },
          },
        ),
        fact(
          'operations',
          'opening_hours',
          { type: 'text', text: 'Mon to Sat, 9 to 18' },
          { label: 'Opening hours', revision: 3 },
        ),
      ];
    });
    const nav = await screen.findByRole('navigation', { name: 'Office' });
    fireEvent.click(await within(nav).findByRole('link', { name: 'Company memory' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Company memory' })).toBeTruthy();
    const list = within(await knowledge());
    const hours = within(await list.findByRole('listitem', { name: 'Opening hours' }));
    expect(hours.getByText('Mon to Sat, 9 to 18')).toBeTruthy();
    expect(hours.getByText(/Typed by a person · You · .* · version 3/)).toBeTruthy();
    expect(hours.getByRole('button', { name: 'Edit' })).toBeTruthy();
    // The profile's own fields are changed in the profile, not twice.
    const city = within(list.getByRole('listitem', { name: 'City' }));
    expect(city.getByText('Changed in “Company information” above.')).toBeTruthy();
    expect(city.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('adds information in a category, into the same Company Brain', async () => {
    const backend = open('/memory');
    fireEvent.click(await screen.findByRole('button', { name: 'Add information' }));
    const form = within(screen.getByRole('form', { name: 'Add information' }));
    fireEvent.change(form.getByLabelText('Category'), { target: { value: 'operations' } });
    fireEvent.change(form.getByLabelText('What it is'), {
      target: { value: 'Horario de atención' },
    });
    fireEvent.change(form.getByLabelText('Information'), {
      target: { value: 'Lunes a sábado, 9 a 18' },
    });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    const list = within(await knowledge());
    expect(await list.findByText('Lunes a sábado, 9 a 18')).toBeTruthy();
    const post = backend
      .apiCalls()
      .find((c) => c.method === 'POST' && c.url.endsWith('/brain/knowledge'));
    expect(JSON.parse(String(post?.body))).toEqual({
      domain: 'operations',
      key: 'horario_de_atencion',
      label: 'Horario de atención',
      value: { type: 'text', text: 'Lunes a sábado, 9 a 18' },
    });
  });

  it('edits a fact: the same key gets a new version', async () => {
    const backend = open('/memory', (b) => {
      b.options.knowledge.org_1 = [
        fact(
          'operations',
          'opening_hours',
          { type: 'text', text: '9 to 18' },
          {
            label: 'Opening hours',
          },
        ),
      ];
    });
    const item = within(
      await within(await knowledge()).findByRole('listitem', { name: 'Opening hours' }),
    );
    fireEvent.click(item.getByRole('button', { name: 'Edit' }));
    fireEvent.change(item.getByLabelText('Information'), { target: { value: '10 to 19' } });
    fireEvent.click(item.getByRole('button', { name: 'Save' }));
    expect(await within(await knowledge()).findByText('10 to 19')).toBeTruthy();
    const post = backend.apiCalls().find((c) => c.method === 'POST');
    expect(JSON.parse(String(post?.body))).toEqual({
      domain: 'operations',
      key: 'opening_hours',
      label: 'Opening hours',
      value: { type: 'text', text: '10 to 19' },
    });
  });

  it('confirms what GIA proposed from a chat, and decides a disagreement', async () => {
    const backend = open('/memory', (b) => {
      b.options.knowledge.org_1 = [
        fact(
          'products',
          'main_products',
          { type: 'list', items: ['Pollo a la brasa'] },
          {
            verification: 'proposed',
            needsConfirmation: true,
            source: { type: 'gia', id: null, reference: null, recordedBy: 'gia', confidence: 0.9 },
            revision: 2,
          },
        ),
      ];
      b.options.knowledgeConflicts.org_1 = [
        {
          id: 'k1',
          itemId: 'org_1_operations_opening_hours',
          domain: 'operations',
          key: 'opening_hours',
          label: 'Opening hours',
          current: {
            value: { type: 'text', text: '9 to 18' },
            verification: 'confirmed',
            source: 'user',
            recordedBy: 'you',
          },
          candidate: {
            value: { type: 'text', text: '10 to 20' },
            verification: 'proposed',
            source: 'gia',
            recordedBy: 'gia',
          },
          createdAt: '2026-09-28T12:00:00Z',
        },
      ];
    });
    const review = within(await screen.findByRole('region', { name: 'To review' }));
    const proposed = within(review.getByRole('listitem', { name: 'Main products or services' }));
    expect(proposed.getByText('From a conversation with GIA', { exact: false })).toBeTruthy();
    fireEvent.click(proposed.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(backend.apiCalls().some((c) => c.url.endsWith('/confirm'))).toBe(true),
    );
    const confirm = backend.apiCalls().find((c) => c.url.endsWith('/confirm'));
    expect(JSON.parse(String(confirm?.body))).toEqual({ revision: 2 });

    // The page reads everything again after a change.
    const again = within(await screen.findByRole('region', { name: 'To review' }));
    const conflict = within(await again.findByRole('listitem', { name: 'Opening hours' }));
    expect(conflict.getByText('10 to 20')).toBeTruthy();
    fireEvent.click(conflict.getByRole('button', { name: 'Use the new one' }));
    await waitFor(() =>
      expect(backend.apiCalls().some((c) => c.url.endsWith('/conflicts/k1/resolve'))).toBe(true),
    );
    const resolve = backend.apiCalls().find((c) => c.url.endsWith('/resolve'));
    expect(JSON.parse(String(resolve?.body))).toEqual({ choice: 'took_candidate' });
  });

  it('lets a role that only reads look, not change', async () => {
    open(
      '/memory',
      (b) => {
        b.options.knowledge.org_1 = [
          fact(
            'operations',
            'opening_hours',
            { type: 'text', text: '9 to 18' },
            {
              label: 'Opening hours',
              verification: 'proposed',
            },
          ),
        ];
      },
      ['knowledge.read'],
    );
    const item = within(
      await within(await knowledge()).findByRole('listitem', { name: 'Opening hours' }),
    );
    expect(item.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(item.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add information' })).toBeNull();
    expect(item.getByRole('button', { name: 'See versions' })).toBeTruthy();
  });

  it('is not in the sidebar for a member who may read neither the business nor its knowledge', async () => {
    open(
      '/',
      (b) => {
        b.options.permissions = b.options.permissions.filter((p) => p !== 'organization.read');
      },
      [],
    );
    const nav = await screen.findByRole('navigation', { name: 'Office' });
    await within(nav).findByRole('link', { name: 'GIA' });
    expect(within(nav).queryByRole('link', { name: 'Company memory' })).toBeNull();
  });

  it('keeps a history of changes, newest first, including what was archived', async () => {
    open('/memory', (b) => {
      b.options.knowledge.org_1 = [
        fact(
          'brand',
          'tone_of_voice',
          { type: 'text', text: 'Cercano' },
          {
            updatedAt: '2026-09-27T10:00:00Z',
          },
        ),
        fact(
          'marketing',
          'promo',
          { type: 'text', text: '2x1 los martes' },
          {
            label: 'Promotion',
            status: 'archived',
            updatedAt: '2026-09-28T10:00:00Z',
          },
        ),
      ];
    });
    const region = within(await knowledge());
    await region.findByRole('listitem', { name: 'Tone of voice' });
    expect(region.queryByRole('listitem', { name: 'Promotion' })).toBeNull();
    fireEvent.click(region.getByRole('tab', { name: 'History of changes' }));
    const archived = await region.findByRole('listitem', { name: 'Promotion' });
    expect(within(archived).getByText('Archived')).toBeTruthy();
    expect(region.getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual([
      'Promotion',
      'Tone of voice',
    ]);
  });

  it('turns what a person names into a key', () => {
    expect(keyFor('Horario de atención')).toBe('horario_de_atencion');
    expect(keyFor('  2x1 Promo! ')).toBe('x1_promo');
    expect(keyFor('¿?')).toBeUndefined();
  });
});

describe('teaching the company memory (block 7)', () => {
  const teacher = [...OWNER, 'knowledge.capture'];

  it('sends what a person wrote to GIA and shows what she proposes, to confirm', async () => {
    const backend = open('/memory', undefined, teacher);
    const tell = within(
      await screen.findByRole('region', { name: 'Teach GIA about your company' }),
    );
    const send = tell.getByRole('button', { name: 'Send to GIA' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(tell.getByLabelText('Tell GIA something about your business'), {
      target: { value: 'Abrimos de lunes a sábado.' },
    });
    fireEvent.click(send);
    expect(
      await tell.findByText('GIA found 1 fact. It waits under “To review” for your confirmation.'),
    ).toBeTruthy();
    expect((await screen.findAllByText('Abrimos de lunes a sábado.')).length).toBeGreaterThan(0);
    const [sent] = backend
      .apiCalls()
      .filter((c) => c.method === 'POST' && c.url.endsWith('/brain/capture'));
    expect(JSON.parse(sent?.body ?? '{}')).toEqual({ text: 'Abrimos de lunes a sábado.' });
  });

  it('says plainly when GIA cannot read it, and saves nothing', async () => {
    open(
      '/memory',
      (b) => {
        b.options.captureExtraction = 'unavailable';
      },
      teacher,
    );
    const tell = within(
      await screen.findByRole('region', { name: 'Teach GIA about your company' }),
    );
    fireEvent.change(tell.getByLabelText('Tell GIA something about your business'), {
      target: { value: 'Vendemos melones.' },
    });
    fireEvent.click(tell.getByRole('button', { name: 'Send to GIA' }));
    expect(await tell.findByRole('alert')).toBeTruthy();
    expect(tell.getByText(/GIA cannot read this right now/)).toBeTruthy();
  });

  it('updates from MelonOffice records and says how many facts changed', async () => {
    open(
      '/memory',
      (b) => {
        b.options.syncChanged = 3;
      },
      OWNER,
    );
    const tell = within(
      await screen.findByRole('region', { name: 'Teach GIA about your company' }),
    );
    // Without knowledge.capture, only the update from records is offered.
    expect(tell.queryByRole('button', { name: 'Send to GIA' })).toBeNull();
    fireEvent.click(tell.getByRole('button', { name: 'Update from MelonOffice' }));
    expect(await tell.findByText('3 facts were updated.')).toBeTruthy();
  });

  it('offers no teaching to a member who may only read', async () => {
    open('/memory', undefined, ['knowledge.read']);
    await knowledge();
    expect(screen.queryByRole('region', { name: 'Teach GIA about your company' })).toBeNull();
  });
});
