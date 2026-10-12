import { actorOf, buildAuditEvent, type AuditService } from '@melonoffice/audit';
import { signedInRecently, type AuthenticatedContext } from '@melonoffice/auth';
import type { IsoTimestamp, UserId } from '@melonoffice/domain';
import {
  confirmationIdOf,
  isConfirmationToken,
  isPasskeyError,
  newConfirmationToken,
  newPasskeyChallengeId,
  newPasskeyId,
  PASSKEY_CHALLENGE_TTL_MS,
  PASSKEY_CONFIRMATION_TTL_MS,
  type CommercialRepository,
  type Passkey,
  type PasskeyConfirmation,
  type PasskeyPurpose,
  type PasskeyStore,
} from '@melonoffice/tenancy';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { recordOutcome, requestFields } from './audit.js';
import type { AuthEnv } from './auth.js';
import { platformAdminOf } from './platform-admin.js';

/**
 * Passkeys for sensitive administrators (ADR-0188, S-2): platform, white-label and reseller
 * administrators add passkeys and confirm with them, with the device's fingerprint, face or PIN
 * and no typed code. Once a person has a passkey, their administrative changes need a passkey
 * confirmation from the last 30 minutes (`staleSignInRefusal`); without one, a recent sign-in
 * (ADR-0138) is still what counts. A business owner never meets any of this.
 */

/** The browser's header carrying a passkey confirmation token. */
export const PASSKEY_CONFIRMATION_HEADER = 'x-melon-passkey';

/** Who the passkeys belong to: the web app's site, and the exact origins that may use them. */
export interface RelyingParty {
  /** The web app's host (or a parent domain of it), e.g. `melonoffice.io`. */
  readonly id: string;
  /** What the device shows when it asks for the passkey. */
  readonly name: string;
  readonly origins: readonly string[];
}

/**
 * The relying party from the web app's origins (`WEB_ORIGINS`): `id` is the first origin's host
 * unless one is given, and only origins on that host or below it are accepted. No origin: none.
 */
export function relyingPartyOf(
  webOrigins: readonly string[],
  id?: string,
): RelyingParty | undefined {
  const hosts = webOrigins.flatMap((origin) => {
    try {
      const url = new URL(origin);
      return url.protocol === 'https:' || url.hostname === 'localhost'
        ? [{ origin, host: url.hostname }]
        : [];
    } catch {
      return [];
    }
  });
  const rpId = id ?? hosts[0]?.host;
  if (rpId === undefined) return undefined;
  const origins = hosts
    .filter(({ host }) => host === rpId || host.endsWith(`.${rpId}`))
    .map(({ origin }) => origin);
  return origins.length === 0 ? undefined : { id: rpId, name: 'MelonOffice', origins };
}

/** What a request's person has: passkeys or not, and a live confirmation or not. */
export interface PasskeyState {
  readonly enrolled: boolean;
  readonly confirmation: PasskeyConfirmation | undefined;
}

