import { describe, expect, it } from 'vitest';
import { workflowIntentOf } from './intent.js';

/** Whether a person's words ask for work that could be an automation (Block 3 F3, ADR-0177). */
describe('workflowIntentOf (ADR-0177)', () => {
  it('reads repeatable, event-driven and multi-step work, in Spanish and English', () => {
    for (const text of [
      'Cada lunes prepara un resumen de las ventas de la semana',
      'Todos los días revisa los clientes que pidieron precio',
      'Automatiza el seguimiento de mis clientes',
      'Cada vez que llegue un pedido, prepara la confirmación',
      'Cuando un cliente pida precio, prepara una propuesta',
      'Primero investiga la competencia y luego prepara una campaña',
      'quiero una rutina para revisar los pedidos',
      'Every Monday, summarise last week’s sales',
      'Automate the follow-up with my customers',
      'Whenever a customer asks for a quote, draft a proposal',
      'First research the market, then draft a campaign',
      'Send me a weekly report of new leads',
    ]) {
      expect([text, workflowIntentOf(text)]).toEqual([text, true]);
    }
  });

  it('leaves ordinary questions and one-off requests to GIA’s chat', () => {
    for (const text of [
      '¿Qué pasó hoy?',
      '¿Cuánto vendí cada mes?',
      '¿Qué es una automatización?',
      'Escribe un post para Instagram sobre el nuevo menú',
      'Resume las oportunidades abiertas',
      'How much did I sell every month?',
      'What is a workflow?',
      'Draft a reply to this customer',
      '',
      '   ',
    ]) {
      expect([text, workflowIntentOf(text)]).toEqual([text, false]);
    }
    expect(workflowIntentOf(undefined as unknown as string)).toBe(false);
  });
});
