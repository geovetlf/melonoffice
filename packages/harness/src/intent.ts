import type {
  HarnessComplexity,
  HarnessDomain,
  HarnessIntent,
  TaskClassification,
} from './model.js';

/**
 * Reading a request (ADR-0099 §3): fixed rules over the request's words, in English and Spanish,
 * with accents folded. No model is asked, so reading costs nothing and the same words always give
 * the same answer. A wrong reading can only change the order the router tries models in and which
 * context is read; it never grants a permission, an agent or a tool.
 */

export const MAX_HARNESS_REQUEST_LENGTH = 2000;

/** Lower case, accents removed, spaces collapsed. */
export const foldText = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Whether `text` has a word starting with `stem` (a stem may be several words). */
const has = (text: string, stem: string): boolean => {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}`).test(text);
};

/** In the order they are tried: the first intent with a matching stem wins. */
export const INTENT_RULES: readonly {
  readonly intent: Exclude<HarnessIntent, 'question' | 'generation'>;
  readonly stems: readonly string[];
}[] = Object.freeze([
  {
    intent: 'action',
    stems: [
      'envia',
      'enviar',
      'send',
      'publica',
      'publicar',
      'publish',
      'paga',
      'pagar',
      'pay ',
      'transfiere',
      'transferir',
      'transfer',
      'elimina',
      'eliminar',
      'borra',
      'borrar',
      'delete',
      'agenda',
      'agendar',
      'schedule',
      'actualiza',
      'actualizar',
      'update',
      'registra',
      'registrar',
    ],
  },
  {
    intent: 'planning',
    stems: [
      'planifica',
      'planificar',
      'plan ',
      'plan de',
      'plan for',
      'estrategia',
      'strategy',
      'campana',
      'campaign',
      'roadmap',
      'hoja de ruta',
      'recuperar clientes',
      'win back',
    ],
  },
  {
    intent: 'analysis',
    stems: [
      'analiza',
      'analizar',
      'analisis',
      'analy',
      'compara',
      'compare',
      'comparison',
      'evalua',
      'evaluate',
      'diagnostica',
      'diagnose',
      'tendencia',
      'trend',
      'por que',
      'why',
      'deberia contactar',
      'should i contact',
      'prioriza',
      'prioritize',
    ],
  },
  {
    intent: 'summary',
    stems: ['resume', 'resumen', 'resumir', 'summar', 'sintetiza', 'sintesis', 'tl;dr'],
  },
  {
    intent: 'extraction',
    stems: ['extrae', 'extraer', 'extract', 'obten los datos', 'get the data', 'saca los datos'],
  },
  {
    intent: 'classification',
    stems: ['clasifica', 'clasificar', 'classify', 'categoriza', 'categori', 'etiqueta', 'label'],
  },
]);

const QUESTION_STARTS = [
  'que',
  'cual',
  'cuanto',
  'cuanta',
  'como',
  'donde',
  'cuando',
  'quien',
  'what',
  'which',
  'how',
  'when',
  'where',
  'who',
  'is ',
  'are ',
  'do ',
  'does ',
  'can ',
];

export const DOMAIN_RULES: readonly {
  readonly domain: HarnessDomain;
  readonly stems: readonly string[];
}[] = Object.freeze([
  {
    domain: 'crm',
    stems: [
      'cliente',
      'customer',
      'client',
      'contacto',
      'contact',
      'lead',
      'prospecto',
      'oportunidad',
      'opportunit',
      'venta',
      'sales',
      'pipeline',
      'seguimiento',
      'follow-up',
      'follow up',
      'compraron',
      'compra',
      'bought',
    ],
  },
  {
    domain: 'finance',
    stems: [
      'factura',
      'invoice',
      'pago',
      'payment',
      'cobro',
      'precio',
      'price',
      'margen',
      'margin',
      'costo',
      'coste',
      'cost ',
      'costs',
      'ingreso',
      'revenue',
      'gasto',
      'expense',
    ],
  },
  {
    domain: 'marketing',
    stems: [
      'campana',
      'campaign',
      'marketing',
      'anuncio',
      'publicidad',
      'advert',
      'redes sociales',
      'social media',
      'contenido',
      'content',
      'newsletter',
      'promocion',
      'promotion',
    ],
  },
  {
    domain: 'operations',
    stems: [
      'inventario',
      'inventory',
      'stock',
      'pedido',
      'order',
      'entrega',
      'delivery',
      'proveedor',
      'supplier',
      'logistica',
      'logistics',
    ],
  },
  {
    domain: 'knowledge',
    stems: [
      'politica',
      'policy',
      'procedimiento',
      'procedure',
      'nuestra empresa',
      'our company',
      'nuestro negocio',
      'our business',
      'norma',
      'regla',
      'rule',
      'manual',
      'horario',
      'opening hours',
    ],
  },
]);

/** A person asking, in their words, for a person (ADR-0099: handoff). */
export const PERSON_STEMS: readonly string[] = Object.freeze([
  'hablar con una persona',
  'hablar con un humano',
  'persona real',
  'agente humano',
  'un humano',
  'talk to a person',
  'speak to a person',
  'talk to a human',
  'speak to a human',
  'real person',
  'human agent',
]);

/** Requests at least this long are more than a simple task. */
const LONG_REQUEST = 800;
const SHORT_REQUEST = 200;

const SIMPLE_INTENTS: readonly HarnessIntent[] = ['question', 'classification', 'extraction'];
const COMPLEX_INTENTS: readonly HarnessIntent[] = ['analysis', 'planning'];

/** Reads one request. Its length is checked by the caller. */
export function classifyTask(request: string): TaskClassification {
  const text = foldText(request);
  const signals: string[] = [];
  let intent: HarnessIntent | undefined;
  for (const rule of INTENT_RULES) {
    const stem = rule.stems.find((s) => has(text, s));
    if (stem !== undefined) {
      intent = rule.intent;
      signals.push(`intent:${rule.intent}`);
      break;
    }
  }
  if (intent === undefined) {
    const question =
      request.trim().endsWith('?') ||
      request.trim().startsWith('¿') ||
      QUESTION_STARTS.some((s) => text.startsWith(s.endsWith(' ') ? s : `${s} `));
    intent = question ? 'question' : 'generation';
    signals.push(`intent:${intent}`);
  }
  const domains = DOMAIN_RULES.filter((r) => r.stems.some((s) => has(text, s))).map(
    (r) => r.domain,
  );
  for (const d of domains) signals.push(`domain:${d}`);
  const asksForPerson = PERSON_STEMS.some((s) => has(text, s));
  if (asksForPerson) signals.push('handoff:asks_for_person');

  let complexity: HarnessComplexity = 'standard';
  if (COMPLEX_INTENTS.includes(intent) || text.length >= LONG_REQUEST || domains.length >= 3) {
    complexity = 'complex';
  } else if (SIMPLE_INTENTS.includes(intent) && text.length < SHORT_REQUEST) {
    complexity = 'simple';
  }
  signals.push(`complexity:${complexity}`);
  return Object.freeze({
    intent,
    domains: Object.freeze(domains),
    complexity,
    asksForPerson,
    signals: Object.freeze(signals),
  });
}

/** The department type a task's domains point at, when exactly one does. */
export const DOMAIN_DEPARTMENTS: Readonly<Partial<Record<HarnessDomain, string>>> = Object.freeze({
  crm: 'sales',
  finance: 'finance',
  marketing: 'marketing',
  operations: 'operations',
});

export function departmentOf(classification: TaskClassification): string | undefined {
  const departments = new Set(
    classification.domains.flatMap((d) => {
      const department = DOMAIN_DEPARTMENTS[d];
      return department === undefined ? [] : [department];
    }),
  );
  return departments.size === 1 ? [...departments][0] : undefined;
}
