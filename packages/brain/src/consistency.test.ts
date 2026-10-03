import { describe, expect, it } from 'vitest';
import { figureContradictions, parseFigure, type FigureFact } from './consistency.js';

const money = (label: string, amountMinor: number, confirmed = true): FigureFact => ({
  id: `f_${label}`,
  label,
  value: { type: 'money', amountMinor, currency: 'PEN' },
  confirmed,
});

describe('figure contradictions (G-1, ADR-0131)', () => {
  it('reads figures with either decimal mark and thousands groups', () => {
    expect(parseFigure('25')).toBe(25);
    expect(parseFigure('25.50')).toBe(25.5);
    expect(parseFigure('25,50')).toBe(25.5);
    expect(parseFigure('1.234')).toBe(1234);
    expect(parseFigure('1,234.50')).toBe(1234.5);
    expect(parseFigure('1.234,50')).toBe(1234.5);
    expect(parseFigure('')).toBeUndefined();
  });

  it('finds a price the text gives that disagrees with the recorded one', () => {
    const found = figureContradictions(
      'Hola. El Combo Familiar cuesta S/ 30 y el delivery es gratis.',
      [money('Combo Familiar', 2500), money('Pollo entero', 6000, false)],
    );
    expect(found).toEqual([
      {
        factId: 'f_Combo Familiar',
        label: 'Combo Familiar',
        recorded: 'PEN 25.00',
        stated: 's/ 30',
        confirmed: true,
      },
    ]);
  });

  it('agrees when one of the figures is the recorded one, in any form', () => {
    for (const text of [
      'El combo familiar cuesta S/ 25.',
      'Combo Familiar: 25,00 soles.',
      'combo familiar a 25 soles (antes S/ 30)',
      'COMBO FAMILIAR → $25.00',
    ]) {
      expect(figureContradictions(text, [money('Combo Familiar', 2500)])).toEqual([]);
    }
  });

  it('leaves alone what it cannot read with certainty', () => {
    const facts = [money('Combo Familiar', 2500)];
    // A number with no currency, a fact the text does not name, another sentence.
    expect(figureContradictions('El Combo Familiar es para 4 personas.', facts)).toEqual([]);
    expect(figureContradictions('El Combo Personal cuesta S/ 15.', facts)).toEqual([]);
    expect(figureContradictions('Tenemos Combo Familiar.\nEl envío cuesta S/ 5.', facts)).toEqual(
      [],
    );
    // A label too short to match safely, or part of another word.
    expect(figureContradictions('El XL cuesta S/ 9.', [money('XL', 1000)])).toEqual([]);
    expect(figureContradictions('Supercombo familiares a S/ 9.', facts)).toEqual([]);
  });

  it('compares quantities only when the fact has a unit', () => {
    const minutes: FigureFact = {
      id: 'delivery',
      label: 'tiempo de entrega',
      value: { type: 'number', number: 30, unit: 'min' },
      confirmed: false,
    };
    expect(figureContradictions('El tiempo de entrega es de 45 min.', [minutes])).toEqual([
      {
        factId: 'delivery',
        label: 'tiempo de entrega',
        recorded: '30 min',
        stated: '45 min',
        confirmed: false,
      },
    ]);
    expect(figureContradictions('El tiempo de entrega es de 30 min.', [minutes])).toEqual([]);
    const bare: FigureFact = { ...minutes, value: { type: 'number', number: 30 } };
    expect(figureContradictions('El tiempo de entrega es de 45 min.', [bare])).toEqual([]);
  });

  it('knows currencies with no minor unit', () => {
    const clp: FigureFact = {
      id: 'c',
      label: 'Menu del dia',
      value: { type: 'money', amountMinor: 5000, currency: 'CLP' },
      confirmed: true,
    };
    expect(figureContradictions('Menú del día: $5.000', [clp])).toEqual([]);
    expect(figureContradictions('Menú del día: $6.000', [clp])).toHaveLength(1);
  });
});
