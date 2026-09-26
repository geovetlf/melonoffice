import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AuthError } from './errors.js';
import type { IdTokenVerifier, VerifiedIdentity } from './identity.js';

/** Public keys Google signs Identity Platform (Firebase Auth) ID tokens with. */
export const IDENTITY_PLATFORM_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/** Only email and password sign-in is enabled (ADR-0014). Tokens from any other method are rejected. */
const ALLOWED_SIGN_IN_PROVIDERS = new Set(['password']);

/** Allowed clock difference between Google and this service, in seconds. */
const CLOCK_TOLERANCE_SECONDS = 5;

const MAX_SUBJECT_LENGTH = 128;

export interface IdentityPlatformVerifierOptions {
  /** The Google Cloud project whose Identity Platform issues the tokens. */
  readonly projectId: string;
  /** Signing keys. Defaults to Google's published keys; tests pass their own. */
  readonly keys?: JWTVerifyGetKey;
  /** Current time. Defaults to the system clock; tests pass a fixed one. */
  readonly now?: () => Date;
}

interface FirebaseClaim {
  readonly sign_in_provider?: unknown;
  readonly tenant?: unknown;
}

/**
 * Verifies Identity Platform ID tokens locally: RS256 signature against Google's keys, issuer and
 * audience of this project, expiry, and the checks Google documents for these tokens. It never
 * trusts anything in the token before the signature is verified.
 */
export function createIdentityPlatformVerifier(
  options: IdentityPlatformVerifierOptions,
): IdTokenVerifier {
  const { projectId } = options;
  const keys = options.keys ?? createRemoteJWKSet(new URL(IDENTITY_PLATFORM_JWKS_URL));
  const now = options.now ?? (() => new Date());

  return {
    async verify(token) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, keys, {
          algorithms: ['RS256'],
          issuer: `https://securetoken.google.com/${projectId}`,
          audience: projectId,
          requiredClaims: ['sub', 'iat', 'exp', 'auth_time'],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          currentDate: now(),
        }));
      } catch (error) {
        throw new AuthError(classify(error));
      }
      return toIdentity(payload, now());
    },
  };
}

function classify(error: unknown): 'token_expired' | 'invalid_token' | 'verifier_unavailable' {
  if (error instanceof errors.JWTExpired) return 'token_expired';
  // Google's keys could not be fetched: the token may be fine, so this is not the caller's fault.
  if (error instanceof errors.JWKSTimeout) return 'verifier_unavailable';
  if (error instanceof errors.JOSEError) return 'invalid_token';
  return 'verifier_unavailable';
}

function toIdentity(payload: JWTPayload, now: Date): VerifiedIdentity {
  const subject = payload.sub;
  if (typeof subject !== 'string' || subject === '' || subject.length > MAX_SUBJECT_LENGTH) {
    throw new AuthError('invalid_token');
  }
  // Google requires both times to be in the past; jose checks neither.
  const latest = now.getTime() / 1000 + CLOCK_TOLERANCE_SECONDS;
  const { auth_time: authTime, iat } = payload;
  if (typeof authTime !== 'number' || authTime > latest) throw new AuthError('invalid_token');
  if (typeof iat !== 'number' || iat > latest) throw new AuthError('invalid_token');

  const firebase = payload.firebase as FirebaseClaim | undefined;
  if (
    typeof firebase?.sign_in_provider !== 'string' ||
    !ALLOWED_SIGN_IN_PROVIDERS.has(firebase.sign_in_provider)
  ) {
    throw new AuthError('invalid_token');
  }
  // Identity Platform tenants are not used; a tenant token belongs to some other setup.
  if (firebase.tenant !== undefined) throw new AuthError('invalid_token');

  const email = typeof payload.email === 'string' ? payload.email : undefined;
  return {
    subject,
    ...(email === undefined ? {} : { email }),
    emailVerified: payload.email_verified === true,
  };
}
