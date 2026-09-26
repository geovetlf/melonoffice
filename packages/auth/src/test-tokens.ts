import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

export const PROJECT_ID = 'melonoffice-test';
/** A fixed "now" so expiry checks do not depend on the machine clock. */
export const NOW = new Date('2026-09-26T12:00:00Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);

/** A signing key and its public JWKS, standing in for Google's keys. */
export async function createSigner(kid = 'test-key') {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });

  /** Signs an Identity Platform-shaped ID token; `claims` override or, with undefined, remove defaults. */
  async function sign(
    claims: Record<string, unknown> = {},
    header: { kid?: string } = {},
  ): Promise<string> {
    const merged: Record<string, unknown> = {
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: 'uid-alice',
      iat: nowSeconds - 60,
      exp: nowSeconds + 3600,
      auth_time: nowSeconds - 60,
      email: 'alice@example.com',
      email_verified: true,
      firebase: { sign_in_provider: 'password', identities: {} },
      ...claims,
    };
    const payload = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined),
    );
    return new SignJWT(payload as JWTPayload)
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: header.kid ?? kid })
      .sign(privateKey);
  }

  return { keys, sign };
}

export { nowSeconds };
