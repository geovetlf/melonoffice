import type { FakeBackend } from '../identity/testing.js';
import type { PreviewRoutes } from './routes.js';

/**
 * The data of the `pages` scenario: a small Peruvian shop (Acme) a few weeks into MelonOffice, so
 * every secondary page shows what it looks like with real content. All of it is fictional, like
 * the tests' fixtures, and it never leaves the preview.
 */

/** Everything the secondary pages ask for, on top of the owner's Home permissions. */
export const PAGES_PERMISSIONS = [
  'brand.manage',
  'channel.read',
  'channel.create',
  'channel.update',
  'channel.disconnect',
  'channel.delete',
  'contact.manage',
  'execution.cancel',
  'follow_up.manage',
  'knowledge.manage',
  'knowledge.propose',
  'opportunity.read',
  'opportunity.manage',
  'organization.update',
  'pipeline.manage',
  'plan.create',
  'relationship.read',
  'relationship.manage',
  'tool.read',
  'workflow.manage',
];

const DAY = 86_400_000;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const dateIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

const contact = (
  id: string,
  displayName: string,
  stage: 'lead' | 'customer' | 'inactive',
  extra: {
    phone?: string;
    email?: string | null;
    owner?: 'you' | 'member' | null;
    source?: string;
    consent?: 'granted' | 'denied' | 'unknown';
    nextAction?: { text: string; dueOn: string } | null;
    days?: number;
  } = {},
) => ({
  id,
  displayName,
  phone: extra.phone ?? '+51987111222',
  email: extra.email ?? null,
  origin: extra.source === 'manual' ? 'user' : 'channel',
  revision: 1,
  commercial: {
    stage,
    owner: extra.owner ?? null,
    source: extra.source ?? 'channel',
    consent: extra.consent ?? 'unknown',
    consentAt: null,
    nextAction: extra.nextAction ?? null,
    stageChangedAt: at((extra.days ?? 1) * 1440),
  },
  createdAt: at((extra.days ?? 1) * 1440 + 60),
  updatedAt: at((extra.days ?? 1) * 1440),
});

const CUSTOMERS = [
  contact('ct_1', 'Juan Pérez', 'customer', {
    phone: '+51987654321',
    email: 'juan.perez@example.com',
    owner: 'you',
    consent: 'granted',
    nextAction: { text: 'Enviar catálogo de octubre', dueOn: dateIn(2) },
    days: 12,
  }),
  contact('ct_2', 'María Quispe', 'lead', {
    phone: '+51912345678',
    consent: 'granted',
    nextAction: { text: 'Confirmar tallas', dueOn: dateIn(0) },
  }),
  contact('ct_3', 'Carlos Rojas', 'lead', { phone: '+51955443322', source: 'campaign', days: 2 }),
  contact('ct_4', 'Lucía Fernández', 'customer', {
    phone: '+51966778899',
    email: 'lucia@example.com',
    owner: 'member',
    consent: 'granted',
    days: 30,
  }),
  contact('ct_5', 'Distribuidora Andina', 'lead', {
    phone: '+51014567890',
    email: 'compras@example.com',
    source: 'manual',
    owner: 'you',
    nextAction: { text: 'Llamar para cotización', dueOn: dateIn(-1) },
    days: 4,
  }),
  contact('ct_6', 'Rosa Mamani', 'lead', { phone: '+51933221100', days: 3 }),
  contact('ct_7', 'Pedro Salazar', 'inactive', { phone: '+51944556677', days: 60 }),
];

const opportunity = (
  id: string,
  contactId: string,
  contactName: string,
  title: string,
  stageId: string,
  amountMinor: number,
  probability: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  contactId,
  contactName,
  stageId,
  status: stageId === 'won' ? 'won' : stageId === 'lost' ? 'lost' : 'open',
  title,
  value: { amountMinor, currency: 'PEN' },
  probability,
  owner: 'you',
  expectedCloseOn: dateIn(10),
  nextAction: null,
  lostReason: null,
  closedAt: null,
  revision: 1,
  updatedAt: at(180),
  ...extra,
});

const OPPORTUNITIES = [
  opportunity(
    'opp_1',
    'ct_5',
    'Distribuidora Andina',
    'Pedido mayorista de octubre',
    'proposal',
    1_250_000,
    50,
    {
      nextAction: { text: 'Enviar propuesta revisada', dueOn: dateIn(1) },
    },
  ),
  opportunity(
    'opp_2',
    'ct_2',
    'María Quispe',
    'Uniformes para su tienda',
    'contacted',
    320_000,
    25,
  ),
  opportunity('opp_3', 'ct_1', 'Juan Pérez', 'Renovación de stock', 'negotiation', 480_000, 75),
  opportunity('opp_4', 'ct_3', 'Carlos Rojas', 'Primera compra', 'new', 85_000, 10, {
    owner: null,
  }),
  opportunity('opp_5', 'ct_6', 'Rosa Mamani', 'Regalos corporativos', 'new', 150_000, 10),
  opportunity('opp_6', 'ct_4', 'Lucía Fernández', 'Pedido de septiembre', 'won', 260_000, 100, {
    closedAt: at(4 * 1440),
  }),
];

