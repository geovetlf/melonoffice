import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { relyingPartyOf } from './passkeys.js';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Passkeys for sensitive administrators (ADR-0188). A software authenticator below plays the
 * person's device: it signs exactly what a phone or laptop would, so the API's real WebAuthn
 * verification runs. Alice is the platform administrator; Carol runs White Label A; Heidi owns
 * Company H and administers nothing. `token-<who>-stale` is the same person signed in long ago.
 */
type Body = Record<string, unknown> & { error?: string };

const ORIGIN = 'https://app.melonoffice.test';
const RP_ID = 'app.melonoffice.test';
const KEY = '44444444-4444-4444-8444-444444444444';

// ---------------------------------------------------------------- a tiny CBOR encoder

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const parts = [head(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- the software authenticator

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest();

/** One passkey on one device: a P-256 key pair and its signature counter. */
class Device {
  readonly credentialId = randomBytes(16);
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  #counter = 0;

  constructor(
    readonly origin = ORIGIN,
    readonly rpId = RP_ID,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
  }

  #clientData(type: string, challenge: string) {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }),
      'utf8',
    );
  }

  #authData(attested: boolean) {
    this.#counter += 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.#counter);
    // User present (0x01) and verified (0x04, the fingerprint or PIN); 0x40 with a new key.
    const flags = Buffer.from([0x01 | 0x04 | (attested ? 0x40 : 0)]);
    const parts: Uint8Array[] = [sha256(this.rpId), flags, count];
    if (attested) {
      const jwk = this.#publicKey.export({ format: 'jwk' });
      const cose = new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, 'base64url')],
        [-3, Buffer.from(jwk.y as string, 'base64url')],
      ]);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), length, this.credentialId, cbor(cose));
    }
    return Buffer.concat(parts);
  }

  /** The answer to registration options, as `startRegistration` gives it. */
  register(options: { challenge: string }) {
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', this.#authData(true)],
      ]),
    );
    return {
      id: b64(this.credentialId),
      rawId: b64(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64(this.#clientData('webauthn.create', options.challenge)),
        attestationObject: b64(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** The answer to confirmation options, as `startAuthentication` gives it. */
  confirm(options: { challenge: string }) {
    const clientData = this.#clientData('webauthn.get', options.challenge);
    const authData = this.#authData(false);
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientData)]),
      this.#privateKey,
    );
    return {
      id: b64(this.credentialId),
      rawId: b64(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(signature),
      },
      clientExtensionResults: {},
    };
  }
}

// ---------------------------------------------------------------- the API under test

describe('the relying party comes from the web origins', () => {
  it('uses the first origin host, keeps only origins under it, and needs https', () => {
    expect(relyingPartyOf([])).toBeUndefined();
    expect(relyingPartyOf(['http://evil.example'])).toBeUndefined();
    expect(relyingPartyOf(['https://app.melonoffice.io', 'https://other.example'])).toEqual({
      id: 'app.melonoffice.io',
      name: 'MelonOffice',
      origins: ['https://app.melonoffice.io'],
    });
    expect(
      relyingPartyOf(['https://app.melonoffice.io', 'https://melonoffice.io'], 'melonoffice.io'),
    ).toMatchObject({ origins: ['https://app.melonoffice.io', 'https://melonoffice.io'] });
  });
});

