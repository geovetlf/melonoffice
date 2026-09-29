import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionsPage, maskPhone, permissionsOf } from './ConnectionsPage.js';
import { createConnectionsClient, type ConnectionView } from './connectionsClient.js';

/**
 * Settings → Connections (ADR-0044) against an API held in memory that answers like the real
 * routes: one organization per client, each change behind its own permission, and bodies that
 * carry secret names, never values.
 */

afterEach(cleanup);

const API = 'https://api.example.test';
const ORG_A = 'org_a';
const ORG_B = 'org_b';
const ALL = [
  'channel.read',
  'channel.create',
  'channel.update',
  'channel.disconnect',
  'channel.delete',
];

const connection = (id: string, over: Partial<ConnectionView> = {}): ConnectionView => ({
  id,
  provider: 'meta_whatsapp_cloud',
  category: 'messaging',
  channel: 'whatsapp',
  status: 'connected',
  statusReason: null,
  displayName: 'Ventas',
  account: { phoneNumberId: '106540352242922', displayPhoneNumber: '+51 987 654 321' },
  lastValidatedAt: null,
  updatedAt: '2026-09-28T04:00:00Z',
  ...over,
});

const setupOf = (id: string) => ({
  secretIds: {
    app_secret: `channel-${id}-app-secret`,
    access_token: `channel-${id}-access-token`,
    verify_token: `channel-${id}-verify-token`,
  },
  webhookPath: `/webhooks/whatsapp/${id}`,
});

/** The API's connection routes, for two organizations, with one permission set per caller. */
function fakeApi(granted: readonly string[] = ALL) {
  const stores: Record<string, ConnectionView[]> = {
    [ORG_A]: [connection('conn-a')],
    [ORG_B]: [connection('conn-b', { displayName: 'B private line' })],
  };
  const calls: { method: string; path: string; body: string | undefined }[] = [];
  const templates: Record<string, Record<string, unknown>[]> = {};
  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const request = async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? init.body : undefined;
    calls.push({ method, path, body });
    const match = /^\/v1\/organizations\/([^/]+)\/(.*)$/.exec(path);
    if (match === null) return answer(404, { error: 'not_found' });
    const [, org = '', rest = ''] = match;
    const store = stores[org];
    if (store === undefined) return answer(403, { error: 'permission_denied' });
    const need = (permission: string) => granted.includes(permission);
    if (rest === 'integrations/providers') {
      return need('channel.read')
        ? answer(200, {
            providers: [
              { provider: 'meta_whatsapp_cloud', category: 'messaging', channel: 'whatsapp' },
            ],
          })
        : answer(403, { error: 'permission_denied' });
    }
    if (rest === 'channel-connections') {
      if (method === 'GET') {
        return need('channel.read')
          ? answer(200, { connections: store })
          : answer(403, { error: 'permission_denied' });
      }
      if (!need('channel.create')) return answer(403, { error: 'permission_denied' });
      const input = JSON.parse(body ?? '{}') as {
        displayName: string;
        account: { phoneNumberId: string; displayPhoneNumber?: string };
      };
      const created = connection(`conn-${store.length + 1}`, {
        status: 'created',
        displayName: input.displayName,
        account: {
          phoneNumberId: input.account.phoneNumberId,
          displayPhoneNumber: input.account.displayPhoneNumber ?? null,
        },
      });
      store.push(created);
      return answer(201, { ...created, setup: setupOf(created.id) });
    }
    const template =
      /^channel-connections\/([^/]+)\/templates(?:\/([^/]+)\/(check|disable))?$/.exec(rest);
    if (template !== null) {
      const [, connectionId = '', templateId, templateAction] = template;
      const list = (templates[connectionId] ??= []);
      if (method === 'GET') {
        return need('channel.read')
          ? answer(200, { templates: list })
          : answer(403, { error: 'permission_denied' });
      }
      if (!need('channel.update')) return answer(403, { error: 'permission_denied' });
      if (templateId === undefined) {
        const input = JSON.parse(body ?? '{}') as { name: string; language: string };
        const approved = input.name === 'order_update';
        const created = {
          id: `tpl-${list.length + 1}`,
          name: input.name,
          language: input.language,
          status: approved ? 'active' : 'invalid',
          statusReason: approved ? null : 'template_not_found',
          category: approved ? 'utility' : null,
          spec: approved ? { header: { format: 'none' }, bodyParameters: 2, urlButtons: [] } : null,
          lastValidatedAt: approved ? '2026-09-29T12:00:00Z' : null,
        };
        list.push(created);
        return answer(201, created);
      }
      const found = list.find((t) => t.id === templateId);
      if (found === undefined) return answer(404, { error: 'template_not_found' });
      if (templateAction === 'disable') found.status = 'disabled';
      return answer(200, found);
    }
    const [, id = '', action] = /^channel-connections\/([^/]+)(?:\/(\w+))?$/.exec(rest) ?? [];
    const index = store.findIndex((c) => c.id === id);
    if (index < 0) return answer(404, { error: 'connection_not_found' });
    const current = store[index] as ConnectionView;
    const change = (permission: string, next: Partial<ConnectionView>) => {
      if (!need(permission)) return answer(403, { error: 'permission_denied' });
      store[index] = { ...current, ...next };
      return answer(200, store[index]);
    };
    if (method === 'GET') return answer(200, { ...current, setup: setupOf(id) });
    if (method === 'PATCH') {
      return change('channel.update', JSON.parse(body ?? '{}') as Partial<ConnectionView>);
    }
    if (method === 'DELETE') return change('channel.delete', { status: 'revoked' });
    if (action === 'connect') return change('channel.update', { status: 'connected' });
    if (action === 'pause') return change('channel.update', { status: 'paused' });
    if (action === 'disconnect') return change('channel.disconnect', { status: 'disconnected' });
    return answer(404, { error: 'not_found' });
  };
  return { request, calls, stores };
}

