import { catalogs, I18nProvider, pseudoLocalizeCatalog } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationsCenter } from './ConversationsCenter.js';
import {
  createInboxClient,
  InboxError,
  type ConversationDetail,
  type ConversationRow,
  type InboxClient,
} from './inboxClient.js';

afterEach(cleanup);

const ME = '11111111-1111-4111-8111-111111111111';
const SALES = 'org_sales';

const row = (id: string, overrides: Partial<ConversationRow> = {}): ConversationRow => ({
  id,
  contactId: `contact-${id}`,
  channel: 'whatsapp',
  status: 'open',
  assigneeId: null,
  departmentId: null,
  priority: 'normal',
  tags: [],
  lastMessage: { direction: 'inbound', preview: `Hola desde ${id}`, at: '2026-09-27T12:00:00Z' },
  lastMessageAt: '2026-09-27T12:00:00Z',
  createdAt: '2026-09-27T11:00:00Z',
  contact: { id: `contact-${id}`, displayName: id === 'c1' ? 'Juan Pérez' : 'María', phone: null },
  ...overrides,
});

/** An inbox held in memory, with the same answers the API gives. */
function fakeClient(initial: ConversationRow[]) {
  let rows = initial;
  const update = (id: string, change: Partial<ConversationRow>) => {
    rows = rows.map((r) => (r.id === id ? { ...r, ...change } : r));
    return rows.find((r) => r.id === id) as ConversationRow;
  };
  const messages: Record<string, ConversationDetail['messages'][number][]> = {
    c1: [
      {
        id: 'm1',
        direction: 'inbound',
        sender: { kind: 'contact' },
        type: 'text',
        text: 'Hola, quisiera información',
        status: 'received',
        sentAt: '2026-09-27T12:00:00Z',
      },
    ],
  };
  const client = {
    list: vi.fn(async (query: Parameters<InboxClient['list']>[0]) =>
      rows.filter(
        (r) =>
          (query.status === undefined || r.status === query.status) &&
          (query.unassigned !== true || r.assigneeId === null) &&
          (query.q === undefined ||
            (r.contact?.displayName ?? '').toLowerCase().includes(query.q.toLowerCase())),
      ),
    ),
    detail: vi.fn(async (id: string) => ({
      conversation: rows.find((r) => r.id === id) as ConversationRow,
      contact: {
        id: `contact-${id}`,
        displayName: id === 'c1' ? 'Juan Pérez' : 'María',
        phone: '+5215512345678',
        email: null,
        createdAt: '2026-09-27T11:00:00Z',
      },
      identity: { channel: 'whatsapp', externalId: '5215512345678', displayName: null },
      messages: messages[id] ?? [],
    })),
    departments: vi.fn(async () => [{ id: SALES, nameKey: 'department.sales.short', name: null }]),
    assign: vi.fn(async (id: string, change: Parameters<InboxClient['assign']>[1]) =>
      update(id, {
        ...(change.assigneeId === undefined ? {} : { assigneeId: change.assigneeId }),
        ...(change.departmentId === undefined ? {} : { departmentId: change.departmentId }),
      }),
    ),
    setStatus: vi.fn(async (id: string, status: ConversationRow['status']) =>
      update(id, { status }),
    ),
    setPriority: vi.fn(async (id: string, priority: ConversationRow['priority']) =>
      update(id, { priority }),
    ),
    changeTags: vi.fn(async (id: string, change: Parameters<InboxClient['changeTags']>[1]) => {
      const current = rows.find((r) => r.id === id) as ConversationRow;
      const removed = new Set(change.remove ?? []);
      return update(id, {
        tags: [...current.tags.filter((t) => !removed.has(t)), ...(change.add ?? [])],
      });
    }),
    reply: vi.fn(async (id: string, reply: { clientMessageId: string; text: string }) => {
      (messages[id] ??= []).push({
        id: reply.clientMessageId,
        direction: 'outbound',
        sender: { kind: 'user', userId: ME },
        type: 'text',
        text: reply.text,
        status: 'sent',
        sentAt: '2026-09-27T12:01:00Z',
      });
      return { kind: 'sent' as const };
    }),
  } satisfies InboxClient;
  return client;
}

function center(client: InboxClient, locale: 'en' | 'es' = 'es') {
  render(
    <I18nProvider locale={locale} messages={catalogs[locale]}>
      <ConversationsCenter client={client} currentUserId={ME} newKey={() => 'key-1'} />
    </I18nProvider>,
  );
}

async function open(name: string) {
  const list = await screen.findByRole('list', { name: 'Conversaciones' });
  fireEvent.click(await within(list).findByText(name));
  return screen.findByRole('article', { name });
}

