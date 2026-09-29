import type { Firestore } from '@google-cloud/firestore';
import {
  InMemoryAgentTaskRepository,
  parseAgentAnswer,
  type AgentTaskRepository,
} from '@melonoffice/agents';
import {
  createModelPolicyCatalogue,
  createProviderRegistry,
  CREDIT_RATE,
  type AICreditsPort,
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
import { InMemoryApprovalRepository } from '@melonoffice/approvals';
import { createAuditService, InMemoryAuditStore, type AuditEvent } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { InMemoryKnowledgeRepository, type KnowledgeRepository } from '@melonoffice/brain';
import {
  InMemoryConversationRepository,
  type ConversationRepository,
} from '@melonoffice/conversations';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  ExecutionId,
  InitialBilling,
  JobId,
  Organization,
  Plan,
  Specialist,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import {
  createAgentOutputStore,
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
  FirestoreDepartmentRepository,
  FirestoreExecutionRepository,
  FirestoreJobRepository,
  FirestoreKnowledgeRepository,
  FirestorePlanRepository,
  FirestoreSpecialistRepository,
  FirestoreTenancyStore,
  fromAuditDocument,
  type AuditDocument,
} from '@melonoffice/firestore';
import { emulatorFirestore, emulatorHost } from '@melonoffice/firestore/testing';
import { InMemoryJobRepository, isJobError } from '@melonoffice/jobs';
import {
  createDelegation,
  createPlanConductor,
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
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import { createToolRegistry, TOOL_CATALOGUE } from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';
import { createAgentTaskParts, createConversationAgentParts, routeAgentWork } from './agents.js';
import { createPlanConditions } from './conditions.js';
import { createWorkerRuntime, type WorkerStores } from './runtime.js';

/**
 * WF-1 (ADR-0070): a person approves a plan and it runs end to end on the real engines. Each
 * specialist step is its own child execution run by the worker's runtime; its agent's model is
 * reached only through the AI Gateway (a fake Vertex AI adapter behind the real policy and
 * credits); a step reads the answers of the steps before it; and the plan conductor starts the
 * next step when one ends, then closes the plan. In memory and on the emulator.
 */

const T0 = new Date('2026-09-29T12:00:00Z');
const LEASE_MS = 60_000;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;

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

const answer = (structured: unknown): ProviderOutcome => ({
  status: 'success',
  output: { structured },
  usage: { inputTokens: 700, outputTokens: 80 },
  finishReason: 'stop',
  providerRequestId: 'vertex-req-1',
});
const GOOD = answer({
  answer: 'El Combo Familiar cuesta S/ 25. Sugiero ofrecerlo a clientes que piden para cuatro.',
  missing: ['Margen del Combo Familiar'],
});

type Stores = WorkerStores & {
  readonly conversations: ConversationRepository;
  readonly outputs: AgentOutputRepository;
  readonly tasks: AgentTaskRepository;
  readonly knowledge: KnowledgeRepository;
  readonly plans: PlanRepository;
  readonly events: () => Promise<readonly AuditEvent[]>;
};

function memoryStores(now: () => Date): Stores {
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  return {
    tenancy: new InMemoryTenancyStore(now, audit, undefined, departments),
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

describe.each(STORES)(
  'WF-1 an approved plan runs, with storage in %s',
  (_storage, createStores) => {
    async function world() {
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
      const orgA = a.organization.id;
      const authorization = createAuthorizationService();
      const audit = createAuditService(stores.audit, now);
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
        tools: () => undefined,
        now,
      });

      const providerCalls: ProviderCall[] = [];
      let modelAnswers: (() => Promise<ProviderOutcome>)[] = [];
      const vertex = {
        providerId: VERTEX_AI_PROVIDER_ID,
        adapterVersion: 'vertex-test-1',
        capabilities: () => VERTEX_AI_PROVIDER.capabilities,
        health: async () => 'available' as const,
        async generate(call: ProviderCall): Promise<ProviderOutcome> {
          providerCalls.push(call);
          const next = modelAnswers.shift();
          return next === undefined ? GOOD : next();
        },
      };
      const credits: AICreditsPort = {
        async balanceOf() {
          return { status: 'present', balance: 1_000 };
        },
        async consume() {
          return { balance: 1_000, replayed: false };
        },
        async refund() {
          throw new Error('not used');
        },
      };

      // The worker's composition, as in production: the plan steps are routed like tasks, and the
      // runtime tells the plan conductor when a step ends.
      const conversation = createConversationAgentParts({ stores, now });
      const routed = routeAgentWork(
        conversation,
        createAgentTaskParts({
          stores: {
            tenancy: stores.tenancy,
            specialists: stores.specialists,
            tasks: stores.tasks,
            knowledge: stores.knowledge,
            outputs: stores.outputs,
            plans: stores.plans,
          },
          now,
        }),
      );
      const dispatched: JobId[] = [];
      const { jobs, runtime } = createWorkerRuntime({
        stores,
        environment: 'dev',
        leaseMs: LEASE_MS,
        tools: { registry: createToolRegistry(TOOL_CATALOGUE), executors: conversation.executors },
        ai: createProviderRegistry({
          providers: [VERTEX_AI_PROVIDER],
          models: VERTEX_AI_MODELS,
          adapters: [vertex],
        }),
        credits: { port: credits, rate: CREDIT_RATE },
        policies: createModelPolicyCatalogue([
          { ...CONVERSATION_AGENT_POLICY, backoffMs: 0 },
          { ...AGENT_TASK_POLICY, backoffMs: 0 },
        ]),
        work: routed.work,
        verifier: routed.verifier,
        outputs: conversation.outputs,
        onStopped: routed.onStopped,
        plans: stores.plans,
        conditions: createPlanConditions({
          stores: { tenancy: stores.tenancy, knowledge: stores.knowledge, audit: stores.audit },
          // A skill that lets agents propose a discount (ADR-0083): none in code grants it yet.
          skills: createSkillCatalogue([
            {
              id: 'offers',
              version: 1,
              nameKey: 'fixture',
              descriptionKey: 'fixture',
              tools: [],
              actions: ['opportunity.offer_discount'],
              reads: [],
            } as never,
          ]),
          now,
        }),
        dispatcher: { dispatch: async (id) => void dispatched.push(id) },
        now,
      });

      // The API's side: plans, their approval, and the conductor that runs one once approved.
      const executions = createExecutionService({
        repository: stores.executions,
        organizations: stores.tenancy,
        assignments: specialists.assignments,
        authorization,
        audit,
        now,
      });
      const plans = createPlanService({
        repository: stores.plans,
        executions,
        validator: createPlanValidator({
          specialists,
          departments: stores.departments,
          tools: createToolRegistry(TOOL_CATALOGUE),
          authorization,
          environment: undefined,
        }),
        organizations: stores.tenancy,
        authorization,
        audit,
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
            await executions.start(tenant, executionId);
            await runtime.kickoff(tenant, executionId);
          },
        },
        now,
      });

      const tenantA = await resolveTenant(as(ALICE), orgA, stores.tenancy);

      async function agent(templateId = 'commercial'): Promise<Specialist> {
        const created = await management.create(tenantA, { templateId, displayName: 'Lucía' });
        return management.setStatus(tenantA, created.identity.id, { from: 'draft', to: 'active' });
      }

      /**
       * A plan of two steps by `s`, the second after the first, proposed and approved by Alice.
       * With `continueOn`, a condition between them asks the Decision Engine whether an agent may
       * prepare a discount (WF-4), and the second step waits on it.
       */
      async function approvedPlan(s: Specialist, continueOn?: string[]): Promise<Plan> {
        const planning = await executions.create(tenantA, {
          mode: 'plan',
          input: { type: 'task', id: 'market-study' },
          specialistId: s.identity.id,
          specialistVersion: s.version,
          departmentId: s.configuration.departmentId,
          versionSnapshot: {
            schemaVersion: 1,
            components: [{ kind: 'specialist', id: s.identity.id, version: String(s.version) }],
          },
        });
        await executions.changeStatus(tenantA, planning.id, { from: 'pending', to: 'planning' });
        const verification = {
          policy: 'output_schema',
          expectedOutput: 'answer',
          requiredChecks: ['agent_answer_valid'],
        };
        const outcome = await plans.propose(tenantA, {
          executionId: planning.id,
          proposal: {
            summary: 'Plan de ventas',
            objective: 'Preparar la campaña del Combo Familiar',
            steps: [
              {
                id: 'research',
                kind: 'specialist',
                label: 'Revisar precios del Combo Familiar',
                dependsOn: [],
                specialistId: s.identity.id,
                verification,
                approvalRequired: true,
              },
              ...(continueOn === undefined
                ? []
                : [
                    {
                      id: 'gate',
                      kind: 'condition',
                      label: '¿Puede ofrecer un descuento?',
                      dependsOn: ['research'],
                      decision: {
                        decision: 'action.policy_check',
                        continueOn,
                        input: { action: 'opportunity.offer_discount', proposer: 'agent' },
                      },
                    },
                  ]),
              {
                id: 'pitch',
                kind: 'specialist',
                label: 'Escribir el mensaje de venta',
                dependsOn: [continueOn === undefined ? 'research' : 'gate'],
                specialistId: s.identity.id,
                verification,
              },
            ],
          },
          source: {
            kind: 'planner',
            model: { provider: 'vertex_ai', id: 'gemini', version: 'v' },
            policy: { id: 'default_model', version: 1 },
          },
        });
        if (outcome.status !== 'planned') throw new Error(`refused: ${outcome.reason}`);
        const version = must(
          await stores.plans.findVersion(orgA, outcome.plan.id, outcome.plan.version),
        );
        return plans.approve(tenantA, outcome.plan.id, {
          version: version.version,
          digest: version.digest,
        });
      }

      async function drive(limit = 20): Promise<void> {
        for (let i = 0; i < limit && dispatched.length > 0; i += 1) {
          const jobId = dispatched.shift() as JobId;
          let claim;
          try {
            claim = await jobs.acquire(jobId, 'worker-1');
          } catch (error) {
            if (isJobError(error)) continue;
            throw error;
          }
          await runtime.advance(claim.lease);
        }
      }

      const stored = async (id: string) => must(await stores.plans.find(orgA, id as Plan['id']));
      const childOf = (plan: Plan, stepId: string): ExecutionId =>
        must(plan.delegations.find((d) => d.stepId === stepId)).executionId;

      return {
        stores,
        tenantA,
        executions,
        conductor,
        providerCalls,
        dispatched,
        agent,
        approvedPlan,
        drive,
        stored,
        childOf,
        outputs: createAgentOutputStore(stores.outputs),
        promptOf: (call: ProviderCall | undefined) => JSON.stringify(call?.messages ?? []),
        setModel: (...next: (() => Promise<ProviderOutcome>)[]) => {
          modelAnswers = next;
        },
      };
    }

    it('1. runs each step in order, the second reading the first answer, and closes the plan', async () => {
      const w = await world();
      const lucia = await w.agent();
      const plan = await w.approvedPlan(lucia);
      expect(plan.status).toBe('approved');
      const running = await w.conductor.run(w.tenantA, plan.id);
      expect(running.status).toBe('executing');
      expect(w.dispatched).toHaveLength(1);

      await w.drive();

      const done = await w.stored(plan.id);
      expect(done.status).toBe('completed');
      const parent = await w.executions.get(w.tenantA, done.executionId);
      expect(parent).toMatchObject({ status: 'completed', verification: { result: 'passed' } });
      for (const step of ['research', 'pitch']) {
        const child = await w.executions.get(w.tenantA, w.childOf(done, step));
        expect(child).toMatchObject({ status: 'completed', verification: { result: 'passed' } });
        const record = await w.outputs.find(w.tenantA, child.id, step);
        expect(parseAgentAnswer(must(record).output)?.answer).toContain('Combo Familiar');
      }
      // Two model calls, in order: the second step was given the first one's answer, as data.
      expect(w.providerCalls).toHaveLength(2);
      expect(w.promptOf(w.providerCalls[0])).toContain('Revisar precios del Combo Familiar');
      const second = w.promptOf(w.providerCalls[1]);
      expect(second).toContain('Escribir el mensaje de venta');
      expect(second).toContain(
        'Revisar precios del Combo Familiar: El Combo Familiar cuesta S/ 25',
      );
      const events = await w.stores.events();
      expect(
        events
          .filter((e) => e.action === 'plan.state_changed')
          .map((e) => `${e.transition?.from}>${e.transition?.to}`),
      ).toEqual(['approved>executing', 'executing>completed']);
    });

    it('2. a step whose answer fails verification stops the plan: the next step never runs', async () => {
      const w = await world();
      const lucia = await w.agent();
      w.setModel(async () => answer({ wrong: 'shape' }));
      const plan = await w.approvedPlan(lucia);
      await w.conductor.run(w.tenantA, plan.id);
      await w.drive();

      const stopped = await w.stored(plan.id);
      expect(stopped.status).toBe('failed');
      expect((await w.executions.get(w.tenantA, stopped.executionId)).status).toBe('failed');
      expect((await w.executions.get(w.tenantA, w.childOf(stopped, 'research'))).status).toBe(
        'failed',
      );
      expect((await w.executions.get(w.tenantA, w.childOf(stopped, 'pitch'))).status).toBe(
        'pending',
      );
      expect(w.providerCalls).toHaveLength(1);
    });
    it('3. a condition the Decision Engine allows lets the next step run (WF-4)', async () => {
      const w = await world();
      const lucia = await w.agent();
      const plan = await w.approvedPlan(lucia, ['allowed']);
      await w.conductor.run(w.tenantA, plan.id);
      await w.drive();

      const done = await w.stored(plan.id);
      expect(done.status).toBe('completed');
      expect(done.conditions).toEqual([
        expect.objectContaining({
          stepId: 'gate',
          result: 'continue',
          decision: expect.objectContaining({ type: 'action.policy_check', outcome: 'allowed' }),
        }),
      ]);
      expect(w.providerCalls).toHaveLength(2);
      // The step after the condition reads the answer of the step before the condition.
      expect(w.promptOf(w.providerCalls[1])).toContain(
        'Revisar precios del Combo Familiar: El Combo Familiar cuesta S/ 25',
      );
      const parent = await w.executions.get(w.tenantA, done.executionId);
      expect(parent.nodes.map((n) => `${n.id}:${n.status}`)).toEqual([
        'research:completed',
        'gate:completed',
        'pitch:completed',
      ]);
      const events = await w.stores.events();
      const decision = events.find((e) => e.action === 'decision.evaluated');
      expect(decision).toMatchObject({ result: 'success', reason: 'allowed' });
      expect(events.find((e) => e.action === 'plan.condition_evaluated')).toMatchObject({
        nodeId: 'gate',
        reason: 'continue',
        reference: decision?.target?.id,
      });
    });

    it('4. a condition that stops skips the step after it, and the plan closes (WF-4)', async () => {
      const w = await world();
      const lucia = await w.agent();
      const plan = await w.approvedPlan(lucia, ['approval_required']);
      await w.conductor.run(w.tenantA, plan.id);
      await w.drive();

      const done = await w.stored(plan.id);
      expect(done.status).toBe('completed');
      expect(done.conditions?.[0]).toMatchObject({ result: 'stop' });
      // Only the first step asked the model: the skipped one never started.
      expect(w.providerCalls).toHaveLength(1);
      expect((await w.executions.get(w.tenantA, w.childOf(done, 'pitch'))).status).toBe('pending');
      const parent = await w.executions.get(w.tenantA, done.executionId);
      expect(parent.status).toBe('completed');
      expect(parent.nodes.map((n) => `${n.id}:${n.status}`)).toEqual([
        'research:completed',
        'gate:completed',
        'pitch:skipped',
      ]);
    });
  },
);
