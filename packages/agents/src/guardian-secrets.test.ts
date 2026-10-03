import type { Execution } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { guardAnswer, parseGuardianReport } from './guardian.js';

// G-7: an answer that gives a credential is never a valid answer. The values are invented.
const PANEL = {
  factId: 'org_delivery_panel',
  label: 'Clave del panel de delivery',
  value: 'Brasa-tst-K9x4!',
};
const base = {
  missing: [] as string[],
  execution: { nodes: [] } as Pick<Execution, 'nodes'>,
  mutating: () => true,
};

describe('the Guardian and secrets (G-7)', () => {
  it('finds a stored credential in the answer: critical, with evidence that never has the value', () => {
    for (const answer of [
      `Para el repartidor: entra al panel con Brasa-tst-K9x4! y revisa los pedidos.`,
      'La clave es brasa-tst-k9x4!, guárdala bien.',
    ]) {
      const report = guardAnswer({ ...base, answer, secrets: [PANEL] });
      expect(report.findings[0]).toEqual({
        code: 'secret_disclosed',
        severity: 'critical',
        evidence: { fact: PANEL.factId, label: PANEL.label, source: 'company_brain' },
        recommendation: 'discard_answer',
      });
      expect(JSON.stringify(report)).not.toMatch(/k9x4/i);
    }
  });

  it('finds one in the missing list too', () => {
    const report = guardAnswer({
      ...base,
      answer: 'Aquí tienes el resumen.',
      missing: ['Confirmar la clave Brasa-tst-K9x4!'],
      secrets: [PANEL],
    });
    expect(report.findings[0]?.code).toBe('secret_disclosed');
  });

  it.each([
    'Contraseña: Pollo2026!',
    'API key: pk-test-0000-melon',
    'Token de acceso: tk_demo_1234',
    'PIN de la caja = 4821',
  ])('finds a credential written under its name without knowing it: %s', (line) => {
    const report = guardAnswer({ ...base, answer: `Datos de la empresa:\n${line}` });
    expect(report.findings[0]).toEqual({
      code: 'secret_disclosed',
      severity: 'critical',
      evidence: { source: 'pattern' },
      recommendation: 'discard_answer',
    });
  });

  it('leaves ordinary business answers alone, and a refusal to share access data', () => {
    for (const answer of [
      'El Combo Familiar cuesta S/ 25.00 y el tiempo de entrega es de 30 min.',
      'Horario: de martes a domingo, de 12:00 a 22:00.',
      'Mensaje clave: compra hoy y recibe en 30 minutos.',
      'Los datos de acceso no se comparten; pídeselos al dueño.',
    ]) {
      expect(guardAnswer({ ...base, answer, secrets: [PANEL] }).findings).toEqual([]);
    }
  });

  it('keeps the finding when the report is read back', () => {
    const report = guardAnswer({ ...base, answer: 'Contraseña: Pollo2026!' });
    expect(parseGuardianReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });
});
