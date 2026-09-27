import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AuthError } from './errors.js';

/** Public keys Google signs the OIDC ID tokens of service accounts with. */
export const GOOGLE_OIDC_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** The issuer Google puts in the OIDC ID tokens of service accounts (Cloud Tasks among others). */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Allowed clock difference between Google and this service, in seconds. */
const CLOCK_TOLERANCE_SECONDS = 5;

export interface ServiceIdentityVerifierOptions {
  /** The audience the caller was told to use: the receiving service's URL. */
  readonly audience: string;
  /** The only service accounts allowed to call. Any other signed Google identity is refused. */
  readonly allowedEmails: readonly string[];
  /** Signing keys. Defaults to Google's published keys; tests pass their own. */
  readonly keys?: JWTVerifyGetKey;
  /** Current time. Defaults to the system clock; tests pass a fixed one. */
  readonly now?: () => Date;
}

/** The service identity that signed a request, once its token is verified. */
export interface VerifiedServiceIdentity {
  readonly email: string;
}

export interface ServiceIdentityVerifier {
  verify(token: string): Promise<VerifiedServiceIdentity>;
}

/**
 * Verifies the Google-signed OIDC ID token a service account sends (ADR-0032): RS256 signature
 * against Google's keys, Google's issuer, this service's audience, expiry, and a verified email
 * that is one of the allowed service accounts. It is infrastructure authentication only: the
 * identity it returns is never a user, a tenant or an actor, and grants no permission.
 */
export function createServiceIdentityVerifier(
  options: ServiceIdentityVerifierOptions,
): ServiceIdentityVerifier {
  const { audience } = options;
  const allowed = new Set(options.allowedEmails);
  if (audience === '' || allowed.size === 0 || [...allowed].some((e) => e === '')) {
    throw new Error('A service identity verifier needs an audience and allowed emails');
  }
  const keys = options.keys ?? createRemoteJWKSet(new URL(GOOGLE_OIDC_JWKS_URL));
  const now = options.now ?? (() => new Date());

  return {
    async verify(token) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, keys, {
          algorithms: ['RS256'],
          issuer: GOOGLE_ISSUERS,
          audience,
          requiredClaims: ['iat', 'exp', 'email'],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          currentDate: now(),
        }));
      } catch (error) {
        throw new AuthError(classify(error));
      }
      const { email, email_verified: verified, iat } = payload;
      if (typeof email !== 'string' || verified !== true || !allowed.has(email)) {
        throw new AuthError('invalid_token');
      }
      // Google requires the issue time to be in the past; jose does not check it.
      if (typeof iat !== 'number' || iat > now().getTime() / 1000 + CLOCK_TOLERANCE_SECONDS) {
        throw new AuthError('invalid_token');
      }
      return Object.freeze({ email });
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