const followUp = (
  id: string,
  contactId: string,
  contactName: string,
  title: string,
  when: 'overdue' | 'today' | 'upcoming',
  days: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  contactId,
  contactName,
  opportunityId: null,
  assignee: 'you',
  type: 'call',
  title,
  description: null,
  scheduledAt: new Date(Date.now() + days * DAY).toISOString(),
  timeZone: 'America/Lima',
  date: dateIn(days),
  time: '10:00',
  when,
  days,
  status: when === 'overdue' ? 'due' : 'scheduled',
  source: 'manual',
  cancelReason: null,
  failure: null,
  revision: 1,
  ...extra,
});

const FOLLOW_UPS = [
  followUp('fu_1', 'ct_1', 'Juan Pérez', 'Llamar a Juan Pérez', 'overdue', -1),
  followUp(
    'fu_2',
    'ct_5',
    'Distribuidora Andina',
    'Enviar propuesta a Distribuidora Andina',
    'today',
    0,
    {
      type: 'message',
      opportunityId: 'opp_1',
      time: '15:30',
    },
  ),
  followUp('fu_3', 'ct_2', 'María Quispe', 'Confirmar tallas con María', 'today', 0, {
    type: 'message',
    source: 'gia',
    time: '17:00',
  }),
  followUp('fu_4', 'ct_3', 'Carlos Rojas', 'Presentar catálogo a Carlos', 'upcoming', 2, {
    type: 'check_in',
  }),
  followUp('fu_5', 'ct_6', 'Rosa Mamani', 'Preguntar por regalos corporativos', 'upcoming', 5),
];

const fact = (
  domain: string,
  key: string,
  label: string | null,
  value: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id: `org_1_${domain}_${key}`,
  domain,
  key,
  subject: null,
  label,
  value,
  verification: 'confirmed',
  status: 'active',
  sensitivity: 'internal',
  critical: false,
  needsConfirmation: false,
  source: { type: 'user', id: null, reference: null, recordedBy: 'you', confidence: null },
  effectiveFrom: at(10 * 1440),
  effectiveUntil: null,
  revision: 1,
  updatedAt: at(3 * 1440),
  openConflictId: null,
  ...extra,
});

const KNOWLEDGE = [
  fact(
    'identity',
    'city',
    null,
    { type: 'text', text: 'Lima' },
    {
      source: {
        type: 'user',
        id: 'business_profile',
        reference: null,
        recordedBy: 'you',
        confidence: null,
      },
    },
  ),
  fact(
    'operations',
    'opening_hours',
    'Horario de atención',
    {
      type: 'text',
      text: 'Lunes a sábado, de 9 a 19 h',
    },
    { revision: 3, openConflictId: 'kc_1' },
  ),
  fact('products', 'main_products', 'Productos principales', {
    type: 'list',
    items: ['Polos de algodón', 'Casacas', 'Uniformes escolares'],
  }),
  fact('commercial', 'delivery', 'Envíos', {
    type: 'text',
    text: 'Envío gratis en Lima por compras desde S/ 150',
  }),
  fact('policies', 'returns', 'Cambios y devoluciones', {
    type: 'text',
    text: 'Cambios dentro de los 15 días con boleta',
  }),
  fact(
    'customers',
    'ideal_customer',
    'Cliente ideal',
    {
      type: 'text',
      text: 'Tiendas de barrio y colegios de Lima Norte',
    },
    {
      verification: 'proposed',
      needsConfirmation: true,
      source: { type: 'gia', id: null, reference: null, recordedBy: 'gia', confidence: 0.86 },
      revision: 2,
    },
  ),
];

const CONFLICTS = [
  {
    id: 'kc_1',
    itemId: 'org_1_operations_opening_hours',
    domain: 'operations',
    key: 'opening_hours',
    label: 'Horario de atención',
    current: {
      value: { type: 'text', text: 'Lunes a sábado, de 9 a 19 h' },
      verification: 'confirmed',
      source: 'user',
      recordedBy: 'you',
    },
    candidate: {
      value: { type: 'text', text: 'Lunes a domingo, de 10 a 20 h' },
      verification: 'proposed',
      source: 'gia',
      recordedBy: 'gia',
    },
    createdAt: at(300),
  },
];

const QUESTIONS = [
  { id: 'tone', domain: 'brand', key: 'tone' },
  { id: 'goals', domain: 'goals', key: 'goals' },
];

const PROFILE = {
  businessType: 'store',
  country: 'PE',
  currency: 'PEN',
  timeZone: 'America/Lima',
  city: 'Lima',
  employees: '6_10',
  salesChannels: ['physical_store', 'whatsapp', 'social_media'],
  offering: 'Ropa y uniformes para tiendas y colegios',
  needs: 'Responder más rápido por WhatsApp',
  notes: null,
  updatedAt: at(3 * 1440),
};

