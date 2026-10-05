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
  PLAN_STEP_APPROVAL_TTL_SECONDS,
} from '@melonoffice/approvals';
import { createAuditService, InMemoryAuditStore, type AuditEvent } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import {
  createCompanyBrain,
  InMemoryKnowledgeRepository,
  type KnowledgeRepository,
} from '@melonoffice/brain';
import {
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
  createPlanConductor,
  createPlanService,
  createPlanStepAttempts,
  createPlanValidator,
  InMemoryPlanRepository,
  planStepOf,
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
  createWorkflowService,
  InMemoryWorkflowRepository,
  type WorkflowRepository,
} from '@melonoffice/workflows';
import { describe, expect, it } from 'vitest';
import { createAgentTaskParts, createConversationAgentParts, routeAgentWork } from './agents.js';
import { createWorkerRuntime, type WorkerStores } from './runtime.js';

/**
 * A workflow a person saved runs end to end (Block 4, ADR-0178), on the engines that already
 * exist and nothing else: the workflow becomes a plan its person approves, each step binds to the
 * real agent of its role, the agent's step reaches its model only through the AI Gateway (a fake
 * Vertex AI adapter behind the real policies and the real Credit Core), its tool step runs
 * through the Tool Gate, a wait wakes the plan, a step marked "ask me first" waits for a person,
 * a declined step skips its branch while the others go on, and the plan ends where the engine
 * says. In memory and on the emulator.
 */

const T0 = new Date('2026-10-05T12:00:00Z');
const LEASE_MS = 60_000;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const WAIT_SECONDS = 3_600;
const CREDITS = 100;

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
const UNAVAILABLE: ProviderOutcome = { status: 'error', kind: 'server_error', httpStatus: 503 };

const VERIFICATION = {
  policy: 'output_schema',
  expectedOutput: 'agent_answer',
  requiredChecks: [],
};
const RESEARCHER = { departmentTypeId: 'research', roleId: 'research_agent' };

/**
 * The workflow: the agent reviews what the company knows and then searches its memory (a tool
 * step); after a wait, it prepares the offer, which asks the person first. Another branch after
 * the research prepares a brief, also asked first, and a note after it. A first step never asks
 * again: the plan's own approval comes right before it (ADR-0146).
 */
const STEPS = [
  {
    id: 'research',
    kind: 'specialist',
    label: 'Revisar lo que sabemos del Combo Familiar',
    dependsOn: [],
    assignee: RESEARCHER,
    verification: VERIFICATION,
  },
  {
    id: 'search',
    kind: 'tool',
    label: 'Buscar el precio en la memoria',
    dependsOn: ['research'],
    performedBy: 'research',
    tool: { id: 'knowledge_search', version: 1 },
    input: { query: 'Combo Familiar' },
  },
  {
    id: 'pause',
    kind: 'wait',
    label: 'Esperar una hora',
    dependsOn: ['research'],
    wait: { seconds: WAIT_SECONDS },
  },
  {
    id: 'offer',
    kind: 'specialist',
    label: 'Preparar la oferta',
    dependsOn: ['pause'],
    assignee: RESEARCHER,
    verification: VERIFICATION,
    approvalRequired: true,
  },
  {
    id: 'brief',
    kind: 'specialist',
    label: 'Preparar un resumen para el equipo',
    dependsOn: ['research'],
    assignee: RESEARCHER,
    verification: VERIFICATION,
    approvalRequired: true,
  },
  {
    id: 'note',
    kind: 'specialist',
    label: 'Dejar una nota con el resumen',
    dependsOn: ['brief'],
    assignee: RESEARCHER,
    verification: VERIFICATION,
  },
];

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

