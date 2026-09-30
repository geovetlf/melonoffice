import type { FakeBackend } from '../identity/testing.js';

/**
 * The office states the preview shows. They are fixtures for design review, like the tests'
 * data: nothing here is served to a real organization.
 */
export type ScenarioName = 'empty' | 'active';

/** Everything an owner can see on the Home and its screens. */
const OWNER_PERMISSIONS = [
  'ai_usage.read',
  'approval.read',
  'approval.approve',
  'document.read',
  'document.upload',
  'follow_up.read',
  'knowledge.read',
  'plan.read',
  'report.read',
  'specialist.manage',
  'specialist.task',
  'workflow.read',
];

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const followUp = (id: string, title: string, when: 'overdue' | 'today') => ({
  id,
  contactId: 'ct_1',
  contactName: 'Juan Pérez',
  opportunityId: null,
  assignee: 'you',
  type: 'call',
  title,
  description: null,
  scheduledAt: minutesAgo(-120),
  timeZone: 'America/Lima',
  date: new Date().toISOString().slice(0, 10),
  time: '10:00',
  when,
  days: when === 'overdue' ? -1 : 0,
  status: 'scheduled',
  source: 'manual',
  cancelReason: null,
  failure: null,
  revision: 1,
});

const task = (id: string, specialistId: string, request: string, status: string) => ({
  id,
  specialistId,
  request,
  createdAt: minutesAgo(20),
  status,
  failure: null,
  completedAt: null,
  answer: null,
});

export const SCENARIOS: Record<ScenarioName, (backend: FakeBackend) => void> = {
  /** A new organization: the catalogue's departments, no agents, nothing recorded yet. */
  empty(backend) {
    backend.options.permissions.push(...OWNER_PERMISSIONS);
    backend.options.approvals = { org_1: [] };
  },

  /** An organization at work: agents in most rooms, some working, one waiting on a person. */
  active(backend) {
    backend.options.permissions.push(...OWNER_PERMISSIONS);
    backend.options.credits = { org_1: 487 };
    backend.options.specialists.org_1 = [
      { id: 'spec_ana', name: 'Ana Ventas', type: 'sales', status: 'active', purpose: 'Leads' },
      { id: 'spec_leo', name: 'Leo Campañas', type: 'marketing', status: 'active' },
      { id: 'spec_ops1', name: 'Olga Procesos', type: 'operations', status: 'active' },
      { id: 'spec_ops2', name: 'Omar Pedidos', type: 'operations', status: 'active' },
      { id: 'spec_eva', name: 'Eva Cuentas', type: 'finance', status: 'paused' },
      { id: 'spec_ivo', name: 'Ivo Datos', type: 'research', status: 'active' },
    ];
    backend.options.agentTasks = {
      spec_ana: [task('t1', 'spec_ana', 'Revisar los leads de esta semana', 'running')],
      spec_ops1: [task('t2', 'spec_ops1', 'Ordenar los pedidos pendientes', 'running')],
      spec_leo: [task('t3', 'spec_leo', 'Preparar la campaña de octubre', 'waiting_approval')],
    };
    backend.options.followUps.org_1 = [
      followUp('fu_1', 'Llamar a Juan Pérez', 'overdue'),
      followUp('fu_2', 'Enviar propuesta a Nordic', 'today'),
    ];
    backend.options.approvals = {
      org_1: [
        {
          id: 'ap_1',
          status: 'pending',
          riskLevel: 'medium',
          reason: 'approval_required',
          impact: 'changes_data',
          estimatedCredits: 2,
          executionId: 'exec-ap_1',
          nodeId: 'send',
          specialist: { id: 'spec_leo', version: 1 },
          tool: { id: 'message_send', version: 1 },
          action: 'send',
          requestedBy: 'user_ana',
          requestedAt: minutesAgo(30),
          expiresAt: minutesAgo(-90),
          decidedAt: null,
          decidedBy: null,
        },
      ],
    };
    backend.options.activity.org_1 = [
      { action: 'conversation.message_received', minutes: 8 },
      { action: 'conversation.message_sent', minutes: 25 },
      { action: 'organization.profile_updated', minutes: 70 },
      { action: 'conversation.assigned', minutes: 140 },
    ].map(({ action, minutes }, i) => ({
      id: `ev_${i}`,
      at: minutesAgo(minutes),
      action,
      result: 'success',
      actor: 'you',
    }));
  },
};