const document = (
  id: string,
  name: string,
  contentType: string,
  sizeBytes: number,
  daysAgo: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  contentType,
  sizeBytes,
  sha256: id.padEnd(64, 'a'),
  status: 'ingested',
  ingestion: null,
  knowledgeDocumentId: `k_${id}`,
  textSource: 'library',
  pages: 3,
  uploadedBy: 'user_ana',
  createdAt: at(daysAgo * 1440),
  updatedAt: at(daysAgo * 1440),
  ...extra,
});

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const DOCUMENTS = [
  document('doc_1', 'Catálogo octubre 2026.pdf', PDF, 2_480_000, 1, { pages: 24 }),
  document('doc_2', 'Lista de precios mayoristas.xlsx', XLSX, 58_000, 3, {
    textSource: 'library',
    pages: null,
  }),
  document('doc_3', 'Política de cambios.docx', DOCX, 21_000, 6, { pages: 2 }),
  document('doc_4', 'Contrato proveedor textil.pdf', PDF, 910_000, 9, {
    status: 'not_ingested',
    ingestion: 'encrypted',
    knowledgeDocumentId: null,
    textSource: null,
    pages: null,
  }),
  document('doc_5', 'Guía de tallas.pdf', PDF, 340_000, 14, { pages: 4 }),
];

const bucket = (operations: number, credits: number) => ({ operations, credits });

const usageEvent = (
  id: string,
  minutesAgo: number,
  capability: string,
  credits: number,
  attribution: Record<string, unknown>,
) => ({
  id,
  occurredAt: at(minutesAgo),
  capability,
  outcome: 'completed',
  credits,
  attribution: { actor: 'agent', ...attribution },
});

const AI_USAGE = {
  summary: {
    totals: bucket(142, 96),
    by: {
      capability: {
        llm: bucket(118, 71),
        ocr: bucket(9, 12),
        document_ai: bucket(6, 8),
        embeddings: bucket(9, 5),
      },
      department: {
        org_1_sales: bucket(74, 48),
        org_1_marketing: bucket(38, 29),
        org_1_operations: bucket(30, 19),
      },
      agent: {
        spec_ana: bucket(61, 40),
        spec_leo: bucket(38, 29),
        spec_ops1: bucket(22, 14),
      },
      task_type: { reply: bucket(80, 44), summary: bucket(34, 30), extraction: bucket(28, 22) },
    },
    quantities: {},
  },
  events: [
    usageEvent('ev_1', 6, 'llm', 1, { departmentId: 'org_1_sales', specialistId: 'spec_ana' }),
    usageEvent('ev_2', 14, 'llm', 1, { departmentId: 'org_1_marketing', specialistId: 'spec_leo' }),
    usageEvent('ev_3', 40, 'ocr', 2, { departmentId: 'org_1_operations' }),
    usageEvent('ev_4', 75, 'llm', 0, { departmentId: 'org_1_sales', specialistId: 'spec_ana' }),
    usageEvent('ev_5', 130, 'document_ai', 2, { departmentId: 'org_1_operations' }),
    usageEvent('ev_6', 220, 'embeddings', 1, {}),
  ],
};

const day = (i: number, days: number) =>
  new Date(Date.now() - (days - i) * DAY).toISOString().slice(0, 10);

const history = (
  metric: string,
  unit: 'currency' | 'count',
  frequency: 'day' | 'week' | 'month',
  values: readonly number[],
  previousTotal: number | null,
) => {
  const step = frequency === 'day' ? 1 : frequency === 'week' ? 7 : 30;
  const points = values.map((value, i) => ({ period: day(i * step, values.length * step), value }));
  const total = values.reduce((a, b) => a + b, 0);
  return {
    metric,
    unit,
    entity: unit === 'currency' ? 'PEN' : 'all',
    frequency,
    timeZone: 'America/Lima',
    from: points[0]?.period,
    to: points.at(-1)?.period,
    points,
    total,
    average: Math.round(total / values.length),
    previousTotal,
    current: { period: dateIn(0), value: values.at(-1) ?? 0 },
    firstRecord: points[0]?.period ?? null,
    readiness: { ready: true, have: values.length, need: 28 },
  };
};

const wave = (length: number, base: number, swing: number) =>
  Array.from({ length }, (_, i) =>
    Math.max(0, Math.round(base + swing * Math.sin(i / 2.3) + (i % 5) * swing * 0.2)),
  );

const METRIC_SERIES: Record<string, { unit: 'currency' | 'count'; base: number; swing: number }> = {
  'sales.won_value': { unit: 'currency', base: 420, swing: 180 },
  'sales.won_count': { unit: 'count', base: 3, swing: 2 },
  'leads.new': { unit: 'count', base: 6, swing: 3 },
  'opportunities.new': { unit: 'count', base: 2, swing: 1 },
  'conversations.new': { unit: 'count', base: 14, swing: 5 },
};

const METRIC_DEPARTMENTS: Record<string, string[]> = {
  'sales.won_value': ['sales', 'leadership', 'finance', 'research'],
  'sales.won_count': ['sales', 'leadership', 'research'],
  'leads.new': ['sales', 'marketing', 'leadership', 'research'],
  'opportunities.new': ['sales', 'leadership', 'research'],
  'conversations.new': ['operations', 'sales', 'marketing', 'leadership', 'research'],
};

