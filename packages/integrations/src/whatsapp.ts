import {
  checkInbound,
  isConversationError,
  isE164,
  isExternalId,
  MAX_ATTACHMENTS,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_TEXT_LENGTH,
} from '@melonoffice/conversations';
import type {
  ChannelCapabilities,
  ChannelConnection,
  IntegrationProviderId,
  IsoTimestamp,
  MessageAttachment,
  MessageType,
  WhatsAppAccount,
} from '@melonoffice/domain';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ChannelAdapter,
  ConnectionCheck,
  ConnectionCredentials,
  NormalizedDelivery,
  OutboundText,
  SendOptions,
} from './adapter.js';
import { IntegrationError } from './errors.js';

/**
 * WhatsApp through Meta's official Cloud API (DG-2). Webhooks are verified with the app secret
 * (`X-Hub-Signature-256`: HMAC-SHA256 of the raw body), the subscription with the verify token,
 * and messages are sent with the connection's access token. No aggregator, no SDK.
 */

export const SIGNATURE_HEADER = 'x-hub-signature-256';
export const GRAPH_API_URL = 'https://graph.facebook.com';

/** At most this many messages and statuses in one delivery; Meta batches far fewer. */
const MAX_EVENTS = 100;
const META_ID = /^[0-9]{5,32}$/;
const WA_ID = /^[0-9]{6,20}$/;
const TIMESTAMP = /^[0-9]{9,11}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{1,128}$/;
const MEDIA_TYPES = ['image', 'document', 'audio', 'video', 'sticker'] as const;
const GRAPH_VERSION = /^v[0-9]{1,3}\.[0-9]$/;
const DISPLAY_PHONE = /^\+?[0-9 ()-]{6,32}$/;

/** Meta's WhatsApp Cloud API: the official provider, reached directly (DG-2, ADR-0044). */
export const WHATSAPP_PROVIDER = 'meta_whatsapp_cloud' as IntegrationProviderId;

/** Only the known, non-sensitive account fields; anything else (a token, a secret) is refused. */
export function checkWhatsAppAccount(value: unknown): WhatsAppAccount {
  const invalid = (detail: string): never => {
    throw new IntegrationError('invalid_connection', detail);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('account');
  const a = value as Record<string, unknown>;
  const allowed = ['phoneNumberId', 'businessAccountId', 'displayPhoneNumber'];
  if (Object.keys(a).some((k) => !allowed.includes(k))) invalid('account.fields');
  if (typeof a.phoneNumberId !== 'string' || !META_ID.test(a.phoneNumberId)) {
    invalid('account.phoneNumberId');
  }
  if (
    a.businessAccountId !== undefined &&
    (typeof a.businessAccountId !== 'string' || !META_ID.test(a.businessAccountId))
  ) {
    invalid('account.businessAccountId');
  }
  if (
    a.displayPhoneNumber !== undefined &&
    (typeof a.displayPhoneNumber !== 'string' || !DISPLAY_PHONE.test(a.displayPhoneNumber))
  ) {
    invalid('account.displayPhoneNumber');
  }
  return Object.freeze({
    phoneNumberId: a.phoneNumberId as string,
    ...(a.businessAccountId === undefined
      ? {}
      : { businessAccountId: a.businessAccountId as string }),
    ...(a.displayPhoneNumber === undefined
      ? {}
      : { displayPhoneNumber: a.displayPhoneNumber as string }),
  });
}
/** Stands in for the organization and connection while checking, before they are known. */
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

function bad(detail: string): never {
  throw new IntegrationError('invalid_payload', detail);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const arrayOf = (value: unknown, field: string): readonly unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVENTS) bad(field);
  return value as unknown[];
};

const timeOf = (value: unknown, field: string): IsoTimestamp => {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) bad(field);
  return new Date(Number(value) * 1000).toISOString() as IsoTimestamp;
};