describe.each(STORES)('passkeys for sensitive administrators with storage in %s', (_n, create) => {
  async function setup() {
    const stores: Stores = create();
    const first = setupApp(stores);
    const ids: Record<string, string> = {};
    for (const who of ['alice', 'carol', 'heidi']) ids[who] = await first.register(`token-${who}`);
    const ctx = setupApp(stores, undefined, undefined, undefined, undefined, {
      platformAdmins: [ids.alice as string],
      webOrigins: [ORIGIN],
    });
    const call = async (
      token: string,
      method: string,
      path: string,
      body?: unknown,
      confirmation?: string,
    ) => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (confirmation !== undefined) headers['x-melon-passkey'] = confirmation;
      const response = await ctx.app.request(
        path,
        ctx.as(`token-${token}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return { status: response.status, body: (await response.json()) as Body };
    };
    /** Adds a passkey on `device`, sending `confirmation` when the person already has one. */
    const add = async (who: string, device: Device, confirmation?: string) => {
      const options = await call(
        who,
        'POST',
        '/v1/me/passkeys/registration-options',
        {},
        confirmation,
      );
      if (options.status !== 200) return options;
      const { challengeId, options: o } = options.body as {
        challengeId: string;
        options: { challenge: string };
      };
      return call(
        who,
        'POST',
        '/v1/me/passkeys',
        { challengeId, response: device.register(o) },
        confirmation,
      );
    };
    /** Confirms with `device`: the token for 30 minutes, or the refusal. */
    const confirm = async (who: string, device: Device) => {
      const options = await call(who, 'POST', '/v1/me/passkeys/confirmation-options', {});
      if (options.status !== 200) return options;
      const { challengeId, options: o } = options.body as {
        challengeId: string;
        options: { challenge: string };
      };
      return call(who, 'POST', '/v1/me/passkeys/confirmations', {
        challengeId,
        response: device.confirm(o),
      });
    };
    const created = await call('alice', 'POST', '/v1/platform/commercial-accounts', {
      type: 'white_label',
      name: 'Acme AI',
      adminUserId: ids.carol,
      limits: { customers: 5, members: 3, resellers: 2 },
    });
    expect(created.status).toBe(201);
    const wl = (created.body.account as { id: string }).id;
    const tenant = (
      (await call('heidi', 'POST', '/v1/organizations', { name: 'Company H' })).body
        .organization as { id: string }
    ).id;
    return { stores, ids, call, add, confirm, wl, tenant };
  }

  it('an administrator adds a passkey after a recent sign-in; only its public part is kept', async () => {
    const { stores, ids, call, add } = await setup();
    expect((await call('alice', 'GET', '/v1/me/passkeys')).body).toEqual({
      available: true,
      administrator: true,
      passkeys: [],
      confirmedUntil: null,
    });
    // An old sign-in is not enough to add the first one.
    expect((await add('alice-stale', new Device())).body).toEqual({
      error: 'reauthentication_required',
    });
    const added = await add('alice', new Device());
    expect(added.status).toBe(201);
    const listed = (await call('alice', 'GET', '/v1/me/passkeys')).body.passkeys as unknown[];
    expect(listed).toEqual([
      { id: expect.any(String), createdAt: expect.any(String), lastUsedAt: null },
    ]);
    const [stored] = await stores.passkeys.passkeysOf(ids.alice as never);
    expect(stored).toMatchObject({ userId: ids.alice, counter: 1, transports: ['internal'] });
    expect(JSON.stringify(listed)).not.toContain(stored?.publicKey);
    expect(await stores.auditEvents()).toContainEqual(
      expect.objectContaining({
        action: 'auth.passkey_added',
        result: 'success',
        target: { type: 'user', id: ids.alice },
        reference: stored?.id,
      }),
    );
  });

  it('a business owner who administers nothing cannot add one', async () => {
    const { call, add } = await setup();
    expect((await call('heidi', 'GET', '/v1/me/passkeys')).body).toMatchObject({
      administrator: false,
    });
    expect(await add('heidi', new Device())).toEqual({
      status: 403,
      body: { error: 'passkey_forbidden' },
    });
  });

  it('with a passkey, changes need a passkey confirmation; a fresh password sign-in is no longer enough', async () => {
    const { stores, ids, call, add, confirm, tenant } = await setup();
    const device = new Device();
    expect((await add('alice', device)).status).toBe(201);
    const grants = `/v1/platform/organizations/${tenant}/credit-grants`;
    const request = { amount: 100, reason: 'manual_purchase', idempotencyKey: KEY };

    expect(await call('alice', 'POST', grants, request)).toEqual({
      status: 403,
      body: { error: 'passkey_required' },
    });
    expect(await stores.auditEvents()).toContainEqual(
      expect.objectContaining({
        action: 'credits.platform_grant',
        result: 'denied',
        reason: 'passkey_required',
      }),
    );
    // Reads never ask.
    expect((await call('alice', 'GET', '/v1/platform/commercial-accounts')).status).toBe(200);

    const confirmed = await confirm('alice', device);
    expect(confirmed.status).toBe(201);
    const token = confirmed.body.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Even an old password sign-in goes through with a fresh passkey confirmation.
    expect((await call('alice-stale', 'POST', grants, request, token)).status).toBe(201);
    expect(await stores.auditEvents()).toContainEqual(
      expect.objectContaining({ action: 'auth.passkey_confirmed', result: 'success' }),
    );
    const [stored] = await stores.passkeys.passkeysOf(ids.alice as never);
    expect(stored).toMatchObject({ counter: 2, lastUsedAt: expect.any(String) });
    // Only the token's hash is stored: the token itself is nowhere in the audit trail.
    expect(await stores.storedAudit()).not.toContain(token);
  });

  it("covers a white label's changes too, and one person's confirmation never serves another", async () => {
    const { call, add, confirm, wl } = await setup();
    const aliceDevice = new Device();
    const carolDevice = new Device();
    expect((await add('alice', aliceDevice)).status).toBe(201);
    expect((await add('carol', carolDevice)).status).toBe(201);
    const brand = { config: { brandName: 'Acme AI' }, expectedUpdatedAt: null };
    const path = `/v1/commercial/accounts/${wl}/brand`;
    expect((await call('carol', 'PUT', path, brand)).body).toEqual({ error: 'passkey_required' });

    const aliceToken = (await confirm('alice', aliceDevice)).body.token as string;
    expect((await call('carol', 'PUT', path, brand, aliceToken)).body).toEqual({
      error: 'passkey_required',
    });
    // A device can only answer for its own passkey.
    expect((await confirm('carol', aliceDevice)).body).toEqual({ error: 'passkey_not_verified' });
    const carolToken = (await confirm('carol', carolDevice)).body.token as string;
    expect((await call('carol', 'PUT', path, brand, carolToken)).status).toBe(200);
  });

  it('refuses answers from another site, a reused challenge and a garbled signature', async () => {
    const { call, add } = await setup();
    const phishing = new Device('https://app.melonoffice.test.evil.example');
    expect((await add('alice', phishing)).body).toEqual({ error: 'passkey_not_verified' });

    const device = new Device();
    const options = await call('alice', 'POST', '/v1/me/passkeys/registration-options', {});
    const { challengeId, options: o } = options.body as {
      challengeId: string;
      options: { challenge: string };
    };
    const answer = device.register(o);
    expect(
      (await call('alice', 'POST', '/v1/me/passkeys', { challengeId, response: answer })).status,
    ).toBe(201);
    // The same answer again is refused: with a passkey now, adding needs a confirmation first.
    expect(
      (await call('alice', 'POST', '/v1/me/passkeys', { challengeId, response: answer })).status,
    ).toBe(403);

    const confirmOptions = await call('alice', 'POST', '/v1/me/passkeys/confirmation-options', {});
    const c = confirmOptions.body as { challengeId: string; options: { challenge: string } };
    const signed = device.confirm(c.options);
    const garbled = {
      ...signed,
      response: { ...signed.response, signature: b64(randomBytes(70)) },
    };
    expect(
      (
        await call('alice', 'POST', '/v1/me/passkeys/confirmations', {
          challengeId: c.challengeId,
          response: garbled,
        })
      ).body,
    ).toEqual({ error: 'passkey_not_verified' });
    // A challenge works once, even after a refused answer.
    expect(
      (
        await call('alice', 'POST', '/v1/me/passkeys/confirmations', {
          challengeId: c.challengeId,
          response: signed,
        })
      ).body,
    ).toEqual({ error: 'passkey_challenge_invalid' });
  });

  it('a second passkey and a removal need a passkey confirmation; removal ends its confirmations', async () => {
    const { stores, call, add, confirm, tenant } = await setup();
    const phone = new Device();
    const laptop = new Device();
    expect((await add('alice', phone)).status).toBe(201);
    // With a passkey already, a recent password sign-in alone cannot add another.
    expect((await add('alice', laptop)).body).toEqual({ error: 'passkey_required' });
    const token = (await confirm('alice', phone)).body.token as string;
    expect((await add('alice', laptop, token)).status).toBe(201);

    const listed = (await call('alice', 'GET', '/v1/me/passkeys', undefined, token)).body;
    expect(listed.confirmedUntil).toEqual(expect.any(String));
    const passkeys = listed.passkeys as { id: string }[];
    expect(passkeys).toHaveLength(2);

    const phoneId = (await stores.passkeys.findByCredential(b64(phone.credentialId)))?.id as string;
    expect(passkeys.map((p) => p.id)).toContain(phoneId);
    expect((await call('alice', 'DELETE', `/v1/me/passkeys/${phoneId}`)).body).toEqual({
      error: 'passkey_required',
    });
    // Removing the passkey that gave the confirmation ends that confirmation too.
    const removed = await call('alice', 'DELETE', `/v1/me/passkeys/${phoneId}`, undefined, token);
    expect(removed).toEqual({ status: 200, body: { removed: 1 } });
    const grants = `/v1/platform/organizations/${tenant}/credit-grants`;
    const request = { amount: 100, reason: 'manual_purchase', idempotencyKey: KEY };
    expect((await call('alice', 'POST', grants, request, token)).body).toEqual({
      error: 'passkey_required',
    });
    // Another passkey still works.
    const laptopToken = (await confirm('alice', laptop)).body.token as string;
    expect((await call('alice', 'POST', grants, request, laptopToken)).status).toBe(201);
  });

  it('a platform administrator resets the passkeys of someone who lost them, audited', async () => {
    const { stores, ids, call, add } = await setup();
    expect((await add('carol', new Device())).status).toBe(201);
    expect(
      (await call('carol', 'POST', `/v1/platform/users/${ids.carol}/passkeys/reset`, {})).status,
    ).toBe(403);
    const reset = await call('alice', 'POST', `/v1/platform/users/${ids.carol}/passkeys/reset`, {});
    expect(reset).toEqual({ status: 200, body: { removed: 1 } });
    expect(await stores.passkeys.passkeysOf(ids.carol as never)).toEqual([]);
    expect(await stores.auditEvents()).toContainEqual(
      expect.objectContaining({
        action: 'auth.passkeys_reset',
        result: 'success',
        target: { type: 'user', id: ids.carol },
      }),
    );
    // Back to a recent sign-in for their next change.
    expect((await call('carol', 'GET', '/v1/me/passkeys')).body).toMatchObject({ passkeys: [] });
  });
});

describe('without web origins there are no passkeys', () => {
  it('says so, and changes keep needing only a recent sign-in', async () => {
    const [, create] = STORES[0] as [string, () => Stores];
    const ctx = setupApp(create());
    await ctx.register('token-alice');
    const listed = await ctx.app.request('/v1/me/passkeys', ctx.as('token-alice'));
    expect(await listed.json()).toEqual({
      available: false,
      administrator: false,
      passkeys: [],
      confirmedUntil: null,
    });
    const options = await ctx.app.request(
      '/v1/me/passkeys/confirmation-options',
      ctx.as('token-alice', { method: 'POST' }),
    );
    expect(options.status).toBe(503);
  });
});