describe.each(STORES)(
  'a saved workflow runs end to end, with storage in %s (ADR-0178)',
  (_storage, createStores) => {
    async function world(steps: readonly unknown[] = STEPS) {
      let clock = new Date(T0);
      const now = () => {
        clock = new Date(clock.getTime() + 1);
        return clock;
      };
      const later = (seconds: number) => {
        clock = new Date(clock.getTime() + seconds * 1_000);
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
      const brain = createCompanyBrain({
        repository: stores.knowledge,
        organizations: stores.tenancy,
        authorization,
        now,
      });
      // The real Credit Core: every model call holds its most, then settles what it cost.
      const credits = createCreditService({
        store: stores.credits,
        organizations: stores.tenancy,
        now,
      });

      const providerCalls: ProviderCall[] = [];
      let script: ProviderOutcome[] = [];
      const vertex = {
        providerId: VERTEX_AI_PROVIDER_ID,
        adapterVersion: 'vertex-test-1',
        capabilities: () => VERTEX_AI_PROVIDER.capabilities,
        health: async () => 'available' as const,
        async generate(call: ProviderCall): Promise<ProviderOutcome> {
          providerCalls.push(call);
          return script.shift() ?? answer('Listo: el Combo Familiar cuesta S/ 25.');
        },
      };

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
        now,
      });
      const routed = routeAgentWork(conversation, taskParts);
      const dispatched: JobId[] = [];
      // What the plan asked Cloud Tasks to do: wake it at a time (ADR-0152).
      const wakes: { planId: string; at: Date }[] = [];
      const wakeups = {
        async wake(_tenant: unknown, plan: { planId: string }, at: Date) {
          wakes.push({ planId: plan.planId, at });
        },
      };
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
      const { jobs, runtime } = worker;

      // The API's side: workflows, plans, approvals, and the conductor a person's approval runs.
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
      const approvals = createApprovalService({
        repository: stores.approvals,
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
          // A person's approval starts it as them; a decision resumes it as its runtime.
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
      await credits.grant(tenantA, {
        amount: CREDITS,
        referenceId: `test-grant:${orgA}`,
        reason: 'test_grant',
      });
      // What the company memory knows, and a credential someone pasted into it.
      await brain.propose(tenantA, {
        domain: 'products',
        key: 'price',
        subject: { type: 'product', id: 'combo_familiar' },
        label: 'Combo Familiar',
        value: { type: 'money', amountMinor: 2_500, currency: 'PEN' },
      });

      // The research agent, moved to company_knowledge@3 so it holds knowledge_search.
      let lucia: Specialist = await management.create(tenantA, {
        templateId: 'research',
        displayName: 'Lucía',
      });
      lucia = await management.upgradeSkill(tenantA, lucia.identity.id, {
        fromVersion: lucia.version,
        skillId: 'company_knowledge',
        version: 3,
      });
      await management.setStatus(tenantA, lucia.identity.id, {
        from: 'draft',
        to: 'active',
      });

      /** Saved, activated and planned by Alice, then approved by her: the plan starts. */
      async function started(): Promise<Plan> {
        const saved = await workflows.create(tenantA, { name: 'Oferta del Combo', steps });
        await workflows.changeStatus(tenantA, saved.id, { from: 'draft', to: 'active' });
        const planned = await workflows.plan(tenantA, saved.id, { requestKey: 'run-1' });
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
            claim = await jobs.acquire(jobId, 'worker-1');
          } catch (error) {
            if (isJobError(error)) continue;
            throw error;
          }
          await runtime.advance(claim.lease);
        }
      }

      /** The worker's wake-up route (`POST /internal/plans/wake`): the plan goes on. */
      async function wake(planId: string): Promise<Plan> {
        const advance = must(worker.advancePlan);
        await advance(runtimeA, planId as Plan['id']);
        return stored(planId);
      }

      /** A person decided a step: the API resumes the plan as its runtime (ADR-0146). */
      async function decide(planId: string, stepId: string, decision: 'approve' | 'reject') {
        const pending = (await approvals.list(tenantA)).find(
          (x) => x.status === 'pending' && x.operation.nodeId === stepId,
        );
        const approval = must(pending);
        if (decision === 'approve') await approvals.approve(tenantA, approval.id);
        else await approvals.reject(tenantA, approval.id);
        await conductor.resume(runtimeA, planId);
        return approval;
      }

      const stored = async (id: string) => must(await stores.plans.find(orgA, id as Plan['id']));
      const childOf = (plan: Plan, stepId: string) =>
        must(plan.delegations.find((d) => d.stepId === stepId)).executionId;
      const wallet = async () => must(await stores.credits.findWallet(orgA));

      return {
        stores,
        orgA,
        tenantA,
        tenantB,
        runtimeA,
        executions,
        approvals,
        conductor,
        providerCalls,
        wakes,
        dispatched,
        started,
        drive,
        wake,
        decide,
        later,
        stored,
        childOf,
        wallet,
        outputs: createAgentOutputStore(stores.outputs),
        promptOf: (call: ProviderCall | undefined) => JSON.stringify(call?.messages ?? []),
        setModel: (...next: ProviderOutcome[]) => {
          script = [...next];
        },
      };
    }

    it('1. runs every step kind once, pauses for people and time, and ends completed', async () => {
      const w = await world();
      const plan = await w.started();
      expect(plan.status).toBe('executing');
      // The first step runs at once: Alice's approval of the plan was the one right before it.
      expect(w.dispatched).toHaveLength(1);
      expect(await w.approvals.list(w.tenantA)).toEqual([]);

      await w.drive();
      let now = await w.stored(plan.id);
      // Once it is done, the brief waits for Alice.
      expect((await w.approvals.list(w.tenantA)).filter((x) => x.status === 'pending')).toEqual([
        expect.objectContaining({ operation: expect.objectContaining({ nodeId: 'brief' }) }),
      ]);
      // The research ran with its tool step: the agent once, then knowledge_search by the Gate.
      const research = await w.executions.get(w.tenantA, w.childOf(now, 'research'));
      expect(research.status).toBe('completed');
      expect(research.nodes.map((n) => `${n.id}:${n.type}:${n.status}`)).toEqual([
        'research:agent:completed',
        'search:tool:completed',
      ]);
      expect(w.providerCalls).toHaveLength(1);
      // Its agent is the real one of its role.
      expect(planStepOf(research)?.stepId).toBe('research');
      // The wait started and asked to be woken when it ends, with its margin.
      expect(now.waits?.map((x) => x.stepId)).toEqual(['pause']);
      expect(w.wakes).toHaveLength(1);
      expect(w.wakes[0]?.at.getTime()).toBeGreaterThan(Date.parse(must(now.waits?.[0]).until) - 1);
      expect(now.status).toBe('executing');

      // Alice turns the brief down: its branch is skipped, the rest goes on.
      await w.decide(plan.id, 'brief', 'reject');
      now = await w.stored(plan.id);
      expect(now.status).toBe('executing');

      // Woken before the wait ends, nothing moves; once it ends, the offer asks Alice.
      await w.wake(plan.id);
      expect((await w.approvals.list(w.tenantA)).some((x) => x.operation.nodeId === 'offer')).toBe(
        false,
      );
      w.later(WAIT_SECONDS + 2);
      await w.wake(plan.id);
      const offerAsk = (await w.approvals.list(w.tenantA)).find(
        (x) => x.operation.nodeId === 'offer',
      );
      expect(offerAsk?.status).toBe('pending');
      expect(w.dispatched).toHaveLength(0);

      // Approved, the offer runs and reads the tool's result as data, cut and without secrets.
      await w.decide(plan.id, 'offer', 'approve');
      await w.drive();
      const done = await w.stored(plan.id);
      expect(done.status).toBe('completed');
      expect(w.providerCalls).toHaveLength(2);
      const offerPrompt = w.promptOf(w.providerCalls[1]);
      expect(offerPrompt).toContain('Preparar la oferta');
      expect(offerPrompt).toContain('Buscar el precio en la memoria: ');
      expect(offerPrompt).toContain('Combo Familiar');
      const context = offerPrompt.slice(
        offerPrompt.indexOf('<context>'),
        offerPrompt.indexOf('</context>'),
      );
      expect(context).toContain('Buscar el precio en la memoria');
      const offer = await w.outputs.find(w.tenantA, w.childOf(done, 'offer'), 'offer');
      expect(parseAgentAnswer(must(offer).output)?.answer).toContain('Combo Familiar');

      // The planning execution mirrors every step (a tool step runs inside its agent's child),
      // the declined branch skipped.
      const parent = await w.executions.get(w.tenantA, done.executionId);
      expect(parent.status).toBe('completed');
      expect(Object.fromEntries(parent.nodes.map((n) => [n.id, n.status]))).toEqual({
        research: 'completed',
        pause: 'completed',
        offer: 'completed',
        brief: 'skipped',
        note: 'skipped',
      });
      // The brief and its note never asked the model.
      expect(done.delegations.find((d) => d.stepId === 'note')).toBeDefined();
      expect(
        (await w.executions.get(w.tenantA, w.childOf(done, 'note'))).startedAt,
      ).toBeUndefined();

      // Credits: each model call held its most, then settled what it cost; nothing stays held.
      const wallet = await w.wallet();
      expect(wallet.holds ?? []).toEqual([]);
      const ledger = await w.stores.credits.ledger(w.orgA);
      const holds = ledger.filter((e) => e.type === 'hold');
      expect(holds).toHaveLength(2);
      const closes = ledger.filter((e) => e.referenceId.endsWith(':close'));
      expect(closes.map((e) => e.referenceId).sort()).toEqual(
        holds.map((e) => `${e.referenceId}:close`).sort(),
      );
      expect(wallet.balance).toBeLessThan(CREDITS);
      expect(wallet.balance).toBe(ledger.reduce((sum, e) => sum + e.amount, 0));

      // The audit trail: the plan, its steps, the agent's runs, the tool, the people, the end.
      const events = await w.stores.events();
      const actions = events.map((e) => e.action);
      for (const action of [
        'workflow.created',
        'plan.created',
        'plan.approved',
        'plan.step_approval_requested',
        'plan.step_declined',
        'plan.wait_started',
        'delegation.created',
        'tool.execution_requested',
        'tool.execution_completed',
        'execution.verification_recorded',
      ]) {
        expect(actions, action).toContain(action);
      }
      expect(
        events
          .filter((e) => e.action === 'plan.state_changed')
          .map((e) => `${e.transition?.from}>${e.transition?.to}`),
      ).toEqual(['approved>executing', 'executing>completed']);
      expect(events.find((e) => e.action === 'plan.step_declined')).toMatchObject({
        nodeId: 'brief',
        reason: 'rejected',
      });
      expect(
        events.filter(
          (e) =>
            e.action === 'execution.node_changed' &&
            e.target?.id === parent.id &&
            e.transition?.to === 'skipped',
        ),
      ).toHaveLength(2);
      // Everything the plan did was done as Alice, in her organization.
      for (const e of events.filter((x) => x.action.startsWith('plan.'))) {
        expect(e.organizationId).toBe(w.orgA);
      }

      // Asked again (a repeated wake, a repeated decision), nothing runs or is charged twice.
      const before = (await w.stores.credits.ledger(w.orgA)).length;
      await w.wake(plan.id);
      await w.conductor.resume(w.runtimeA, plan.id);
      await w.drive();
      expect(w.providerCalls).toHaveLength(2);
      expect((await w.stores.credits.ledger(w.orgA)).length).toBe(before);
      expect(
        (await w.stores.events()).filter(
          (e) => e.action === 'plan.state_changed' && e.transition?.to === 'completed',
        ),
      ).toHaveLength(1);
    });

    it('2. another organization can neither see, move nor decide the plan', async () => {
      const w = await world();
      const plan = await w.started();
      await w.drive();
      await expect(w.conductor.run(w.tenantB, plan.id)).rejects.toMatchObject({
        code: 'plan_not_found',
      });
      const brief = must(
        (await w.approvals.list(w.tenantA)).find((x) => x.operation.nodeId === 'brief'),
      );
      await expect(w.approvals.approve(w.tenantB, brief.id)).rejects.toBeDefined();
      expect((await w.approvals.list(w.tenantB)).length).toBe(0);
      expect((await w.approvals.get(w.tenantA, brief.id)).status).toBe('pending');
    });

    it('3. a step not approved in time is skipped with its branch, and the plan still ends', async () => {
      const w = await world();
      const plan = await w.started();
      await w.drive();
      await w.decide(plan.id, 'brief', 'approve');
      await w.drive();
      w.later(WAIT_SECONDS + 2);
      await w.wake(plan.id);
      // Nobody answers the offer's approval until it expires; the sweep looks at the plan again.
      w.later(PLAN_STEP_APPROVAL_TTL_SECONDS + 2);
      await w.wake(plan.id);
      const done = await w.stored(plan.id);
      expect(done.status).toBe('completed');
      const parent = await w.executions.get(w.tenantA, done.executionId);
      expect(Object.fromEntries(parent.nodes.map((n) => [n.id, n.status]))).toMatchObject({
        offer: 'skipped',
        brief: 'completed',
        note: 'completed',
      });
      const events = await w.stores.events();
      expect(events.find((e) => e.action === 'plan.step_declined')).toMatchObject({
        nodeId: 'offer',
        reason: 'expired',
      });
      // Research, brief and note asked the model; the offer never did.
      expect(w.providerCalls).toHaveLength(3);
    });

    it('4. a passing provider failure runs the step again; an answer that fails its check does not', async () => {
      const retried = [
        { ...STEPS[0], retry: { maxAttempts: 2, backoffMs: 1_000 } },
        STEPS[1],
      ] as const;
      const w = await world(retried);
      // Every call of the first attempt fails as the provider being down.
      w.setModel(UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE);
      const plan = await w.started();
      await w.drive();
      let now = await w.stored(plan.id);
      expect(now.attempts?.map((x) => x.stepId)).toEqual(['research']);
      w.setModel();
      w.later(2);
      await w.wake(plan.id);
      await w.drive();
      now = await w.stored(plan.id);
      expect(now.status).toBe('completed');
      const events = await w.stores.events();
      expect(events.filter((e) => e.action === 'plan.step_retried')).toEqual([
        expect.objectContaining({ nodeId: 'research', reason: 'server_error' }),
      ]);

      // A wrong answer is no passing failure: the same step is never asked again.
      const other = await world(retried);
      other.setModel({
        status: 'success',
        output: { structured: { wrong: 'shape' } },
        usage: { inputTokens: 700, outputTokens: 80 },
        finishReason: 'stop',
      });
      const failing = await other.started();
      await other.drive();
      other.later(2);
      await other.wake(failing.id);
      await other.drive();
      const ended = await other.stored(failing.id);
      expect(ended.status).toBe('failed');
      expect(ended.attempts ?? []).toEqual([]);
      expect(other.providerCalls).toHaveLength(1);
      // Its tool ran once, before the answer was checked, and never again.
      const tools = (await other.stores.events()).filter(
        (e) => e.action === 'tool.execution_requested',
      );
      expect(tools).toHaveLength(1);
      // Nothing stays held when a step fails.
      expect((await other.wallet()).holds ?? []).toEqual([]);
    });
  },
);