describe('Conversations Center (CV-3)', () => {
  it('lists who wrote, on which channel, with the last message and whether it is taken', async () => {
    const client = fakeClient([row('c1'), row('c2', { assigneeId: ME, tags: ['vip'] })]);
    center(client);
    const list = await screen.findByRole('list', { name: 'Conversaciones' });
    await within(list).findByText('Juan Pérez');
    expect(within(list).getByText('Hola desde c1')).toBeTruthy();
    expect(within(list).getAllByText(/WhatsApp/)).toHaveLength(2);
    expect(within(list).getByText('Sin asignar')).toBeTruthy();
    expect(within(list).getByText('Asignada a ti')).toBeTruthy();
    expect(within(list).getByText('vip')).toBeTruthy();
  });

  it('filters by tab ("new" = open and unassigned) and searches by name', async () => {
    const client = fakeClient([row('c1'), row('c2', { status: 'closed' })]);
    center(client);
    await screen.findByText('Juan Pérez');
    fireEvent.click(screen.getByRole('tab', { name: 'Nuevas' }));
    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith({
        status: 'open',
        unassigned: true,
        sort: 'last_activity',
      }),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Cerradas' }));
    await waitFor(() => expect(screen.queryByText('Juan Pérez')).toBeNull());
    expect(screen.getByText('María')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Todas' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'juan' } });
    await waitFor(() => expect(screen.queryByText('María')).toBeNull());
    expect(screen.getByText('Juan Pérez')).toBeTruthy();
  });

  it('opens a conversation: contact, history, and a reply through the existing send', async () => {
    const client = fakeClient([row('c1')]);
    center(client);
    const panel = await open('Juan Pérez');
    expect(within(panel).getByText('Hola, quisiera información')).toBeTruthy();
    expect(within(panel).getByText('+5215512345678')).toBeTruthy();
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Tu respuesta' }), {
      target: { value: 'Hola Juan, te ayudo' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Enviar' }));
    await within(panel).findByText('Hola Juan, te ayudo');
    expect(client.reply).toHaveBeenCalledWith('c1', {
      clientMessageId: 'key-1',
      text: 'Hola Juan, te ayudo',
    });
  });

  it('assigns, sets the department, tags, prioritizes and closes, each as one call', async () => {
    const client = fakeClient([row('c1')]);
    center(client);
    const panel = await open('Juan Pérez');
    fireEvent.click(within(panel).getByRole('button', { name: 'Asignármela' }));
    await within(panel).findByRole('button', { name: 'Quitar asignación' });
    expect(client.assign).toHaveBeenLastCalledWith('c1', { assigneeId: ME });
    await within(panel).findByRole('option', { name: 'Comercial' });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Departamento' }), {
      target: { value: SALES },
    });
    await waitFor(() =>
      expect(client.assign).toHaveBeenLastCalledWith('c1', { departmentId: SALES }),
    );
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Nueva etiqueta' }), {
      target: { value: 'VIP' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Añadir' }));
    await within(panel).findByRole('button', { name: 'Quitar etiqueta: vip' });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Prioridad' }), {
      target: { value: 'urgent' },
    });
    await waitFor(() => expect(client.setPriority).toHaveBeenCalledWith('c1', 'urgent'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Cerrar' }));
    await within(panel).findByRole('button', { name: 'Reabrir' });
    expect(client.setStatus).toHaveBeenCalledWith('c1', 'closed');
  });

  it('shows why a change was refused, without the server’s words', async () => {
    const client = fakeClient([row('c1')]);
    client.setStatus.mockRejectedValueOnce(new InboxError('permission_denied'));
    center(client);
    const panel = await open('Juan Pérez');
    fireEvent.click(within(panel).getByRole('button', { name: 'Cerrar' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'No tienes permiso para hacer eso.',
    );
  });

  it('has no hard-coded text', async () => {
    const client = fakeClient([row('c1')]);
    render(
      <I18nProvider locale="en" messages={pseudoLocalizeCatalog(catalogs.en)}>
        <ConversationsCenter client={client} currentUserId={ME} />
      </I18nProvider>,
    );
    await waitFor(() => expect(client.list).toHaveBeenCalled());
    for (const element of document.body.querySelectorAll('h1, label, button[role=tab], p')) {
      const text = element.textContent?.trim() ?? '';
      if (text !== '') expect(text, text).toMatch(/^\[.*\]$/);
    }
  });
});

describe('inbox client', () => {
  const answering = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('calls only the organization’s inbox routes, with the query it was given', async () => {
    const request = answering(200, { conversations: [] });
    const client = createInboxClient(request, 'org-1');
    await client.list({ status: 'open', unassigned: true, q: ' ana ', sort: 'priority' });
    await client.list({ q: 'a' });
    const paths = request.mock.calls.map((call) => (call as unknown as [string])[0]);
    expect(paths).toEqual([
      '/v1/organizations/org-1/conversations?status=open&unassigned=true&q=ana&sort=priority',
      '/v1/organizations/org-1/conversations',
    ]);
  });

  it('posts each change to its route, and turns a refusal into its code', async () => {
    const request = answering(200, { id: 'c1' });
    const client = createInboxClient(request, 'org-1');
    await client.setPriority('c1', 'high');
    await client.changeTags('c1', { add: ['vip'] });
    await client.assign('c1', { assigneeId: null });
    const calls = request.mock.calls.map((call) => {
      const [path, init] = call as unknown as [string, RequestInit];
      return [path, JSON.parse(init.body as string)];
    });
    expect(calls).toEqual([
      ['/v1/organizations/org-1/conversations/c1/priority', { priority: 'high' }],
      ['/v1/organizations/org-1/conversations/c1/tags', { add: ['vip'] }],
      ['/v1/organizations/org-1/conversations/c1/assign', { assigneeId: null }],
    ]);
    const refusing = createInboxClient(answering(409, { error: 'invalid_transition' }), 'o');
    await expect(refusing.setStatus('c1', 'open')).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    const broken = createInboxClient(answering(500, {}), 'o');
    await expect(broken.detail('c1')).rejects.toMatchObject({ code: 'generic' });
  });
});
