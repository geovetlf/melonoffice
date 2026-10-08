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
import {
  createApprovalService,
  createPlanStepApprovals,
  InMemoryApprovalRepository,
} from '@melonoffice/approvals';
import { createAuditService, InMemoryAuditStore, type AuditEvent } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { InMemoryKnowledgeRepository, type KnowledgeRepository } from '@melonoffice/brain';
import {
  ConversationError,
  createCustomerService,
  createFollowUpService,
  InMemoryConversationRepository,
  type ConversationRepository,
  type FollowUpService,
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
  JobId,
  Organization,
  Plan,
  SubscriptionId,
  ToolDefinition,
  UserId,
  Workflow,
} from '@melonoffice/domain';
import {
  createExecutionService,
  InMemoryAgentOutputRepository,
  InMemoryExecutionRepository,
  type AgentOutputRepository,
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
  fromAuditDocument,
  type AuditDocument,
} from '@melonoffice/firestore';
import { emulatorFirestore, emulatorHost } from '@melonoffice/firestore/testing';
import { harnessTaskPolicy } from '@melonoffice/harness';
import { InMemoryJobRepository, isJobError } from '@melonoffice/jobs';
import {
  createDelegation,
  createPlanCancellationCascade,
  createPlanConductor,
  createPlanService,
  createPlanStepAttempts,
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
  type TenantContext,
} from '@melonoffice/tenancy';
import { createToolRegistry, TOOL_CATALOGUE } from '@melonoffice/tools';
import {
  createWorkflowService,
  InMemoryWorkflowRepository,
  type WorkflowRepository,
} from '@melonoffice/workflows';
import { describe, expect, it } from 'vitest';
import { createAgentTaskParts, createConversationAgentParts, routeAgentWork } from './agents.js';
import { createWorkerRuntime, type WorkerStores } from './runtime.js';

/**
 * A workflow's step writes data (B6, ADR-0184), on the engines that already exist and nothing
 * else: the workflow becomes a plan its person approves; the commercial agent's step asks that
 * person to approve the exact follow-up its tool step will schedule; once approved, the agent
 * works, its tool step runs `workflow_follow_up@1` through the Tool Gate, the follow-up service
 * schedules it once, everything is audited, and the step after it runs. In memory and on the
 * emulator.
 */

const T0 = new Date('2026-10-05T12:00:00Z');
const LEASE_MS = 60_000;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const CREDITS = 100;
// T0 is 07:00 on 2026-10-05 in Lima: two days later, at 10:30 there.
const DUE_DATE = '2026-10-07';

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

/**
 * The workflow: the commercial agent prepares the call and its tool step schedules it with Juan;
 * once that step is done, it writes the note for the team. Another branch, on its own, sums up
 * the week, so a failing write is seen to stop its own branch only.
 */
function stepsFor(contactId: string, over: Record<string, unknown> = {}) {
  return [
    {
      id: 'prepare',
      kind: 'specialist',
      label: 'Preparar la llamada con Juan',
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
      input: {
        contactId,
        type: 'call',
        title: 'Llamar a Juan por su pedido',
        inDays: 2,
        time: '10:30',
      },
      ...over,
    },
    {
      id: 'note',
      kind: 'specialist',
      label: 'Dejar una nota al equipo',
      dependsOn: ['prepare'],
      assignee: SELLER,
      verification: VERIFICATION,
    },
    {
      id: 'week',
      kind: 'specialist',
      label: 'Resumir la semana',
      dependsOn: [],
      assignee: SELLER,
      verification: VERIFICATION,
    },
  ];
}

type Stores = WorkerStores & {
  readonly conversations: ConversationRepository;
  readonly outputs: AgentOutputRepository;
  readonly tasks: AgentTaskRepository;
  readonly knowledge: KnowledgeRepository;
  readonly plans: PlanRepository;
  readonly workflows: WorkflowRepository;
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
    credits,
    audit,
    events: async () => audit.events(),
  };
}