function metrics() {
  const list = Object.entries(METRIC_SERIES).map(([id, { unit }]) => ({
    id,
    unit,
    entity: unit === 'currency' ? 'currency' : 'all',
    frequencies: ['day', 'week', 'month'],
    departments: METRIC_DEPARTMENTS[id] ?? [],
    readable: true,
  }));
  const histories: Record<string, Record<string, unknown>> = {};
  for (const [id, { unit, base, swing }] of Object.entries(METRIC_SERIES)) {
    const daily = wave(30, base, swing);
    const total = daily.reduce((a, b) => a + b, 0);
    histories[`${id}:day`] = history(id, unit, 'day', daily, Math.round(total * 0.82));
    histories[`${id}:week`] = history(
      id,
      unit,
      'week',
      wave(12, base * 7, swing * 7),
      Math.round(total * 2.4),
    );
    histories[`${id}:month`] = history(id, unit, 'month', wave(6, base * 30, swing * 20), null);
  }
  return { list, histories };
}

const approval = (
  id: string,
  specialistId: string,
  tool: string,
  action: string,
  riskLevel: 'low' | 'medium' | 'high',
  minutesAgo: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  status: 'pending',
  riskLevel,
  reason: 'approval_required',
  impact: 'changes_data',
  estimatedCredits: riskLevel === 'high' ? 4 : 2,
  executionId: `exec-${id}`,
  nodeId: action,
  specialist: { id: specialistId, version: 1 },
  tool: { id: tool, version: 1 },
  action,
  requestedBy: 'user_ana',
  requestedAt: at(minutesAgo),
  expiresAt: at(minutesAgo - 240),
  decidedAt: null,
  decidedBy: null,
  ...extra,
});

const EXTRA_APPROVALS = [
  approval('ap_2', 'spec_ana', 'message_send', 'send', 'high', 12),
  approval('ap_3', 'spec_ana', 'follow_up_schedule', 'schedule', 'low', 55),
  approval('ap_4', 'spec_ops1', 'conversation_handoff', 'handoff', 'medium', 95),
  approval('ap_5', 'spec_leo', 'message_send', 'send', 'medium', 26 * 60, {
    status: 'approved',
    decidedAt: at(25 * 60),
    decidedBy: 'you',
  }),
  approval('ap_6', 'spec_ana', 'message_send', 'send', 'high', 50 * 60, {
    status: 'rejected',
    decidedAt: at(49 * 60),
    decidedBy: 'you',
  }),
];

const workflow = (id: string, name: string, status: string, version: number, daysAgo: number) => ({
  id,
  name,
  status,
  version,
  createdAt: at(daysAgo * 1440),
  createdBy: 'user_ana',
  updatedAt: at(daysAgo * 720),
});

const WORKFLOWS = [
  workflow('wf_1', 'Responder consultas de precios', 'active', 3, 20),
  workflow('wf_2', 'Seguimiento de cotizaciones', 'active', 2, 12),
  workflow('wf_3', 'Resumen semanal de ventas', 'active', 1, 7),
  workflow('wf_4', 'Campaña de fin de mes', 'draft', 1, 2),
  workflow('wf_5', 'Bienvenida a nuevos clientes', 'paused', 2, 30),
];

const plan = (
  id: string,
  workflowId: string,
  name: string,
  status: string,
  minutesAgo: number,
  steps: { id: string; label: string; departmentTypeId: string }[],
) => ({
  id,
  status,
  version: 1,
  createdAt: at(minutesAgo),
  current: {
    version: 1,
    digest: id.padEnd(64, 'a'),
    request: { summary: name, objective: name },
    steps: steps.map((s, i) => ({
      id: s.id,
      kind: 'specialist',
      label: s.label,
      dependsOn: i === 0 ? [] : [steps[i - 1]?.id],
      assignee: { departmentTypeId: s.departmentTypeId, roleId: `${s.departmentTypeId}_agent` },
    })),
    riskLevel: 'low',
    source: { kind: 'workflow', workflowId, workflowVersion: 1 },
  },
});

const PLANS = [
  plan('plan_1', 'wf_2', 'Seguimiento de cotizaciones', 'approval_required', 18, [
    { id: 'find', label: 'Buscar cotizaciones sin respuesta', departmentTypeId: 'sales' },
    { id: 'draft', label: 'Redactar recordatorios', departmentTypeId: 'sales' },
  ]),
  plan('plan_2', 'wf_3', 'Resumen semanal de ventas', 'executing', 60, [
    { id: 'collect', label: 'Reunir las ventas de la semana', departmentTypeId: 'research' },
    { id: 'summary', label: 'Escribir el resumen', departmentTypeId: 'leadership' },
  ]),
  plan('plan_3', 'wf_1', 'Responder consultas de precios', 'completed', 26 * 60, [
    { id: 'answer', label: 'Responder con la lista de precios', departmentTypeId: 'sales' },
  ]),
];

