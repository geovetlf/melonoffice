/**
 * Whether a person's message asks for work that could be an automation (Block 3 F3, ADR-0177):
 * something that repeats, starts on its own when something happens, or runs in several steps.
 * It is read from the person's own words, deterministically: no model decides it and nothing
 * runs. A match only lets GIA offer to prepare a workflow draft; the person still asks for it,
 * reviews it, saves it and activates it.
 *
 * A question about the business ("¿cuánto vendí cada mes?", "¿qué es una automatización?") is
 * not a request for work: a message that starts by asking for figures or facts never counts.
 */

/** Lowercase, without accents or inverted marks, spaces collapsed. */
function normalized(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[¿¡]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const DAYS = '(?:lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)';
const EN_DAYS = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?';

/** The person names an automation, a routine or a workflow outright. */
const ASKS_AUTOMATION = new RegExp(
  [
    '\\bautomatiz',
    '\\bautomat(?:e|ed|es|ing|ion)\\b',
    '\\bworkflows?\\b',
    '\\bflujo de trabajo\\b',
    '\\brutina\\b',
    '\\broutine\\b',
  ].join('|'),
);

/** Work that repeats on a cadence. */
const REPEATS = new RegExp(
  [
    `\\b(?:cada|todos los|todas las) (?:dias?|semanas?|mes(?:es)?|manana|mananas|tarde|tardes|noche|noches|${DAYS}|\\d+ (?:dias|horas|semanas))\\b`,
    '\\b(?:diariamente|semanalmente|mensualmente|a diario)\\b',
    `\\b(?:every|each) (?:day|week|month|morning|evening|night|${EN_DAYS}|\\d+ (?:days|hours|weeks))\\b`,
    '\\b(?:daily|weekly|monthly)\\b',
    `\\bon ${EN_DAYS}\\b`,
  ].join('|'),
);

/** Work that starts when something happens. */
const ON_EVENT = new RegExp(
  [
    '\\bcada vez que\\b',
    '\\bsiempre que\\b',
    '\\bcuando (?:llegue|entre|escriba|pida|compre|se registre|un cliente|una cliente)\\b',
    '\\b(?:whenever|every time|each time)\\b',
    '\\bwhen (?:a|an|new) [a-z]+ (?:arrives|comes in|writes|asks|buys|signs up)\\b',
  ].join('|'),
);

/** Work in several ordered steps. */
const STEPS = /\bprimero\b.*\b(?:luego|despues|y despues|y luego)\b|\bfirst\b.*\bthen\b/;

/** A question for figures or facts, not a request for work. */
const ASKS_FACTS =
  /^(?:que|cuanto|cuanta|cuantos|cuantas|cual|cuales|donde|quien|quienes|por que|como (?:va|van|estoy|esta|estan|me fue|nos fue)|what|how (?:much|many)|which|where|who|why|did|was|were|is|are)\b/;

export function workflowIntentOf(text: string): boolean {
  if (typeof text !== 'string') return false;
  const words = normalized(text);
  if (words === '') return false;
  if (ASKS_FACTS.test(words)) return false;
  return (
    ASKS_AUTOMATION.test(words) || REPEATS.test(words) || ON_EVENT.test(words) || STEPS.test(words)
  );
}
