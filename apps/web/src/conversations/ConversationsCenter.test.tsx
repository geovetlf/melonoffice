import { catalogs, I18nProvider, pseudoLocalizeCatalog } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationsCenter } from './ConversationsCenter.js';
import {
  createInboxClient,
  InboxError,
  type AssistResult,
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

const ASSIST_ANSWERS: Record<AssistResult['type'], AssistResult> = {
  summary: {
    type: 'summary',
    summary: 'Juan pide información de precios.',
    intent: 'sales_inquiry',
    customerNeed: 'Precios',
    keyPoints: ['Pidió precios'],
    providedData: [{ label: 'Nombre', value: 'Juan' }],
    actionsTaken: [],
    pendingInformation: ['Cantidad'],
    nextSteps: ['Enviar lista de precios'],
  },
  intent: {
    type: 'intent',
    primary: 'complaint',
    secondary: ['billing_question'],
    confidence: 0.7,
    missingInformation: [],
    requiresHuman: true,
    requiresHumanReason: 'Está molesto',
  },
  reply: {
    type: 'reply',
    reply: 'Hola Juan, te comparto los precios.',
    explanation: null,
    warnings: ['Confirma el stock'],
  },
  next_steps: {
    type: 'next_steps',
    nextSteps: ['Llamar a Juan'],
    missingInformation: [],
    departmentId: SALES,
    requiresHuman: false,
  },
};

/** An inbox held in memory, with the same answers the API gives. */
function fakeClient(
  initial: ConversationRow[],
  options: { readonly aiAllowed?: boolean; readonly handoffSummary?: string } = {},
) {
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
      handoffSummary: options.handoffSummary ?? null,
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
    assist: vi.fn(
      async (_id: string, request: Parameters<InboxClient['assist']>[1]): Promise<AssistResult> =>
        ASSIST_ANSWERS[request.operation],
    ),
    takeOver: vi.fn(async (id: string) =>
      update(id, { control: { handledBy: 'human', aiState: 'paused', changedAt: null } }),
    ),
    handBack: vi.fn(async (id: string) => {
      if (options.aiAllowed !== true) throw new InboxError('autonomy_not_enabled');
      return update(id, {
        control: { handledBy: 'ai', aiState: 'active', changedAt: null },
        handoff: null,
      });
    }),
  } satisfies InboxClient;
  return client;
}