const PLAN_STEPS = {
  plan_2: [
    {
      stepId: 'collect',
      label: 'Reunir las ventas de la semana',
      executionId: 'ex_21',
      status: 'completed',
      failure: null,
      answer: 'Se cerraron 9 ventas por S/ 6 480, un 12 % más que la semana pasada.',
      missing: [],
    },
    {
      stepId: 'summary',
      label: 'Escribir el resumen',
      executionId: 'ex_22',
      status: 'running',
      failure: null,
      answer: null,
      missing: [],
    },
  ],
  plan_3: [
    {
      stepId: 'answer',
      label: 'Responder con la lista de precios',
      executionId: 'ex_31',
      status: 'completed',
      failure: null,
      answer: 'Se respondió a 4 consultas con la lista de precios vigente.',
      missing: ['precio de casacas talla XL'],
    },
  ],
};

const agentTask = (
  id: string,
  specialistId: string,
  request: string,
  status: string,
  minutesAgo: number,
  answer: string | null = null,
) => ({
  id,
  specialistId,
  request,
  createdAt: at(minutesAgo),
  status,
  failure: null,
  completedAt: answer === null ? null : at(minutesAgo - 3),
  answer: answer === null ? null : { answer, missing: [], facts: 0, followUp: null },
});

const SALES_TASKS = [
  agentTask('t1', 'spec_ana', 'Revisar los leads de esta semana', 'running', 20),
  agentTask(
    't4',
    'spec_ana',
    '¿Qué clientes no compran hace más de un mes?',
    'completed',
    26 * 60,
    'Lucía Fernández y Pedro Salazar no compran hace más de 30 días. Lucía suele pedir a fin de mes.',
  ),
  agentTask(
    't5',
    'spec_ana',
    'Resume las consultas de precios de ayer',
    'completed',
    50 * 60,
    'Llegaron 6 consultas: 4 por polos de algodón y 2 por uniformes. Todas recibieron respuesta.',
  ),
];

const conversation = (
  id: string,
  contactId: string,
  name: string,
  preview: string,
  minutesAgo: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  contactId,
  channel: 'whatsapp',
  status: 'open',
  assigneeId: null,
  departmentId: 'org_1_sales',
  priority: 'normal',
  tags: [],
  lastMessage: { direction: 'inbound', preview, at: at(minutesAgo) },
  lastMessageAt: at(minutesAgo),
  createdAt: at(minutesAgo + 600),
  control: { handledBy: 'human', aiState: 'off', changedAt: null },
  handoff: null,
  contact: { id: contactId, displayName: name, phone: '+51987654321' },
  ...extra,
});

const CONVERSATIONS = [
  conversation('c1', 'ct_1', 'Juan Pérez', '¿Tienen polos en talla L?', 4, {
    priority: 'high',
    tags: ['precio'],
  }),
  conversation('c2', 'ct_2', 'María Quispe', 'Perfecto, espero la cotización', 32, {
    assigneeId: 'user_ana',
    lastMessage: { direction: 'outbound', preview: 'Le envío la cotización hoy', at: at(32) },
  }),
  conversation(
    'c3',
    'ct_5',
    'Distribuidora Andina',
    'Necesitamos 200 unidades para noviembre',
    95,
    {
      priority: 'urgent',
      control: { handledBy: 'ai', aiState: 'active', changedAt: at(90) },
    },
  ),
  conversation('c4', 'ct_6', 'Rosa Mamani', 'Gracias, lo reviso con mi jefa', 180),
  conversation('c5', 'ct_3', 'Carlos Rojas', '¿Hacen envíos a Arequipa?', 26 * 60, {
    status: 'pending',
  }),
];

const message = (
  id: string,
  direction: 'inbound' | 'outbound',
  text: string,
  minutesAgo: number,
) => ({
  id,
  direction,
  sender: direction === 'inbound' ? { kind: 'contact' } : { kind: 'user', userId: 'user_ana' },
  type: 'text',
  text,
  status: direction === 'inbound' ? 'received' : 'delivered',
  sentAt: at(minutesAgo),
});

const MESSAGES = [
  message('m1', 'inbound', 'Hola, buenos días. ¿Tienen polos de algodón en talla L?', 40),
  message('m2', 'outbound', 'Hola Juan, sí tenemos. ¿En qué color los necesita?', 35),
  message('m3', 'inbound', 'Negro y azul marino, unas 20 unidades de cada uno.', 20),
  message('m4', 'inbound', '¿Tienen polos en talla L?', 4),
];

const CONNECTION = (
  id: string,
  displayName: string,
  phone: string,
  status: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  provider: 'meta_whatsapp_cloud',
  category: 'messaging',
  channel: 'whatsapp',
  status,
  statusReason: null,
  displayName,
  account: { phoneNumberId: `10654035224${id.length}922`, displayPhoneNumber: phone },
  lastValidatedAt: at(120),
  updatedAt: at(3 * 1440),
  ...extra,
});

const CONNECTIONS = [
  CONNECTION('conn_1', 'Ventas', '+51 987 654 321', 'connected'),
  CONNECTION('conn_2', 'Atención al cliente', '+51 912 345 678', 'paused'),
  CONNECTION('conn_3', 'Tienda Miraflores', '+51 955 443 322', 'error', {
    statusReason: 'channel_unauthorized',
    lastValidatedAt: null,
  }),
];