function textOf(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) bad(field);
  return (value as string).length === 0 ? undefined : (value as string);
}

type ParsedMessage = NormalizedDelivery['messages'][number];
type ParsedStatus = NormalizedDelivery['statuses'][number];

function parseMessage(raw: unknown, names: ReadonlyMap<string, string>): ParsedMessage {
  if (!isObject(raw)) bad('message');
  const m = raw as Record<string, unknown>;
  if (typeof m.from !== 'string' || !WA_ID.test(m.from)) bad('message.from');
  if (!isExternalId(m.id)) bad('message.id');
  const from = m.from as string;
  const phone = `+${from}`;
  const name = names.get(from);
  const kind = typeof m.type === 'string' ? m.type : 'unsupported';
  let type: MessageType = 'unsupported';
  let text: string | undefined;
  const attachments: MessageAttachment[] = [];
  if (kind === 'text') {
    if (!isObject(m.text)) bad('message.text');
    text = textOf((m.text as Record<string, unknown>).body, 'message.text.body');
    if (text === undefined) bad('message.text.body');
    type = 'text';
  } else if ((MEDIA_TYPES as readonly string[]).includes(kind)) {
    const media = m[kind];
    if (!isObject(media) || !isExternalId(media.id)) bad(`message.${kind}`);
    const mediaObject = media as Record<string, unknown>;
    attachments.push(
      Object.freeze({
        providerMediaId: mediaObject.id as string,
        ...(typeof mediaObject.mime_type === 'string' ? { mimeType: mediaObject.mime_type } : {}),
      }),
    );
    text = textOf(mediaObject.caption, `message.${kind}.caption`);
    type = kind as MessageType;
  } else if (kind === 'location') {
    type = 'location';
  }
  if (attachments.length > MAX_ATTACHMENTS) bad('message.attachments');
  const context = isObject(m.context) ? m.context : undefined;
  const replyTo = context !== undefined && isExternalId(context.id) ? context.id : undefined;
  return Object.freeze({
    channel: 'whatsapp',
    externalMessageId: m.id as string,
    from: Object.freeze({
      externalId: from,
      ...(name === undefined ? {} : { displayName: name }),
      ...(isE164(phone) ? { phone } : {}),
    }),
    type,
    ...(text === undefined ? {} : { text }),
    attachments: Object.freeze(attachments),
    ...(replyTo === undefined ? {} : { replyToExternalId: replyTo }),
    sentAt: timeOf(m.timestamp, 'message.timestamp'),
  });
}

function parseStatus(raw: unknown): ParsedStatus | undefined {
  if (!isObject(raw)) bad('status');
  const s = raw as Record<string, unknown>;
  if (!isExternalId(s.id)) bad('status.id');
  const status = s.status;
  // Other statuses (e.g. `deleted`, `warning`) are not ours to track: ignored, not refused.
  if (status !== 'sent' && status !== 'delivered' && status !== 'read' && status !== 'failed') {
    return undefined;
  }
  const errors = Array.isArray(s.errors) ? s.errors : [];
  const first = isObject(errors[0]) ? (errors[0] as Record<string, unknown>) : undefined;
  const code =
    typeof first?.code === 'number' && Number.isSafeInteger(first.code) && first.code >= 0
      ? `whatsapp_${first.code}`
      : undefined;
  return Object.freeze({
    channel: 'whatsapp',
    externalMessageId: s.id as string,
    status,
    at: timeOf(s.timestamp, 'status.timestamp'),
    ...(status === 'failed' ? { failureCode: code ?? 'whatsapp_failed' } : {}),
  });
}

/**
 * WhatsApp's customer service window: a business may send a free-form message only within 24
 * hours of the contact's last message; outside it, only an approved template (Meta, "Send
 * messages" and "Templates"). CV-2 sends no templates, so outside it nothing is sent.
 */
export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Meta's documented error codes, as stable MelonOffice codes (Meta, "Error codes"). Anything
 * not listed stays `provider_rejected`. Only the numeric code is read: never the message.
 */