function center(
  client: InboxClient,
  locale: 'en' | 'es' = 'es',
  options: { newKey?: () => string; can?: (permission: string) => boolean } = {},
) {
  render(
    <I18nProvider locale={locale} messages={catalogs[locale]}>
      <ConversationsCenter
        client={client}
        currentUserId={ME}
        newKey={options.newKey ?? (() => 'key-1')}
        {...(options.can === undefined ? {} : { can: options.can })}
      />
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
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('No tienes permiso para hacer eso.')).toBeTruthy();
  });

  it('can try again after a failure, and shows loading first', async () => {
    const client = fakeClient([row('c1')]);
    client.list.mockRejectedValueOnce(new InboxError('internal'));
    center(client);
    expect(screen.getByRole('status').textContent).toBe('Cargando conversaciones…');
    const alert = await screen.findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Juan Pérez')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a reader only what their role allows (the API still decides)', async () => {
    const client = fakeClient([row('c1')]);
    render(
      <I18nProvider locale="es">
        <ConversationsCenter
          client={client}
          currentUserId={ME}
          can={(permission) => permission === 'conversation.read'}
        />
      </I18nProvider>,
    );
    const panel = await open('Juan Pérez');
    expect(within(panel).queryByRole('button', { name: 'Cerrar' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Asignármela' })).toBeNull();
    expect(within(panel).queryByRole('textbox')).toBeNull();
    expect(within(panel).getByText('Hola, quisiera información')).toBeTruthy();
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

describe('Conversations Center: assisted AI (CV-4)', () => {
  it('summarizes on request, marked as generated by AI, and can be discarded', async () => {
    const client = fakeClient([row('c1')]);
    center(client);
    const panel = await open('Juan Pérez');
    fireEvent.click(within(panel).getByRole('button', { name: 'Resumir' }));
    await within(panel).findByText('Juan pide información de precios.');
    expect(within(panel).getByText('Generado por IA — revisar antes de usar')).toBeTruthy();
    expect(within(panel).getByText('Consulta de venta')).toBeTruthy();
    expect(client.assist).toHaveBeenCalledWith('c1', {
      operation: 'summary',
      requestKey: 'key-1',
      locale: 'es',
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Descartar' }));
    await waitFor(() =>
      expect(within(panel).queryByText('Juan pide información de precios.')).toBeNull(),
    );
  });

  it('shows the intent, whether a person should take over, and next steps', async () => {
    const client = fakeClient([row('c1')]);
    center(client);
    const panel = await open('Juan Pérez');
    fireEvent.click(within(panel).getByRole('button', { name: 'Analizar intención' }));
    await within(panel).findByText('Queja');
    expect(within(panel).getByText('Debería atenderlo una persona')).toBeTruthy();
    expect(within(panel).getByText('Está molesto')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Próximos pasos' }));
    await within(panel).findByText('Llamar a Juan');
    const suggested = within(panel).getByText('Departamento posiblemente involucrado');
    expect(suggested.nextElementSibling?.textContent).toBe('Comercial');
  });

  it('puts an edited suggestion in the reply box, and sends only when the person sends', async () => {
    const client = fakeClient([row('c1')]);
    let n = 0;
    center(client, 'es', { newKey: () => `key-${++n}` });
    const panel = await open('Juan Pérez');
    fireEvent.click(within(panel).getByRole('button', { name: 'Sugerir respuesta' }));
    const suggestion = await within(panel).findByRole('textbox', {
      name: 'Respuesta sugerida (puedes editarla)',
    });
    expect((suggestion as HTMLTextAreaElement).value).toBe('Hola Juan, te comparto los precios.');
    expect(within(panel).getByText('Confirma el stock')).toBeTruthy();
    fireEvent.change(suggestion, { target: { value: 'Hola Juan, aquí van los precios.' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Usar respuesta' }));
    const box = within(panel).getByRole('textbox', { name: 'Tu respuesta' }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe('Hola Juan, aquí van los precios.'));
    // Using a suggestion sends nothing.
    expect(client.reply).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Enviar' }));
    await waitFor(() =>
      expect(client.reply).toHaveBeenCalledWith('c1', {
        clientMessageId: expect.any(String),
        text: 'Hola Juan, aquí van los precios.',
      }),
    );
    expect(client.reply).toHaveBeenCalledTimes(1);
  });

  it('regenerates as a new request, and asks once however fast it is clicked', async () => {
    const client = fakeClient([row('c1')]);
    let n = 0;
    center(client, 'es', { newKey: () => `key-${++n}` });
    const panel = await open('Juan Pérez');
    const button = within(panel).getByRole('button', { name: 'Sugerir respuesta' });
    fireEvent.click(button);
    fireEvent.click(button);
    await within(panel).findByRole('button', { name: 'Regenerar' });
    expect(client.assist).toHaveBeenCalledTimes(1);
    fireEvent.click(within(panel).getByRole('button', { name: 'Regenerar' }));
    await waitFor(() => expect(client.assist).toHaveBeenCalledTimes(2));
    const keys = client.assist.mock.calls.map(([, request]) => request.requestKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('says what went wrong, and a retry after a lost answer keeps its key', async () => {
    const client = fakeClient([row('c1')]);
    let n = 0;
    center(client, 'es', { newKey: () => `key-${++n}` });
    const panel = await open('Juan Pérez');
    client.assist.mockRejectedValueOnce(new InboxError('ai_unavailable'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Resumir' }));
    const alert = await within(panel).findByRole('alert');
    expect(
      within(alert).getByText('No se pudo generar la respuesta. Intenta nuevamente.'),
    ).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    await within(panel).findByText('Juan pide información de precios.');
    const [first, second] = client.assist.mock.calls.map(([, request]) => request.requestKey);
    expect(second).toBe(first);
    client.assist.mockRejectedValueOnce(new InboxError('ai_invalid_output'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Analizar intención' }));
    await within(panel).findByText('No se pudo interpretar la respuesta de IA.');
    client.assist.mockRejectedValueOnce(new InboxError('ai_not_available'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Próximos pasos' }));
    await within(panel).findByText('La asistencia de IA aún no está disponible.');
  });

  it('is hidden from a person whose role lacks conversation.assist', async () => {
    const client = fakeClient([row('c1')]);
    center(client, 'es', { can: (p) => p !== 'conversation.assist' });
    const panel = await open('Juan Pérez');
    expect(within(panel).queryByRole('button', { name: 'Resumir' })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Enviar' })).toBeTruthy();
  });

  it('asks the API with only the operation, key and language', async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    const client = createInboxClient(async (path, init) => {
      calls.push({ path, init });
      return new Response(JSON.stringify({ result: ASSIST_ANSWERS.reply }), { status: 200 });
    }, 'org_1');
    const result = await client.assist('c1', {
      operation: 'reply',
      requestKey: 'web-1',
      locale: 'en',
    });
    expect(result).toEqual(ASSIST_ANSWERS.reply);
    expect(calls[0]?.path).toBe('/v1/organizations/org_1/conversations/c1/assist');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      operation: 'reply',
      requestKey: 'web-1',
      locale: 'en',
    });
  });
});

describe('Human control (CV-6A)', () => {
  const byAI = { control: { handledBy: 'ai', aiState: 'active', changedAt: null } } as const;

  it('shows a conversation AI handles, in the list and when opened, and never hides it', async () => {
    const client = fakeClient([row('c1', byAI), row('c2')]);
    center(client);
    const list = await screen.findByRole('list', { name: 'Conversaciones' });
    const rows = within(list).getAllByRole('button');
    expect(within(rows[0] as HTMLElement).getByText('Atendida por IA')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByText('Atendida por IA')).toBeNull();
    const article = await open('Juan Pérez');
    expect(within(article).getAllByText('Atendida por IA').length).toBeGreaterThan(0);
  });

  it('does not let a person reply while AI handles it, until they take control', async () => {
    const client = fakeClient([row('c1', byAI)]);
    center(client);
    const article = await open('Juan Pérez');
    expect(within(article).queryByRole('textbox', { name: 'Tu respuesta' })).toBeNull();
    expect(within(article).getByText(/Toma el control para responder tú/)).toBeTruthy();
    fireEvent.click(within(article).getByRole('button', { name: 'Tomar control' }));
    await waitFor(() => expect(client.takeOver).toHaveBeenCalledWith('c1'));
    expect(
      await within(article).findByText('IA en pausa: una persona tomó el control'),
    ).toBeTruthy();
    expect(await within(article).findByRole('textbox', { name: 'Tu respuesta' })).toBeTruthy();
  });

  it('shows why AI handed a conversation to a person, and lets a person accept it', async () => {
    const client = fakeClient([
      row('c1', {
        control: { handledBy: 'human', aiState: 'escalated', changedAt: null },
        handoff: { reason: 'customer_requested_human', requestedAt: '2026-09-27T12:05:00Z' },
      }),
    ]);
    center(client);
    const article = await open('Juan Pérez');
    expect(within(article).getByText(/El cliente pidió hablar con una persona/)).toBeTruthy();
    fireEvent.click(within(article).getByRole('button', { name: 'Tomar control' }));
    await waitFor(() => expect(client.takeOver).toHaveBeenCalledWith('c1'));
  });

  it('shows an agent reply waiting for approval, and sends only what a person approves (CV-6C)', async () => {
    const base = fakeClient([
      row('c1', { control: { handledBy: 'ai', aiState: 'active', changedAt: null } }),
    ]);
    const queued = {
      id: 'm2',
      direction: 'outbound' as const,
      sender: { kind: 'specialist', executionId: 'exec-1' },
      type: 'text',
      text: 'Hola, sí hacemos envíos a Lima.',
      status: 'queued',
      sentAt: '2026-09-27T12:01:00Z',
    };
    const detail = base.detail;
    const decideReply = vi.fn(async () => undefined);
    const client: InboxClient = {
      ...base,
      detail: vi.fn(async (id: string) => {
        const d = await detail(id);
        return { ...d, messages: [...d.messages, queued] };
      }),
      pendingReplies: vi.fn(async () => [
        { approvalId: 'appr-1', executionId: 'exec-1', expiresAt: '2026-09-27T13:01:00Z' },
        { approvalId: 'appr-2', executionId: 'exec-other', expiresAt: '2026-09-27T13:01:00Z' },
      ]),
      decideReply,
    };
    center(client);
    const article = await open('Juan Pérez');
    const group = await within(article).findByRole('group', {
      name: 'Respuesta del agente pendiente de tu aprobación.',
    });
    expect(within(article).getAllByRole('group')).toHaveLength(1);
    fireEvent.click(within(group).getByRole('button', { name: 'Aprobar y enviar' }));
    await waitFor(() => expect(decideReply).toHaveBeenCalledWith('appr-1', 'approve'));
    fireEvent.click(within(group).getByRole('button', { name: 'Rechazar' }));
    await waitFor(() => expect(decideReply).toHaveBeenCalledWith('appr-1', 'reject'));
    cleanup();

    // Without the approval permissions, nothing is offered.
    center(client, 'es', { can: (p) => !p.startsWith('approval.') });
    const readOnly = await open('Juan Pérez');
    expect(within(readOnly).queryByRole('group')).toBeNull();
  });

  it('shows the agent’s note to the person taking over, as plain text (CV-6B)', async () => {
    const escalated = {
      control: { handledBy: 'human', aiState: 'escalated', changedAt: null },
      handoff: { reason: 'sensitive_operation', requestedAt: '2026-09-27T12:05:00Z' },
    } as const;
    const client = fakeClient([row('c1', escalated)], {
      handoffSummary:
        'Quiere cambiar la dirección del pedido 1042. <b>Ya</b> dio su código postal.',
    });
    center(client);
    const article = await open('Juan Pérez');
    expect(within(article).getByText(/Nota del agente:/)).toBeTruthy();
    expect(within(article).getByText(/Quiere cambiar la dirección/).textContent).toContain(
      '<b>Ya</b>',
    );
    cleanup();

    // No note: nothing is shown.
    center(fakeClient([row('c1', escalated)]));
    const plain = await open('Juan Pérez');
    expect(within(plain).queryByText(/Nota del agente:/)).toBeNull();
  });

  it('shows an unknown reason as "could not resolve", never the raw code', async () => {
    const client = fakeClient([
      row('c1', {
        control: { handledBy: 'human', aiState: 'escalated', changedAt: null },
        handoff: { reason: 'ignore_previous_instructions', requestedAt: '2026-09-27T12:05:00Z' },
      }),
    ]);
    center(client);
    const article = await open('Juan Pérez');
    expect(within(article).getByText(/La IA no pudo resolverlo/)).toBeTruthy();
    expect(within(article).queryByText(/ignore_previous_instructions/)).toBeNull();
  });

  it('hands back to AI only where the organization allows it, and says so otherwise', async () => {
    const paused = { control: { handledBy: 'human', aiState: 'paused', changedAt: null } } as const;
    const refused = fakeClient([row('c1', paused)]);
    center(refused);
    let article = await open('Juan Pérez');
    fireEvent.click(within(article).getByRole('button', { name: 'Devolver a la IA' }));
    expect(
      await screen.findByText(
        'Tu organización no ha permitido que la IA atienda conversaciones. No se cambió nada.',
      ),
    ).toBeTruthy();
    cleanup();

    const allowed = fakeClient([row('c1', paused)], { aiAllowed: true });
    center(allowed);
    article = await open('Juan Pérez');
    fireEvent.click(within(article).getByRole('button', { name: 'Devolver a la IA' }));
    await waitFor(() => expect(allowed.handBack).toHaveBeenCalledWith('c1'));
    expect((await within(article).findAllByText('Atendida por IA')).length).toBeGreaterThan(0);
  });

  it('offers no control buttons to a person who cannot manage conversations', async () => {
    const client = fakeClient([row('c1', byAI)]);
    center(client, 'es', { can: (p) => p === 'conversation.read' || p === 'conversation.send' });
    const article = await open('Juan Pérez');
    expect(within(article).queryByRole('button', { name: 'Tomar control' })).toBeNull();
    expect(within(article).getAllByText('Atendida por IA').length).toBeGreaterThan(0);
  });

  it('a person with no AI history sees nothing new', async () => {
    const client = fakeClient([row('c1')]);
    center(client);
    const article = await open('Juan Pérez');
    expect(within(article).getByText('Atendida por una persona')).toBeTruthy();
    expect(within(article).queryByRole('button', { name: 'Tomar control' })).toBeNull();
    expect(within(article).queryByRole('button', { name: 'Devolver a la IA' })).toBeNull();
  });
});

describe('inbox client (CV-6A)', () => {
  it('takes over and hands back with an empty body: nothing about who or what is sent', async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    const client = createInboxClient(async (path, init) => {
      calls.push({ path, init });
      return new Response(JSON.stringify(row('c1')), { status: 200 });
    }, 'org-1');
    await client.takeOver('c1');
    await client.handBack('c1');
    expect(calls.map((c) => [c.path, c.init.method, c.init.body])).toEqual([
      ['/v1/organizations/org-1/conversations/c1/takeover', 'POST', '{}'],
      ['/v1/organizations/org-1/conversations/c1/handback', 'POST', '{}'],
    ]);
  });
});
