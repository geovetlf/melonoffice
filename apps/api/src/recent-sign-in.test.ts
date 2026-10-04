import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Sensitive administration needs a recent sign-in (ADR-0138): a platform, white-label or reseller
 * administrator's change is refused with `reauthentication_required` when they signed in more than
 * 30 minutes ago, audited, before anything changes. Reads are not, and a business owner working in
 * their own organization is never asked. `token-<who>-stale` is the same person, signed in two
 * hours ago.
 *
 * Alice is the platform administrator. Carol runs White Label A. Heidi owns Company H.
 */
type Body = Record<string, unknown> & { error?: string };

const KEY = '44444444-4444-4444-8444-444444444444';

describe.each(STORES)(
  'recent sign-in for sensitive administration with storage in %s',
  (_n, create) => {
    async function setup() {
      const stores: Stores = create();
      const first = setupApp(stores);
      const ids: Record<string, string> = {};
      for (const who of ['alice', 'carol', 'heidi'])
        ids[who] = await first.register(`token-${who}`);
      const ctx = setupApp(stores, undefined, undefined, undefined, undefined, {
        platformAdmins: [ids.alice as string],
      });
      const call = async (token: string, method: string, path: string, body?: unknown) => {
        const response = await ctx.app.request(
          path,
          ctx.as(`token-${token}`, {
            method,
            ...(body === undefined
              ? {}
              : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
          }),
        );
        return { status: response.status, body: (await response.json()) as Body };
      };
      const created = await call('alice', 'POST', '/v1/platform/commercial-accounts', {
        type: 'white_label',
        name: 'Acme AI',
        adminUserId: ids.carol,
        limits: { customers: 5, members: 3, resellers: 2 },
      });
      expect(created.status).toBe(201);
      const wl = created.body.account as { id: string };
      const tenant = (
        (await call('heidi', 'POST', '/v1/organizations', { name: 'Company H' })).body
          .organization as { id: string }
      ).id;
      const denials = async () =>
        (await stores.auditEvents()).filter(
          (e) => e.result === 'denied' && e.reason === 'reauthentication_required',
        );
      return { call, wl, tenant, denials };
    }

    it("refuses a platform administrator's change after an old sign-in, audited, changing nothing", async () => {
      const { call, tenant, denials } = await setup();
      const grants = `/v1/platform/organizations/${tenant}/credit-grants`;
      const request = { amount: 100, reason: 'manual_purchase', idempotencyKey: KEY };

      const refused = await call('alice-stale', 'POST', grants, request);
      expect(refused).toEqual({ status: 403, body: { error: 'reauthentication_required' } });
      expect(await denials()).toEqual([
        expect.objectContaining({ action: 'credits.platform_grant' }),
      ]);
      const after = await call('alice', 'GET', `/v1/platform/organizations/${tenant}`);
      expect(after.body).toMatchObject({ credits: { balance: 0 } });

      // Reading still works; after signing in again, the same change goes through.
      expect((await call('alice-stale', 'GET', '/v1/platform/commercial-accounts')).status).toBe(
        200,
      );
      expect((await call('alice', 'POST', grants, request)).status).toBe(201);
    });

    it('refuses every platform change the same way, before its own checks', async () => {
      const { call, wl } = await setup();
      const changes = [
        ['/v1/platform/commercial-accounts', { type: 'reseller', name: 'X' }],
        [`/v1/platform/commercial-accounts/${wl.id}/status`, { status: 'suspended' }],
        [`/v1/platform/commercial-accounts/${wl.id}/limits`, { limits: { customers: 1 } }],
        ['/v1/platform/domain-bindings', { hostname: 'app.acme.example' }],
      ] as const;
      for (const [path, body] of changes) {
        expect((await call('alice-stale', 'POST', path, body)).body.error, path).toBe(
          'reauthentication_required',
        );
      }
    });

    it("refuses a white-label administrator's change after an old sign-in, audited", async () => {
      const { call, wl, denials } = await setup();
      const account = `/v1/commercial/accounts/${wl.id}`;
      const reseller = { name: 'Reseller 1', adminEmail: 'frank@example.com', limits: {} };

      const refused = await call('carol-stale', 'POST', `${account}/resellers`, reseller);
      expect(refused).toEqual({ status: 403, body: { error: 'reauthentication_required' } });
      expect(await denials()).toEqual([
        expect.objectContaining({
          action: 'commercial.access',
          commercialAccountId: wl.id,
          permission: expect.any(String),
        }),
      ]);
      expect((await call('carol-stale', 'GET', account)).status).toBe(200);
      expect((await call('carol', 'GET', `${account}/resellers`)).body.resellers).toEqual([]);
    });

    it('never asks a business owner working in their own organization', async () => {
      const { call, tenant, denials } = await setup();
      const profile = await call(
        'heidi-stale',
        'PUT',
        `/v1/organizations/${tenant}/business-profile`,
        {
          businessType: 'restaurant',
          country: 'PE',
          currency: 'PEN',
          timeZone: 'America/Lima',
          city: 'Lima',
        },
      );
      expect(profile.status).toBe(200);
      expect((await call('heidi-stale', 'GET', `/v1/organizations/${tenant}`)).status).toBe(200);
      expect(await denials()).toEqual([]);
    });
  },
);
