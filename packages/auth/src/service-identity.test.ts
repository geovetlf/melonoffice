import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';
import { AuthError } from './errors.js';
import { createServiceIdentityVerifier } from './service-identity.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const nowSeconds = Math.floor(NOW.getTime() / 1000);
const AUDIENCE = 'https://worker-123.test-region.run.app';
const INVOKER = 'job-dispatch@test-project.iam.gserviceaccount.com';

async function signer(kid = 'google-key') {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return {
    keys: createLocalJWKSet({ keys: [jwk] }),
    async sign(claims: Record<string, unknown> = {}, alg = 'RS256') {
      const merged: Record<string, unknown> = {
        iss: 'https://accounts.google.com',
        aud: AUDIENCE,
        sub: '1234567890',
        email: INVOKER,
        email_verified: true,
        iat: nowSeconds - 30,
        exp: nowSeconds + 3600,
        ...claims,
      };
      const payload = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
      return new SignJWT(payload as JWTPayload)
        .setProtectedHeader({ alg, typ: 'JWT', kid })
        .sign(privateKey);
    },
  };
}

async function setup() {
  const google = await signer();
  const verifier = createServiceIdentityVerifier({
    audience: AUDIENCE,
    allowedEmails: [INVOKER],
    keys: google.keys,
    now: () => NOW,
  });
  return { ...google, verifier };
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

describe('service identity (OIDC) verification', () => {
  it('accepts a Google-signed token of the allowed service account for this audience', async () => {
    const { sign, verifier } = await setup();
    expect(await verifier.verify(await sign())).toEqual({ email: INVOKER });
    expect(await verifier.verify(await sign({ iss: 'accounts.google.com' }))).toEqual({
      email: INVOKER,
    });
  });

  it('refuses another service account, even a valid Google one', async () => {
    const { sign, verifier } = await setup();
    expect(
      await codeOf(
        verifier.verify(await sign({ email: 'other@test-project.iam.gserviceaccount.com' })),
      ),
    ).toBe('invalid_token');
  });

  it('refuses an unverified or missing email', async () => {
    const { sign, verifier } = await setup();
    expect(await codeOf(verifier.verify(await sign({ email_verified: false })))).toBe(
      'invalid_token',
    );
    expect(await codeOf(verifier.verify(await sign({ email_verified: undefined })))).toBe(
      'invalid_token',
    );
    expect(await codeOf(verifier.verify(await sign({ email: undefined })))).toBe('invalid_token');
  });

  it('refuses another audience, another issuer, an expired token and a future one', async () => {
    const { sign, verifier } = await setup();
    expect(await codeOf(verifier.verify(await sign({ aud: 'https://api.example' })))).toBe(
      'invalid_token',
    );
    expect(
      await codeOf(verifier.verify(await sign({ iss: 'https://securetoken.google.com/x' }))),
    ).toBe('invalid_token');
    expect(await codeOf(verifier.verify(await sign({ exp: nowSeconds - 60 })))).toBe(
      'token_expired',
    );
    expect(await codeOf(verifier.verify(await sign({ iat: nowSeconds + 600 })))).toBe(
      'invalid_token',
    );
  });

  it('refuses a token signed by any other key, and garbage', async () => {
    const { verifier } = await setup();
    const forger = await signer('google-key');
    expect(await codeOf(verifier.verify(await forger.sign()))).toBe('invalid_token');
    expect(await codeOf(verifier.verify('not-a-token'))).toBe('invalid_token');
  });

  it('needs an audience and at least one allowed service account', () => {
    expect(() =>
      createServiceIdentityVerifier({ audience: '', allowedEmails: [INVOKER] }),
    ).toThrow();
    expect(() =>
      createServiceIdentityVerifier({ audience: AUDIENCE, allowedEmails: [] }),
    ).toThrow();
  });
});