const template = (id: string, name: string, status: string, bodyParameters: number) => ({
  id,
  name,
  language: 'es',
  status,
  statusReason: status === 'invalid' ? 'template_not_found' : null,
  category: 'utility',
  spec: { header: { format: 'none' }, bodyParameters, urlButtons: [] },
  lastValidatedAt: at(600),
});

const relationship = (
  commercialAccountId: string,
  name: string,
  type: 'partner' | 'agency',
  mode: string,
  status: string,
  scopes: string[],
) => ({
  commercialAccountId,
  mode,
  status,
  scopes,
  updatedAt: at(2 * 1440),
  account: { name, type },
});

const RELATIONSHIPS = [
  relationship('acc_1', 'Nexo Consultores', 'partner', 'white_label', 'pending', [
    'summary',
    'usage',
    'knowledge',
  ]),
  relationship('acc_2', 'Agencia Pampa', 'agency', 'agency', 'active', [
    'summary',
    'usage',
    'conversations',
  ]),
  relationship('acc_3', 'Soporte Andes', 'partner', 'direct', 'active', ['summary', 'support']),
];

const consoleCustomer = (organizationId: string, name: string | null, scopes: string[]) => ({
  organizationId,
  mode: 'white_label',
  scopes,
  name,
});

const PLATFORM_BUCKET = (operations: number, costMicroUsd: number, credits: number) => ({
  operations,
  costMicroUsd,
  unpricedOperations: 0,
  credits,
});

const PLATFORM = {
  ai: {
    environment: 'dev',
    providers: [
      {
        id: 'google-vertex-ai',
        name: 'Google Cloud Vertex AI',
        status: 'active',
        health: 'available',
        capabilities: ['text_generation', 'embeddings'],
        environments: ['dev', 'prod'],
        maxSensitivity: 'confidential',
      },
      {
        id: 'nvidia',
        name: 'NVIDIA',
        status: 'active',
        health: 'degraded',
        capabilities: ['text_generation'],
        environments: ['dev'],
        maxSensitivity: 'public',
      },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        status: 'active',
        health: 'available',
        capabilities: ['text_generation'],
        environments: ['dev'],
        maxSensitivity: 'public',
      },
    ],
    models: [
      {
        providerId: 'google-vertex-ai',
        modelId: 'gemini-2.5-flash-lite',
        version: 'stable',
        displayName: null,
        status: 'active',
        capabilities: ['text_generation'],
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 65_536,
        pricing: {
          status: 'known',
          inputMicroUsdPerMillionTokens: 100_000,
          outputMicroUsdPerMillionTokens: 400_000,
          source: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
          asOf: '2026-09-27',
        },
        environments: ['dev', 'prod'],
        maxSensitivity: 'confidential',
        terms: null,
      },
      {
        providerId: 'nvidia',
        modelId: 'llama-3.3-70b-instruct',
        version: '1',
        displayName: null,
        status: 'active',
        capabilities: ['text_generation'],
        contextWindowTokens: 131_072,
        maxOutputTokens: 8_192,
        pricing: { status: 'unknown' },
        environments: ['dev'],
        maxSensitivity: 'public',
        terms: { offering: 'trial', production: 'not_allowed' },
      },
    ],
    policies: [
      {
        id: 'gia_assist',
        version: 2,
        allowedModels: ['google-vertex-ai/gemini-2.5-flash-lite'],
        environments: ['dev', 'prod'],
        maxSensitivity: 'confidential',
        maxCostMicroUsd: 10_000,
        strategy: null,
        fallback: 'compatible',
        maxAttempts: 2,
      },
      {
        id: 'conversation_reply',
        version: 1,
        allowedModels: null,
        environments: ['dev'],
        maxSensitivity: 'internal',
        maxCostMicroUsd: 5_000,
        strategy: 'cheapest',
        fallback: 'none',
        maxAttempts: 1,
      },
    ],
  },
  usage: {
    scope: 'platform',
    totals: PLATFORM_BUCKET(1_284, 412_500, 860),
    by: {
      provider: {
        'google-vertex-ai': PLATFORM_BUCKET(1_102, 398_000, 790),
        nvidia: PLATFORM_BUCKET(120, 0, 40),
        deepseek: PLATFORM_BUCKET(62, 14_500, 30),
      },
      model: {
        'google-vertex-ai/gemini-2.5-flash-lite': PLATFORM_BUCKET(1_102, 398_000, 790),
        'nvidia/llama-3.3-70b-instruct': PLATFORM_BUCKET(120, 0, 40),
      },
    },
    byOrganization: [
      { organizationId: 'org_1', name: 'Acme', ...PLATFORM_BUCKET(642, 206_000, 430) },
      { organizationId: 'org_2', name: 'Panadería Sol', ...PLATFORM_BUCKET(388, 124_000, 260) },
      {
        organizationId: 'org_3',
        name: 'Ferretería El Clavo',
        ...PLATFORM_BUCKET(254, 82_500, 170),
      },
    ],
  },
};

const commercialAccount = (
  id: string,
  type: string,
  name: string,
  status: string,
  limits: Record<string, number> | null,
  parentAccountId: string | null = null,
) => ({ id, type, name, status, limits, parentAccountId, updatedAt: at(5 * 1440) });

