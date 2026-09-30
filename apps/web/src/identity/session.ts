import { IdentityError, type IdentityClient, type IdentityTokens } from './identityPlatform.js';

/**
 * The browser session (ADR-0036). The ID token, the one the API accepts, lives only in memory.
 * The refresh token is kept in `sessionStorage`, so a reload in the same tab stays signed in and
 * closing the tab ends the session; nothing goes to `localStorage` or cookies, and no password
 * is kept anywhere. A token about to expire is refreshed before use, once, however many calls
 * ask at the same time.
 */

export const REFRESH_KEY = 'melonoffice.session';
/** Refresh this long before the ID token expires, so a request never races the expiry. */
const MARGIN_MS = 60_000;

export type SessionEvent = 'signed_in' | 'signed_out' | 'expired';

export interface Session {
  /** Whether a session can be resumed (a refresh token is held). */
  readonly present: boolean;
  signIn(email: string, password: string): Promise<void>;
  /** Creates the account, signs it in and asks for its verification email (ADR-0089). */
  signUp(email: string, password: string): Promise<void>;
  /** Asks again for the verification email of the signed-in account. */
  sendVerification(): Promise<void>;
  /** An ID token valid for at least a minute, refreshed if needed. `undefined`: no session. */
  token(options?: { readonly force?: boolean }): Promise<string | undefined>;
  /** Ends the session here: tokens forgotten. */
  signOut(): void;
  /** The session can no longer be refreshed (revoked, expired): forgotten, and said so. */
  expire(): void;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

/** Storage that may be missing or refuse (private mode): the session then lives in memory only. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function browserSessionStore(): KeyValueStore | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export function createSession(
  identity: IdentityClient,
  store: KeyValueStore | undefined = browserSessionStore(),
  now: () => number = Date.now,
): Session {
  let current: IdentityTokens | undefined;
  let refreshToken: string | undefined;
  try {
    refreshToken = store?.getItem(REFRESH_KEY) ?? undefined;
  } catch {
    refreshToken = undefined;
  }
  let refreshing: Promise<string | undefined> | undefined;
  const listeners = new Set<(event: SessionEvent) => void>();
  const emit = (event: SessionEvent) => listeners.forEach((listener) => listener(event));

  function keep(tokens: IdentityTokens): void {
    current = tokens;
    refreshToken = tokens.refreshToken;
    try {
      store?.setItem(REFRESH_KEY, tokens.refreshToken);
    } catch {
      // Storage refused: the session still works until the tab reloads.
    }
  }

  function forget(): void {
    current = undefined;
    refreshToken = undefined;
    try {
      store?.removeItem(REFRESH_KEY);
    } catch {
      // Nothing was stored.
    }
  }

  async function refresh(): Promise<string | undefined> {
    const held = refreshToken;
    if (held === undefined) return undefined;
    try {
      keep(await identity.refresh(held));
      return current?.idToken;
    } catch (error) {
      if (error instanceof IdentityError && error.code === 'session_expired') {
        forget();
        emit('expired');
        return undefined;
      }
      throw error;
    }
  }

  const session: Session = {
    get present() {
      return refreshToken !== undefined;
    },
    async signIn(email, password) {
      keep(await identity.signIn(email, password));
      emit('signed_in');
    },
    async signUp(email, password) {
      keep(await identity.signUp(email, password));
      emit('signed_in');
      // The account exists either way; a failed email can be asked for again.
      await identity.sendVerification(current?.idToken ?? '').catch(() => undefined);
    },
    async sendVerification() {
      const idToken = await session.token();
      if (idToken === undefined) throw new IdentityError('session_expired');
      await identity.sendVerification(idToken);
    },
    async token({ force = false } = {}) {
      if (!force && current !== undefined && current.expiresAt - now() > MARGIN_MS) {
        return current.idToken;
      }
      refreshing ??= refresh().finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    },
    signOut() {
      forget();
      emit('signed_out');
    },
    expire() {
      forget();
      emit('expired');
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return session;
}
