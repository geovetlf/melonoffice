import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError } from './apiClient.js';
import { IdentityError, type IdentityErrorCode } from './identityPlatform.js';
import type { IdentityServices } from './services.js';

/** Where Google sends the browser back to finish a sign-in (ADR-0105): the sign-in page. */
export const GOOGLE_RETURN_PATH = '/login';

/**
 * Who is signed in and in which organization (ADR-0036). Everything here comes from the API:
 * the user from `/v1/me`, the organization from `/v1/me/organizations` (only the caller's active
 * memberships), and the permissions from the organization's own view. The web app never picks an
 * organization the API did not list, and it uses permissions only to shape the screen: every
 * call is still authorized by the API.
 */

export interface Me {
  readonly userId: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
}

export interface Workspace {
  readonly organization: { readonly id: string; readonly name: string };
  readonly role: string;
  readonly permissions: ReadonlySet<string>;
}

export type AuthState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed_out'; readonly expired: boolean }
  | { readonly status: 'signed_in'; readonly me: Me; readonly workspace: Workspace | undefined }
  /** The API refused this user access (403): nothing to show, and nothing to retry. */
  | { readonly status: 'denied' }
  | { readonly status: 'unavailable' };

export type SignInResult =
  { readonly ok: true } | { readonly ok: false; readonly code: IdentityErrorCode };

export interface Auth {
  readonly state: AuthState;
  readonly services: IdentityServices;
  signIn(email: string, password: string): Promise<SignInResult>;
  /** Creates an account, signs it in and asks for its verification email (ADR-0089). */
  signUp(email: string, password: string): Promise<SignInResult>;
  /**
   * Starts signing in with Google (ADR-0105): on success the browser is on its way to Google's
   * page, which sends it back to `/login` to finish.
   */
  signInWithGoogle(): Promise<SignInResult>;
  /** Finishes a Google sign-in from the URL Google sent the browser back to. */
  finishGoogleSignIn(requestUri: string): Promise<SignInResult>;
  /** Asks again for the verification email. `false`: it could not be sent. */
  sendVerification(): Promise<boolean>;
  /** Takes a fresh token, so a just-verified email counts, and loads the profile again. */
  refreshIdentity(): Promise<void>;
  signOut(): void;
  /**
   * Creates the signed-in user's first organization, with them as its owner (POST
   * /v1/organizations, ADR-0018), then loads it as their workspace. `code`: the API's refusal.
   */
  createOrganization(
    name: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
  /** Try loading the profile again after the API was unavailable. */
  retry(): void;
}

const AuthContext = createContext<Auth | undefined>(undefined);

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (auth === undefined) throw new Error('useAuth needs an AuthProvider');
  return auth;
}

/** Whether the signed-in user's role grants a permission. For the screen only, never security. */
export function useCan(permission: string): boolean {
  const { state } = useAuth();
  return state.status === 'signed_in' && state.workspace?.permissions.has(permission) === true;
}

interface OrganizationsBody {
  readonly organizations: readonly {
    readonly organization: { readonly id: string; readonly name: string };
    readonly membership: { readonly role: string };
  }[];
}

/** Loads the user and their organization. `registering`: first call after a sign-in. */
export async function loadProfile(
  { api }: IdentityServices,
  registering: boolean,
): Promise<{ me: Me; workspace: Workspace | undefined }> {
  let me: Me;
  try {
    // A sign-in is recorded by POST (ADR-0017); a restored session only reads.
    me = await api.json<Me>('/v1/me', registering ? { method: 'POST' } : {});
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'user_not_registered')) throw error;
    me = await api.json<Me>('/v1/me', { method: 'POST' });
  }
  const { organizations } = await api.json<OrganizationsBody>('/v1/me/organizations');
  // The API lists only the caller's active memberships; the first one is theirs to use.
  const [first] = organizations;
  if (first === undefined) return { me, workspace: undefined };
  const view = await api.json<{ permissions?: readonly string[] }>(
    `/v1/organizations/${encodeURIComponent(first.organization.id)}`,
  );
  return {
    me,
    workspace: {
      organization: { id: first.organization.id, name: first.organization.name },
      role: first.membership.role,
      permissions: new Set(view.permissions ?? []),
    },
  };
}

export function AuthProvider({
  services,
  children,
}: {
  readonly services: IdentityServices;
  readonly children: ReactNode;
}) {
  const { session } = services;
  const [state, setState] = useState<AuthState>(() =>
    session.present ? { status: 'loading' } : { status: 'signed_out', expired: false },
  );
  // Bumped to load the profile again (after a retry); the effect below does the loading.
  const [attempt, setAttempt] = useState(0);

  // A profile that could not be loaded: a refused token ends the session; a 403 is final.
  const settle = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.kind === 'unauthorized') session.expire();
      else if (error instanceof ApiError && error.kind === 'forbidden')
        setState({ status: 'denied' });
      else setState({ status: 'unavailable' });
    },
    [session],
  );

  useEffect(
    () =>
      session.subscribe((event) => {
        if (event === 'signed_in') return;
        setState({ status: 'signed_out', expired: event === 'expired' });
      }),
    [session],
  );

  useEffect(() => {
    if (!session.present) return;
    let live = true;
    loadProfile(services, false)
      .then((profile) => {
        if (live) setState({ status: 'signed_in', ...profile });
      })
      .catch((error: unknown) => {
        if (!live) return;
        if (!session.present) {
          setState({ status: 'signed_out', expired: true });
        } else {
          settle(error);
        }
      });
    return () => {
      live = false;
    };
  }, [services, session, settle, attempt]);

  // Signs in (or up), then records the sign-in with the API and loads the profile.
  const enter = useCallback(
    async (start: () => Promise<void>): Promise<SignInResult> => {
      try {
        await start();
      } catch (error) {
        return { ok: false, code: error instanceof IdentityError ? error.code : 'unavailable' };
      }
      setState({ status: 'loading' });
      try {
        setState({ status: 'signed_in', ...(await loadProfile(services, true)) });
      } catch (error) {
        settle(error);
      }
      return { ok: true };
    },
    [services, settle],
  );

  const auth = useMemo<Auth>(
    () => ({
      state,
      services,
      signIn: (email, password) => enter(() => session.signIn(email, password)),
      signUp: (email, password) => enter(() => session.signUp(email, password)),
      async signInWithGoogle() {
        try {
          const authUri = await session.startProvider(
            `${globalThis.location.origin}${GOOGLE_RETURN_PATH}`,
          );
          services.leave(authUri);
          return { ok: true };
        } catch (error) {
          return { ok: false, code: error instanceof IdentityError ? error.code : 'unavailable' };
        }
      },
      finishGoogleSignIn: (requestUri) => enter(() => session.finishProvider(requestUri)),
      async sendVerification() {
        try {
          await session.sendVerification();
          return true;
        } catch {
          return false;
        }
      },
      async refreshIdentity() {
        setState({ status: 'loading' });
        try {
          await session.token({ force: true });
          setState({ status: 'signed_in', ...(await loadProfile(services, true)) });
        } catch (error) {
          settle(error);
        }
      },
      signOut() {
        session.signOut();
      },
      async createOrganization(name) {
        try {
          await services.api.json('/v1/organizations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          });
        } catch (error) {
          return { ok: false, code: error instanceof ApiError ? error.code : 'generic' };
        }
        try {
          setState({ status: 'signed_in', ...(await loadProfile(services, false)) });
        } catch (error) {
          settle(error);
        }
        return { ok: true };
      },
      retry() {
        setState({ status: 'loading' });
        setAttempt((n) => n + 1);
      },
    }),
    [state, services, session, settle, enter],
  );

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
