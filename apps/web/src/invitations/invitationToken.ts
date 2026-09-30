import type { KeyValueStore } from '../identity/session.js';

/**
 * The invitation link's secret in the browser (ADR-0089). The link carries it in the fragment
 * (`/invite#t=…`), which browsers never send to a server or in a Referer. It is kept in
 * `sessionStorage` only while the person signs in, creates their account or their organization,
 * and removed from the address bar at once.
 */

export const INVITATION_KEY = 'melonoffice.invitation';
export const INVITE_PATH = '/invite';
/** Where a link to join a partner or agency account lands (ADR-0093), and where it is kept. */
export const JOIN_KEY = 'melonoffice.memberInvitation';
export const JOIN_PATH = '/join';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Which link: a customer invitation (the default) or an invitation to join an account. */
export interface LinkKind {
  readonly key: string;
  readonly path: string;
}
const INVITE: LinkKind = { key: INVITATION_KEY, path: INVITE_PATH };
export const JOIN: LinkKind = { key: JOIN_KEY, path: JOIN_PATH };

/** The link to share for a secret the API answered once. */
export const invitationLink = (origin: string, token: string) =>
  `${origin}${INVITE_PATH}#t=${token}`;

/** The link to join a partner or agency account, for a secret the API answered once. */
export const joinLink = (origin: string, token: string) => `${origin}${JOIN_PATH}#t=${token}`;

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
export function captureInvitationToken(
  store: KeyValueStore | undefined = storage(),
  kind: LinkKind = INVITE,
) {
  const match = /^#t=([A-Za-z0-9_-]{43})$/.exec(globalThis.location?.hash ?? '');
  if (match?.[1] !== undefined) {
    try {
      store?.setItem(kind.key, match[1]);
    } catch {
      // Storage refused: the secret still works for this page.
    }
    globalThis.history.replaceState(null, '', kind.path);
    return match[1];
  }
  return pendingInvitationToken(store, kind);
}

export function pendingInvitationToken(
  store: KeyValueStore | undefined = storage(),
  kind: LinkKind = INVITE,
) {
  try {
    const token = store?.getItem(kind.key) ?? undefined;
    return token !== undefined && TOKEN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export function clearInvitationToken(
  store: KeyValueStore | undefined = storage(),
  kind: LinkKind = INVITE,
) {
  try {
    store?.removeItem(kind.key);
  } catch {
    // Nothing was stored.
  }
}