export interface PasskeyDependencies {
  readonly store: PasskeyStore;
  readonly relyingParty: RelyingParty;
  readonly audit: AuditService;
  /** The platform administrators (ADR-0082). */
  readonly admins: ReadonlySet<string>;
  /** Commercial memberships, to know who administers a white label or a reseller (ADR-0098). */
  readonly commercial?: Pick<CommercialRepository, 'membershipsOfUser' | 'findAccount'>;
  readonly now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHALLENGE_ID = UUID;

const changes = (method: string) => method !== 'GET' && method !== 'HEAD';

/**
 * Before the routes it covers: reads the person's passkeys and the confirmation their browser
 * sent, once, for every change to platform or commercial administration and for the passkey
 * routes themselves. `staleSignInRefusal` decides with it.
 */
export function passkeyStateMiddleware(deps: PasskeyDependencies): MiddlewareHandler<AuthEnv> {
  const now = deps.now ?? (() => new Date());
  return async (c, next) => {
    const auth = c.get('auth');
    const covered =
      c.req.path.startsWith('/v1/me/passkeys') ||
      (changes(c.req.method) &&
        (c.req.path.startsWith('/v1/platform/') || c.req.path.startsWith('/v1/commercial/')));
    if (auth === undefined || auth.actor !== 'user' || !covered) return next();
    c.set(
      'passkey',
      await stateOf(deps, auth.userId, c.req.header(PASSKEY_CONFIRMATION_HEADER), now()),
    );
    return next();
  };
}

async function stateOf(
  deps: PasskeyDependencies,
  userId: UserId,
  token: string | undefined,
  at: Date,
): Promise<PasskeyState> {
  const passkeys = await deps.store.passkeysOf(userId);
  if (passkeys.length === 0) return { enrolled: false, confirmation: undefined };
  const found = isConfirmationToken(token)
    ? await deps.store.findConfirmation(confirmationIdOf(token), at)
    : undefined;
  // A confirmation counts only for its own person and while that passkey still exists.
  const confirmation =
    found !== undefined && found.userId === userId && passkeys.some((p) => p.id === found.passkeyId)
      ? found
      : undefined;
  return { enrolled: true, confirmation };
}

/** A passkey as its person sees it: never its key or credential id. */
const passkeyView = (p: Passkey) => ({
  id: p.id,
  createdAt: p.createdAt,
  lastUsedAt: p.lastUsedAt,
});

const body = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> => {
  const value: unknown = await c.req.json().catch(() => undefined);
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const isResponseJson = (value: unknown): value is { readonly id: string; readonly type: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { id?: unknown }).id === 'string' &&
  (value as { type?: unknown }).type === 'public-key';

export function registerPasskeyRoutes(app: Hono<AuthEnv>, deps: PasskeyDependencies): void {
  const { store, relyingParty: rp, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const base = '/v1/me/passkeys';

  /** Platform administrators and active white-label or reseller members, with a verified email. */
  const administers = async (auth: AuthenticatedContext): Promise<boolean> => {
    if (auth.actor !== 'user' || !auth.emailVerified) return false;
    if (deps.admins.has(auth.userId)) return true;
    for (const m of (await deps.commercial?.membershipsOfUser(auth.userId)) ?? []) {
      if (m.status !== 'active' || m.userId !== auth.userId) continue;
      const account = await deps.commercial?.findAccount(m.commercialAccountId);
      if (account?.status === 'active') return true;
    }
    return false;
  };

  const denied = (
    c: Context<AuthEnv>,
    action: 'auth.passkey_added' | 'auth.passkey_confirmed' | 'auth.passkey_removed',
    reason: string,
    reference?: string,
  ) =>
    recordOutcome(c, audit, {
      action,
      result: 'denied',
      actor: actorOf(c.get('auth')),
      reason,
      ...(reference === undefined ? {} : { reference }),
      ...requestFields(c),
    });

  /**
   * Adding a passkey is itself sensitive: with passkeys already, it needs a passkey confirmation;
   * without, a recent sign-in. Answers the refusal, or undefined.
   */
  const refuseToAdd = async (c: Context<AuthEnv>): Promise<Response | undefined> => {
    const auth = c.get('auth');
    if (!(await administers(auth))) {
      await denied(c, 'auth.passkey_added', 'not_administrator');
      return c.json({ error: 'passkey_forbidden' }, 403);
    }
    const state = c.get('passkey');
    if (state?.enrolled === true) {
      if (state.confirmation !== undefined) return undefined;
      await denied(c, 'auth.passkey_added', 'passkey_required');
      return c.json({ error: 'passkey_required' }, 403);
    }
    if (signedInRecently(auth, now())) return undefined;
    await denied(c, 'auth.passkey_added', 'reauthentication_required');
    return c.json({ error: 'reauthentication_required' }, 403);
  };

  const challengeFor = async (userId: UserId, purpose: PasskeyPurpose, challenge: string) => {
    const id = newPasskeyChallengeId();
    await store.saveChallenge({
      id,
      userId,
      purpose,
      challenge,
      expiresAt: new Date(now().getTime() + PASSKEY_CHALLENGE_TTL_MS).toISOString() as IsoTimestamp,
    });
    return id;
  };

  // The person's passkeys and whether they may have any: the screen shows the section from this.
  app.get(base, async (c) => {
    const auth = c.get('auth');
    if (auth.actor !== 'user') return c.json({ error: 'passkey_forbidden' }, 403);
    const [passkeys, administrator] = await Promise.all([
      store.passkeysOf(auth.userId),
      administers(auth),
    ]);
    return c.json({
      available: true,
      administrator,
      passkeys: passkeys.map(passkeyView),
      confirmedUntil: c.get('passkey')?.confirmation?.expiresAt ?? null,
    });
  });

  // Step 1 of adding a passkey: what the device must sign.
  app.post(`${base}/registration-options`, async (c) => {
    const refused = await refuseToAdd(c);
    if (refused !== undefined) return refused;
    const auth = c.get('auth');
    const existing = await store.passkeysOf(auth.userId);
    const options = await generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      userName: auth.email ?? auth.userId,
      userID: new TextEncoder().encode(auth.userId),
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({
        id: p.credentialId,
        transports: [...p.transports],
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    const challengeId = await challengeFor(auth.userId, 'register', options.challenge);
    return c.json({ challengeId, options });
  });

  // Step 2: the device's answer. Only its public key is kept.
  app.post(base, async (c) => {
    const refused = await refuseToAdd(c);
    if (refused !== undefined) return refused;
    const auth = c.get('auth');
    const input = await body(c);
    const challenge =
      typeof input.challengeId === 'string' && CHALLENGE_ID.test(input.challengeId)
        ? await store.takeChallenge(input.challengeId, auth.userId, 'register', now())
        : undefined;
    if (challenge === undefined) return c.json({ error: 'passkey_challenge_invalid' }, 400);
    if (!isResponseJson(input.response)) return c.json({ error: 'passkey_not_verified' }, 400);
    let credential;
    try {
      const verified = await verifyRegistrationResponse({
        response: input.response as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: [...rp.origins],
        expectedRPID: rp.id,
        requireUserVerification: true,
      });
      if (!verified.verified) throw new Error('not verified');
      credential = verified.registrationInfo.credential;
    } catch {
      await denied(c, 'auth.passkey_added', 'not_verified');
      return c.json({ error: 'passkey_not_verified' }, 400);
    }
    const at = now();
    const iso = at.toISOString() as IsoTimestamp;
    const passkey: Passkey = {
      id: newPasskeyId(),
      userId: auth.userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: (credential.transports ?? []).slice(0, 8),
      createdAt: iso,
      lastUsedAt: null,
    };
    try {
      await store.addPasskey(passkey, [
        buildAuditEvent(
          {
            action: 'auth.passkey_added',
            result: 'success',
            actor: actorOf(auth),
            target: { type: 'user', id: auth.userId },
            reference: passkey.id,
            ...requestFields(c),
          },
          at,
        ),
      ]);
    } catch (error) {
      if (!isPasskeyError(error)) throw error;
      return c.json({ error: error.code }, 409);
    }
    return c.json({ passkey: passkeyView(passkey) }, 201);
  });

  // Step 1 of confirming: what one of the person's passkeys must sign.
  app.post(`${base}/confirmation-options`, async (c) => {
    const auth = c.get('auth');
    if (auth.actor !== 'user') return c.json({ error: 'passkey_forbidden' }, 403);
    const passkeys = await store.passkeysOf(auth.userId);
    if (passkeys.length === 0) return c.json({ error: 'passkey_none' }, 409);
    const options = await generateAuthenticationOptions({
      rpID: rp.id,
      allowCredentials: passkeys.map((p) => ({
        id: p.credentialId,
        transports: [...p.transports],
      })),
      userVerification: 'required',
    });
    const challengeId = await challengeFor(auth.userId, 'confirm', options.challenge);
    return c.json({ challengeId, options });
  });

  // Step 2: the signed answer. A good one gives the browser a confirmation for 30 minutes.
  app.post(`${base}/confirmations`, async (c) => {
    const auth = c.get('auth');
    if (auth.actor !== 'user') return c.json({ error: 'passkey_forbidden' }, 403);
    const input = await body(c);
    const challenge =
      typeof input.challengeId === 'string' && CHALLENGE_ID.test(input.challengeId)
        ? await store.takeChallenge(input.challengeId, auth.userId, 'confirm', now())
        : undefined;
    if (challenge === undefined) return c.json({ error: 'passkey_challenge_invalid' }, 400);
    const response = input.response;
    const passkey = isResponseJson(response)
      ? (await store.passkeysOf(auth.userId)).find((p) => p.credentialId === response.id)
      : undefined;
    if (passkey === undefined) {
      await denied(c, 'auth.passkey_confirmed', 'unknown_passkey');
      return c.json({ error: 'passkey_not_verified' }, 400);
    }
    let counter: number;
    try {
      const verified = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: [...rp.origins],
        expectedRPID: rp.id,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
          counter: passkey.counter,
          transports: [...passkey.transports],
        },
        requireUserVerification: true,
      });
      if (!verified.verified) throw new Error('not verified');
      counter = verified.authenticationInfo.newCounter;
    } catch {
      await denied(c, 'auth.passkey_confirmed', 'not_verified', passkey.id);
      return c.json({ error: 'passkey_not_verified' }, 400);
    }
    const at = now();
    const { token, id } = newConfirmationToken();
    const confirmation: PasskeyConfirmation = {
      id,
      userId: auth.userId,
      passkeyId: passkey.id,
      confirmedAt: at.toISOString() as IsoTimestamp,
      expiresAt: new Date(at.getTime() + PASSKEY_CONFIRMATION_TTL_MS).toISOString() as IsoTimestamp,
    };
    try {
      await store.confirm(passkey, counter, confirmation, [
        buildAuditEvent(
          {
            action: 'auth.passkey_confirmed',
            result: 'success',
            actor: actorOf(auth),
            target: { type: 'user', id: auth.userId },
            reference: passkey.id,
            ...requestFields(c),
          },
          at,
        ),
      ]);
    } catch (error) {
      if (!isPasskeyError(error)) throw error;
      return c.json({ error: 'passkey_not_verified' }, 400);
    }
    return c.json({ token, expiresAt: confirmation.expiresAt }, 201);
  });

  // Removing one: only right after confirming with a passkey, so a password alone never does it.
  app.delete(`${base}/:passkeyId`, async (c) => {
    const auth = c.get('auth');
    if (auth.actor !== 'user') return c.json({ error: 'passkey_forbidden' }, 403);
    const passkeyId = c.req.param('passkeyId');
    if (!UUID.test(passkeyId)) return c.json({ error: 'passkey_not_found' }, 404);
    if (c.get('passkey')?.confirmation === undefined) {
      await denied(c, 'auth.passkey_removed', 'passkey_required', passkeyId);
      return c.json({ error: 'passkey_required' }, 403);
    }
    const at = now();
    const removed = await store.removePasskeys(auth.userId, passkeyId, [
      buildAuditEvent(
        {
          action: 'auth.passkey_removed',
          result: 'success',
          actor: actorOf(auth),
          target: { type: 'user', id: auth.userId },
          reference: passkeyId,
          ...requestFields(c),
        },
        at,
      ),
    ]);
    return removed === 0 ? c.json({ error: 'passkey_not_found' }, 404) : c.json({ removed });
  });

  // A person who lost every passkey: a platform administrator removes them all, audited.
  app.post('/v1/platform/users/:userId/passkeys/reset', async (c) => {
    const admin = await platformAdminOf(
      c,
      deps.admins,
      { audit, action: 'auth.passkeys_reset' },
      now,
    );
    if (admin instanceof Response) return admin;
    const userId = c.req.param('userId');
    if (!UUID.test(userId)) return c.json({ error: 'invalid_user' }, 400);
    const at = now();
    const removed = await store.removePasskeys(userId as UserId, undefined, [
      buildAuditEvent(
        {
          action: 'auth.passkeys_reset',
          result: 'success',
          actor: actorOf(c.get('auth')),
          target: { type: 'user', id: userId },
          ...requestFields(c),
        },
        at,
      ),
    ]);
    return c.json({ removed });
  });
}
