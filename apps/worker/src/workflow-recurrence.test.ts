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
  OrganizationId,
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
  MEMBERSHIPS,
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
  membershipIdOf,
  resolveRuntimeTenant,
  resolveTenant,
} from '@melonoffice/tenancy';
import { createToolRegistry, TOOL_CATALOGUE } from '@melonoffice/tools';
import {
  createWorkflowScheduleService,
  createWorkflowService,
  InMemoryWorkflowRepository,
  InMemoryWorkflowScheduleRepository,
  SCHEDULE_LEASE_MS,
  SCHEDULE_RECOVER_AFTER_MS,
  type ScheduleTask,
  type WorkflowRepository,
  type WorkflowScheduleRepository,
} from '@melonoffice/workflows';
import { describe, expect, it } from 'vitest';
import { createAgentTaskParts, createConversationAgentParts, routeAgentWork } from './agents.js';
import { createWorkerRuntime, type WorkerStores } from './runtime.js';
import { createExecutionSweeper, sweepSlotOf } from './sweeps.js';
import { createScheduleDelegation, createWorkflowScheduleRunner } from './workflow-schedules.js';

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
const THIRD = '2026-10-07T14:00:00.000Z';
const LEASE_MS = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const CREDITS = 100;
const DAILY = { frequency: 'daily', time: '09:00' };
/**
 * The role a person takes when they lose `plan.create`. The built-in roles hold only `owner` today
 * (D-22), and a role RBAC does not know grants nothing: so this role is the person with no planning.
 */
const LOST_ROLE = 'viewer';
const OWNER_ROLE = 'owner';

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

/** Two weekly steps, the second after the first: a delegation makes the first child, then the second. */
const TWO_STEPS = [
  SUMMARY[0],
  { ...SUMMARY[0], id: 'then', label: 'Revisar la semana', dependsOn: ['week'] },
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
  /** Changes a person's role in an organization, as an edit of the membership does (ADR-0187). */
  readonly setRole: (organizationId: OrganizationId, userId: UserId, role: string) => Promise<void>;
};

