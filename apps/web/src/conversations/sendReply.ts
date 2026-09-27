/**
 * A person's reply in a conversation, as the web app sends it (CV-2, ADR-0034): the key of the
 * draft and its text, nothing else. The organization, recipient and channel come from the
 * server. The caller supplies an authenticated request function; this module decides nothing
 * about sign-in.
 */
export type ReplyRequest = (path: string, init: RequestInit) => Promise<Response>;

/** What happened to a reply, as the composer shows it. */
export type ReplyOutcome =
  | { readonly kind: 'sent' }
  /** WhatsApp may have received it; it is never sent again automatically. */
  | { readonly kind: 'unknown' }
  /** Nothing was sent. `code` is a stable error code with its own message. */
  | { readonly kind: 'refused'; readonly code: ReplyErrorCode };

export const REPLY_ERROR_CODES = [
  'outside_messaging_window',
  'conversation_closed',
  'channel_not_available',
  'permission_denied',
  'duplicate_request',
  'external_send_failed',
  'generic',
] as const;
export type ReplyErrorCode = (typeof REPLY_ERROR_CODES)[number];

const isReplyErrorCode = (value: unknown): value is ReplyErrorCode =>
  typeof value === 'string' && (REPLY_ERROR_CODES as readonly string[]).includes(value);

/** A new key for a new draft. A retry of the same draft reuses its key, so it is sent once. */
export const newClientMessageId = (): string => `web-${crypto.randomUUID()}`;

export async function sendReply(
  request: ReplyRequest,
  organizationId: string,
  conversationId: string,
  reply: { readonly clientMessageId: string; readonly text: string },
): Promise<ReplyOutcome> {
  let response: Response;
  try {
    response = await request(
      `/v1/organizations/${encodeURIComponent(organizationId)}/conversations/${encodeURIComponent(
        conversationId,
      )}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientMessageId: reply.clientMessageId, text: reply.text }),
      },
    );
  } catch {
    // The request may have reached the server: the same key, sent again, is answered safely.
    return { kind: 'unknown' };
  }
  if (response.status === 200 || response.status === 201) return { kind: 'sent' };
  if (response.status === 202) return { kind: 'unknown' };
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return { kind: 'refused', code: isReplyErrorCode(body.error) ? body.error : 'generic' };
}
