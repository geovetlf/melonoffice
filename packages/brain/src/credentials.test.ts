import { describe, expect, it } from 'vitest';
import { isCredentialFact, storedSecretsOf } from './credentials.js';

const item = (key: string, text: string, label?: string, status = 'active' as const) => ({
  id: `org_${key}`,
  key,
  ...(label === undefined ? {} : { label }),
  value: { type: 'text' as const, text },
  status,
});

describe('credentials in the company memory (G-7)', () => {
  it('knows a credential by its label or key', () => {
    expect(isCredentialFact({ label: 'Clave del panel de delivery' })).toBe(true);
    expect(isCredentialFact({ key: 'payments_api_key' })).toBe(true);
    expect(isCredentialFact({ key: 'wifi_password' })).toBe(true);
    expect(isCredentialFact({ label: 'Mensaje clave', key: 'key_message' })).toBe(false);
    expect(isCredentialFact({ label: 'Combo Familiar', key: 'price' })).toBe(false);
  });

  it('lists the active ones an answer must never repeat, long enough to look for', () => {
    const secrets = storedSecretsOf([
      item('delivery_panel', 'Brasa-tst-K9x4!', 'Clave del panel de delivery'),
      item('cash_pin', '12', 'PIN de la caja'),
      item('old_password', 'Viejo-2024!', 'Contraseña anterior', 'archived' as never),
      item('city', 'Lima', 'Ciudad'),
    ]);
    expect(secrets).toEqual([
      {
        factId: 'org_delivery_panel',
        label: 'Clave del panel de delivery',
        value: 'Brasa-tst-K9x4!',
      },
    ]);
  });
});
