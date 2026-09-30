import { SignJWT, base64url } from 'jose';
import { describe, expect, it } from 'vitest';
import { AuthError } from './errors.js';
import { createIdentityPlatformVerifier } from './identity-platform.js';
import { readBearerToken } from './identity.js';
import { createSigner, NOW, nowSeconds, PROJECT_ID } from './test-tokens.js';

async function setup() {
  const signer = await createSigner();
  const verifier = createIdentityPlatformVerifier({
    projectId: PROJECT_ID,
    keys: signer.keys,
    now: () => NOW,
  });
  return { ...signer, verifier };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('Identity Platform ID token verification', () => {
  it('accepts a valid token and returns the identity in it', async () => {
    const { sign, verifier } = await setup();
    expect(await verifier.verify(await sign())).toEqual({
      subject: 'uid-alice',
      email: 'alice@example.com',
      emailVerified: true,
    });
  });

  it('accepts a Google sign-in (ADR-0105)', async () => {
    const { sign, verifier } = await setup();
    expect(
      await verifier.verify(await sign({ firebase: { sign_in_provider: 'google.com' } })),
    ).toEqual({ subject: 'uid-alice', email: 'alice@example.com', emailVerified: true });
  });

  it('reports an unverified or missing email as such', async () => {
    const { sign, verifier } = await setup();
    const identity = await verifier.verify(
      await sign({ email: undefined, email_verified: undefined }),
    );
    expect(identity).toEqual({ subject: 'uid-alice', emailVerified: false });
  });

  it('rejects an expired token as expired', async () => {
    const { sign, verifier } = await setup();
    const token = await sign({ iat: nowSeconds - 7200, exp: nowSeconds - 3600 });
    expect(await codeOf(verifier.verify(token))).toBe('token_expired');
  });

  it.each([
    ['another project as audience', { aud: 'other-project' }],
    ['another issuer', { iss: 'https://securetoken.google.com/other-project' }],
    ['a non-Google issuer', { iss: 'https://evil.example.com' }],
    ['no subject', { sub: undefined }],
    ['an empty subject', { sub: '' }],
    ['a subject over 128 characters', { sub: 'x'.repeat(129) }],
    ['no auth_time', { auth_time: undefined }],
    ['an auth_time in the future', { auth_time: nowSeconds + 600 }],
    ['an iat in the future', { iat: nowSeconds + 600 }],
    ['an anonymous sign-in', { firebase: { sign_in_provider: 'anonymous' } }],
    ['a custom-token sign-in', { firebase: { sign_in_provider: 'custom' } }],
    ['a phone sign-in', { firebase: { sign_in_provider: 'phone' } }],
    ['another identity provider', { firebase: { sign_in_provider: 'facebook.com' } }],
    ['no firebase claim', { firebase: undefined }],
    ['an Identity Platform tenant', { firebase: { sign_in_provider: 'password', tenant: 't1' } }],
  ])('rejects a token with %s', async (_name, claims) => {
    const { sign, verifier } = await setup();
    expect(await codeOf(verifier.verify(await sign(claims)))).toBe('invalid_token');
  });

  it('rejects a token signed by a key Google does not publish', async () => {
    const { verifier } = await setup();
    const forger = await createSigner('test-key');
    expect(await codeOf(verifier.verify(await forger.sign()))).toBe('invalid_token');
  });

  it('rejects a token whose key id is unknown', async () => {
    const { sign, verifier } = await setup();
    expect(await codeOf(verifier.verify(await sign({}, { kid: 'other' })))).toBe('invalid_token');
  });

  it('rejects a token whose payload was changed after signing', async () => {
    const { sign, verifier } = await setup();
    const [header, , signature] = (await sign()).split('.');
    const payload = base64url.encode(
      JSON.stringify({ sub: 'uid-mallory', aud: PROJECT_ID, exp: nowSeconds + 3600 }),
    );
    expect(await codeOf(verifier.verify(`${header}.${payload}.${signature}`))).toBe(
      'invalid_token',
    );
  });

  it('rejects unsigned and symmetric-key tokens', async () => {
    const { verifier } = await setup();
    const claims = { sub: 'uid-alice', aud: PROJECT_ID, exp: nowSeconds + 3600 };
    const none = `${base64url.encode('{"alg":"none"}')}.${base64url.encode(JSON.stringify(claims))}.`;
    expect(await codeOf(verifier.verify(none))).toBe('invalid_token');
    const hmac = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
      .sign(new TextEncoder().encode('a-shared-secret-of-enough-length!!'));
    expect(await codeOf(verifier.verify(hmac))).toBe('invalid_token');
  });

  it('rejects garbage', async () => {
    const { verifier } = await setup();
    expect(await codeOf(verifier.verify('not-a-token'))).toBe('invalid_token');
  });

  it('reports a failure to reach the signing keys as unavailable, not as a bad token', async () => {
    const { sign } = await setup();
    const verifier = createIdentityPlatformVerifier({
      projectId: PROJECT_ID,
      keys: async () => {
        throw new TypeError('fetch failed');
      },
      now: () => NOW,
    });
    expect(await codeOf(verifier.verify(await sign()))).toBe('verifier_unavailable');
  });
});

describe('readBearerToken', () => {
  it('reads a bearer token', () => {
    expect(readBearerToken('Bearer abc.def-ghi_jkl')).toBe('abc.def-ghi_jkl');
  });

  it('treats an absent header as missing', () => {
    expect(readBearerToken(undefined)).toBeUndefined();
    expect(readBearerToken('')).toBeUndefined();
  });

  it.each(['Basic abc', 'Bearer', 'Bearer ', 'bearer abc', 'Bearer a b', 'Bearer abc\n'])(
    'treats %j as malformed',
    (header) => {
      expect(readBearerToken(header)).toBeNull();
    },
  );
});