const META_ERRORS: Readonly<Record<number, string>> = Object.freeze({
  131047: 'outside_messaging_window',
  130429: 'rate_limited',
  131056: 'rate_limited',
  4: 'rate_limited',
  80007: 'rate_limited',
  131026: 'invalid_destination',
  131051: 'unsupported_message',
  0: 'channel_unauthorized',
  190: 'channel_unauthorized',
  10: 'channel_unauthorized',
  368: 'policy_restricted',
  131031: 'policy_restricted',
  // "Something went wrong": not documented as temporary, so final, never retried (ADR-0045).
  131000: 'provider_error',
  131016: 'temporary_provider_error',
  2: 'temporary_provider_error',
});

/**
 * The codes under which Meta refused a send and says to try again later (Meta, "Error codes"):
 * it did not take the message, so the Integration Engine may call again (ADR-0045).
 */
const TRANSIENT_CODES: readonly string[] = ['rate_limited', 'temporary_provider_error'];

/**
 * Network errors raised before the request could reach the provider: nothing was sent. A reset
 * or a timeout once connected is not here, because the request may already have arrived.
 */
const NOT_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Whether a failed call surely never reached the provider (its cause says so). */
export function neverConnected(error: unknown): boolean {
  for (let e = error, depth = 0; e !== null && typeof e === 'object' && depth < 4; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_CONNECTED.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** The provider's `Retry-After` (seconds, or an HTTP date), in milliseconds; at most a minute. */
export function retryAfterHeader(answer: Response, now = Date.now()): number | undefined {
  const raw = answer.headers.get('retry-after');
  if (raw === null) return undefined;
  const ms = /^[0-9]{1,6}$/.test(raw.trim()) ? Number(raw.trim()) * 1000 : Date.parse(raw) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : undefined;
}

/** The stable code for a rejected send, from the numeric `error.code` of Meta's answer. */
async function rejectionOf(answer: Response): Promise<string> {
  return (await metaCodeOf(answer)) ?? 'provider_rejected';
}

/** The stable code of Meta's structured error, or `undefined` when there is none we know. */
async function metaCodeOf(answer: Response): Promise<string | undefined> {
  try {
    const parsed = (await answer.json()) as { error?: { code?: unknown } };
    const code = parsed.error?.code;
    return typeof code === 'number' && Object.hasOwn(META_ERRORS, code)
      ? (META_ERRORS[code] as string)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a WhatsApp Cloud API connection can do in MelonOffice today: text both ways, media in,
 * delivery statuses, within the 24-hour service window. No media out and no templates yet, so
 * nothing is ever sent outside the window.
 */
export const WHATSAPP_CAPABILITIES: ChannelCapabilities = Object.freeze({
  inboundText: true,
  inboundMedia: true,
  outboundText: true,
  outboundMedia: false,
  outboundTemplates: false,
  deliveryStatus: true,
  maxOutboundTextLength: MAX_TEXT_LENGTH,
  serviceWindowMs: WHATSAPP_SERVICE_WINDOW_MS,
});

export interface WhatsAppAdapterOptions {
  /** The Graph API version to send with, e.g. `v23.0`: set by configuration, never guessed. */
  readonly graphApiVersion?: string;
  readonly fetch?: typeof fetch;
  /** The longest one provider call may take; a send may ask for less (`SendOptions`). */
  readonly timeoutMs?: number;
}

export function createWhatsAppAdapter(options: WhatsAppAdapterOptions = {}): ChannelAdapter {
  const call = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const versionOf = (): string => {
    const version = options.graphApiVersion;
    if (version === undefined || !GRAPH_VERSION.test(version)) {
      throw new IntegrationError('provider_unavailable', 'graph_api_version');
    }
    return version;
  };

  /**
   * Reads the phone number's own node with the access token (Graph API, "WhatsApp Business Phone
   * Number"): valid only when Meta answers with that same id. Sends nothing.
   */
  async function check(
    connection: ChannelConnection,
    credentials: ConnectionCredentials,
  ): Promise<ConnectionCheck> {
    let version: string;
    try {
      version = versionOf();
    } catch {
      return { status: 'unavailable', code: 'graph_api_version' };
    }
    const id = connection.account.phoneNumberId;
    let answer: Response;
    try {
      answer = await call(`${GRAPH_API_URL}/${version}/${id}?fields=id`, {
        headers: { authorization: `Bearer ${credentials.accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { status: 'unavailable', code: 'no_answer' };
    }
    if (answer.status === 429) return { status: 'unavailable', code: 'rate_limited' };
    if (answer.status >= 500) return { status: 'unavailable', code: 'server_error' };
    if (!answer.ok) {
      const code = await rejectionOf(answer);
      if (TRANSIENT_CODES.includes(code) || code === 'provider_error') {
        return { status: 'unavailable', code };
      }
      return {
        status: 'invalid',
        code: code === 'provider_rejected' ? 'account_not_accessible' : code,
      };
    }
    try {
      const body = (await answer.json()) as { id?: unknown };
      return body.id === id ? { status: 'valid' } : { status: 'invalid', code: 'account_mismatch' };
    } catch {
      return { status: 'unavailable', code: 'response' };
    }
  }

  const adapter: ChannelAdapter = {
    provider: WHATSAPP_PROVIDER,
    category: 'messaging',
    channel: 'whatsapp',
    capabilities: WHATSAPP_CAPABILITIES,

    checkAccount: checkWhatsAppAccount,

    accountIdOf: (account) => account.phoneNumberId,

    verifySignature(rawBody, headers, appSecret) {
      const header = headers.get(SIGNATURE_HEADER) ?? '';
      const match = /^sha256=([0-9a-f]{64})$/.exec(header);
      if (match === null || appSecret.length === 0) return false;
      const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
      const given = Buffer.from(match[1] as string, 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    },

    handshake(query, verifyToken) {
      const mode = query.get('hub.mode');
      const token = query.get('hub.verify_token') ?? '';
      const challenge = query.get('hub.challenge') ?? '';
      if (mode !== 'subscribe' || !CHALLENGE.test(challenge) || verifyToken.length === 0) {
        return undefined;
      }
      const a = Buffer.from(token, 'utf8');
      const b = Buffer.from(verifyToken, 'utf8');
      return a.length === b.length && timingSafeEqual(a, b) ? challenge : undefined;
    },

    normalizeInbound(rawBody) {
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        bad('json');
      }
      if (!isObject(body) || body.object !== 'whatsapp_business_account') bad('object');
      const deliveries: NormalizedDelivery[] = [];
      let events = 0;
      for (const entry of arrayOf((body as Record<string, unknown>).entry, 'entry')) {
        if (!isObject(entry)) bad('entry');
        for (const change of arrayOf(entry.changes, 'changes')) {
          if (!isObject(change)) bad('change');
          // Only message events are ours; template, account and other updates are ignored.
          if (change.field !== 'messages') continue;
          const value = change.value;
          if (!isObject(value)) bad('value');
          const metadata = value.metadata;
          if (!isObject(metadata) || typeof metadata.phone_number_id !== 'string') {
            bad('metadata');
          }
          const accountId = (metadata as Record<string, unknown>).phone_number_id as string;
          if (!META_ID.test(accountId)) bad('metadata.phone_number_id');
          const names = new Map<string, string>();
          for (const contact of arrayOf(value.contacts, 'contacts')) {
            if (!isObject(contact) || typeof contact.wa_id !== 'string') continue;
            const profile = isObject(contact.profile) ? contact.profile : undefined;
            const name = profile?.name;
            if (
              typeof name === 'string' &&
              name.length > 0 &&
              name.length <= MAX_DISPLAY_NAME_LENGTH &&
              // eslint-disable-next-line no-control-regex
              !/[\u0000-\u001f\u007f]/.test(name)
            ) {
              names.set(contact.wa_id, name);
            }
          }
          const messages = arrayOf(value.messages, 'messages').map((m) => parseMessage(m, names));
          const statuses = arrayOf(value.statuses, 'statuses')
            .map(parseStatus)
            .filter((s): s is ParsedStatus => s !== undefined);
          events += messages.length + statuses.length;
          if (events > MAX_EVENTS) bad('too_many_events');
          deliveries.push(Object.freeze({ accountId, messages, statuses }));
        }
      }
      // Each message is checked as the domain will check it, before anything is stored.
      for (const d of deliveries) {
        for (const m of d.messages) {
          try {
            checkInbound({ ...m, organizationId: PLACEHOLDER, connectionId: PLACEHOLDER } as never);
          } catch (error) {
            bad(isConversationError(error) ? (error.detail ?? 'message') : 'message');
          }
        }
      }
      return Object.freeze(deliveries);
    },

    normalizeOutbound(message: OutboundText) {
      if (
        typeof message.to !== 'string' ||
        !WA_ID.test(message.to) ||
        typeof message.text !== 'string' ||
        message.text.length === 0 ||
        message.text.length > MAX_TEXT_LENGTH ||
        (message.replyToExternalId !== undefined && !isExternalId(message.replyToExternalId))
      ) {
        throw new IntegrationError('invalid_outbound');
      }
      return Object.freeze({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: message.to,
        type: 'text',
        text: { body: message.text, preview_url: false },
        ...(message.replyToExternalId === undefined
          ? {}
          : { context: { message_id: message.replyToExternalId } }),
      });
    },

    async send(
      connection: ChannelConnection,
      credentials: ConnectionCredentials,
      message: OutboundText,
      sendOptions?: SendOptions,
    ) {
      const version = versionOf();
      const body = adapter.normalizeOutbound(message);
      const limit = Math.min(timeoutMs, sendOptions?.timeoutMs ?? timeoutMs);
      let answer: Response;
      try {
        answer = await call(
          `${GRAPH_API_URL}/${version}/${connection.account.phoneNumberId}/messages`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${credentials.accessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(Math.max(limit, 1)),
          },
        );
      } catch (error) {
        // The connection never opened: nothing reached Meta, so it can be tried again.
        if (neverConnected(error))
          throw new IntegrationError('provider_unavailable', 'not_connected');
        // No answer (a timeout, a reset): the request may have been accepted all the same.
        throw new IntegrationError('provider_unavailable', 'no_answer');
      }
      if (answer.status === 429) {
        throw new IntegrationError(
          'provider_unavailable',
          'rate_limited',
          retryAfterHeader(answer),
        );
      }
      if (!answer.ok) {
        const code = await metaCodeOf(answer);
        // Meta refused it and says to try later (its rate limits, its temporary errors): not
        // taken, whatever the status.
        if (code !== undefined && TRANSIENT_CODES.includes(code)) {
          throw new IntegrationError('provider_unavailable', code, retryAfterHeader(answer));
        }
        // A server error without such a code does not say whether the message went out.
        if (answer.status >= 500) {
          throw new IntegrationError('provider_unavailable', 'server_error');
        }
        throw new IntegrationError('provider_rejected', code ?? 'provider_rejected');
      }
      let id: unknown;
      try {
        const parsed = (await answer.json()) as { messages?: { id?: unknown }[] };
        id = parsed.messages?.[0]?.id;
      } catch {
        id = undefined;
      }
      if (!isExternalId(id)) throw new IntegrationError('provider_unavailable', 'response');
      return Object.freeze({ externalMessageId: id as string });
    },

    validateConnection: check,
    healthCheck: check,
  };
  return Object.freeze(adapter);
}
