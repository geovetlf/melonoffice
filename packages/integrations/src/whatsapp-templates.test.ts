import type {
  ChannelConnection,
  ChannelConnectionId,
  IsoTimestamp,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationError } from './errors.js';
import { secretRefsFor } from './secrets.js';
import { createWhatsAppAdapter, WHATSAPP_CAPABILITIES, WHATSAPP_PROVIDER } from './whatsapp.js';

const T0 = '2026-09-28T12:00:00.000Z' as IsoTimestamp;
const CONNECTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ChannelConnectionId;
const PHONE_NUMBER_ID = '106540352242922';
const WABA = '102290129340398';
// Test value only: a stand-in for what Secret Manager would hold.
const ACCESS_TOKEN = 'test-access-token-value';
const CREDENTIALS = { accessToken: ACCESS_TOKEN };

const connection = (businessAccountId: string | null = WABA): ChannelConnection => ({
  id: CONNECTION,
  organizationId: '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId,
  provider: WHATSAPP_PROVIDER,
  category: 'messaging',
  channel: 'whatsapp',
  status: 'connected',
  displayName: 'Ventas',
  account: {
    phoneNumberId: PHONE_NUMBER_ID,
    ...(businessAccountId === null ? {} : { businessAccountId }),
  },
  capabilities: WHATSAPP_CAPABILITIES,
  secrets: secretRefsFor('melonoffice-test', CONNECTION),
  createdAt: T0,
  createdBy: '11111111-1111-4111-8111-111111111111' as UserId,
  updatedAt: T0,
  updatedBy: '11111111-1111-4111-8111-111111111111' as UserId,
  revision: 1,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A Graph API that owns the number and answers with these template records. */
const graph = (templates: unknown[], numbers: unknown[] = [{ id: PHONE_NUMBER_ID }]) =>
  vi.fn(async (url: string) =>
    url.includes('/phone_numbers') ? json({ data: numbers }) : json({ data: templates }),
  );

const adapterWith = (fetch: unknown) =>
  createWhatsAppAdapter({ graphApiVersion: 'v26.0', fetch: fetch as never });

const TEMPLATE = { name: 'pedido_listo', language: 'es' };

const record = (overrides: Record<string, unknown> = {}) => ({
  name: 'pedido_listo',
  language: 'es',
  status: 'APPROVED',
  category: 'UTILITY',
  components: [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Hola {{1}}, tu pedido {{2}} está listo.' },
    { type: 'FOOTER', text: 'MelonOffice' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Gracias' },
        { type: 'URL', text: 'Ver', url: 'https://example.com/p/{{1}}' },
      ],
    },
  ],
  ...overrides,
});

async function codeOf(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof IntegrationError)) throw new Error('expected an IntegrationError');
  return error.detail === undefined ? error.code : `${error.code}:${error.detail}`;
}

describe('WhatsApp template check', () => {
  it("reads what an approved template needs from Meta's own record", async () => {
    const fetch = graph([record()]);
    const check = await adapterWith(fetch).checkTemplate?.(connection(), CREDENTIALS, TEMPLATE);
    expect(check).toEqual({
      status: 'approved',
      category: 'utility',
      spec: { header: { format: 'image' }, bodyParameters: 2, urlButtons: [{ index: 1 }] },
    });
    const urls = fetch.mock.calls.map(([url]) => url);
    expect(urls[0]).toBe(
      `https://graph.facebook.com/v26.0/${WABA}/phone_numbers?fields=id&limit=100`,
    );
    expect(urls[1]).toContain(`/${WABA}/message_templates?name=pedido_listo&`);
  });

  it('needs the business account, and one that owns the number', async () => {
    const adapter = adapterWith(graph([record()], [{ id: '999' }]));
    expect(await adapter.checkTemplate?.(connection(null), CREDENTIALS, TEMPLATE)).toEqual({
      status: 'invalid',
      code: 'business_account_required',
    });
    expect(await adapter.checkTemplate?.(connection(), CREDENTIALS, TEMPLATE)).toEqual({
      status: 'invalid',
      code: 'account_mismatch',
    });
  });

  it.each([
    ['an unknown name', [], 'template_not_found'],
    ['another language', [record({ language: 'en_US' })], 'template_language_not_found'],
    ['a paused template', [record({ status: 'PAUSED' })], 'template_paused'],
    ['a rejected template', [record({ status: 'REJECTED' })], 'template_rejected'],
    ['named parameters', [record({ parameter_format: 'NAMED' })], 'template_named_parameters'],
    [
      'a named placeholder',
      [record({ components: [{ type: 'BODY', text: 'Hola {{nombre}}' }] })],
      'template_named_parameters',
    ],
    [
      'a gap in the placeholders',
      [record({ components: [{ type: 'BODY', text: 'Hola {{1}} y {{3}}' }] })],
      'template_unsupported',
    ],
    [
      'a location header',
      [record({ components: [{ type: 'HEADER', format: 'LOCATION' }] })],
      'template_header_unsupported',
    ],
    [
      'a flow button',
      [record({ components: [{ type: 'BUTTONS', buttons: [{ type: 'FLOW' }] }] })],
      'template_button_unsupported',
    ],
    [
      'a carousel',
      [record({ components: [{ type: 'CAROUSEL', cards: [] }] })],
      'template_component_unsupported',
    ],
  ])('refuses %s, never guessing', async (_case, templates, code) => {
    expect(
      await adapterWith(graph(templates)).checkTemplate?.(connection(), CREDENTIALS, TEMPLATE),
    ).toEqual({ status: 'invalid', code });
  });

  it('answers unavailable, not invalid, when Meta is not reachable', async () => {
    const down = adapterWith(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await down.checkTemplate?.(connection(), CREDENTIALS, TEMPLATE)).toEqual({
      status: 'unavailable',
      code: 'no_answer',
    });
    const busy = adapterWith(async () => json({}, 503));
    expect(await busy.checkTemplate?.(connection(), CREDENTIALS, TEMPLATE)).toMatchObject({
      status: 'unavailable',
    });
  });
});

