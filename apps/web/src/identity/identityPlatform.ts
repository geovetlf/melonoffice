/**
 * Google Identity Platform, as the browser talks to it (ADR-0036): its REST endpoints for email
 * and password sign-in, for signing in with a Google account (ADR-0105) and for exchanging a
 * refresh token, called with `fetch`. No SDK is added.
 * MelonOffice never sees or stores a password: it goes from the form to Google, and only the
 * tokens Google issues come back. The API verifies those tokens itself (ADR-0016).
 */

export const SIGN_IN_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
export const REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';
export const SIGN_UP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp';
/** Asks Identity Platform to email the address a verification link (its own email, not ours). */
export const SEND_CODE_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode';

/** Starts a sign-in with an identity provider: returns the provider's page to send the browser to. */
export const CREATE_AUTH_URI_URL =
  'https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri';
/** Finishes it: the page the provider sent the browser back to becomes a session. */
export const SIGN_IN_WITH_IDP_URL =
  'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp';
export const GOOGLE_PROVIDER = 'google.com';

/** Where to send the browser to sign in with Google, and the handle to finish it on return. */
export interface ProviderRedirect {
  readonly authUri: string;
  readonly sessionId: string;
}

/** A signed-in session as Identity Platform issued it. */
export interface IdentityTokens {
  readonly idToken: string;
  readonly refreshToken: string;
  /** When the ID token stops being accepted, in ms since the epoch. */
  readonly expiresAt: number;
}

/** Why signing in or refreshing failed, as a stable code the login page can explain. */
export type IdentityErrorCode =
  | 'invalid_credentials'
  | 'user_disabled'
  | 'too_many_attempts'
  | 'session_expired'
  | 'email_exists'
  | 'weak_password'
  | 'network'
  | 'unavailable'
  /** Google sign-in is not turned on in Identity Platform, or this site is not an authorized domain. */
  | 'provider_disabled'
  /** The person closed Google's page or said no. */
  | 'provider_cancelled'
  /** The email already has an account with another way in (a password): use that. */
  | 'account_exists';

export class IdentityError extends Error {
  override readonly name = 'IdentityError';
  constructor(readonly code: IdentityErrorCode) {
    super(code);
  }
}

/** Identity Platform's error messages (e.g. `INVALID_PASSWORD : …`) mapped to our codes. */
function codeOf(message: string): IdentityErrorCode {
  const key = message.split(/[ :]/)[0] ?? '';
  switch (key) {
    case 'EMAIL_NOT_FOUND':
    case 'INVALID_PASSWORD':
    case 'INVALID_LOGIN_CREDENTIALS':
    case 'INVALID_EMAIL':
    case 'MISSING_PASSWORD':
      return 'invalid_credentials';
    case 'EMAIL_EXISTS':
      return 'email_exists';
    case 'WEAK_PASSWORD':
      return 'weak_password';
    case 'USER_DISABLED':
      return 'user_disabled';
    case 'TOO_MANY_ATTEMPTS_TRY_LATER':
      return 'too_many_attempts';
    case 'TOKEN_EXPIRED':
    case 'INVALID_REFRESH_TOKEN':
    case 'USER_NOT_FOUND':
    case 'INVALID_GRANT_TYPE':
    case 'MISSING_REFRESH_TOKEN':
      return 'session_expired';
    case 'OPERATION_NOT_ALLOWED':
    case 'UNAUTHORIZED_DOMAIN':
    case 'INVALID_PROVIDER_ID':
    case 'INVALID_IDP_RESPONSE':
    case 'INVALID_CONTINUE_URI':
      return 'provider_disabled';
    case 'FEDERATED_USER_ID_ALREADY_LINKED':
    case 'EMAIL_EXISTS_WITH_DIFFERENT_CREDENTIAL':
      return 'account_exists';
    default:
      return 'unavailable';
  }
}

export interface IdentityClient {
  signIn(email: string, password: string): Promise<IdentityTokens>;
  refresh(refreshToken: string): Promise<IdentityTokens>;
  /** Creates an email and password account (ADR-0089) and signs it in. */
  signUp(email: string, password: string): Promise<IdentityTokens>;
  /** Has Identity Platform email this account's address a link to verify it. */
  sendVerification(idToken: string): Promise<void>;
  /**
   * Starts a Google sign-in (ADR-0105). `continueUri` is this site's page Google sends the
   * browser back to; it must be an authorized redirect of the Google client and an authorized
   * domain of Identity Platform.
   */
  startProvider(continueUri: string): Promise<ProviderRedirect>;
  /** Finishes it from the full URL Google sent the browser back to. */
  finishProvider(requestUri: string, sessionId: string): Promise<IdentityTokens>;
}

export function createIdentityClient(
  apiKey: string,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): IdentityClient {
  async function post(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetcher(`${url}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        ...init,
      });
    } catch {
      throw new IdentityError('network');
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error = body.error as { message?: unknown } | undefined;
      throw new IdentityError(
        typeof error?.message === 'string' ? codeOf(error.message) : 'unavailable',
      );
    }
    return body;
  }

  const tokensOf = (idToken: unknown, refreshToken: unknown, expiresIn: unknown) => {
    const seconds = Number(expiresIn);
    if (
      typeof idToken !== 'string' ||
      typeof refreshToken !== 'string' ||
      !Number.isFinite(seconds) ||
      seconds <= 0
    ) {
      throw new IdentityError('unavailable');
    }
    return Object.freeze({ idToken, refreshToken, expiresAt: now() + seconds * 1000 });
  };

  return {
    async signIn(email, password) {
      const body = await post(SIGN_IN_URL, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      });
      return tokensOf(body.idToken, body.refreshToken, body.expiresIn);
    },
    async signUp(email, password) {
      const body = await post(SIGN_UP_URL, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      });
      return tokensOf(body.idToken, body.refreshToken, body.expiresIn);
    },
    async sendVerification(idToken) {
      await post(SEND_CODE_URL, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken }),
      });
    },
    async startProvider(continueUri) {
      const body = await post(CREATE_AUTH_URI_URL, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: GOOGLE_PROVIDER, continueUri }),
      });
      const { authUri, sessionId } = body;
      if (
        typeof authUri !== 'string' ||
        !authUri.startsWith('https://accounts.google.com/') ||
        typeof sessionId !== 'string' ||
        sessionId === ''
      ) {
        throw new IdentityError('provider_disabled');
      }
      return Object.freeze({ authUri, sessionId });
    },
    async finishProvider(requestUri, sessionId) {
      const body = await post(SIGN_IN_WITH_IDP_URL, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestUri, sessionId, returnSecureToken: true }),
      });
      // The email already signs in another way and Identity Platform will not merge on its own.
      if (body.needConfirmation === true) throw new IdentityError('account_exists');
      return tokensOf(body.idToken, body.refreshToken, body.expiresIn);
    },
    async refresh(refreshToken) {
      const body = await post(REFRESH_URL, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
      });
      return tokensOf(body.id_token, body.refresh_token, body.expires_in);
    },
  };
}
