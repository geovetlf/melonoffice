import type { Firestore } from '@google-cloud/firestore';
import { InMemoryAgentTaskRepository, type AgentTaskRepository } from '@melonoffice/agents';
import {
  createModelPolicyCatalogue,
  createProviderRegistry,
  CREDIT_RATE,
  type ProviderCall,
  type ProviderOutcome,
} from '@melonoffice/ai-gateway';
import {
  AGENT_TASK_POLICY,
  CONVERSATION_AGENT_POLICY,
  VERTEX_AI_MODELS,
  VERTEX_AI_PROVIDER,
  VERTEX_AI_PROVIDER_ID,
} from '@melonoffice/ai-vertex';
import { createApprovalService, InMemoryApprovalRepository } from '@melonoffice/approvals';
import { createAuditService, InMemoryAuditStore, type AuditEvent } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { InMemoryKnowledgeRepository, type KnowledgeRepository } from '@melonoffice/brain';
import {
  createCustomerService,
  createFollowUpService,
  InMemoryConversationRepository,
  type ConversationRepository,
} from '@melonoffice/conversations';
import {
  createCreditService,
  InMemoryCreditStore,
  openWallet,
  type CreditStore,
} from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  InitialBilling,
  IsoTimestamp,
  JobId,
  Organization,
  Plan,
  SubscriptionId,
  UserId,
  Workflow,
  WorkflowId,
} from '@melonoffice/domain';
import {
  createExecutionService,
  InMemoryAgentOutputRepository,
  InMemoryExecutionRepository,
  InMemorySweepLedger,
  type AgentOutputRepository,
  type StaleExecutionIndex,
} from '@melonoffice/execution';
import {
  AUDIT_LOGS,
  FirestoreAgentOutputRepository,
  FirestoreAgentTaskRepository,
  FirestoreApprovalRepository,
  FirestoreAuditStore,
  FirestoreConversationRepository,
  FirestoreCreditStore,
  FirestoreDepartmentRepository,
  FirestoreExecutionRepository,
  FirestoreJobRepository,
  FirestoreKnowledgeRepository,
  FirestorePlanRepository,
  FirestoreSpecialistRepository,
  FirestoreTenancyStore,
  FirestoreWorkflowRepository,
  FirestoreWorkflowScheduleRepository,
  fromAuditDocument,
  WORKFLOW_SCHEDULES,
  type AuditDocument,
} from '@melonoffice/firestore';
import { emulatorFirestore, emulatorHost } from '@melonoffice/firestore/testing';
import { harnessTaskPolicy } from '@melonoffice/harness';
import { InMemoryJobRepository, isJobError } from '@melonoffice/jobs';
import {
  createPlanCancellationCascade,
  createPlanService,
  createPlanValidator,
  InMemoryPlanRepository,
  type PlanRepository,
} from '@melonoffice/planning';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createSkillCatalogue,
  createSpecialistManagement,
  createSpecialistService,
  InMemorySpecialistRepository,
} from '@melonoffice/specialists';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
} from '@melonoffice/tenancy';
import { createToolRegistry, TOOL_CATALOGUE } from '@melonoffice/tools';
import {
  createWorkflowScheduleService,
  createWorkflowService,
  InMemoryWorkflowRepository,
  InMemoryWorkflowScheduleRepository,
  type ScheduleTask,
  type WorkflowRepository,
  type WorkflowScheduleRepository,
} from '@melonoffice/workflows';
import { describe, expect, it } from 'vitest';
import { createAgentTaskParts, createConversationAgentParts, routeAgentWork } from './agents.js';
import { createWorkerRuntime, type WorkerStores } from './runtime.js';
import { createExecutionSweeper, sweepSlotOf } from './sweeps.js';
import { createWorkflowScheduleRunner } from './workflow-schedules.js';

/**
 * A workflow runs by itself on a schedule (ADR-0185), on the engines that already exist: a
 * person switches the schedule on (a standing approval), each occurrence is one task the worker
 * claims once, the workflow is planned as that person's runtime, the standing approval decides
 * the plan, the conductor starts it, the agents work, and every step is audited. Step approvals,
 * credits, cancellation and tenancy are the existing ones. In memory and on the emulator.
 */

// 07:00 in Lima (UTC-5): the first 09:00 occurrence is at 14:00Z the same day.
const T0 = new Date('2026-10-05T12:00:00Z');
const FIRST = '2026-10-05T14:00:00.000Z';
const SECOND = '2026-10-06T14:00:00.000Z';
const LEASE_MS = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const CREDITS = 100;
const DAILY = { frequency: 'daily', time: '09:00' };

const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

const answer = (text: string): ProviderOutcome => ({
  status: 'success',
  output: { structured: { answer: text, missing: [] } },
  usage: { inputTokens: 700, outputTokens: 80 },
  finishReason: 'stop',
  providerRequestId: 'vertex-req',
});

const VERIFICATION = {
  policy: 'output_schema',
  expectedOutput: 'agent_answer',
  requiredChecks: [],
};
const SELLER = { departmentTypeId: 'sales', roleId: 'commercial_agent' };

/** A weekly summary by the commercial agent: one step, nothing written. */
const SUMMARY = [
  {
    id: 'week',
    kind: 'specialist',
    label: 'Resumir la semana',
    dependsOn: [],
    assignee: SELLER,
    verification: VERIFICATION,
  },
];