function memoryStores(now: () => Date): Stores {
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const credits = new InMemoryCreditStore(audit);
  const tenancy = new InMemoryTenancyStore(now, audit, undefined, departments, credits);
  return {
    tenancy,
    async setRole(organizationId, userId, role) {
      const membership = await tenancy.findMembership(organizationId, userId);
      if (membership === undefined) throw new Error('no membership to change');
      tenancy.put({ ...membership, role });
    },
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
    async setRole(organizationId, userId, role) {
      await db.collection(MEMBERSHIPS).doc(membershipIdOf(organizationId, userId)).update({ role });
    },
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
  (storage, createStores) => {
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
      /**
       * Injected faults, set by a test. The delegation's child creations succeed `allowed` times and
       * fail after that, while `children` is set. `parentFails` failures are injected into the
       * planning execution's move to `failed`, which is where an attempt's cleanup can stop.
       */
      const faults = { children: false, allowed: 0, parentFails: 0 };
      const down = () => Object.assign(new Error('down'), { code: 'unavailable' });
      type DelegationExecutions = Parameters<typeof createScheduleDelegation>[0]['executions'];
      const breakExecutions = (executions: DelegationExecutions): DelegationExecutions => ({
        ...executions,
        async create(tenant, request) {
          if (request.mode === 'execute' && faults.children) {
            if (faults.allowed <= 0) throw down();
            faults.allowed -= 1;
          }
          return executions.create(tenant, request);
        },
        async runtimePlanChangeStatus(tenant, id, change) {
          if (faults.parentFails > 0) {
            faults.parentFails -= 1;
            throw down();
          }
          if (executions.runtimePlanChangeStatus === undefined) throw down();
          return executions.runtimePlanChangeStatus(tenant, id, change);
        },
      });
      const worker = createWorkerRuntime({
        stores,
        environment: 'dev',
        leaseMs: LEASE_MS,
        scheduleDelegation: (deps) =>
          createScheduleDelegation({ ...deps, executions: breakExecutions(deps.executions) }),
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
      const runnerOf = (
        conductor = runtimeConductor,
        options: {
          readonly standingAuthorization?: Parameters<
            typeof createWorkflowScheduleRunner
          >[0]['standingAuthorization'];
          readonly workflows?: WorkflowRepository;
          readonly plans?: PlanRepository;
        } = {},
      ) =>
        createWorkflowScheduleRunner({
          stores,
          plans: options.plans ?? stores.plans,
          workflows: options.workflows ?? stores.workflows,
          schedules: stores.schedules,
          tools: registry,
          environment: 'dev',
          conductor,
          scheduler,
          ...(options.standingAuthorization === undefined
            ? {}
            : { standingAuthorization: options.standingAuthorization }),
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
        faults,
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
        /** Alice keeps her membership and takes `role`: the permissions she holds from now on. */
        setRole: (role: string) => stores.setRole(orgA, ALICE, role),
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

    it('6. a late occurrence still runs; past 6 hours it is missed, and missed ones are never replayed', async () => {
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
        ...w.runtimeConductor,
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
      // Retried inside the lease: the first worker may still be alive, so this one waits.
      expect(await w.deliver(task, { runner: w.runnerOf() })).toEqual({
        status: 503,
        body: { result: 'retry', code: 'in_progress' },
      });
      // A new worker instance gets the same task again once the lease has lapsed: it takes the
      // claimed occurrence up (ADR-0185 §5).
      w.at(new Date(Date.parse(FIRST) + SCHEDULE_LEASE_MS + 60_000));
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
        ...w.runtimeConductor,
        async run(tenant, planId) {
          const started = await w.runtimeConductor.run(tenant, planId);
          if (ambiguous) throw Object.assign(new Error('timeout'), { code: 'deadline' });
          return started;
        },
      });
      expect(await w.deliver(next, { runner: lossy })).toMatchObject({ status: 503 });
      // The work the lost answer covered ran before the retry: its job is done.
      await w.drive();
      ambiguous = false;
      w.at(new Date(Date.parse(SECOND) + SCHEDULE_LEASE_MS + 60_000));
      expect(await w.deliver(next, { runner: lossy })).toMatchObject({
        status: 200,
        body: { result: 'planned' },
      });
      await w.drive();
      const runs = await w.plansOf(workflow.id);
      expect(runs).toHaveLength(2);
      expect(runs.every((p) => p.status === 'completed')).toBe(true);
      // One provider call per plan: the retry of the lost answer ran nothing again.
      expect(w.providerCalls).toHaveLength(2);
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
      // Consecutive days of deliveries and sweeps: one plan per occurrence, one occurrence per day. In
      // memory, ten days. On the emulator, three: a day there is a full plan run (about 3 s), so ten
      // would take most of the 40 s limit. Each day's date is worked out here, from the first
      // occurrence and a day's length (Lima keeps no daylight saving), never read back from the
      // store, so both variants check the schedule's dates against an independent calculation.
      const DAYS = storage === 'firestore' ? 3 : 10;
      const dayOf = (n: number) =>
        new Date(Date.parse(FIRST) + n * DAY).toISOString() as IsoTimestamp;
      for (let day = 0; day < DAYS; day += 1) {
        const occurrence = (await w.scheduleOf(workflow.id)).nextRunAt as IsoTimestamp;
        expect(occurrence).toBe(dayOf(day));
        const task = w.taskFor(workflow.id, occurrence);
        await Promise.all([w.deliver(task), w.deliver(task), w.runner.recover()]);
        await w.drive();
      }
      expect((await w.scheduleOf(workflow.id)).nextRunAt).toBe(dayOf(DAYS));
      // Newest first, so reversed: one plan per day, in order, each on its own occurrence.
      const runs = await w.plansOf(workflow.id);
      expect(runs).toHaveLength(DAYS);
      expect(runs.map((p) => p.workflow?.occurrence).reverse()).toEqual(
        Array.from({ length: DAYS }, (_, day) => dayOf(day)),
      );
    });

    it('25. under a standing approval, a first step that needs approval still waits for a person', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, [{ ...SUMMARY[0], approvalRequired: true }]);
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toEqual({
        status: 200,
        body: { result: 'planned' },
      });
      await w.drive();
      const [plan] = await w.plansOf(workflow.id);
      expect(must(plan).decision?.via).toBe('schedule');
      // The standing approval gave the plan, never the step: nothing ran for it.
      const waiting = await w.stored(must(plan).id);
      expect(waiting.stepApprovals?.map((a) => a.stepId)).toEqual(['week']);
      expect((await w.childOf(waiting, 'week')).startedAt).toBeUndefined();
      expect(w.providerCalls).toHaveLength(0);
      // Once a person approves the step, it runs and the plan completes.
      await w.approvals.approve(w.tenantA, must(waiting.stepApprovals?.[0]).approvalId);
      await w.advance(waiting.id);
      await w.drive();
      expect((await w.stored(waiting.id)).status).toBe('completed');
    });

    it('26. a delivery that finds its occurrence held waits; the occurrence runs once', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      const task = w.taskFor(workflow.id, FIRST);
      let entered = () => {};
      const inFlight = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The first delivery stops inside its plan's run, while it holds the occurrence.
      const slow = w.runnerOf({
        ...w.runtimeConductor,
        async run(tenant, planId) {
          entered();
          await held;
          return w.runtimeConductor.run(tenant, planId);
        },
      });
      const first = w.deliver(task, { runner: slow });
      await inFlight;
      expect(await w.deliver(task)).toEqual({
        status: 503,
        body: { result: 'retry', code: 'in_progress' },
      });
      release();
      expect(await first).toEqual({ status: 200, body: { result: 'planned' } });
      expect(await w.deliver(task)).toMatchObject({ body: { result: 'not_this_occurrence' } });
      await w.drive();
      expect(await w.plansOf(workflow.id)).toHaveLength(1);
      // Only the claim that ran queued the next task.
      expect(
        w.tasks.filter((t) => t.body.workflowId === workflow.id && t.body.occurrence === SECOND),
      ).toHaveLength(1);
    });

    it('27. a time changed later the same day plans tomorrow, never a second plan that day', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toMatchObject({
        body: { result: 'planned' },
      });
      await w.drive();
      // At 10:00 in Lima, the run moves to 18:00 in Lima: tomorrow, not the same day.
      w.at('2026-10-05T15:00:00.000Z');
      const saved = await w.schedules.save(w.tenantA, workflow.id, {
        recurrence: { frequency: 'daily', time: '18:00' },
      });
      expect(saved.nextRunAt).toBe('2026-10-06T23:00:00.000Z');
      expect(w.tasks.some((t) => t.body.occurrence === '2026-10-05T23:00:00.000Z')).toBe(false);
      expect(await w.deliver(w.taskFor(workflow.id, '2026-10-06T23:00:00.000Z'))).toMatchObject({
        body: { result: 'planned' },
      });
      await w.drive();
      expect((await w.plansOf(workflow.id)).map((p) => p.workflow?.occurrence).sort()).toEqual([
        FIRST,
        '2026-10-06T23:00:00.000Z',
      ]);
    });

    it('28. a standing approval whose person lost a permission runs nothing, and the run says so', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      // Alice may no longer approve: the runner checks the standing permissions at the occurrence.
      const rbac = createAuthorizationService();
      const withoutApproval: Parameters<
        typeof createWorkflowScheduleRunner
      >[0]['standingAuthorization'] = {
        authorize: (tenant, permission, resource) =>
          permission === 'approval.approve'
            ? { allowed: false, reason: 'permission_denied' }
            : rbac.authorize(tenant, permission, resource),
      };
      expect(
        await w.deliver(w.taskFor(workflow.id, FIRST), {
          runner: w.runnerOf(w.runtimeConductor, { standingAuthorization: withoutApproval }),
        }),
      ).toEqual({ status: 200, body: { result: 'not_allowed' } });
      expect(await w.plansOf(workflow.id)).toEqual([]);
      expect(await w.scheduleOf(workflow.id)).toMatchObject({
        nextRunAt: SECOND,
        last: { occurrence: FIRST, outcome: 'not_allowed' },
      });
    });

    it('29. an occurrence whose retries all fail is recorded as abandoned when the next one runs', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      // The first occurrence fails after its claim, every time, and never reaches a plan.
      const broken = Object.assign(Object.create(w.stores.workflows), {
        find: async () => {
          throw Object.assign(new Error('down'), { code: 'unavailable' });
        },
      }) as WorkflowRepository;
      expect(
        await w.deliver(w.taskFor(workflow.id, FIRST), {
          runner: w.runnerOf(w.runtimeConductor, { workflows: broken }),
        }),
      ).toMatchObject({ status: 503, body: { result: 'retry' } });
      expect(await w.plansOf(workflow.id)).toEqual([]);
      // Tomorrow's occurrence runs, and the lost one is recorded in audit as abandoned.
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toEqual({
        status: 200,
        body: { result: 'planned' },
      });
      const runs = (await w.scheduleEvents(workflow.id)).filter(
        (e) => e.action === 'workflow.schedule_run',
      );
      expect(runs.map((e) => [e.reference, e.reason])).toEqual([
        [`occurrence:${FIRST}`, 'abandoned'],
        [`occurrence:${SECOND}`, 'planned'],
      ]);
      expect((await w.plansOf(workflow.id)).map((p) => p.workflow?.occurrence)).toEqual([SECOND]);
      expect(await w.scheduleOf(workflow.id)).toMatchObject({
        nextRunAt: '2026-10-07T14:00:00.000Z',
        last: { occurrence: SECOND, outcome: 'planned' },
      });
    });

    /** A start that fails before it delegates anything: the occurrence's plan is left approved. */
    const failingStart = () =>
      ({
        run: async () => {
          throw Object.assign(new Error('down'), { code: 'unavailable' });
        },
      }) as unknown as World['runtimeConductor'];

    /** Plans with a closure, as the audit reads them: the schedule's own closure reason. */
    const closures = async (w: World) =>
      (await w.stores.events()).filter(
        (e) => e.action === 'plan.state_changed' && e.reason === 'schedule_abandoned',
      );

    /** The plan changes a schedule made, by reason, as (reason, occurrence, status it moved to). */
    const closedWith = async (w: World, reason: string) =>
      (await w.stores.events())
        .filter((e) => e.action === 'plan.state_changed' && e.reason === reason)
        .map((e) => [e.reason, e.reference, e.transition?.to]);

    /** The runs a schedule recorded, as (occurrence, outcome). */
    const runsOf = async (w: World, workflowId: string) =>
      (await w.scheduleEvents(workflowId))
        .filter((e) => e.action === 'workflow.schedule_run')
        .map((e) => [e.reference, e.reason]);

    it('30. an approved plan whose occurrence exhausts its retries is closed when the next one claims, and the next one runs', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      // The first occurrence makes its plan, the standing approval approves it, and its start fails.
      expect(
        await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) }),
      ).toMatchObject({ status: 503, body: { result: 'retry' } });
      const [lost] = await w.plansOf(workflow.id);
      expect(must(lost)).toMatchObject({ status: 'approved', decision: { via: 'schedule' } });
      // Tomorrow's occurrence closes the lost plan, and it is not held as an overlap.
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toEqual({
        status: 200,
        body: { result: 'planned' },
      });
      expect(await w.stored(must(lost).id)).toMatchObject({ status: 'cancelled' });
      const next = (await w.plansOf(workflow.id)).find((p) => p.workflow?.occurrence === SECOND);
      expect(must(next)).toMatchObject({ status: 'executing' });
      await w.drive();
      expect((await w.stored(must(next).id)).status).toBe('completed');
      expect(await w.scheduleOf(workflow.id)).toMatchObject({
        nextRunAt: THIRD,
        last: { occurrence: SECOND, outcome: 'planned', planId: must(next).id },
      });
    });

    it('31. a plan still running is never closed, and a retry keeps the plan of its own occurrence', async () => {
      const w = await world();
      // The first occurrence's plan waits for a person's step approval: it is executing, and active.
      const { workflow } = await scheduled(w, [{ ...SUMMARY[0], approvalRequired: true }]);
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toEqual({
        status: 200,
        body: { result: 'planned' },
      });
      await w.drive();
      const [active] = await w.plansOf(workflow.id);
      expect(must(active).status).toBe('executing');
      // The next occurrence is held by it, and the running plan is not touched.
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toEqual({
        status: 200,
        body: { result: 'overlap' },
      });
      expect(await w.stored(must(active).id)).toMatchObject({ status: 'executing' });
      expect(await closures(w)).toEqual([]);
    });

    it('31b. a plan changed within the lease is refused, and a retry of an occurrence keeps its own plan', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      const [lost] = await w.plansOf(workflow.id);
      // A live delivery changed it just now: the service refuses, whatever the occurrence.
      const untouched = new Date(Date.parse(must(lost).updatedAt) - 1).toISOString();
      expect(
        await codeOf(
          w.plans.abandonScheduled(w.runtimeA, must(lost).id, {
            workflowId: workflow.id,
            supersededBy: SECOND as IsoTimestamp,
            untouchedBefore: untouched as IsoTimestamp,
          }),
        ),
      ).toBe('plan_not_abandonable');
      // Its own occurrence is never superseded by itself.
      expect(
        await codeOf(
          w.plans.abandonScheduled(w.runtimeA, must(lost).id, {
            workflowId: workflow.id,
            supersededBy: FIRST as IsoTimestamp,
            untouchedBefore: SECOND as IsoTimestamp,
          }),
        ),
      ).toBe('plan_not_abandonable');
      expect(await w.stored(must(lost).id)).toMatchObject({ status: 'approved' });
      // The next occurrence starts, and its start fails too: its plan is left approved.
      await w.deliver(w.taskFor(workflow.id, SECOND), { runner: w.runnerOf(failingStart()) });
      const own = (await w.plansOf(workflow.id)).find((p) => p.workflow?.occurrence === SECOND);
      expect(must(own)).toMatchObject({ status: 'approved' });
      // Its retry, once the lease has lapsed, runs the same plan: it is not closed as a stale one.
      expect(
        await w.deliver(w.taskFor(workflow.id, SECOND), {
          late: SCHEDULE_LEASE_MS + 60_000,
          runner: w.runnerOf(),
        }),
      ).toEqual({ status: 200, body: { result: 'planned' } });
      expect(await w.stored(must(own).id)).toMatchObject({ status: 'executing' });
      expect(await w.stored(must(lost).id)).toMatchObject({ status: 'cancelled' });
      expect(
        (await w.plansOf(workflow.id)).filter((p) => p.workflow?.occurrence === SECOND),
      ).toHaveLength(1);
    });

    it('32. two workers and the sweep reach the same occurrence at once: one plan, one closure', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      const task = w.taskFor(workflow.id, SECOND);
      w.at(task.at);
      const [first, second] = await Promise.all([
        w.runnerOf().run(task.body),
        w.runnerOf().run(task.body),
        w.runner.recover(),
      ]);
      expect([first, second].filter((r) => r.body.result === 'planned')).toHaveLength(1);
      expect([first.status, second.status].every((s) => s === 200 || s === 503)).toBe(true);
      expect(
        (await w.plansOf(workflow.id)).filter((p) => p.workflow?.occurrence === SECOND),
      ).toHaveLength(1);
      expect((await w.plansOf(workflow.id)).map((p) => p.status).sort()).toEqual([
        'cancelled',
        'executing',
      ]);
      expect(await closures(w)).toHaveLength(1);
    });

    it('33. a person cancels the open plan while the next occurrence runs: one transition, either order', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      const [open] = await w.plansOf(workflow.id);
      const [cancel, delivered] = await Promise.allSettled([
        w.plans.cancel(w.tenantA, must(open).id, 'director_request'),
        w.deliver(w.taskFor(workflow.id, SECOND)),
      ]);
      expect(delivered).toMatchObject({
        status: 'fulfilled',
        value: { status: 200, body: { result: 'planned' } },
      });
      // Cancelled by the person, or closed by the occurrence: never twice.
      if (cancel.status === 'rejected') {
        expect(cancel.reason).toMatchObject({ code: 'invalid_plan_transition' });
      }
      expect(await w.stored(must(open).id)).toMatchObject({ status: 'cancelled' });
      const transitions = (await w.stores.events()).filter(
        (e) => e.action === 'plan.state_changed' && e.target?.id === must(open).id,
      );
      expect(transitions).toHaveLength(1);
    });

    it('34. the closure is audited with its reason, its actor and the occurrence it closes', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      const [lost] = await w.plansOf(workflow.id);
      await w.deliver(w.taskFor(workflow.id, SECOND));
      expect(await closures(w)).toMatchObject([
        {
          result: 'success',
          actor: { type: 'system', id: 'runtime', via: 'runtime' },
          target: { type: 'plan', id: must(lost).id },
          transition: { from: 'approved', to: 'cancelled' },
          reason: 'schedule_abandoned',
          reference: `occurrence:${FIRST}`,
        },
      ]);
      // The schedule records the lost occurrence as abandoned, as before.
      expect(
        (await w.scheduleEvents(workflow.id))
          .filter((e) => e.action === 'workflow.schedule_run')
          .map((e) => [e.reference, e.reason]),
      ).toEqual([
        [`occurrence:${FIRST}`, 'abandoned'],
        [`occurrence:${SECOND}`, 'planned'],
      ]);
    });

    it('35. another organization’s runtime cannot close a plan of this one', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      const [lost] = await w.plansOf(workflow.id);
      const runtimeB = await resolveRuntimeTenant(BOB, w.orgB, w.stores.tenancy);
      expect(
        await codeOf(
          w.plans.abandonScheduled(runtimeB, must(lost).id, {
            workflowId: workflow.id,
            supersededBy: SECOND as IsoTimestamp,
            untouchedBefore: new Date(Date.parse(FIRST) + DAY).toISOString() as IsoTimestamp,
          }),
        ),
      ).toBe('plan_not_found');
      expect(await w.stored(must(lost).id)).toMatchObject({ status: 'approved' });
      expect(await closures(w)).toEqual([]);
    });

    it('36. a sweep and a redelivery after the closure add no plan, no execution and no closure', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      await w.deliver(w.taskFor(workflow.id, SECOND));
      await w.drive();
      const own = must(
        (await w.plansOf(workflow.id)).find((p) => p.workflow?.occurrence === SECOND),
      );
      const delegations = (await w.stored(own.id)).delegations.length;
      expect(await w.runner.recover()).toBe(0);
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toEqual({
        status: 200,
        body: { result: 'not_this_occurrence' },
      });
      expect(
        (await w.plansOf(workflow.id)).filter((p) => p.workflow?.occurrence === SECOND),
      ).toHaveLength(1);
      expect((await w.stored(own.id)).delegations).toHaveLength(delegations);
      expect(await closures(w)).toHaveLength(1);
    });

    it('37. a normal recurrence closes nothing: an earlier plan that completed is left as it is', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toEqual({
        status: 200,
        body: { result: 'planned' },
      });
      await w.drive();
      const [first] = await w.plansOf(workflow.id);
      expect(await w.stored(must(first).id)).toMatchObject({ status: 'completed' });
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toEqual({
        status: 200,
        body: { result: 'planned' },
      });
      expect(await w.stored(must(first).id)).toMatchObject({ status: 'completed' });
      expect(await closures(w)).toEqual([]);
    });

    it('38. a worker that dies after claiming an occurrence leaves the closure to the one that resumes it', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      const [lost] = await w.plansOf(workflow.id);
      // Tomorrow's occurrence is claimed, and its worker fails before it reads the plans.
      const broken = Object.assign(Object.create(w.stores.plans), {
        listForWorkflow: async () => {
          throw Object.assign(new Error('down'), { code: 'unavailable' });
        },
      }) as PlanRepository;
      expect(
        await w.deliver(w.taskFor(workflow.id, SECOND), {
          runner: w.runnerOf(undefined, { plans: broken }),
        }),
      ).toMatchObject({ status: 503, body: { result: 'retry' } });
      expect(await w.stored(must(lost).id)).toMatchObject({ status: 'approved' });
      // A restarted worker takes the occurrence up once its lease has lapsed, and closes the plan.
      expect(
        await w.deliver(w.taskFor(workflow.id, SECOND), {
          late: SCHEDULE_LEASE_MS + 60_000,
          runner: w.runnerOf(),
        }),
      ).toEqual({ status: 200, body: { result: 'planned' } });
      expect(await w.stored(must(lost).id)).toMatchObject({ status: 'cancelled' });
      expect(
        (await w.plansOf(workflow.id)).filter((p) => p.workflow?.occurrence === SECOND),
      ).toHaveLength(1);
      expect(await closures(w)).toHaveLength(1);
      expect(
        (await w.scheduleEvents(workflow.id))
          .filter((e) => e.action === 'workflow.schedule_run')
          .map((e) => [e.reference, e.reason]),
      ).toEqual([
        [`occurrence:${FIRST}`, 'abandoned'],
        [`occurrence:${SECOND}`, 'planned'],
      ]);
    });

    it('39. a lost task for the next occurrence: the sweep runs it, and the stale plan is closed then', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      const [lost] = await w.plansOf(workflow.id);
      // Tomorrow's task never arrives: past the sweep's threshold, the sweep runs the occurrence.
      w.at(new Date(Date.parse(SECOND) + SCHEDULE_RECOVER_AFTER_MS + 60_000));
      expect(await w.runner.recover()).toBe(1);
      expect(await w.stored(must(lost).id)).toMatchObject({ status: 'cancelled' });
      expect(await w.scheduleOf(workflow.id)).toMatchObject({
        nextRunAt: THIRD,
        last: { occurrence: SECOND, outcome: 'planned' },
      });
      expect(await closures(w)).toHaveLength(1);
    });

    it('40. the occurrence that claims closes what the one before it left open, even if its worker dies after', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      const [lost] = await w.plansOf(workflow.id);
      // Tomorrow's worker claims, closes the lost plan, and then fails before it reads the workflow.
      const broken = Object.assign(Object.create(w.stores.workflows), {
        find: async () => {
          throw Object.assign(new Error('down'), { code: 'unavailable' });
        },
      }) as WorkflowRepository;
      expect(
        await w.deliver(w.taskFor(workflow.id, SECOND), {
          runner: w.runnerOf(undefined, { workflows: broken }),
        }),
      ).toMatchObject({ status: 503, body: { result: 'retry' } });
      // Closed at the claim, so the worker that resumes the occurrence has nothing left to close.
      expect(await w.stored(must(lost).id)).toMatchObject({ status: 'cancelled' });
      expect(await closedWith(w, 'schedule_abandoned')).toEqual([
        ['schedule_abandoned', `occurrence:${FIRST}`, 'cancelled'],
      ]);
    });

    it('41. a switched-off schedule closes its open plan once the claim lapses, with its reason and occurrence', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      const [open] = await w.plansOf(workflow.id);
      await w.schedules.switchOff(w.tenantA, workflow.id);
      // Within the lease the claim is still someone’s: the sweep leaves the plan as it is.
      expect(await w.runner.recover()).toBe(0);
      expect(await w.stored(must(open).id)).toMatchObject({ status: 'approved' });
      // Once the lease has lapsed, nothing will take the occurrence up again: the sweep settles it.
      w.at(new Date(Date.parse(FIRST) + SCHEDULE_LEASE_MS + 60_000));
      expect(await w.runner.recover()).toBe(1);
      expect(await w.stored(must(open).id)).toMatchObject({ status: 'cancelled' });
      expect(await closedWith(w, 'schedule_off')).toEqual([
        ['schedule_off', `occurrence:${FIRST}`, 'cancelled'],
      ]);
      expect(
        (await w.stores.events()).find(
          (e) => e.action === 'plan.state_changed' && e.reason === 'schedule_off',
        ),
      ).toMatchObject({
        result: 'success',
        actor: { type: 'system', id: 'runtime', via: 'runtime' },
        target: { type: 'plan', id: must(open).id },
      });
      expect(await w.scheduleOf(workflow.id)).toMatchObject({
        status: 'off',
        last: { occurrence: FIRST, outcome: 'abandoned' },
      });
      expect(await runsOf(w, workflow.id)).toEqual([[`occurrence:${FIRST}`, 'abandoned']]);
    });

    it('42. an archived workflow: the sweep runs its next occurrence, which closes the plan before it and switches the schedule off', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      const [open] = await w.plansOf(workflow.id);
      await w.workflows.changeStatus(w.tenantA, workflow.id, { from: 'active', to: 'paused' });
      await w.workflows.changeStatus(w.tenantA, workflow.id, { from: 'paused', to: 'archived' });
      // Tomorrow’s task never arrives: past the sweep’s threshold, the sweep runs the occurrence.
      w.at(new Date(Date.parse(SECOND) + SCHEDULE_RECOVER_AFTER_MS + 60_000));
      expect(await w.runner.recover()).toBe(1);
      expect(await w.stored(must(open).id)).toMatchObject({ status: 'cancelled' });
      expect(await closedWith(w, 'schedule_abandoned')).toEqual([
        ['schedule_abandoned', `occurrence:${FIRST}`, 'cancelled'],
      ]);
      expect(await w.scheduleOf(workflow.id)).toMatchObject({
        status: 'off',
        last: { occurrence: SECOND, outcome: 'workflow_not_active' },
      });
      expect(await runsOf(w, workflow.id)).toEqual([
        [`occurrence:${FIRST}`, 'abandoned'],
        [`occurrence:${SECOND}`, 'workflow_not_active'],
      ]);
    });

    it('43. a plan that started is never closed: a switched-off schedule and an archived one leave it executing', async () => {
      const w = await world();
      const off = await scheduled(w, [{ ...SUMMARY[0], approvalRequired: true }]);
      const archived = await scheduled(w, [{ ...SUMMARY[0], approvalRequired: true }]);
      for (const { workflow } of [off, archived]) {
        expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toEqual({
          status: 200,
          body: { result: 'planned' },
        });
      }
      await w.drive();
      const [started] = await w.plansOf(off.workflow.id);
      expect(must(started)).toMatchObject({ status: 'executing' });

      await w.schedules.switchOff(w.tenantA, off.workflow.id);
      w.at(new Date(Date.parse(FIRST) + SCHEDULE_LEASE_MS + 60_000));
      expect(await w.runner.recover()).toBe(0);
      expect(await w.stored(must(started).id)).toMatchObject({ status: 'executing' });

      await w.workflows.changeStatus(w.tenantA, archived.workflow.id, {
        from: 'active',
        to: 'paused',
      });
      await w.workflows.changeStatus(w.tenantA, archived.workflow.id, {
        from: 'paused',
        to: 'archived',
      });
      const [kept] = await w.plansOf(archived.workflow.id);
      w.at(new Date(Date.parse(SECOND) + SCHEDULE_RECOVER_AFTER_MS + 60_000));
      expect(await w.runner.recover()).toBe(1);
      expect(await w.stored(must(kept).id)).toMatchObject({ status: 'executing' });
      expect(await closedWith(w, 'schedule_off')).toEqual([]);
      expect(await closedWith(w, 'schedule_abandoned')).toEqual([]);
      expect(await w.scheduleOf(archived.workflow.id)).toMatchObject({ status: 'off' });
    });

    it('44. two workers and the sweep settle a switched-off schedule at once: one closure, one run recorded', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      const [open] = await w.plansOf(workflow.id);
      await w.schedules.switchOff(w.tenantA, workflow.id);
      w.at(new Date(Date.parse(FIRST) + SCHEDULE_LEASE_MS + 60_000));
      const ran = await Promise.all([
        w.runner.recover(),
        w.runnerOf().recover(),
        w.runnerOf().recover(),
      ]);
      expect(ran.reduce((sum, n) => sum + n, 0)).toBe(1);
      expect(await w.stored(must(open).id)).toMatchObject({ status: 'cancelled' });
      expect(await closedWith(w, 'schedule_off')).toHaveLength(1);
      expect(await runsOf(w, workflow.id)).toEqual([[`occurrence:${FIRST}`, 'abandoned']]);
    });

    it('45. a person cancels the open plan while the sweep settles the switched-off schedule: one transition', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) });
      const [open] = await w.plansOf(workflow.id);
      await w.schedules.switchOff(w.tenantA, workflow.id);
      w.at(new Date(Date.parse(FIRST) + SCHEDULE_LEASE_MS + 60_000));
      const [cancel] = await Promise.allSettled([
        w.plans.cancel(w.tenantA, must(open).id, 'director_request'),
        w.runner.recover(),
      ]);
      // Cancelled by the person, or closed by the sweep: never twice.
      if (cancel.status === 'rejected') {
        expect(cancel.reason).toMatchObject({ code: 'invalid_plan_transition' });
      }
      expect(await w.stored(must(open).id)).toMatchObject({ status: 'cancelled' });
      const transitions = (await w.stores.events()).filter(
        (e) => e.action === 'plan.state_changed' && e.target?.id === must(open).id,
      );
      expect(transitions).toHaveLength(1);
    });

    /** A delegation of FIRST that stops after its first child: the plan is left `creating`. */
    async function stuckAtFirst(w: World, workflowId: string): Promise<Plan> {
      w.faults.children = true;
      w.faults.allowed = 1;
      expect(await w.deliver(w.taskFor(workflowId, FIRST))).toMatchObject({
        status: 503,
        body: { result: 'retry' },
      });
      w.faults.children = false;
      w.faults.allowed = 0;
      const [stuck] = await w.plansOf(workflowId);
      expect(must(stuck)).toMatchObject({
        status: 'approved',
        delegationState: 'creating',
        decision: { via: 'schedule' },
      });
      return must(stuck);
    }

    it('46. a creating delegation left by a stopped attempt is failed at the next claim, its child stays pending, and the next occurrence runs', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      const made = await w.childOf(stuck, 'week');
      expect(made.status).toBe('pending');

      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toEqual({
        status: 200,
        body: { result: 'planned' },
      });
      expect(await w.stored(stuck.id)).toMatchObject({
        status: 'failed',
        delegationState: 'failed',
        delegationFailure: 'delegation_abandoned',
      });
      expect((await w.executions.get(w.tenantA, stuck.executionId)).status).toBe('failed');
      expect(await closedWith(w, 'schedule_abandoned')).toEqual([
        ['schedule_abandoned', `occurrence:${FIRST}`, 'failed'],
      ]);
      // The child it made never runs: nothing starts a plan that failed.
      await w.drive();
      expect((await w.executions.get(w.tenantA, made.id)).status).toBe('pending');
      const next = must(
        (await w.plansOf(workflow.id)).find((p) => p.workflow?.occurrence === SECOND),
      );
      expect((await w.stored(next.id)).status).toBe('completed');
      expect(await runsOf(w, workflow.id)).toEqual([
        [`occurrence:${FIRST}`, 'abandoned'],
        [`occurrence:${SECOND}`, 'planned'],
      ]);
    });

    it('47. a creating delegation of a schedule switched off is failed by the sweep, with its reason; its child stays pending', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      const made = await w.childOf(stuck, 'week');
      await w.schedules.switchOff(w.tenantA, workflow.id);
      w.at(new Date(Date.parse(FIRST) + SCHEDULE_LEASE_MS + 60_000));
      expect(await w.runner.recover()).toBe(1);
      expect(await w.stored(stuck.id)).toMatchObject({
        status: 'failed',
        delegationFailure: 'delegation_abandoned',
      });
      expect(await closedWith(w, 'schedule_off')).toEqual([
        ['schedule_off', `occurrence:${FIRST}`, 'failed'],
      ]);
      await w.drive();
      expect((await w.executions.get(w.tenantA, made.id)).status).toBe('pending');
      expect(await w.scheduleOf(workflow.id)).toMatchObject({
        status: 'off',
        last: { occurrence: FIRST, outcome: 'abandoned' },
      });
    });

    it('48. a failed delegation whose cleanup an interrupted attempt left open is finished by the next claim, and never reactivated', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      // The next occurrence fails the delegation, and its cleanup stops at the planning execution.
      w.faults.parentFails = 1;
      expect(
        await w.deliver(w.taskFor(workflow.id, SECOND), { runner: w.runnerOf() }),
      ).toMatchObject({ status: 503, body: { result: 'retry' } });
      expect(await w.stored(stuck.id)).toMatchObject({ status: 'failed' });
      expect((await w.executions.get(w.tenantA, stuck.executionId)).status).toBe(
        'waiting_approval',
      );
      // The retry, once the lease has lapsed, finishes the cleanup and runs its own occurrence.
      expect(
        await w.deliver(w.taskFor(workflow.id, SECOND), {
          late: SCHEDULE_LEASE_MS + 60_000,
          runner: w.runnerOf(),
        }),
      ).toEqual({ status: 200, body: { result: 'planned' } });
      expect((await w.executions.get(w.tenantA, stuck.executionId)).status).toBe('failed');
      // Never reactivated: the failed plan has no new child, and no second closure.
      expect(await w.stored(stuck.id)).toMatchObject({
        status: 'failed',
        delegationFailure: 'delegation_abandoned',
        delegations: stuck.delegations,
      });
      expect(await closedWith(w, 'schedule_abandoned')).toEqual([
        ['schedule_abandoned', `occurrence:${FIRST}`, 'failed'],
      ]);
      expect(
        (await w.plansOf(workflow.id)).filter((p) => p.workflow?.occurrence === SECOND),
      ).toHaveLength(1);
    });

    it('49. repeated sweeps and redeliveries add no plan, no child and no closure', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toEqual({
        status: 200,
        body: { result: 'planned' },
      });
      await w.drive();
      const plansBefore = (await w.plansOf(workflow.id)).map((p) => [p.id, p.status]);
      const children = (await w.stored(stuck.id)).delegations.length;
      expect(await w.runner.recover()).toBe(0);
      expect(await w.runner.recover()).toBe(0);
      expect(await w.deliver(w.taskFor(workflow.id, FIRST))).toEqual({
        status: 200,
        body: { result: 'not_this_occurrence' },
      });
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toEqual({
        status: 200,
        body: { result: 'not_this_occurrence' },
      });
      expect((await w.plansOf(workflow.id)).map((p) => [p.id, p.status])).toEqual(plansBefore);
      expect((await w.stored(stuck.id)).delegations).toHaveLength(children);
      expect(await closedWith(w, 'schedule_abandoned')).toHaveLength(1);
      expect(await runsOf(w, workflow.id)).toEqual([
        [`occurrence:${FIRST}`, 'abandoned'],
        [`occurrence:${SECOND}`, 'planned'],
      ]);
    });

    it('50. two workers and the sweep reach the next occurrence at once, over a stuck delegation: one failure, one plan', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      const task = w.taskFor(workflow.id, SECOND);
      w.at(new Date(Date.parse(SECOND) + SCHEDULE_RECOVER_AFTER_MS + 60_000));
      await Promise.all([
        w.runnerOf().run(task.body),
        w.runnerOf().run(task.body),
        w.runner.recover(),
      ]);
      expect(
        (await w.plansOf(workflow.id)).filter((p) => p.workflow?.occurrence === SECOND),
      ).toHaveLength(1);
      expect(await w.stored(stuck.id)).toMatchObject({ status: 'failed' });
      expect(await closedWith(w, 'schedule_abandoned')).toHaveLength(1);
      expect((await runsOf(w, workflow.id)).filter(([, reason]) => reason === 'planned')).toEqual([
        [`occurrence:${SECOND}`, 'planned'],
      ]);
    });

    it('51. another organization’s runtime finds none of this schedule’s plans and changes none', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      const runtimeB = await resolveRuntimeTenant(BOB, w.orgB, w.stores.tenancy);
      expect(
        await codeOf(
          w.runtimeConductor.abandon(runtimeB, stuck.id, {
            workflowId: workflow.id,
            supersededBy: SECOND as IsoTimestamp,
            untouchedBefore: stuck.updatedAt,
          }),
        ),
      ).toBe('plan_not_found');
      expect(await codeOf(w.runtimeConductor.closeFailed(runtimeB, stuck.id))).toBe(
        'plan_not_found',
      );
      expect(
        await codeOf(
          w.plans.abandonScheduled(runtimeB, stuck.id, {
            workflowId: workflow.id,
            supersededBy: SECOND as IsoTimestamp,
            untouchedBefore: stuck.updatedAt,
          }),
        ),
      ).toBe('plan_not_found');
      expect(await w.stored(stuck.id)).toMatchObject({
        status: 'approved',
        delegationState: 'creating',
      });
      expect(await closedWith(w, 'schedule_abandoned')).toEqual([]);
    });

    it('52. a failed delegation whose cleanup the claim that failed it left open is finished when the schedule is switched off', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      // The next occurrence fails the delegation, and its claim stops at the planning execution.
      w.faults.parentFails = 1;
      expect(
        await w.deliver(w.taskFor(workflow.id, SECOND), { runner: w.runnerOf() }),
      ).toMatchObject({ status: 503, body: { result: 'retry' } });
      expect(await w.stored(stuck.id)).toMatchObject({ status: 'failed' });
      // Nothing claims again: the schedule is switched off, and the sweep settles the lapsed claim.
      await w.schedules.switchOff(w.tenantA, workflow.id);
      w.at(new Date(Date.parse(SECOND) + SCHEDULE_LEASE_MS + 60_000));
      expect(await w.runner.recover()).toBe(1);
      expect((await w.executions.get(w.tenantA, stuck.executionId)).status).toBe('failed');
      expect(await closedWith(w, 'schedule_abandoned')).toEqual([
        ['schedule_abandoned', `occurrence:${FIRST}`, 'failed'],
      ]);
      expect(await runsOf(w, workflow.id)).toEqual([
        [`occurrence:${FIRST}`, 'abandoned'],
        [`occurrence:${SECOND}`, 'abandoned'],
      ]);
    });

    it('53. a person who loses plan.create releases the stuck plan at the next claim, audited as permission_lost, and that occurrence is not allowed to plan', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      await w.setRole(LOST_ROLE);

      // The claim releases the stuck plan on the schedule's own rules, and refuses the occurrence.
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toEqual({
        status: 200,
        body: { result: 'not_allowed' },
      });
      expect(await w.stored(stuck.id)).toMatchObject({
        status: 'failed',
        delegationState: 'failed',
        delegationFailure: 'delegation_abandoned',
      });
      expect((await w.executions.get(w.tenantA, stuck.executionId)).status).toBe('failed');
      expect(await closedWith(w, 'permission_lost')).toEqual([
        ['permission_lost', `occurrence:${FIRST}`, 'failed'],
      ]);
      expect(await closedWith(w, 'schedule_abandoned')).toEqual([]);
      expect(
        (await w.plansOf(workflow.id)).filter((p) => p.workflow?.occurrence === SECOND),
      ).toEqual([]);
      expect(await runsOf(w, workflow.id)).toEqual([
        [`occurrence:${FIRST}`, 'abandoned'],
        [`occurrence:${SECOND}`, 'not_allowed'],
      ]);

      // Once it may plan again, the next occurrence plans and runs as usual, and nothing is released twice.
      await w.setRole(OWNER_ROLE);
      w.at(new Date(Date.parse(THIRD) + SCHEDULE_RECOVER_AFTER_MS + 60_000));
      expect(await w.runner.recover()).toBe(1);
      await w.drive();
      const third = must(
        (await w.plansOf(workflow.id)).find((p) => p.workflow?.occurrence === THIRD),
      );
      expect((await w.stored(third.id)).status).toBe('completed');
      expect(await runsOf(w, workflow.id)).toEqual([
        [`occurrence:${FIRST}`, 'abandoned'],
        [`occurrence:${SECOND}`, 'not_allowed'],
        [`occurrence:${THIRD}`, 'planned'],
      ]);
      expect(await closedWith(w, 'permission_lost')).toHaveLength(1);
    });

    it('54. the sweep reaches a switched-off schedule behind a page it cannot settle yet, and settles it', async () => {
      const w = await world();
      // Fifty schedules switched off while their claims lapsed, whose person has left: the sweep reads
      // them and cannot settle them yet. Their ids sort first, so they fill the first page of the sweep.
      const GONE = '99999999-9999-4999-8999-999999999999' as UserId;
      const CLAIMED = '2026-10-01T08:00:00.000Z' as IsoTimestamp;
      const offSince = (workflowId: WorkflowId, confirmedBy: UserId) => ({
        schedule: {
          workflowId,
          organizationId: w.orgA,
          status: 'off' as const,
          recurrence: { frequency: 'daily' as const, time: '09:00' },
          timeZone: 'Europe/Madrid',
          workflowVersion: 1,
          confirmedBy,
          confirmedAt: CLAIMED,
          last: { occurrence: CLAIMED, outcome: 'claimed' as const, at: CLAIMED },
          revision: 1,
          updatedAt: CLAIMED,
        },
        events: [],
      });
      const held = Array.from(
        { length: 50 },
        (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` as WorkflowId,
      );
      for (const id of held) await w.stores.schedules.update(w.orgA, id, () => offSince(id, GONE));
      const target = 'ffffffff-ffff-4fff-8fff-ffffffffffff' as WorkflowId;
      await w.stores.schedules.update(w.orgA, target, () => offSince(target, ALICE));
      w.at(new Date(Date.parse(CLAIMED) + SCHEDULE_LEASE_MS + 60_000));

      // One settled, found on the second page; the fifty held ones stay as they are.
      expect(await w.runner.recover()).toBe(1);
      expect((await w.scheduleOf(target)).last?.outcome).toBe('abandoned');
      expect((await w.scheduleOf(held[0] as WorkflowId)).last?.outcome).toBe('claimed');
    });

    it('55. a switched-off schedule whose person lost plan.create is settled by the sweep: its stuck plan is released as permission_lost, and the occurrence recorded abandoned', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      await w.schedules.switchOff(w.tenantA, workflow.id);
      await w.setRole(LOST_ROLE);
      // The claim of FIRST has lapsed. An off schedule claims nothing again, so the sweep settles it.
      w.at(new Date(Date.parse(FIRST) + SCHEDULE_LEASE_MS + 60_000));
      expect(await w.runner.recover()).toBe(1);
      expect(await w.stored(stuck.id)).toMatchObject({
        status: 'failed',
        delegationFailure: 'delegation_abandoned',
      });
      expect((await w.executions.get(w.tenantA, stuck.executionId)).status).toBe('failed');
      expect(await closedWith(w, 'permission_lost')).toEqual([
        ['permission_lost', `occurrence:${FIRST}`, 'failed'],
      ]);
      expect(await closedWith(w, 'schedule_off')).toEqual([]);
      expect(await runsOf(w, workflow.id)).toEqual([[`occurrence:${FIRST}`, 'abandoned']]);
      // Settled once: the sweep finds nothing more to do.
      expect(await w.runner.recover()).toBe(0);
      expect(await closedWith(w, 'permission_lost')).toHaveLength(1);
    });

    it('56. a switched-off schedule whose person lost plan.create: the sweep cancels the approved plan that never started, as permission_lost', async () => {
      const w = await world();
      const { workflow } = await scheduled(w);
      // The standing approval approves the plan, and its start fails: nothing was delegated.
      expect(
        await w.deliver(w.taskFor(workflow.id, FIRST), { runner: w.runnerOf(failingStart()) }),
      ).toMatchObject({ status: 503, body: { result: 'retry' } });
      const [lost] = await w.plansOf(workflow.id);
      expect(must(lost)).toMatchObject({ status: 'approved', decision: { via: 'schedule' } });
      await w.schedules.switchOff(w.tenantA, workflow.id);
      await w.setRole(LOST_ROLE);
      w.at(new Date(Date.parse(FIRST) + SCHEDULE_LEASE_MS + 60_000));

      expect(await w.runner.recover()).toBe(1);
      expect(await w.stored(must(lost).id)).toMatchObject({ status: 'cancelled' });
      expect(await closedWith(w, 'permission_lost')).toEqual([
        ['permission_lost', `occurrence:${FIRST}`, 'cancelled'],
      ]);
      expect(await runsOf(w, workflow.id)).toEqual([[`occurrence:${FIRST}`, 'abandoned']]);
    });

    it('57. two workers and the sweep release the stuck plan of a person who lost plan.create at once: one release, one occurrence refused', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      await w.setRole(LOST_ROLE);
      const task = w.taskFor(workflow.id, SECOND);
      w.at(new Date(Date.parse(SECOND) + SCHEDULE_RECOVER_AFTER_MS + 60_000));
      await Promise.all([
        w.runnerOf().run(task.body),
        w.runnerOf().run(task.body),
        w.runner.recover(),
      ]);

      expect(await w.stored(stuck.id)).toMatchObject({
        status: 'failed',
        delegationFailure: 'delegation_abandoned',
      });
      expect(await closedWith(w, 'permission_lost')).toHaveLength(1);
      expect(
        (await w.plansOf(workflow.id)).filter((p) => p.workflow?.occurrence === SECOND),
      ).toEqual([]);
      expect(await runsOf(w, workflow.id)).toEqual([
        [`occurrence:${FIRST}`, 'abandoned'],
        [`occurrence:${SECOND}`, 'not_allowed'],
      ]);
    });

    it('58. another organization’s runtime finds none of this schedule’s plans, even once the person lost plan.create here', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      await w.setRole(LOST_ROLE);
      const runtimeB = await resolveRuntimeTenant(BOB, w.orgB, w.stores.tenancy);

      expect(
        await codeOf(
          w.runtimeConductor.abandon(runtimeB, stuck.id, {
            workflowId: workflow.id,
            supersededBy: SECOND as IsoTimestamp,
            untouchedBefore: stuck.updatedAt,
          }),
        ),
      ).toBe('plan_not_found');
      expect(await codeOf(w.runtimeConductor.closeFailed(runtimeB, stuck.id))).toBe(
        'plan_not_found',
      );
      expect(await w.stored(stuck.id)).toMatchObject({
        status: 'approved',
        delegationState: 'creating',
      });
      expect(await closedWith(w, 'permission_lost')).toEqual([]);
    });

    it('59. a switched-off schedule whose person got plan.create back before the sweep is settled as schedule_off, not as permission_lost', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      await w.setRole(LOST_ROLE);
      await w.setRole(OWNER_ROLE);
      await w.schedules.switchOff(w.tenantA, workflow.id);
      w.at(new Date(Date.parse(FIRST) + SCHEDULE_LEASE_MS + 60_000));

      expect(await w.runner.recover()).toBe(1);
      expect(await w.stored(stuck.id)).toMatchObject({
        status: 'failed',
        delegationFailure: 'delegation_abandoned',
      });
      expect(await closedWith(w, 'schedule_off')).toEqual([
        ['schedule_off', `occurrence:${FIRST}`, 'failed'],
      ]);
      expect(await closedWith(w, 'permission_lost')).toEqual([]);
    });

    it('60. the sweep leaves an on schedule’s lapsed claim to its next occurrence, which settles the stuck plan as superseded', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      // The claim lapsed, but the schedule is still on: the sweep settles nothing of a schedule that runs.
      w.at(new Date(Date.parse(FIRST) + SCHEDULE_LEASE_MS + 60_000));
      expect(await w.runner.recover()).toBe(0);
      expect(await w.stored(stuck.id)).toMatchObject({
        status: 'approved',
        delegationState: 'creating',
      });
      expect(await w.scheduleOf(workflow.id)).toMatchObject({
        status: 'on',
        last: { occurrence: FIRST, outcome: 'claimed' },
      });
      expect(await closedWith(w, 'schedule_off')).toEqual([]);
      expect(await closedWith(w, 'schedule_abandoned')).toEqual([]);

      // Its next occurrence closes the stuck plan as superseded, and plans as usual.
      expect(await w.deliver(w.taskFor(workflow.id, SECOND))).toEqual({
        status: 200,
        body: { result: 'planned' },
      });
      expect(await closedWith(w, 'schedule_abandoned')).toEqual([
        ['schedule_abandoned', `occurrence:${FIRST}`, 'failed'],
      ]);
    });

    it('61. the sweep releases a hand-made plan of a person who lost plan.create through the schedule runner’s recovery, audited as permission_lost once', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      // The same stopped delegation as a plan Alice approved by hand: her own decision, and no schedule
      // or occurrence made it. The schedule is still on, so only the hand-made pass can reach it.
      await w.stores.plans.update(w.orgA, stuck.id, (current) => {
        const decision = must(current.decision);
        const ref = must(current.workflow);
        return {
          plan: {
            ...current,
            decision: {
              decision: decision.decision,
              version: decision.version,
              digest: decision.digest,
              decidedBy: decision.decidedBy,
              decidedAt: decision.decidedAt,
            },
            workflow: { id: ref.id, version: ref.version },
            revision: current.revision + 1,
          },
          events: [],
        };
      });
      await w.setRole(LOST_ROLE);
      w.at(new Date(Date.parse(FIRST) + SCHEDULE_LEASE_MS + 60_000));

      await w.runner.recover();
      expect(await w.stored(stuck.id)).toMatchObject({
        status: 'failed',
        delegationState: 'failed',
        delegationFailure: 'delegation_abandoned',
      });
      expect((await w.executions.get(w.tenantA, stuck.executionId)).status).toBe('failed');
      expect(await closedWith(w, 'permission_lost')).toEqual([
        ['permission_lost', undefined, 'failed'],
      ]);

      // Released once: the next sweep finds nothing more to release.
      await w.runner.recover();
      expect(await closedWith(w, 'permission_lost')).toHaveLength(1);
    });

    it('62. a release a crash left open: the schedule runner’s recovery closes its planning execution once a lease has passed, audited once', async () => {
      const w = await world();
      const { workflow } = await scheduled(w, TWO_STEPS);
      const stuck = await stuckAtFirst(w, workflow.id);
      // The hand-made plan of 61, failed by a release at the time of the crash, and its planning
      // execution still open: the release never reached its cleanup (ADR-0187, decision 8).
      await w.stores.plans.update(w.orgA, stuck.id, (current) => {
        const decision = must(current.decision);
        const ref = must(current.workflow);
        return {
          plan: {
            ...current,
            decision: {
              decision: decision.decision,
              version: decision.version,
              digest: decision.digest,
              decidedBy: decision.decidedBy,
              decidedAt: decision.decidedAt,
            },
            workflow: { id: ref.id, version: ref.version },
            status: 'failed',
            delegationState: 'failed',
            delegationFailure: 'delegation_abandoned',
            updatedAt: FIRST,
            revision: current.revision + 1,
          },
          events: [],
        };
      });
      // The planning execution's closures, audited with their failure code.
      const closures = async () =>
        (await w.stores.events())
          .filter(
            (e) =>
              e.action === 'execution.state_changed' &&
              e.target?.id === stuck.executionId &&
              e.reason !== undefined,
          )
          .map((e) => e.reason);
      const before = await closures();
      expect((await w.executions.get(w.tenantA, stuck.executionId)).status).not.toBe('failed');

      w.at(new Date(Date.parse(FIRST) + SCHEDULE_LEASE_MS + 60_000));
      await w.runner.recover();
      expect((await w.executions.get(w.tenantA, stuck.executionId)).status).toBe('failed');
      expect(await closures()).toEqual([...before, 'delegation_abandoned']);
      expect(await w.stored(stuck.id)).toMatchObject({
        status: 'failed',
        delegationFailure: 'delegation_abandoned',
      });

      // Closed once: the next sweep finds the execution closed and writes nothing.
      await w.runner.recover();
      expect(await closures()).toEqual([...before, 'delegation_abandoned']);
    });
  },
);