const PLATFORM_ACCOUNTS = [
  commercialAccount('acc_1', 'white_label', 'Nexo Consultores', 'active', {
    customers: 20,
    members: 5,
    resellers: 3,
  }),
  commercialAccount(
    'acc_4',
    'reseller',
    'Redes del Sur',
    'active',
    { customers: 5, members: 2 },
    'acc_1',
  ),
  commercialAccount('acc_2', 'agency', 'Agencia Pampa', 'active', { customers: 10, members: 4 }),
  commercialAccount('acc_3', 'partner', 'Soporte Andes', 'suspended', { customers: 5, members: 2 }),
];

const DOMAINS = [
  {
    hostname: 'app.nexo.example',
    target: { type: 'commercial_account', commercialAccountId: 'acc_1' },
    status: 'active',
    updatedAt: at(8 * 1440),
  },
  {
    hostname: 'oficina.acme.example',
    target: { type: 'organization', organizationId: 'org_1' },
    status: 'pending_verification',
    updatedAt: at(1440),
  },
];

/** What the `pages` scenario adds to `active`: data for every secondary page. */
export function seedPages(backend: FakeBackend, routes: PreviewRoutes) {
  const { options } = backend;
  options.permissions.push(...PAGES_PERMISSIONS);
  options.businessProfiles.org_1 = PROFILE;
  options.customers.org_1 = CUSTOMERS;
  options.opportunities.org_1 = OPPORTUNITIES;
  options.followUps.org_1 = FOLLOW_UPS;
  options.contactContext.ct_1 = {
    conversations: [
      { id: 'c1', channel: 'whatsapp', status: 'open', lastMessageAt: at(4) },
      { id: 'c9', channel: 'whatsapp', status: 'closed', lastMessageAt: at(20 * 1440) },
    ],
    opportunities: [
      {
        id: 'opp_3',
        title: 'Renovación de stock',
        status: 'open',
        value: { amountMinor: 480_000, currency: 'PEN' },
        probability: 75,
        owner: 'you',
        expectedCloseOn: dateIn(10),
        nextAction: null,
        lostReason: null,
        stage: {
          id: 'negotiation',
          kind: 'open',
          name: null,
          nameKey: 'pipeline.stage.negotiation',
        },
        updatedAt: at(180),
      },
      {
        id: 'opp_9',
        title: 'Pedido de agosto',
        status: 'lost',
        value: null,
        probability: 0,
        owner: null,
        expectedCloseOn: null,
        nextAction: null,
        lostReason: 'price',
        stage: { id: 'lost', kind: 'lost', name: null, nameKey: 'pipeline.stage.lost' },
        updatedAt: at(40 * 1440),
      },
    ],
    history: [
      {
        id: 'h2',
        at: at(3 * 1440),
        action: 'opportunity.created',
        transition: { from: 'none', to: 'negotiation' },
        reason: null,
        actor: 'you',
        opportunityId: 'opp_3',
      },
      {
        id: 'h1',
        at: at(12 * 1440),
        action: 'contact.stage_changed',
        transition: { from: 'lead', to: 'customer' },
        reason: null,
        actor: 'member',
        opportunityId: null,
      },
    ],
  };
  options.customerNotes.ct_1 = [
    {
      id: 'note_1',
      text: 'Prefiere que lo llamen por la mañana.',
      author: 'you',
      createdAt: at(5 * 1440),
    },
  ];
  options.knowledge.org_1 = KNOWLEDGE;
  options.knowledgeConflicts.org_1 = CONFLICTS;
  options.knowledgeQuestions.org_1 = QUESTIONS;
  options.documents.org_1 = DOCUMENTS;
  options.aiUsage.org_1 = AI_USAGE;
  options.metrics.org_1 = metrics();
  options.approvals.org_1 = [...(options.approvals.org_1 ?? []), ...EXTRA_APPROVALS];
  options.workflows.org_1 = WORKFLOWS;
  options.plans.org_1 = PLANS;
  Object.assign(options.planSteps, PLAN_STEPS);
  options.agentTasks.spec_ana = SALES_TASKS;
  options.conversations.org_1 = CONVERSATIONS.map((c) => ({
    id: c.id,
    name: c.contact.displayName,
    priority: c.priority,
  }));
  options.activity.org_1 = [
    ...(options.activity.org_1 ?? []),
    ...[
      { action: 'gia.message_answered', minutes: 3, actor: 'gia' },
      { action: 'opportunity.won', minutes: 50, actor: 'you' },
      { action: 'gia.message_answered', minutes: 95, actor: 'gia' },
      { action: 'follow_up.created', minutes: 160, actor: 'gia' },
      { action: 'plan.approved', minutes: 210, actor: 'you' },
    ].map(({ action, minutes, actor }, i) => ({
      id: `ev_pages_${i}`,
      at: at(minutes),
      action,
      result: 'success',
      actor,
    })),
  ];
  options.platform = PLATFORM;
  options.commercialAccounts = [
    {
      id: 'acc_1',
      type: 'partner',
      name: 'Nexo Consultores',
      status: 'active',
      limits: { customers: 20, members: 5 },
      parentAccountId: null,
      role: 'partner.admin',
    },
  ];

  const org = '/v1/organizations/org_1';
  routes.set(`GET ${org}/conversations`, () => ({ conversations: CONVERSATIONS }));
  for (const c of CONVERSATIONS) {
    routes.set(`GET ${org}/conversations/${c.id}/detail`, () => ({
      conversation: c,
      contact: {
        id: c.contactId,
        displayName: c.contact.displayName,
        phone: c.contact.phone,
        email: null,
        createdAt: c.createdAt,
      },
      identity: { channel: 'whatsapp', externalId: '51987654321', displayName: null },
      messages:
        c.id === 'c1' ? MESSAGES : [message(`${c.id}_m1`, 'inbound', c.lastMessage.preview, 60)],
      handoffSummary: null,
    }));
  }
  routes.set(`GET ${org}/integrations/providers`, () => ({
    providers: [{ provider: 'meta_whatsapp_cloud', category: 'messaging', channel: 'whatsapp' }],
  }));
  routes.set(`GET ${org}/channel-connections`, () => ({ connections: CONNECTIONS }));
  routes.set(`GET ${org}/channel-connections/conn_1/templates`, () => ({
    templates: [
      template('tpl_1', 'confirmacion_pedido', 'active', 2),
      template('tpl_2', 'recordatorio_pago', 'active', 1),
      template('tpl_3', 'promo_octubre', 'pending', 0),
    ],
  }));
  routes.set(`GET ${org}/commercial-relationships`, () => ({ relationships: RELATIONSHIPS }));
  // The brand screen's own level; no stored level, so the app keeps its look.
  routes.set(`GET ${org}/brand`, () => ({
    levels: [],
    own: {
      productName: 'Acme Oficina',
      faviconUrl: 'https://acme.example/favicon.png',
      primaryColor: '#1f6f5c',
    },
    updatedAt: at(1440),
  }));

  const account = '/v1/commercial/accounts/acc_1';
  routes.set(`GET ${account}/customers`, () => ({
    customers: [
      consoleCustomer('org_2', 'Panadería Sol', ['summary', 'usage', 'billing', 'branding']),
      consoleCustomer('org_3', 'Ferretería El Clavo', ['summary', 'usage']),
      consoleCustomer('org_4', 'Librería Central', ['summary', 'support']),
      consoleCustomer('org_5', null, ['usage']),
    ],
    pending: [{ organizationId: 'org_6', mode: 'white_label', scopes: ['summary', 'usage'] }],
  }));
  routes.set(`GET ${account}/invitations`, () => ({
    invitations: [
      {
        id: 'inv_1',
        email: 'gerencia@panaderia-sol.example',
        mode: 'white_label',
        scopes: ['summary', 'usage'],
        status: 'pending',
        expiresAt: at(-5 * 1440),
        createdAt: at(2 * 1440),
        updatedAt: at(2 * 1440),
      },
      {
        id: 'inv_2',
        email: 'dueno@libreria.example',
        mode: 'white_label',
        scopes: ['summary'],
        status: 'accepted',
        expiresAt: at(-1440),
        createdAt: at(9 * 1440),
        updatedAt: at(6 * 1440),
      },
    ],
  }));
  routes.set(`GET ${account}/members`, () => ({
    members: [
      { userId: 'user_ana', role: 'partner.admin', status: 'active', updatedAt: at(30 * 1440) },
      { userId: 'user_luis', role: 'partner.support', status: 'active', updatedAt: at(10 * 1440) },
    ],
  }));
  routes.set(`GET ${account}/member-invitations`, () => ({
    invitations: [
      {
        id: 'mi_1',
        email: 'soporte@nexo.example',
        role: 'partner.support',
        status: 'pending',
        expiresAt: at(-6 * 1440),
        createdAt: at(1440),
        updatedAt: at(1440),
      },
    ],
  }));
  routes.set(`GET ${account}/brand`, () => ({
    config: { productName: 'Nexo Oficina', primaryColor: '#24507a' },
    updatedAt: at(4 * 1440),
  }));

  routes.set('GET /v1/platform/commercial-accounts', () => ({ accounts: PLATFORM_ACCOUNTS }));
  routes.set('GET /v1/platform/domain-bindings', () => ({ domains: DOMAINS }));

  // An invitation link opened by a signed-in person (`/invite#t=…`, `/join#t=…`).
  routes.set('POST /v1/invitations/lookup', () => ({
    invitation: {
      account: { name: 'Nexo Consultores', type: 'partner' },
      mode: 'white_label',
      scopes: ['summary', 'usage', 'billing', 'knowledge'],
      status: 'pending',
      expiresAt: at(-5 * 1440),
      updatedAt: at(1440),
    },
    person: 'invited',
    organization: { id: 'org_1', canDecide: true },
  }));
  routes.set('POST /v1/member-invitations/lookup', () => ({
    invitation: {
      account: { name: 'Nexo Consultores', type: 'partner' },
      role: 'partner.support',
      status: 'pending',
      expiresAt: at(-5 * 1440),
      updatedAt: at(1440),
    },
    person: 'invited',
  }));
}