describe('WhatsApp media and template sends', () => {
  const sent = async (message: Parameters<ReturnType<typeof adapterWith>['send']>[2]) => {
    const fetch = vi.fn(async () => json({ messages: [{ id: 'wamid.sent' }] }));
    await adapterWith(fetch).send(connection(), CREDENTIALS, message);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    return JSON.parse(init.body as string) as Record<string, unknown>;
  };

  it('sends a document by link, with its file name and caption', async () => {
    expect(
      await sent({
        kind: 'media',
        to: '15551234567',
        media: { type: 'document', url: 'https://files.example.com/f.pdf', filename: 'f.pdf' },
        caption: 'Factura',
      }),
    ).toMatchObject({
      type: 'document',
      document: { link: 'https://files.example.com/f.pdf', filename: 'f.pdf', caption: 'Factura' },
    });
  });

  it('sends a template with its values in the order Meta expects', async () => {
    expect(
      await sent({
        kind: 'template',
        to: '15551234567',
        template: {
          name: 'pedido_listo',
          language: 'es',
          header: { type: 'media', media: { type: 'image', url: 'https://img.example.com/a.png' } },
          body: ['Ana', 'A-17'],
          buttons: [{ index: 1, text: 'A-17' }],
        },
      }),
    ).toMatchObject({
      type: 'template',
      template: {
        name: 'pedido_listo',
        language: { code: 'es' },
        components: [
          {
            type: 'header',
            parameters: [{ type: 'image', image: { link: 'https://img.example.com/a.png' } }],
          },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ana' },
              { type: 'text', text: 'A-17' },
            ],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '1',
            parameters: [{ type: 'text', text: 'A-17' }],
          },
        ],
      },
    });
  });

  it.each([
    ['a plain http link', { type: 'image', url: 'http://img.example.com/a.png' }],
    ['a private address', { type: 'image', url: 'https://10.0.0.1/a.png' }],
    ['localhost', { type: 'image', url: 'https://localhost/a.png' }],
    ['credentials in the link', { type: 'image', url: 'https://u:p@img.example.com/a.png' }],
    ['a file name on an image', { type: 'image', url: 'https://i.example.com/a', filename: 'a' }],
  ])('refuses %s before calling Meta', async (_case, media) => {
    const fetch = vi.fn();
    expect(
      await codeOf(
        adapterWith(fetch).send(connection(), CREDENTIALS, {
          kind: 'media',
          to: '15551234567',
          media: media as never,
        }),
      ),
    ).toMatch(/^invalid_outbound/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [131052, 'media_download_failed'],
    [132000, 'template_parameter_mismatch'],
    [132001, 'template_not_found'],
    [132015, 'template_paused'],
  ])('maps Meta code %i to a final %s', async (code, reason) => {
    const adapter = adapterWith(async () => json({ error: { code } }, 400));
    expect(
      await codeOf(
        adapter.send(connection(), CREDENTIALS, {
          kind: 'media',
          to: '15551234567',
          media: { type: 'image', url: 'https://img.example.com/a.png' },
        }),
      ),
    ).toBe(`provider_rejected:${reason}`);
  });
});