function firestoreStores(now: () => Date): Stores {
  const db: Firestore = emulatorFirestore();
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
    credits: new FirestoreCreditStore(db),
    audit: new FirestoreAuditStore(db),
    async events() {
      const snapshot = await db.collection(AUDIT_LOGS).orderBy('occurredAt').get();
      return snapshot.docs.map((doc) => fromAuditDocument(doc.id, doc.data() as AuditDocument));
    },
  };
}

const STORES: [string, (now: () => Date) => Stores][] = [
  ['memory', memoryStores],
  ...(emulatorHost ? [['firestore', firestoreStores] as [string, typeof memoryStores]] : []),
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

/** The catalogue, with `workflow_follow_up@1` given a shorter deadline for a timeout test. */
function catalogue(timeoutMs?: number): readonly ToolDefinition[] {
  if (timeoutMs === undefined) return TOOL_CATALOGUE;
  return TOOL_CATALOGUE.map((t) =>
    t.id !== 'workflow_follow_up'
      ? t
      : { ...t, versions: t.versions.map((v) => ({ ...v, timeoutMs })) },
  );
}

type CreateHook = (
  real: FollowUpService['create'],
  tenant: TenantContext,
  input: Record<string, unknown>,
) => ReturnType<FollowUpService['create']>;

describe.each(STORES)(
  "a workflow's step writes data, with storage in %s (B6, ADR-0184)",
  (_storage, createStores) => {
    async function world(
      options: {
        readonly credits?: number;
        readonly skill?: number;
        readonly timeoutMs?: number;
      } = {},
    ) {
      let clock = new Date(T0);
      const now = () => {
        clock = new Date(clock.getTime() + 1);
        return clock;
      };
      const stores = createStores(now);
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
      const authorization = createAuthorizationService();
      const audit = createAuditService(stores.audit, now);
      const registry = createToolRegistry(catalogue(options.timeoutMs));
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

      // The follow-up service as the worker builds it, its queue faked. A test may stand in front
      // of its `create` to make it slow, fail, or answer ambiguously.
      const queued: string[] = [];
      const service = createFollowUpService({
        repository: stores.conversations,
        organizations: stores.tenancy,
        authorization,
        timeZone: async () => 'America/Lima',
        scheduler: { schedule: async (ref) => void queued.push(ref.followUpId) },
        now,
      });
      let hook: CreateHook | undefined;
      const followUps: FollowUpService = {
        ...service,
        create: (tenant, input) =>
          hook === undefined ? service.create(tenant, input) : hook(service.create, tenant, input),
      };
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
          timeZone: async () => 'America/Lima',
        },
        now,
      });
      const routed = routeAgentWork(conversation, taskParts);
      const dispatched: JobId[] = [];
      const wakeups = { async wake() {} };
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
        wakeups,
        dispatcher: { dispatch: async (id) => void dispatched.push(id) },
        now,
      });
      const { runtime } = worker;

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
      const conductor = createPlanConductor({
        plans: stores.plans,
        delegation: createDelegation({
          plans: stores.plans,
          executions,
          specialists,
          organizations: stores.tenancy,
          authorization,
          now,
        }),
        executions,
        starter: {
          async start(tenant, executionId) {
            if (tenant.actor === 'user') await executions.start(tenant, executionId);
            else await executions.runtimeStart(tenant, executionId);
            await runtime.kickoff(tenant, executionId);
          },
        },
        approvals: createPlanStepApprovals(approvals, now, registry),
        attempts: createPlanStepAttempts({ executions, specialists }),
        wakeups,
        now,
      });

      const tenantA = await resolveTenant(as(ALICE), orgA, stores.tenancy);
      const tenantB = await resolveTenant(as(BOB), b.organization.id, stores.tenancy);
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
      const carla = await customers.create(tenantB, {
        displayName: 'Carla Ruiz',
        phone: '+51911222333',
      });

      // The commercial agent, moved by Alice to customer_follow_up@4 (or the version a test names).
      const created = await management.create(tenantA, {
        templateId: 'commercial',
        displayName: 'Lucía',
      });
      const skill = options.skill ?? 4;
      const upgraded =
        skill === 2
          ? created
          : await management.upgradeSkill(tenantA, created.identity.id, {
              fromVersion: created.version,
              skillId: 'customer_follow_up',
              version: skill,
            });
      const lucia = await management.setStatus(tenantA, upgraded.identity.id, {
        from: 'draft',
        to: 'active',
      });

      const saved = new Map<string, Workflow>();
      /** Saves and switches on a workflow once, by its name. */
      async function workflowOf(name: string, steps: readonly unknown[]): Promise<Workflow> {
        const found = saved.get(name);
        if (found !== undefined) return found;
        let w = await workflows.create(tenantA, { name, steps });
        w = await workflows.changeStatus(tenantA, w.id, { from: 'draft', to: 'active' });
        saved.set(name, w);
        return w;
      }

      /** Planned from the workflow by Alice, approved by her: the plan starts. */
      async function started(
        key = 'run-1',
        steps: readonly unknown[] = stepsFor(juan.id),
        name = 'Llamar a Juan',
      ): Promise<Plan> {
        const workflow = await workflowOf(name, steps);
        const planned = await workflows.plan(tenantA, workflow.id, { requestKey: key });
        if (planned.status !== 'planned') throw new Error(`refused: ${JSON.stringify(planned)}`);
        const version = must(
          await stores.plans.findVersion(orgA, planned.plan.id, planned.plan.version),
        );
        await plans.approve(tenantA, planned.plan.id, {
          version: version.version,
          digest: version.digest,
        });
        return conductor.run(tenantA, planned.plan.id);
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

      /** The tool step's approval for a plan, as Alice's inbox lists it. */
      async function writeApproval(plan: Plan) {
        const childId = (await stored(plan.id)).delegations.find(
          (d) => d.stepId === 'prepare',
        )?.executionId;
        return (await approvals.list(tenantA)).filter(
          (x) => x.operation.nodeId === 'schedule' && x.operation.executionId === childId,
        );
      }

      /** Alice approves (or rejects) the write; the API resumes the plan as its runtime. */
      async function decideWrite(plan: Plan, decision: 'approve' | 'reject' = 'approve') {
        const approval = must((await writeApproval(plan)).find((x) => x.status === 'pending'));
        if (decision === 'approve') await approvals.approve(tenantA, approval.id);
        else await approvals.reject(tenantA, approval.id);
        await conductor.resume(runtimeA, plan.id);
        return approval;
      }

      const stored = async (id: string) => must(await stores.plans.find(orgA, id as Plan['id']));
      const childOf = async (plan: Plan, stepId: string) =>
        executions.get(
          tenantA,
          must((await stored(plan.id)).delegations.find((d) => d.stepId === stepId)).executionId,
        );
      const scheduled = async (tenant: TenantContext = tenantA) =>
        (await service.list(tenant)).items;

      return {
        stores,
        orgA,
        tenantA,
        tenantB,
        runtimeA,
        juan,
        carla,
        lucia,
        workflows,
        executions,
        approvals,
        conductor,
        providerCalls,
        dispatched,
        queued,
        started,
        drive,
        writeApproval,
        decideWrite,
        stored,
        childOf,
        scheduled,
        setHook: (next: CreateHook | undefined) => {
          hook = next;
        },
        later: (ms: number) => {
          clock = new Date(clock.getTime() + ms);
        },
      };
    }
    type World = Awaited<ReturnType<typeof world>>;

    /** Started, approved by Alice, and driven to its end. */
    async function runToEnd(w: World, key = 'run-1', steps?: readonly unknown[]) {
      const plan = await w.started(key, steps);
      await w.drive();
      await w.decideWrite(plan);
      await w.drive();
      return w.stored(plan.id);
    }

    it('1, 12, 13. an authorized write schedules the follow-up once, is audited, and the next step runs', async () => {
      const w = await world();
      const plan = await w.started();
      await w.drive();
      // The week's summary ran at once; the agent's step waits for Alice to approve the write.
      expect(await w.scheduled()).toEqual([]);
      const [ask] = await w.writeApproval(plan);
      expect(ask).toMatchObject({
        status: 'pending',
        impact: 'changes_data',
        riskLevel: 'low',
        operation: { toolId: 'workflow_follow_up', toolVersion: 1, action: 'schedule' },
      });
      expect((await w.childOf(plan, 'prepare')).startedAt).toBeUndefined();

      await w.decideWrite(plan);
      await w.drive();
      const done = await w.stored(plan.id);
      expect(done.status).toBe('completed');

      // One follow-up: the workflow's contact, type, title and time, two days after today in the
      // business's time zone, scheduled by the agent for Alice, and queued once.
      const [followUp, ...more] = await w.scheduled();
      expect(more).toEqual([]);
      expect(followUp).toMatchObject({
        contactId: w.juan.id,
        type: 'call',
        title: 'Llamar a Juan por su pedido',
        source: 'agent',
        createdBy: ALICE,
        timeZone: 'America/Lima',
      });
      expect(followUp?.scheduledAt).toBe('2026-10-07T15:30:00.000Z');
      expect(w.queued).toEqual([followUp?.id]);

      // The agent's child: its answer, then the write through the Tool Gate.
      const child = await w.childOf(plan, 'prepare');
      expect(child.nodes.map((n) => `${n.id}:${n.type}:${n.status}`)).toEqual([
        'prepare:agent:completed',
        'schedule:tool:completed',
      ]);
      const toolNode = must(child.nodes.find((n) => n.id === 'schedule'));
      expect(toolNode.idempotencyKey).toBeDefined();
      expect(toolNode.approvalId).toBe(ask?.id);
      // 13. The note after it ran, and so did the other branch.
      expect((await w.childOf(plan, 'note')).status).toBe('completed');
      expect((await w.childOf(plan, 'week')).status).toBe('completed');

      // 12. The whole trail: who approved, the gate's checks, the call, its end, the follow-up.
      const events = await w.stores.events();
      const ofChild = events.filter((e) => e.target?.id === child.id);
      const actions = ofChild.map((e) => e.action);
      for (const action of [
        'tool.authorization_checked',
        'tool.execution_requested',
        'tool.execution_completed',
      ]) {
        expect(actions.filter((a) => a === action)).toHaveLength(1);
      }
      const checked = must(ofChild.find((e) => e.action === 'tool.authorization_checked'));
      expect(checked.reason).toBe('approved');
      expect(checked.organizationId).toBe(w.orgA);
      expect(checked.actor).toMatchObject({ type: 'system', id: 'runtime', initiatedBy: ALICE });
      const approved = must(
        events.find((e) => e.action === 'tool.approval_approved' && e.target?.id === ask?.id),
      );
      expect(approved.actor).toMatchObject({ type: 'user', userId: ALICE });
      const createdEvents = events.filter(
        (e) => e.action === 'follow_up.created' && e.target?.id === followUp?.id,
      );
      expect(createdEvents).toHaveLength(1);
      expect(createdEvents[0]?.actor).toMatchObject({
        type: 'system',
        id: 'runtime',
        initiatedBy: ALICE,
      });
      expect(events.some((e) => e.action === 'tool.execution_failed')).toBe(false);
    });

    it('2. without authorization nothing is written: no skill grant, no write tool fit for plans, or no approval', async () => {
      // An agent still on customer_follow_up@3 does not hold workflow_follow_up: the plan is refused.
      const unskilled = await world({ skill: 3 });
      const workflow = await unskilled.workflows.create(unskilled.tenantA, {
        name: 'Llamar a Juan',
        steps: stepsFor(unskilled.juan.id),
      });
      await unskilled.workflows
        .changeStatus(unskilled.tenantA, workflow.id, {
          from: 'draft',
          to: 'active',
        })
        .catch(() => undefined);
      const planned = await unskilled.workflows
        .plan(unskilled.tenantA, workflow.id, { requestKey: 'run-1' })
        .catch((error: unknown) => ({
          status: 'refused',
          code: (error as { code?: string }).code,
        }));
      expect(planned.status).not.toBe('planned');
      expect(await unskilled.scheduled()).toEqual([]);

      // A write not built for plans (the agent's version 2) is never a step, whatever the agent.
      const w = await world();
      const v2 = stepsFor(w.juan.id, {
        tool: { id: 'follow_up_schedule', version: 2 },
        input: {
          requestKey: 'mine-00000001',
          contactId: w.juan.id,
          type: 'call',
          title: 'x',
          date: DUE_DATE,
          time: '10:30',
          source: 'agent',
        },
      });
      const other = await w.workflows.create(w.tenantA, { name: 'Con v2', steps: v2 });
      expect(
        await codeOf(
          w.workflows.changeStatus(w.tenantA, other.id, { from: 'draft', to: 'active' }),
        ),
      ).not.toBe('ok');

      // Bob, of another organization, can neither see nor decide Alice's write.
      const plan = await w.started();
      await w.drive();
      const [ask] = await w.writeApproval(plan);
      expect(await w.approvals.list(w.tenantB)).toEqual([]);
      expect(await codeOf(w.approvals.approve(w.tenantB, must(ask).id))).not.toBe('ok');
      expect(await w.scheduled()).toEqual([]);
    });

    it('3. the same job delivered twice, and concurrent resumes, write once', async () => {
      const w = await world();
      const plan = await w.started();
      await w.drive();
      const ask = must((await w.writeApproval(plan))[0]);
      await w.approvals.approve(w.tenantA, ask.id);
      await Promise.all([
        w.conductor.resume(w.runtimeA, plan.id),
        w.conductor.resume(w.runtimeA, plan.id),
      ]);
      // Every job delivered twice.
      w.dispatched.push(...w.dispatched);
      await w.drive(60);
      // The tool node's job again, after it ran: it is not run twice.
      const child = await w.childOf(plan, 'prepare');
      expect((await w.stored(plan.id)).status).toBe('completed');
      expect(await w.scheduled()).toHaveLength(1);
      expect(w.queued).toHaveLength(1);
      const requested = (await w.stores.events()).filter(
        (e) => e.action === 'tool.execution_requested' && e.target?.id === child.id,
      );
      expect(requested).toHaveLength(1);
    });

    it('4. a write that timed out is never run again; running the workflow again reaches the same follow-up', async () => {
      // The gate gives up after 2 s, and the service answers 4 s after it wrote: a late answer by
      // construction. The margins are wide because the emulator's latency varies on a loaded runner.
      const w = await world({ timeoutMs: 2000 });
      // The service writes, then answers too late: whether it wrote is unknown to the gate.
      let answered: Promise<void> = Promise.resolve();
      w.setHook(async (real, tenant, input) => {
        const result = await real(tenant, input);
        answered = new Promise((resolve) => setTimeout(resolve, 4000));
        await answered;
        return result;
      });
      const first = await runToEnd(w);
      const child = await w.childOf(first, 'prepare');
      // Its outcome is unknown (ADR-0029): never retried, left for a person, nothing else in it runs.
      const node = must(child.nodes.find((n) => n.id === 'schedule'));
      expect(node.status).toBe('failed');
      expect(node.error?.code).toBe('timeout');
      expect(child.status).not.toBe('completed');
      expect((await w.childOf(first, 'note')).startedAt).toBeUndefined();
      expect((await w.childOf(first, 'week')).status).toBe('completed');
      const requested = (await w.stores.events()).filter(
        (e) => e.action === 'tool.execution_requested' && e.target?.id === child.id,
      );
      expect(requested).toHaveLength(1);
      expect(await w.scheduled()).toHaveLength(1);
      // The late answer arrives before Alice runs the workflow again, and it changes nothing: the
      // timed-out write stays failed, the plan stays open, and no second write was requested.
      await answered;
      const late = await w.childOf(first, 'prepare');
      expect(must(late.nodes.find((n) => n.id === 'schedule')).status).toBe('failed');
      expect(late.status).not.toBe('completed');
      expect(await w.scheduled()).toHaveLength(1);

      // Alice stops that plan and runs the workflow again the same day: the same follow-up.
      await w.executions.cancel(w.tenantA, first.executionId, 'director_request');
      w.setHook(undefined);
      const again = await runToEnd(w, 'run-2');
      expect(again.status).toBe('completed');
      expect(await w.scheduled()).toHaveLength(1);
      // Asked again, the service queues the same follow-up's task, which runs once.
      expect(new Set(w.queued).size).toBe(1);
    });

    it('5. an ambiguous answer after the write fails the step; running again writes nothing more', async () => {
      const w = await world();
      w.setHook(async (real, tenant, input) => {
        await real(tenant, input);
        throw new Error('connection reset');
      });
      const first = await runToEnd(w);
      const child = await w.childOf(first, 'prepare');
      expect(child.status).toBe('failed');
      expect(child.nodes.find((n) => n.id === 'schedule')?.error?.code).toBe('executor_error');
      // Retried once by the runtime, as a write under its idempotency key may be (ADR-0029); the
      // server's key keeps it one follow-up. Then its branch stopped; the other branch ran.
      const events = (await w.stores.events()).filter((e) => e.target?.id === child.id);
      expect(events.filter((e) => e.action === 'tool.execution_requested')).toHaveLength(2);
      expect(
        events.filter((e) => e.action === 'execution.node_retried').map((e) => e.reason),
      ).toEqual(['idempotent_effect']);
      expect((await w.childOf(first, 'week')).status).toBe('completed');
      expect(await w.scheduled()).toHaveLength(1);
      w.setHook(undefined);
      const again = await runToEnd(w, 'run-2');
      expect(again.status).toBe('completed');
      const [only, ...rest] = await w.scheduled();
      expect(rest).toEqual([]);
      expect(only?.contactId).toBe(w.juan.id);
    });

    it('6. two plans of the workflow at once write one follow-up', async () => {
      const w = await world();
      const [one, two] = await Promise.all([w.started('run-1'), w.started('run-2')]);
      await w.drive();
      await Promise.all([w.decideWrite(must(one)), w.decideWrite(must(two))]);
      await w.drive(60);
      expect((await w.stored(must(one).id)).status).toBe('completed');
      expect((await w.stored(must(two).id)).status).toBe('completed');
      expect(await w.scheduled()).toHaveLength(1);
      expect(new Set(w.queued).size).toBe(1);
      // Each plan's write ran once, and one of them found the follow-up already there.
      const completed = (await w.stores.events()).filter(
        (e) => e.action === 'tool.execution_completed',
      );
      expect(completed).toHaveLength(2);
    });

    it('7. a plan stopped before the write runs writes nothing, and its approval is withdrawn', async () => {
      const w = await world();
      const plan = await w.started();
      await w.drive();
      const ask = must((await w.writeApproval(plan))[0]);
      await w.executions.cancel(w.tenantA, plan.executionId, 'director_request');
      expect((await w.stored(plan.id)).status).toBe('cancelled');
      expect((await w.approvals.get(w.tenantA, ask.id)).status).toBe('cancelled');
      // Approving it now changes nothing.
      expect(await codeOf(w.approvals.approve(w.tenantA, ask.id))).toBe('approval_not_pending');
      await w.conductor.resume(w.runtimeA, plan.id);
      await w.drive();
      expect(await w.scheduled()).toEqual([]);
    });

    it('8. a plan stopped while its agent works never reaches the write', async () => {
      const w = await world();
      const plan = await w.started();
      await w.drive();
      await w.decideWrite(plan);
      // The agent's job runs, and its tool node is queued next; then Alice stops the plan.
      const child = await w.childOf(plan, 'prepare');
      const agentJob = w.dispatched.length;
      expect(agentJob).toBeGreaterThan(0);
      await w.drive(1);
      expect((await w.childOf(plan, 'prepare')).nodes.find((n) => n.id === 'prepare')?.status).toBe(
        'completed',
      );
      await w.executions.cancel(w.tenantA, plan.executionId, 'director_request');
      await w.drive();
      expect((await w.executions.get(w.tenantA, child.id)).status).toBe('cancelled');
      expect(await w.scheduled()).toEqual([]);
      const events = await w.stores.events();
      expect(
        events.some((e) => e.action === 'tool.execution_requested' && e.target?.id === child.id),
      ).toBe(false);
    });

    it('9. a withdrawn or rejected approval skips the write and its branch; the rest goes on', async () => {
      const w = await world();
      const plan = await w.started();
      await w.drive();
      const ask = must((await w.writeApproval(plan))[0]);
      await w.approvals.cancel(w.tenantA, ask.id, 'withdrawn');
      await w.conductor.resume(w.runtimeA, plan.id);
      await w.drive();
      const ended = await w.stored(plan.id);
      expect(['completed', 'failed']).toContain(ended.status);
      expect((await w.childOf(plan, 'week')).status).toBe('completed');
      expect((await w.childOf(plan, 'prepare')).startedAt).toBeUndefined();
      expect(await w.scheduled()).toEqual([]);

      const rejected = await world();
      const second = await rejected.started();
      await rejected.drive();
      await rejected.decideWrite(second, 'reject');
      await rejected.drive();
      expect((await rejected.childOf(second, 'prepare')).startedAt).toBeUndefined();
      expect(await rejected.scheduled()).toEqual([]);
    });

    it('10. without credits for its agent, the step never reaches the write', async () => {
      const w = await world({ credits: 0 });
      const plan = await runToEnd(w);
      const child = await w.childOf(plan, 'prepare');
      expect(child.status).toBe('failed');
      expect(child.nodes.find((n) => n.id === 'schedule')?.status).not.toBe('completed');
      expect(w.providerCalls).toHaveLength(0);
      expect(await w.scheduled()).toEqual([]);
    });

    it("11. another organization's contact is never written, even approved", async () => {
      const w = await world();
      const plan = await runToEnd(w, 'run-1', stepsFor(w.carla.id));
      const child = await w.childOf(plan, 'prepare');
      expect(child.status).toBe('failed');
      expect(child.nodes.find((n) => n.id === 'schedule')?.error?.code).toBe('contact_not_found');
      expect(await w.scheduled()).toEqual([]);
      expect(await w.scheduled(w.tenantB)).toEqual([]);
    });

    it('14, 15. a write that fails stops its own branch; once the cause is gone, running again writes it once', async () => {
      const w = await world();
      // The follow-up's queue is down: the service refuses and writes nothing.
      w.setHook(async () => {
        throw new ConversationError('follow_up_scheduler_unavailable');
      });
      const first = await runToEnd(w);
      // Its branch failed; the plan ends with the other branch done and the failure shown.
      expect(first.status).toBe('completed');
      const child = await w.childOf(first, 'prepare');
      expect(child.status).toBe('failed');
      expect(child.nodes.find((n) => n.id === 'schedule')?.error?.code).toBe(
        'follow_up_scheduler_unavailable',
      );
      // The note after the write never ran; the other branch did.
      expect((await w.stored(first.id)).delegations.some((d) => d.stepId === 'note')).toBe(true);
      expect((await w.childOf(first, 'note')).startedAt).toBeUndefined();
      expect((await w.childOf(first, 'week')).status).toBe('completed');
      expect(await w.scheduled()).toEqual([]);
      // Tried twice (one runtime retry under its key, ADR-0029), audited each time, written never.
      const failed = (await w.stores.events()).filter(
        (e) => e.action === 'tool.execution_failed' && e.target?.id === child.id,
      );
      expect(failed.map((e) => e.reason)).toEqual([
        'follow_up_scheduler_unavailable',
        'follow_up_scheduler_unavailable',
      ]);

      // The queue is back: Alice runs the workflow again, and the follow-up is written once.
      w.setHook(undefined);
      const again = await runToEnd(w, 'run-2');
      expect(again.status).toBe('completed');
      expect(await w.scheduled()).toHaveLength(1);
      expect((await w.childOf(again, 'note')).status).toBe('completed');
    });
  },
);