/** The agent prepares a call and its tool step schedules it with the contact (B6, ADR-0184). */
const callSteps = (contactId: string) => [
  {
    id: 'prepare',
    kind: 'specialist',
    label: 'Preparar la llamada',
    dependsOn: [],
    assignee: SELLER,
    verification: VERIFICATION,
  },
  {
    id: 'schedule',
    kind: 'tool',
    label: 'Agendar la llamada',
    dependsOn: ['prepare'],
    performedBy: 'prepare',
    tool: { id: 'workflow_follow_up', version: 1 },
    input: { contactId, type: 'call', title: 'Llamar por su pedido', inDays: 1, time: '10:30' },
  },
];

type Stores = WorkerStores & {
  /** What the sweep reads: every open execution nothing moved since a time (ADR-0121). */
  readonly executions: WorkerStores['executions'] & StaleExecutionIndex;
  readonly conversations: ConversationRepository;
  readonly outputs: AgentOutputRepository;
  readonly tasks: AgentTaskRepository;
  readonly knowledge: KnowledgeRepository;
  readonly plans: PlanRepository;
  readonly workflows: WorkflowRepository;
  readonly schedules: WorkflowScheduleRepository;
  readonly credits: CreditStore;
  readonly events: () => Promise<readonly AuditEvent[]>;
};

function memoryStores(now: () => Date): Stores {
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const credits = new InMemoryCreditStore(audit);
  return {
    tenancy: new InMemoryTenancyStore(now, audit, undefined, departments, credits),
    departments,
    specialists: new InMemorySpecialistRepository(audit),
    executions: new InMemoryExecutionRepository(audit),
    approvals: new InMemoryApprovalRepository(audit),
    jobs: new InMemoryJobRepository(audit),
    conversations: new InMemoryConversationRepository(audit),
    outputs: new InMemoryAgentOutputRepository(),
    tasks: new InMemoryAgentTaskRepository(),
    knowledge: new InMemoryKnowledgeRepository(audit),
    plans: new InMemoryPlanRepository(audit),
    workflows: new InMemoryWorkflowRepository(audit),
    schedules: new InMemoryWorkflowScheduleRepository(audit),
    credits,
    audit,
    events: async () => audit.events(),
  };
}

async function firestoreStores(now: () => Date): Promise<Stores> {
  const db: Firestore = emulatorFirestore();
  // The sweep's recovery reads every organization's schedules: start from none.
  const left = await db.collection(WORKFLOW_SCHEDULES).get();
  await Promise.all(left.docs.map((doc) => doc.ref.delete()));
  return {
    tenancy: new FirestoreTenancyStore(db, now),
    departments: new FirestoreDepartmentRepository(db),
    specialists: new FirestoreSpecialistRepository(db),
    executions: new FirestoreExecutionRepository(db),
    approvals: new FirestoreApprovalRepository(db),
    jobs: new FirestoreJobRepository(db),
    conversations: new FirestoreConversationRepository(db),
    outputs: new FirestoreAgentOutputRepository(db),
    tasks: new FirestoreAgentTaskRepository(db),
    knowledge: new FirestoreKnowledgeRepository(db),
    plans: new FirestorePlanRepository(db),
    workflows: new FirestoreWorkflowRepository(db),
    schedules: new FirestoreWorkflowScheduleRepository(db),
    credits: new FirestoreCreditStore(db),
    audit: new FirestoreAuditStore(db),
    async events() {
      const snapshot = await db.collection(AUDIT_LOGS).orderBy('occurredAt').get();
      return snapshot.docs.map((doc) => fromAuditDocument(doc.id, doc.data() as AuditDocument));
    },
  };
}

const STORES: [string, (now: () => Date) => Stores | Promise<Stores>][] = [
  ['memory', memoryStores],
  ...(emulatorHost ? [['firestore', firestoreStores] as [string, typeof firestoreStores]] : []),
];

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing');
  return value;
};

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
};