function show(granted: readonly string[] = ALL, org = ORG_A) {
  const api = fakeApi(granted);
  const can = (permission: string) => granted.includes(permission);
  render(
    <I18nProvider locale="en">
      <ConnectionsPage
        client={createConnectionsClient(api.request, org)}
        permissions={permissionsOf(can)}
        apiUrl={API}
      />
    </I18nProvider>,
  );
  return api;
}

const card = async (name: string) => {
  const title = await screen.findByText(name);
  return title.closest('li') as HTMLElement;
};

describe('Settings → Connections', () => {
  it("lists the organization's connections with WhatsApp as a Meta official API provider", async () => {
    show();
    const ventas = await card('Ventas');
    expect(within(ventas).getByText('WhatsApp')).toBeTruthy();
    expect(within(ventas).getByText('Meta official API')).toBeTruthy();
    expect(within(ventas).getByText('Connected')).toBeTruthy();
    // The number is masked; the Phone Number ID is not shown on the card.
    expect(within(ventas).getByText('+51 ••••21')).toBeTruthy();
    expect(ventas.textContent).not.toContain('106540352242922');
  });

  it('offers no change to a person who may only read', async () => {
    show(['channel.read']);
    const ventas = await card('Ventas');
    expect(
      within(ventas)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['View setup', 'Templates']);
    expect(screen.queryByRole('button', { name: 'Connect a channel' })).toBeNull();
  });

  it('shows each action only with its own permission', async () => {
    const cases: [string, string[]][] = [
      ['channel.update', ['Pause', 'Rename']],
      ['channel.disconnect', ['Disconnect']],
      ['channel.delete', ['Delete']],
    ];
    for (const [permission, labels] of cases) {
      show(['channel.read', permission]);
      const ventas = await card('Ventas');
      const buttons = within(ventas)
        .getAllByRole('button')
        .map((b) => b.textContent);
      expect(buttons).toEqual(['View setup', 'Templates', ...labels]);
      cleanup();
    }
  });

  it('creates a connection with account data only, then shows secret names, never values', async () => {
    const api = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a channel' }));
    const form = screen.getByRole('form', { name: 'Connect a channel' });
    // No field for a token, secret or password: credentials never pass through the web app.
    expect(form.querySelector('input[type="password"]')).toBeNull();
    expect(
      within(form)
        .getAllByRole('textbox')
        .map((i) => i.getAttribute('name')),
    ).toEqual(['displayName', 'phoneNumberId', 'displayPhoneNumber']);
    fireEvent.change(within(form).getByLabelText('Connection name'), {
      target: { value: 'Soporte' },
    });
    fireEvent.change(within(form).getByLabelText('Phone Number ID'), {
      target: { value: '306540352242922' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create connection' }));
    const soporte = await card('Soporte');
    expect(within(soporte).getByText('Waiting to connect')).toBeTruthy();
    expect(within(soporte).getByText('channel-conn-2-access-token')).toBeTruthy();
    expect(within(soporte).getByText(`${API}/webhooks/whatsapp/conn-2`)).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post).toEqual({
      method: 'POST',
      path: `/v1/organizations/${ORG_A}/channel-connections`,
      body: JSON.stringify({
        provider: 'meta_whatsapp_cloud',
        displayName: 'Soporte',
        account: { phoneNumberId: '306540352242922' },
      }),
    });
  });

  it('connects, renames, disconnects and deletes through the engine routes', async () => {
    const api = show();
    let ventas = await card('Ventas');
    fireEvent.click(within(ventas).getByRole('button', { name: 'Pause' }));
    await within(ventas).findByText('Paused');
    fireEvent.click(within(ventas).getByRole('button', { name: 'Connect' }));
    await within(ventas).findByText('Connected');
    fireEvent.click(within(ventas).getByRole('button', { name: 'Rename' }));
    fireEvent.change(within(ventas).getByLabelText('Connection name'), {
      target: { value: 'Ventas Lima' },
    });
    fireEvent.click(within(ventas).getByRole('button', { name: 'Save' }));
    ventas = await card('Ventas Lima');
    fireEvent.click(within(ventas).getByRole('button', { name: 'Disconnect' }));
    await within(ventas).findByText('Disconnected');
    fireEvent.click(within(ventas).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(ventas).getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(screen.queryByText('Ventas Lima')).toBeNull());
    // Only the Integration Engine's routes of this organization were called.
    expect(
      api.calls.map((c) => `${c.method} ${c.path.replace(`/v1/organizations/${ORG_A}`, '')}`),
    ).toEqual([
      'GET /integrations/providers',
      'GET /channel-connections',
      'POST /channel-connections/conn-a/pause',
      'POST /channel-connections/conn-a/connect',
      'PATCH /channel-connections/conn-a',
      'POST /channel-connections/conn-a/disconnect',
      'DELETE /channel-connections/conn-a',
    ]);
  });

  it("never shows or reaches another organization's connection", async () => {
    const api = show();
    await card('Ventas');
    expect(screen.queryByText('B private line')).toBeNull();
    expect(api.calls.every((c) => c.path.startsWith(`/v1/organizations/${ORG_A}/`))).toBe(true);
  });

  it('shows the API refusal, which stays the final word', async () => {
    // The screen offers the action, but the API has not granted it: the refusal is shown.
    const api = fakeApi(['channel.read']);
    render(
      <I18nProvider locale="en">
        <ConnectionsPage
          client={createConnectionsClient(api.request, ORG_A)}
          permissions={permissionsOf(() => true)}
          apiUrl={API}
        />
      </I18nProvider>,
    );
    const ventas = await card('Ventas');
    fireEvent.click(within(ventas).getByRole('button', { name: 'Disconnect' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "You don't have permission for this action.",
    );
    expect(within(ventas).getByText('Connected')).toBeTruthy();
  });

  it('masks a phone number enough to recognise it', () => {
    expect(maskPhone('+51 987 654 321')).toBe('+51 ••••21');
    expect(maskPhone(null)).toBeNull();
  });

  it('registers a WhatsApp template, shows what it needs, and turns one off', async () => {
    const api = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Templates' }));
    const panel = within(await screen.findByRole('region', { name: 'Message templates' }));
    expect(await panel.findByText('No templates registered yet.')).toBeTruthy();
    fireEvent.change(panel.getByLabelText('Template name in WhatsApp'), {
      target: { value: 'order_update' },
    });
    fireEvent.change(panel.getByLabelText(/Language code/), { target: { value: 'es_PE' } });
    fireEvent.click(panel.getByRole('button', { name: 'Register and check' }));
    expect(await panel.findByText('order_update · es_PE')).toBeTruthy();
    expect(panel.getByText(/Approved, can be sent · utility/)).toBeTruthy();
    expect(panel.getByText('Needs 2 values in the body.')).toBeTruthy();
    const [registered] = api.calls.filter(
      (c) => c.method === 'POST' && c.path.endsWith('/conn-a/templates'),
    );
    expect(JSON.parse(registered?.body ?? '{}')).toEqual({
      name: 'order_update',
      language: 'es_PE',
    });

    fireEvent.change(panel.getByLabelText('Template name in WhatsApp'), {
      target: { value: 'missing_one' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Register and check' }));
    expect(
      await panel.findByText(
        /Not confirmed, not sent · WhatsApp has no approved template with that name/,
      ),
    ).toBeTruthy();

    fireEvent.click(panel.getAllByRole('button', { name: 'Turn off' })[0] as HTMLElement);
    expect(await panel.findByText(/Turned off/)).toBeTruthy();
  });

  it('refuses a template name WhatsApp would not accept, without calling the API', async () => {
    const api = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Templates' }));
    const panel = within(await screen.findByRole('region', { name: 'Message templates' }));
    await panel.findByText('No templates registered yet.');
    fireEvent.change(panel.getByLabelText('Template name in WhatsApp'), {
      target: { value: 'Order Update' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Register and check' }));
    expect(await panel.findByRole('alert')).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/templates'))).toBe(false);
  });

  it('shows templates read-only to a member who may only read', async () => {
    show(['channel.read']);
    fireEvent.click(await screen.findByRole('button', { name: 'Templates' }));
    const panel = within(await screen.findByRole('region', { name: 'Message templates' }));
    expect(await panel.findByText('No templates registered yet.')).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Register and check' })).toBeNull();
  });
});
