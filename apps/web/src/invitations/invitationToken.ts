import type { KeyValueStore } from '../identity/session.js';

/**
 * The invitation link's secret in the browser (ADR-0089). The link carries it in the fragment
 * (`/invite#t=…`), which browsers never send to a server or in a Referer. It is kept in
 * `sessionStorage` only while the person signs in, creates their account or their organization,
 * and removed from the address bar at once.
 */

export const INVITATION_KEY = 'melonoffice.invitation';
export const INVITE_PATH = '/invite';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The link to share for a secret the API answered once. */
export const invitationLink = (origin: string, token: string) =>
  `${origin}${INVITE_PATH}#t=${token}`;

function storage(): KeyValueStore | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Takes the secret out of the address bar, if there is one, and keeps it for this tab. Answers
 * the secret this tab holds, if any.
 */
export function captureInvitationToken(store: KeyValueStore | undefined = storage()) {
  const match = /^#t=([A-Za-z0-9_-]{43})$/.exec(globalThis.location?.hash ?? '');
  if (match?.[1] !== undefined) {
    try {
      store?.setItem(INVITATION_KEY, match[1]);
    } catch {
      // Storage refused: the secret still works for this page.
    }
    globalThis.history.replaceState(null, '', INVITE_PATH);
    return match[1];
  }
  return pendingInvitationToken(store);
}

export function pendingInvitationToken(store: KeyValueStore | undefined = storage()) {
  try {
    const token = store?.getItem(INVITATION_KEY) ?? undefined;
    return token !== undefined && TOKEN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export function clearInvitationToken(store: KeyValueStore | undefined = storage()) {
  try {
    store?.removeItem(INVITATION_KEY);
  } catch {
    // Nothing was stored.
  }
}
