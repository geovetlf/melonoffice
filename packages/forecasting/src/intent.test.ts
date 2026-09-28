import { describe, expect, it } from 'vitest';
import { forecastIntentOf } from './intent.js';

describe("15. reading a forecast request from the person's words", () => {
  it.each([
    ['¿Cuánto venderemos el próximo mes?', 'sales.won_value', 'day', 30, false],
    ['Proyecta nuestras ventas de los próximos 30 días.', 'sales.won_value', 'day', 30, false],
    ['¿Cuál es la tendencia de nuestras ventas?', 'sales.won_value', 'day', 30, true],
    ['¿Cómo viene la tendencia de ventas?', 'sales.won_value', 'day', 30, true],
    ['Proyecta los leads de las próximas 8 semanas', 'leads.new', 'week', 8, false],
    ['¿Cuántas conversaciones esperamos la próxima semana?', 'conversations.new', 'day', 7, false],
    ['Pronóstico de ingresos del trimestre', 'sales.won_value', 'day', 90, false],
    ['Forecast our sales for the next 14 days', 'sales.won_value', 'day', 14, false],
    ['How many new leads will we get next month?', 'leads.new', 'day', 30, false],
    ['¿Cuántas ventas cerraremos? proyecta 3 meses', 'sales.won_count', 'month', 3, false],
  ])('%s', (message, metric, frequency, horizon, trend) => {
    expect(forecastIntentOf(message)).toEqual({
      kind: 'forecast',
      metric,
      frequency,
      horizon,
      trend,
    });
  });

  it('says there is no data for orders, products, stock or campaigns: nothing stands in', () => {
    expect(forecastIntentOf('¿Cuántos pedidos esperamos la próxima semana?')).toEqual({
      kind: 'unsupported',
      subject: 'orders',
    });
    expect(forecastIntentOf('¿Qué productos muestran crecimiento?')).toEqual({
      kind: 'unsupported',
      subject: 'products',
    });
    expect(forecastIntentOf('Proyecta el inventario')).toMatchObject({ subject: 'inventory' });
  });

  it('is not a forecast when nothing asks about the future', () => {
    expect(forecastIntentOf('¿Cuánto vendimos ayer?')).toBeUndefined();
    expect(
      forecastIntentOf('¿Cuál es mi próximo seguimiento sobre la venta de Juan?'),
    ).toBeUndefined();
    expect(forecastIntentOf('Hola GIA')).toBeUndefined();
  });
});