describe.each(STORES)(
  'a workflow runs on its schedule, with storage in %s (ADR-0185)',
  (_storage, createStores) => {
    async function world(
      options: {
        readonly credits?: number;
        readonly timeZone?: string;
        readonly skill?: number;
      } = {},
    ) {
      let clock = new Date(T0);
      const now = () => {
        clock = new Date(clock.getTime() + 1);
        return clock;
      };
      const stores = await createStores(now);
      const provision = (organization: Organization) =>
        provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE);
      const a = await createOrganization(as(ALICE), { name: 'Pollería A' }, stores.tenancy, {
        billing: BILLING,
        credits: openWallet,
        departments: provision,
      });
      const b = await createOrganization(as(BOB), { name: 'Empresa B' }, stores.tenancy, {
        billing: BILLING,
        credits: openWallet,
        departments: provision,
      });
      const orgA = a.organization.id;
      const orgB = b.organization.id;
      const authorization = createAuthorizationService();
      const audit = createAuditService(stores.audit, now);
      const registry = createToolRegistry(TOOL_CATALOGUE);
      const specialists = createSpecialistService({
        repository: stores.specialists,
        departments: stores.departments,
        organizations: stores.tenancy,
        authorization,
      });
      const management = createSpecialistManagement({
        repository: stores.specialists,
        departments: stores.departments,
        organizations: stores.tenancy,
        authorization,
        skills: createSkillCatalogue(),
        tools: (id, version) => {
          const found = registry.resolve(id, version)?.version;
          return found === undefined
            ? undefined
            : {
                riskLevel: found.riskLevel,
                approval: found.approvalPolicy,
                permissions: found.permissions,
              };
        },
        now,
      });
      const credits = createCreditService({
        store: stores.credits,
        organizations: stores.tenancy,
        now,
      });

      const providerCalls: ProviderCall[] = [];
      const vertex = {
        providerId: VERTEX_AI_PROVIDER_ID,
        adapterVersion: 'vertex-test-1',
        capabilities: () => VERTEX_AI_PROVIDER.capabilities,
        health: async () => 'available' as const,
        async generate(call: ProviderCall): Promise<ProviderOutcome> {
          providerCalls.push(call);
          return answer('Listo.');
        },
      };
      const zone = options.timeZone ?? 'America/Lima';
      const followUps = createFollowUpService({
        repository: stores.conversations,
        organizations: stores.tenancy,
        authorization,
        timeZone: async () => zone,
        scheduler: { schedule: async () => undefined },
        now,
      });
      const customers = createCustomerService({
        repository: stores.conversations,
        organizations: stores.tenancy,
        authorization,
        now,
      });
      const conversation = createConversationAgentParts({ stores, now });
      const taskParts = createAgentTaskParts({
        stores: {
          tenancy: stores.tenancy,
          specialists: stores.specialists,
          tasks: stores.tasks,
          knowledge: stores.knowledge,
          outputs: stores.outputs,
          plans: stores.plans,
        },
        proposals: {
          conversations: stores.conversations,
          followUps,
          timeZone: async () => zone,
        },
        now,
      });
      const routed = routeAgentWork(conversation, taskParts);
      const dispatched: JobId[] = [];
      const worker = createWorkerRuntime({
        stores,
        environment: 'dev',
        leaseMs: LEASE_MS,
        tools: { registry, executors: { ...conversation.executors, ...taskParts.executors } },
        ai: createProviderRegistry({
          providers: [VERTEX_AI_PROVIDER],
          models: VERTEX_AI_MODELS,
          adapters: [vertex],
        }),
        credits: { port: credits, rate: CREDIT_RATE },
        policies: createModelPolicyCatalogue([
          { ...CONVERSATION_AGENT_POLICY, backoffMs: 0 },
          { ...AGENT_TASK_POLICY, backoffMs: 0 },
          {
            ...harnessTaskPolicy({
              preferredProviders: ['nvidia'],
              environments: ['dev'],
              maxCostMicroUsd: CREDIT_RATE.microUsdPerCredit,
            }),
            backoffMs: 0,
          },
        ]),
        work: routed.work,
        verifier: routed.verifier,
        outputs: conversation.outputs,
        onStopped: routed.onStopped,
        plans: stores.plans,
        wakeups: { async wake() {} },
        dispatcher: { dispatch: async (id) => void dispatched.push(id) },
        now,
      });
      const runtimeConductor = must(worker.conductor);

      // The person's side, as the API builds it.
      const approvals = createApprovalService({
        repository: stores.approvals,
        organizations: stores.tenancy,
        authorization,
        audit,
        now,
      });
      const executions = createExecutionService({
        repository: stores.executions,
        organizations: stores.tenancy,
        assignments: specialists.assignments,
        authorization,
        audit,
        cascade: createPlanCancellationCascade({ repository: stores.plans, approvals, now }),
        now,
      });
      const plans = createPlanService({
        repository: stores.plans,
        executions,
        validator: createPlanValidator({
          specialists,
          departments: stores.departments,
          tools: registry,
          authorization,
          environment: 'dev',
        }),
        organizations: stores.tenancy,
        authorization,
        audit,
        now,
      });
      const workflows = createWorkflowService({
        repository: stores.workflows,
        plans,
        executions,
        specialists,
        departments: stores.departments,
        organizations: stores.tenancy,
        authorization,
        now,
      });
      // Every task the API or the worker queues, as Cloud Tasks holds it.
      const tasks: { body: ScheduleTask; at: Date }[] = [];
      const scheduler = {
        schedule: async (body: object, at: Date) =>
          void tasks.push({ body: body as ScheduleTask, at }),
      };
      const schedules = createWorkflowScheduleService({
        repository: stores.schedules,
        workflows: stores.workflows,
        organizations: stores.tenancy,
        authorization,
        timeZone: async () => zone,
        scheduler,
        audit,
        now,
      });
      /** One worker instance's runner: the worker's own composition. */
      const runnerOf = (conductor = runtimeConductor) =>
        createWorkflowScheduleRunner({
          stores,
          plans: stores.plans,
          workflows: stores.workflows,
          schedules: stores.schedules,
          tools: registry,
          environment: 'dev',
          conductor,
          scheduler,
          now,
        });
      const runner = runnerOf();
      const sweeper = createExecutionSweeper({
        executions: stores.executions,
        jobs: stores.jobs,
        approvals: stores.approvals,
        tenancy: stores.tenancy,
        runtime: worker.runtime,
        ledger: new InMemorySweepLedger(),
        schedules: runner,
        now,
      });

      const tenantA = await resolveTenant(as(ALICE), orgA, stores.tenancy);
      const tenantB = await resolveTenant(as(BOB), orgB, stores.tenancy);
      const runtimeA = await resolveRuntimeTenant(ALICE, orgA, stores.tenancy);
      const amount = options.credits ?? CREDITS;
      if (amount > 0) {
        await credits.grant(tenantA, {
          amount,
          referenceId: `test-grant:${orgA}`,
          reason: 'test_grant',
        });
      }
      const juan = await customers.create(tenantA, {
        displayName: 'Juan Pérez',
        phone: '+51999888777',
      });
      const created = await management.create(tenantA, {
        templateId: 'commercial',
        displayName: 'Lucía',
      });
      const upgraded = await management.upgradeSkill(tenantA, created.identity.id, {
        fromVersion: created.version,
        skillId: 'customer_follow_up',
        version: options.skill ?? 4,
      });
      const lucia = await management.setStatus(tenantA, upgraded.identity.id, {
        from: 'draft',
        to: 'active',
      });

      /** Saved and switched on by Alice. */
      async function workflowOf(
        steps: readonly unknown[] = SUMMARY,
        name = 'Resumen diario',
      ): Promise<Workflow> {
        const w = await workflows.create(tenantA, { name, steps });
        return workflows.changeStatus(tenantA, w.id, { from: 'draft', to: 'active' });
      }

      /** Moves the clock to `at` when it is later. */
      const at = (iso: string | Date) => {
        const t = new Date(iso);
        if (t.getTime() > clock.getTime()) clock = t;
      };

      /** The queued task for a workflow's occurrence, as Cloud Tasks holds it. */
      const taskFor = (workflowId: string, occurrence?: string) =>
        must(
          tasks.find(
            (t) =>
              t.body.workflowId === workflowId &&
              (occurrence === undefined || t.body.occurrence === occurrence),
          ),
        );

      /** Cloud Tasks delivers a task at its time (or later) to the worker. */
      async function deliver(
        task: { body: ScheduleTask; at: Date },
        options: { readonly late?: number; readonly runner?: typeof runner } = {},
      ) {
        at(new Date(task.at.getTime() + (options.late ?? 0)));
        return (options.runner ?? runner).run(task.body);
      }

      /** Runs every queued job, as Cloud Tasks would deliver them to the worker. */
      async function drive(limit = 30): Promise<void> {
        for (let i = 0; i < limit && dispatched.length > 0; i += 1) {
          const jobId = dispatched.shift() as JobId;
          let claim;
          try {
            claim = await worker.jobs.acquire(jobId, 'worker-1');
          } catch (error) {
            if (isJobError(error)) continue;
            throw error;
          }
          await worker.runtime.advance(claim.lease);
        }
      }

      /** The write steps' approvals, as Alice's inbox lists them. */
      const writeAsks = async () =>
        (await approvals.list(tenantA)).filter((x) => x.operation.nodeId === 'schedule');
      const advance = (planId: string) => must(worker.advancePlan)(runtimeA, planId as Plan['id']);
      const scheduledFollowUps = async () => (await followUps.list(tenantA)).items;
      const scheduleOf = async (workflowId: string) =>
        must(await stores.schedules.find(orgA, workflowId as WorkflowId));
      const plansOf = async (workflowId: string) =>
        (await plans.listForWorkflow(tenantA, workflowId as WorkflowId)).filter(
          (p) => p.workflow?.occurrence !== undefined,
        );
      const stored = async (id: string) => must(await stores.plans.find(orgA, id as Plan['id']));
      const childOf = async (plan: Plan, stepId: string) =>
        executions.get(
          tenantA,
          must((await stored(plan.id)).delegations.find((d) => d.stepId === stepId)).executionId,
        );
      const scheduleEvents = async (workflowId: string) =>
        (await stores.events()).filter(
          (e) => e.action.startsWith('workflow.schedule_') && e.target?.id === workflowId,
        );

      return {
        stores,
        orgA,
        orgB,
        tenantA,
        tenantB,
        runtimeA,
        juan,
        lucia,
        management,
        workflows,
        executions,
        approvals,
        plans,
        schedules,
        runner,
        runnerOf,
        runtimeConductor,
        sweeper,
        tasks,
        providerCalls,
        workflowOf,
        taskFor,
        deliver,
        drive,
        at,
        now,
        scheduleOf,
        plansOf,
        stored,
        childOf,
        scheduleEvents,
        writeAsks,
        advance,
        followUps: scheduledFollowUps,
      };
    }
    type World = Awaited<ReturnType<typeof world>>;

    /** A daily 09:00 schedule switched on by Alice for a new summary workflow. */
    async function scheduled(w: World, steps?: readonly unknown[], recurrence: unknown = DAILY) {
      const workflow = await w.workflowOf(steps);
      const schedule = await w.schedules.save(w.tenantA, workflow.id, { recurrence });
      return { workflow, schedule };
    }

    it('1, 17. the first occurrence plans the workflow, the standing approval starts it, and it runs', async () => {
      const w = await world();
      const { workflow, schedule } = await scheduled(w);
      expect(schedule).toMatchObject({
        status: 'on',
        recurrence: DAILY,
        timeZone: 'America/Lima',
        workflowVersion: 1,
        confirmedBy: ALICE,
        nextRunAt: FIRST,
      });
      // The API queued the first occurrence's task for its time.
      const task = w.taskFor(workflow.id, FIRST);
      expect(task.at.toISOString()).toBe(FIRST);

      expect(await w.deliver(task)).toEqual({ status: 200, body: { result: 'planned' } });
      const [plan, ...more] = await w.plansOf(workflow.id);
      expect(more).toEqual([]);
      expect(plan).toMatchObject({
        status: 'executing',
        createdBy: ALICE,
        workflow: { id: workflow.id, version: 1, occurrence: FIRST },
        decision: { decision: 'approved', decidedBy: ALICE, via: 'schedule' },
      });
      await w.drive();
      expect((await w.stored(must(plan).id)).status).toBe('completed');
      expect((await w.childOf(must(plan), 'week')).status).toBe('completed');
      expect(w.providerCalls.length).toBeGreaterThan(0);

      // The schedule moved on, and the occurrence is recorded and audited.
      expect(await w.scheduleOf(workflow.id)).toMatchObject({
        nextRunAt: SECOND,
        last: { occurrence: FIRST, outcome: 'planned', planId: must(plan).id },
      });
      const events = await w.scheduleEvents(workflow.id);
      expect(events.map((e) => `${e.action}:${e.result}:${e.reason ?? ''}`)).toEqual([
        'workflow.schedule_saved:success:',
        'workflow.schedule_run:success:planned',
      ]);
      expect(events[0]).toMatchObject({
        actor: { type: 'user', userId: ALICE },
        organizationId: w.orgA,
        reference: 'daily-0900',
      });
      expect(events[1]).toMatchObject({
        actor: { type: 'system', id: 'runtime', initiatedBy: ALICE },
        organizationId: w.orgA,
        reference: `occurrence:${FIRST}`,
      });
      // The plan's approval is the runtime's, applying Alice's standing approval.
      const approved = (await w.stores.events()).filter(
        (e) => e.action === 'plan.approved' && e.target?.id === must(plan).id,
      );
      expect(approved).toHaveLength(1);
      expect(approved[0]).toMatchObject({
        result: 'success',
        reason: 'schedule',
        actor: { type: 'system', id: 'runtime' },
      });
    });

    it('2. the second occurrence is its own plan, the next day, queued by the first', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST));
      await w.drive();
      // The first run queued the second occurrence's task before anything else.
      const next = w.taskFor(workflow.id, SECOND);
      expect(next.at.toISOString()).toBe(SECOND);
      expect(await w.deliver(next)).toEqual({ status: 200, body: { result: 'planned' } });
      await w.drive();
      const runs = await w.plansOf(workflow.id);
      expect(runs.map((p) => p.workflow?.occurrence).sort()).toEqual([FIRST, SECOND]);
      expect(runs.every((p) => p.status === 'completed')).toBe(true);
      expect(new Set(runs.map((p) => p.id)).size).toBe(2);
      expect((await w.scheduleOf(workflow.id)).nextRunAt).toBe('2026-10-07T14:00:00.000Z');
    });

    it('3. a schedule switched off runs nothing, and switching it on again never runs a past occurrence', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      const off = await w.schedules.switchOff(w.tenantA, workflow.id);
      expect(off.status).toBe('off');
      expect(off.nextRunAt).toBeUndefined();
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toEqual({
        status: 200,
        body: { result: 'not_on' },
      });
      expect(await w.plansOf(workflow.id)).toEqual([]);
      // Back on after its time: the next occurrence is tomorrow's.
      w.at('2026-10-05T15:00:00Z');
      const on = await w.schedules.save(w.tenantA, workflow.id, { recurrence: DAILY });
      expect(on).toMatchObject({ status: 'on', nextRunAt: SECOND });
      const events = await w.scheduleEvents(workflow.id);
      expect(events.map((e) => `${e.action}:${e.reason ?? ''}`)).toEqual([
        'workflow.schedule_saved:',
        'workflow.schedule_switched_off:person',
        'workflow.schedule_saved:',
      ]);
    });

    it('4, 23. a changed recurrence replaces the next run; the old task finds nothing to claim', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      const weekly = { frequency: 'weekly', time: '18:30', weekdays: [3, 5] };
      // 2026-10-05 is a Monday; Wednesday at 18:30 in Lima is 23:30Z.
      const changed = await w.schedules.save(w.tenantA, workflow.id, { recurrence: weekly });
      expect(changed).toMatchObject({
        recurrence: weekly,
        nextRunAt: '2026-10-07T23:30:00.000Z',
        revision: 2,
      });
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toEqual({
        status: 200,
        body: { result: 'not_this_occurrence' },
      });
      expect(await w.plansOf(workflow.id)).toEqual([]);
      expect(await w.deliver(w.taskFor(workflow.id, '2026-10-07T23:30:00.000Z'))).toMatchObject({
        body: { result: 'planned' },
      });
      // Then Friday.
      expect((await w.scheduleOf(workflow.id)).nextRunAt).toBe('2026-10-09T23:30:00.000Z');
      // Monthly on the 1st.
      const monthly = await w.schedules.save(w.tenantA, workflow.id, {
        recurrence: { frequency: 'monthly', time: '08:00', dayOfMonth: 1 },
      });
      expect(monthly.nextRunAt).toBe('2026-11-01T13:00:00.000Z');
      // A recurrence the schedule cannot hold is refused, and nothing changes.
      const revision = (await w.scheduleOf(workflow.id)).revision;
      for (const recurrence of [
        { frequency: 'hourly', time: '09:00' },
        { frequency: 'daily', time: '9:00' },
        { frequency: 'daily', time: '09:00', every: 5 },
        { frequency: 'weekly', time: '09:00', weekdays: [] },
        { frequency: 'weekly', time: '09:00', weekdays: [8] },
        { frequency: 'monthly', time: '09:00', dayOfMonth: 31 },
        'daily',
      ]) {
        expect(await codeOf(w.schedules.save(w.tenantA, workflow.id, { recurrence }))).toBe(
          'invalid_schedule',
        );
      }
      expect((await w.scheduleOf(workflow.id)).revision).toBe(revision);
    });

    it("5. occurrences are at the business's local time, through daylight saving changes", async () => {
      const w = await world({ timeZone: 'America/New_York' });
      const { workflow, schedule } = await scheduled(w);
      // 09:00 in New York while on daylight time (UTC-4).
      expect(schedule.timeZone).toBe('America/New_York');
      expect(schedule.nextRunAt).toBe('2026-10-05T13:00:00.000Z');
      // Daylight time ends on 2026-11-01: 09:00 is then 14:00Z.
      w.at('2026-10-31T14:00:00Z');
      const later = await w.schedules.save(w.tenantA, workflow.id, { recurrence: DAILY });
      expect(later.nextRunAt).toBe('2026-11-01T14:00:00.000Z');
      await w.deliver(w.taskFor(workflow.id, '2026-11-01T14:00:00.000Z'));
      expect((await w.scheduleOf(workflow.id)).nextRunAt).toBe('2026-11-02T14:00:00.000Z');

      const tokyo = await world({ timeZone: 'Asia/Tokyo' });
      const { schedule: there } = await scheduled(tokyo);
      // 12:00Z is 21:00 in Tokyo: tomorrow's 09:00 there is 00:00Z.
      expect(there.nextRunAt).toBe('2026-10-06T00:00:00.000Z');
    });

    it('6, 24. a late occurrence still runs; past 6 hours it is missed, and missed ones are never replayed', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      // Two hours late (a slow queue): it runs.
      expect(await w.deliver(w.taskFor(workflow.id, FIRST), { late: 2 * HOUR })).toMatchObject({
        body: { result: 'planned' },
      });
      await w.drive();
      // The worker is down for three days: the second task arrives 3 days late.
      const second = w.taskFor(workflow.id, SECOND);
      expect(await w.deliver(second, { late: 3 * DAY })).toMatchObject({
        body: { result: 'missed' },
      });
      // Nothing ran for it, and the next occurrence is the next one after now, not a burst.
      expect(await w.plansOf(workflow.id)).toHaveLength(1);
      expect(await w.scheduleOf(workflow.id)).toMatchObject({
        nextRunAt: '2026-10-10T14:00:00.000Z',
        last: { occurrence: SECOND, outcome: 'missed' },
      });
      // The sweep, repeatedly, runs nothing more.
      for (let i = 0; i < 3; i += 1) await w.runner.recover();
      expect(await w.plansOf(workflow.id)).toHaveLength(1);
      expect(w.tasks.filter((t) => t.body.workflowId === workflow.id).length).toBeLessThanOrEqual(
        3,
      );
    });

    it('7. a new workflow version runs only once a person confirms the schedule again', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.workflows.publishVersion(w.tenantA, workflow.id, {
        steps: [{ ...SUMMARY[0], label: 'Resumir la semana, con ventas' }],
      });
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toMatchObject({
        body: { result: 'version_changed' },
      });
      expect(await w.plansOf(workflow.id)).toEqual([]);
      // Alice confirms the schedule for version 2.
      w.at('2026-10-05T15:00:00Z');
      const confirmed = await w.schedules.save(w.tenantA, workflow.id, { recurrence: DAILY });
      expect(confirmed.workflowVersion).toBe(2);
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toMatchObject({
        body: { result: 'planned' },
      });
      const [plan] = await w.plansOf(workflow.id);
      expect(plan?.workflow).toMatchObject({ version: 2, occurrence: SECOND });
    });

    it('8, 9, 21. the same occurrence delivered twice at once, again later, or to two workers plans once', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      const task = w.taskFor(workflow.id, FIRST);
      const other = w.runnerOf();
      const results = await Promise.all([
        w.deliver(task),
        w.deliver(task),
        w.deliver(task, { runner: other }),
      ]);
      expect(results.every((r) => r.status === 200 || r.status === 503)).toBe(true);
      // Delivered again after it ran: nothing to claim.
      expect(await w.deliver(task)).toMatchObject({ body: { result: 'not_this_occurrence' } });
      expect(await w.deliver(task, { runner: other })).toMatchObject({
        body: { result: 'not_this_occurrence' },
      });
      await w.drive();
      const runs = await w.plansOf(workflow.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('completed');
      const runEvents = (await w.scheduleEvents(workflow.id)).filter(
        (e) => e.action === 'workflow.schedule_run',
      );
      expect(runEvents).toHaveLength(1);
      // The next occurrence was queued, and it too runs once.
      const next = w.taskFor(workflow.id, SECOND);
      await Promise.all([w.deliver(next), w.deliver(next, { runner: other })]);
      expect(await w.plansOf(workflow.id)).toHaveLength(2);
    });

    it('10, 11, 20. a delivery that fails or ends ambiguously is retried, and a restarted worker finishes it once', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      const task = w.taskFor(workflow.id, FIRST);
      // The worker dies after planning and approving, before it starts the plan: 503, retried.
      let failing = true;
      const flaky = w.runnerOf({
        async run(tenant, planId) {
          if (failing) throw Object.assign(new Error('lost'), { code: 'unavailable' });
          return w.runtimeConductor.run(tenant, planId);
        },
      });
      expect(await w.deliver(task, { runner: flaky })).toMatchObject({
        status: 503,
        body: { result: 'retry' },
      });
      const [waiting] = await w.plansOf(workflow.id);
      expect(waiting?.status).toBe('approved');
      // A new worker instance gets the same task again: it takes the claimed occurrence up again.
      failing = false;
      const restarted = w.runnerOf();
      expect(await w.deliver(task, { runner: restarted })).toMatchObject({
        status: 200,
        body: { result: 'planned' },
      });
      await w.drive();
      // An ambiguous end: it started the plan, but the answer was lost. Delivered again.
      const next = w.taskFor(workflow.id, SECOND);
      let ambiguous = true;
      const lossy = w.runnerOf({
        async run(tenant, planId) {
          const started = await w.runtimeConductor.run(tenant, planId);
          if (ambiguous) throw Object.assign(new Error('timeout'), { code: 'deadline' });
          return started;
        },
      });
      expect(await w.deliver(next, { runner: lossy })).toMatchObject({ status: 503 });
      ambiguous = false;
      expect(await w.deliver(next, { runner: lossy })).toMatchObject({
        status: 200,
        body: { result: 'planned' },
      });
      await w.drive();
      const runs = await w.plansOf(workflow.id);
      expect(runs).toHaveLength(2);
      expect(runs.every((p) => p.status === 'completed')).toBe(true);
      // Each plan's step ran once.
      for (const plan of runs) {
        const child = await w.childOf(plan, 'week');
        expect(child.status).toBe('completed');
      }
      const runEvents = (await w.scheduleEvents(workflow.id)).filter(
        (e) => e.action === 'workflow.schedule_run',
      );
      expect(runEvents.map((e) => e.reason)).toEqual(['planned', 'planned']);
    });

    it('12. a person cancels a scheduled run; the next occurrence runs as usual', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, callSteps(w.juan.id));
      await w.deliver(w.taskFor(workflow.id, FIRST));
      await w.drive();
      const [plan] = await w.plansOf(workflow.id);
      // The write waits for Alice; she stops the plan instead.
      await w.executions.cancel(w.tenantA, must(plan).executionId, 'director_request');
      expect((await w.stored(must(plan).id)).status).toBe('cancelled');
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toMatchObject({
        body: { result: 'planned' },
      });
      const runs = await w.plansOf(workflow.id);
      expect(runs).toHaveLength(2);
      expect(runs.find((p) => p.workflow?.occurrence === SECOND)?.status).toBe('executing');
    });

    it('13. a step that needs approval still waits for a person on every run, and an open run is never stacked', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, callSteps(w.juan.id));
      await w.deliver(w.taskFor(workflow.id, FIRST));
      await w.drive();
      const [plan] = await w.plansOf(workflow.id);
      expect(must(plan).decision?.via).toBe('schedule');
      // The write's approval is Alice's to give: the standing approval never gives it.
      const asks = await w.writeAsks();
      expect(asks.map((x) => x.status)).toEqual(['pending']);
      expect((await w.childOf(must(plan), 'prepare')).startedAt).toBeUndefined();
      expect(await w.followUps()).toEqual([]);
      // Tomorrow's occurrence finds today's run still open: it never stacks on it.
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toMatchObject({
        body: { result: 'overlap' },
      });
      expect(await w.plansOf(workflow.id)).toHaveLength(1);
      // Alice approves; the run writes the follow-up once and ends.
      await w.approvals.approve(w.tenantA, must(asks[0]).id);
      await w.advance(must(plan).id);
      await w.drive();
      expect((await w.stored(must(plan).id)).status).toBe('completed');
      const written = await w.followUps();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ contactId: w.juan.id, createdBy: ALICE });
      // The day after, the next occurrence asks again.
      const third = w.taskFor(workflow.id, '2026-10-07T14:00:00.000Z');
      expect(await w.deliver(third)).toMatchObject({ body: { result: 'planned' } });
      await w.drive();
      expect((await w.writeAsks()).filter((x) => x.status === 'pending')).toHaveLength(1);
    });

    it('14. a withdrawn step approval skips its branch; the schedule goes on', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, callSteps(w.juan.id));
      await w.deliver(w.taskFor(workflow.id, FIRST));
      await w.drive();
      const [plan] = await w.plansOf(workflow.id);
      const ask = must((await w.writeAsks())[0]);
      await w.approvals.cancel(w.tenantA, ask.id, 'withdrawn');
      await w.advance(must(plan).id);
      await w.drive();
      // Its only branch was declined: the run ends, having run nothing, and never hangs.
      const ended = await w.stored(must(plan).id);
      expect(ended.status).toBe('failed');
      expect((await w.executions.get(w.tenantA, ended.executionId)).failure?.code).toBe(
        'nothing_ran',
      );
      expect((await w.childOf(must(plan), 'prepare')).startedAt).toBeUndefined();
      expect(await w.followUps()).toEqual([]);
      // The run is over: tomorrow's occurrence runs.
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toMatchObject({
        body: { result: 'planned' },
      });
    });

    it('15. without credits the run fails at its agent; the schedule records it and goes on', async () => {
      const w = await world({ credits: 0 });
      const { workflow } = await scheduled(w);
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toMatchObject({
        body: { result: 'planned' },
      });
      await w.drive();
      const [plan] = await w.plansOf(workflow.id);
      expect((await w.childOf(must(plan), 'week')).status).toBe('failed');
      expect(w.providerCalls).toHaveLength(0);
      expect(['failed', 'completed']).toContain((await w.stored(must(plan).id)).status);
      // The next occurrence is planned all the same.
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toMatchObject({
        body: { result: 'planned' },
      });
    });

    it("16. another organization can neither read, change nor run a workflow's schedule", async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      expect(await codeOf(w.schedules.get(w.tenantB, workflow.id))).toBe('workflow_not_found');
      expect(await codeOf(w.schedules.save(w.tenantB, workflow.id, { recurrence: DAILY }))).toBe(
        'workflow_not_found',
      );
      expect(await codeOf(w.schedules.switchOff(w.tenantB, workflow.id))).toBe(
        'workflow_not_found',
      );
      // A task naming B's organization with A's workflow finds nothing.
      const forged = { ...w.taskFor(workflow.id, FIRST).body, organizationId: w.orgB };
      expect(await w.runner.run(forged)).toMatchObject({ body: { result: 'not_on' } });
      expect(await w.stores.schedules.find(w.orgB, workflow.id)).toBeUndefined();
      // A's schedule is untouched and runs as A's person, in A.
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toMatchObject({
        body: { result: 'planned' },
      });
      const [plan] = await w.plansOf(workflow.id);
      expect(plan).toMatchObject({ organizationId: w.orgA, createdBy: ALICE });
      // A malformed task is refused outright.
      for (const body of [
        {},
        { ...forged, extra: 1 },
        { ...forged, occurrence: '2026-10-05' },
        { ...forged, workflowId: '../x' },
      ]) {
        expect(await w.runner.run(body)).toMatchObject({ status: 400 });
      }
    });

    it('16, 17. only a person with the permissions switches a schedule on; refusals are audited', async () => {
      const w = await world();
      const workflow = await w.workflowOf();
      // The runtime (and so GIA's or any agent's work) can never set a standing approval.
      expect(await codeOf(w.schedules.save(w.runtimeA, workflow.id, { recurrence: DAILY }))).toBe(
        'permission_denied',
      );
      expect(await codeOf(w.schedules.switchOff(w.runtimeA, workflow.id))).toBe(
        'permission_denied',
      );
      const denied = (await w.scheduleEvents(workflow.id)).filter((e) => e.result === 'denied');
      expect(denied.map((e) => `${e.action}:${e.reason ?? ''}`)).toEqual([
        'workflow.schedule_saved:runtime_cannot_schedule',
        'workflow.schedule_switched_off:runtime_cannot_schedule',
      ]);
      // A plan can only be run by the runtime when its own person's schedule approved it.
      const planned = await w.workflows.plan(w.tenantA, workflow.id, { requestKey: 'by-hand' });
      if (planned.status !== 'planned') throw new Error('refused');
      expect(
        await codeOf(
          w.plans.approveScheduled(w.runtimeA, planned.plan.id, {
            workflowId: workflow.id,
            workflowVersion: 1,
          }),
        ),
      ).toBe('permission_denied');
      expect(await codeOf(w.runtimeConductor.run(w.runtimeA, planned.plan.id))).toBe(
        'permission_denied',
      );
      // A person's own planning cannot pose as an occurrence.
      expect(
        await codeOf(w.workflows.plan(w.tenantA, workflow.id, { requestKey: 'schedule-1' })),
      ).toBe('invalid_workflow');
    });

    it('18. a run that is refused does not stop the next one', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      // The only agent for the step is paused: the occurrence is refused.
      const paused = await w.management.setStatus(w.tenantA, w.lucia.identity.id, {
        from: 'active',
        to: 'paused',
      });
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toMatchObject({
        body: { result: 'refused' },
      });
      await w.management.setStatus(w.tenantA, paused.identity.id, {
        from: 'paused',
        to: 'active',
      });
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toMatchObject({
        body: { result: 'planned' },
      });
      await w.drive();
      const runs = await w.plansOf(workflow.id);
      expect(runs.find((p) => p.workflow?.occurrence === SECOND)?.status).toBe('completed');
    });

    it('19, 20. the sweep recovers an occurrence whose task was lost, once', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      // The task is lost (or the worker was down when it came). 20 minutes past its time:
      w.at('2026-10-05T14:20:00Z');
      const record = await w.sweeper.sweep(sweepSlotOf(w.now()).id);
      expect(record.counts.schedules).toBe(1);
      const [plan] = await w.plansOf(workflow.id);
      expect(plan?.workflow?.occurrence).toBe(FIRST);
      // Another sweep, and the lost task arriving after all, run nothing more.
      await w.sweeper.sweep(sweepSlotOf(new Date(w.now().getTime() + 3 * HOUR)).id);
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toMatchObject({
        body: { result: 'not_this_occurrence' },
      });
      expect(await w.plansOf(workflow.id)).toHaveLength(1);
      // Within 15 minutes of its time an occurrence is its task's, not the sweep's.
      w.at('2026-10-06T14:10:00Z');
      expect(await w.runner.recover()).toBe(0);
    });

    it('22. a paused workflow skips its occurrences; an archived one switches its schedule off', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.workflows.changeStatus(w.tenantA, workflow.id, { from: 'active', to: 'paused' });
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toMatchObject({
        body: { result: 'workflow_not_active' },
      });
      expect((await w.scheduleOf(workflow.id)).status).toBe('on');
      // A paused workflow cannot be scheduled.
      expect(await codeOf(w.schedules.save(w.tenantA, workflow.id, { recurrence: DAILY }))).toBe(
        'workflow_not_active',
      );
      await w.workflows.changeStatus(w.tenantA, workflow.id, { from: 'paused', to: 'archived' });
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toMatchObject({
        body: { result: 'workflow_not_active' },
      });
      const off = await w.scheduleOf(workflow.id);
      expect(off.status).toBe('off');
      expect(off.nextRunAt).toBeUndefined();
      expect(await w.plansOf(workflow.id)).toEqual([]);
      const events = await w.scheduleEvents(workflow.id);
      expect(events.at(-1)).toMatchObject({
        action: 'workflow.schedule_switched_off',
        reason: 'workflow_archived',
        actor: { type: 'system', id: 'runtime', initiatedBy: ALICE },
      });
    });

    it('24. a schedule makes at most one plan per day, whatever is delivered', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      // A task for a time the schedule never had, early or forged, runs nothing.
      const forged = {
        ...w.taskFor(workflow.id, FIRST).body,
        occurrence: '2026-10-05T14:01:00.000Z',
      };
      expect(await w.runner.run(forged)).toMatchObject({
        body: { result: 'not_this_occurrence' },
      });
      // An early delivery (a hop) only queues itself again.
      const before = w.tasks.length;
      expect(await w.runner.run(w.taskFor(workflow.id, FIRST).body)).toMatchObject({
        body: { result: 'early' },
      });
      expect(w.tasks.length).toBe(before + 1);
      // Ten days of deliveries and sweeps: one plan per occurrence, one occurrence per day.
      for (let day = 0; day < 10; day += 1) {
        const occurrence = (await w.scheduleOf(workflow.id)).nextRunAt as IsoTimestamp;
        const task = w.taskFor(workflow.id, occurrence);
        await Promise.all([w.deliver(task), w.deliver(task), w.runner.recover()]);
        await w.drive();
      }
      const runs = await w.plansOf(workflow.id);
      expect(runs).toHaveLength(10);
      const days = runs.map((p) => p.workflow?.occurrence?.slice(0, 10));
      expect(new Set(days).size).toBe(10);
    });
  },
);
