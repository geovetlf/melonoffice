import { describe, expect, it } from 'vitest';
import {
  carriesLabelledSecret,
  looksLikeCredentialName,
  REDACTED,
  redactSecretText,
} from './secrets.js';

// Credentials stored in the company memory (G-7). The values are invented for the tests.
describe('credential names', () => {
  it.each([
    'Clave del panel de delivery',
    'Contraseña del correo',
    'Password',
    'delivery_panel_password',
    'API key de pagos',
    'api-key',
    'Token de acceso',
    'PIN de la caja',
    'Clave wifi',
    'Clave de acceso al sistema',
    'Usuario y clave del banco',
    'Credenciales del proveedor',
  ])('%s is a credential', (name) => {
    expect(looksLikeCredentialName(name)).toBe(true);
  });

  it.each([
    'Combo Familiar',
    'Mensaje clave',
    'Punto clave',
    'Palabras clave',
    'Horario',
    'Ciudad',
    'Ventas de septiembre',
    'Clientes clave',
  ])('%s is not', (name) => {
    expect(looksLikeCredentialName(name)).toBe(false);
  });
});

describe('a credential written under its name', () => {
  it.each([
    '- Clave del panel de delivery: Brasa-com-K9x4!',
    'Contraseña: Pollo2026!',
    'PIN de la caja = 4821',
    'API key: pk-test-0000-melon',
    'Token de acceso: tk_demo_1234',
    'La guía:\n- Clave wifi: brasa#2026',
  ])('%s is found and its value cut', (text) => {
    expect(carriesLabelledSecret(text)).toBe(true);
    const clean = redactSecretText(text);
    expect(clean).toContain(REDACTED);
    expect(clean).not.toMatch(/K9x4|Pollo2026|4821|0000-melon|tk_demo|brasa#2026/);
  });

  it('keeps the name, so the reader knows something was withheld', () => {
    expect(redactSecretText('- Clave del panel de delivery: Brasa-com-K9x4!')).toBe(
      `- Clave del panel de delivery: ${REDACTED}`,
    );
  });

  it.each([
    'contraseña: no la tengo',
    'Mensaje clave: compra hoy',
    'Usa el PIN que te di. Hora: 12:30',
    '- Combo Familiar: PEN 25.00',
    '- Horario: De martes a domingo, de 12:00 a 22:00',
    'Tokens: 120',
  ])('%s is ordinary business data and stays as is', (text) => {
    expect(carriesLabelledSecret(text)).toBe(false);
    expect(redactSecretText(text)).toBe(text);
  });
});
