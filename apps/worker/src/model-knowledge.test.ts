import type { Firestore } from '@google-cloud/firestore';
import {
  createAgentTaskService,
  InMemoryAgentTaskRepository,
  MODEL_KNOWLEDGE_DESCRIPTION,
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
import {
  createCompanyBrain,
  InMemoryKnowledgeRepository,
  type KnowledgeRepository,
} from '@melonoffice/brain';
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
  Execution,
  InitialBilling,
  JobId,
  Organization,
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
  FirestoreSpecialistRepository,
  FirestoreTenancyStore,
  fromAuditDocument,
  type AuditDocument,
} from '@melonoffice/firestore';
import { emulatorFirestore, emulatorHost } from '@melonoffice/firestore/testing';
import { harnessTaskPolicy } from '@melonoffice/harness';
import { InMemoryJobRepository, isJobError } from '@melonoffice/jobs';
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
import { createWorkerRuntime, type WorkerStores } from './runtime.js';

/**
 * `knowledge_search@1` (RT-1, ADR-0130): an agent a person moved to company_knowledge@3 searches
 * the company memory in the middle of a task. The Harness classes it A (it only reads), so it runs
 * through the Tool Gate without a person, at every level of autonomy, and the next turn reads its
 * result. The worker's real composition: the real catalogue, skills, gate, Company Brain and
 * gateway, with a fake Vertex AI adapter. In memory and on the emulator.
 */

const T0 = new Date('2026-10-03T12:00:00Z');
const LEASE_MS = 60_000;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;

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

const price = (soles: number) => ({
  domain: 'products',
  key: 'price',
  subject: { type: 'product', id: 'combo_familiar' },
  label: 'Combo Familiar',
  value: { type: 'money', amountMinor: soles * 100, currency: 'PEN' },
});

/** The model asks for these searches. */
const searches = (...queries: unknown[]): ProviderOutcome => ({
  status: 'success',
  output: {
    toolCalls: queries.map((args, i) => ({
      id: `call_${i}`,
      name: 'knowledge_search',
      arguments: args as Record<string, unknown>,
    })),
  },
  usage: { inputTokens: 600, outputTokens: 30 },
  finishReason: 'tool_use',
  providerRequestId: 'vertex-tools',
});

const answers = (answer: string): ProviderOutcome => ({
  status: 'success',
  output: { text: JSON.stringify({ answer, missing: [] }) },
  usage: { inputTokens: 700, outputTokens: 60 },
  finishReason: 'stop',
  providerRequestId: 'vertex-answer',
});

type Stores = WorkerStores & {
  readonly conversations: ConversationRepository;
  readonly outputs: AgentOutputRepository;
  readonly tasks: AgentTaskRepository;
  readonly knowledge: KnowledgeRepository;
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

describe.each(STORES)(
  'knowledge_search@1 mid-task, storage in %s (ADR-0130)',
  (_s, createStores) => {
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
      const b = await createOrganization(as(BOB), { name: 'Empresa B' }, stores.tenancy, {
        billing: BILLING,
        credits: openWallet,
        departments: provision,
      });
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

      const providerCalls: ProviderCall[] = [];
      let script: ProviderOutcome[] = [];
      const vertex = {
        providerId: VERTEX_AI_PROVIDER_ID,
        adapterVersion: 'vertex-test-1',
        capabilities: () => VERTEX_AI_PROVIDER.capabilities,
        health: async () => 'available' as const,
        async generate(call: ProviderCall): Promise<ProviderOutcome> {
          providerCalls.push(call);
          const next = script.shift();
          if (next === undefined) throw new Error('the model was not expected to be called');
          return next;
        },
      };
      let balance = 1_000;
      const credits: AICreditsPort = {
        async balanceOf() {
          return { status: 'present', balance };
        },
        async consume(_tenant, { amount }) {
          balance -= amount;
          return { balance, replayed: false };
        },
        async refund() {
          throw new Error('not used');
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
        },
        tools: { registry, executors: Object.keys(conversation.executors) },
        now,
      });
      const routed = routeAgentWork(conversation, taskParts);
      const dispatched: JobId[] = [];
      const { jobs, runtime } = createWorkerRuntime({
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
        toolLoop: routed.toolLoop,
        ...(taskParts.onEnded === undefined ? {} : { onEnded: taskParts.onEnded }),
        dispatcher: { dispatch: async (id) => void dispatched.push(id) },
        now,
      });
      const executions = createExecutionService({
        repository: stores.executions,
        organizations: stores.tenancy,
        assignments: specialists.assignments,
        authorization,
        audit,
        now,
      });
      const tasks = createAgentTaskService({
        tasks: stores.tasks,
        specialists: stores.specialists,
        executions,
        authorization,
        runtime,
        now,
      });

      const tenantA = await resolveTenant(as(ALICE), a.organization.id, stores.tenancy);
      const tenantB = await resolveTenant(as(BOB), b.organization.id, stores.tenancy);

      /**
       * An active agent of Alice's from a template, moved to company_knowledge@3 by default. The
       * research agent: a commercial agent still on customer_follow_up@2 has the ADR-0084 schedule
       * step, and such tasks are offered no tools (ADR-0103).
       */
      async function agent(
        templateId = 'research',
        upgrade = true,
        autonomy?: 'propose' | 'within_policy',
      ): Promise<Specialist> {
        let current = await management.create(tenantA, { templateId, displayName: 'Lucía' });
        if (upgrade) {
          current = await management.upgradeSkill(tenantA, current.identity.id, {
            fromVersion: current.version,
            skillId: 'company_knowledge',
            version: 3,
          });
        }
        if (autonomy !== undefined) {
          current = await management.setAutonomy(tenantA, current.identity.id, {
            fromVersion: current.version,
            autonomy,
          });
        }
        return management.setStatus(tenantA, current.identity.id, { from: 'draft', to: 'active' });
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

      async function run(model: ProviderOutcome[], who: Specialist): Promise<Execution> {
        script = [...model];
        const asked = await tasks.assign(tenantA, who.identity.id, {
          request: 'Prepara una oferta para un cliente que pide para cuatro personas',
        });
        await drive();
        return executions.get(tenantA, asked.task.id);
      }

      const toolResultsOf = (call: ProviderCall | undefined) =>
        (call?.messages ?? []).flatMap((m) =>
          m.content.flatMap((p) => (p.type === 'tool_result' ? [p] : [])),
        );

      return {
        stores,
        brain,
        tenantA,
        tenantB,
        providerCalls,
        outputs: createAgentOutputStore(stores.outputs),
        agent,
        run,
        toolResultsOf,
      };
    }

    it('1. searched mid-task without a person: the next turn reads its own organization’s facts', async () => {
      const w = await world();
      await w.brain.propose(w.tenantA, price(25));
      await w.brain.propose(w.tenantB, price(99));
      const lucia = await w.agent();
      const execution = await w.run(
        [
          searches({ query: 'Combo Familiar precio' }),
          answers('Ofrécele el Combo Familiar a S/ 25.'),
        ],
        lucia,
      );
      // Offered exactly this tool, described as a read whose results are data.
      const first = must(w.providerCalls[0]);
      expect(first.tools?.map((t) => [t.name, t.description])).toEqual([
        ['knowledge_search', MODEL_KNOWLEDGE_DESCRIPTION],
      ]);
      // Level A: it ran at once, with no approval, and the task went on to its answer.
      expect(execution.status).toBe('completed');
      expect(execution.verification?.result).toBe('passed');
      expect(execution.nodes.map((n) => `${n.id}:${n.status}`)).toEqual([
        'work:completed',
        'work_t0:completed',
        'work_turn2:completed',
      ]);
      const node = must(execution.nodes.find((n) => n.id === 'work_t0'));
      expect(node).toMatchObject({ tool: { id: 'knowledge_search', version: 1 } });
      expect(node.approvalId).toBeUndefined();
      expect(node.approvalRequired).toBeUndefined();
      const results = w.toolResultsOf(w.providerCalls[1]).map((p) => p.result);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ available: true, truncated: false });
      const facts = (results[0] as { facts: { label: string; value: string }[] }).facts;
      expect(facts.map((f) => f.label)).toEqual(['Combo Familiar']);
      expect(JSON.stringify(results)).toContain('25');
      expect(JSON.stringify(results)).not.toContain('99');
      const answer = await w.outputs.find(w.tenantA, execution.id, 'work_turn2');
      expect(parseAgentAnswer(must(answer).output)?.answer).toContain('S/ 25');
      // The gate recorded the call like any other tool, by the runtime for Alice.
      const events = await w.stores.events();
      const toolEvents = events.filter((e) => e.action.startsWith('tool.'));
      expect(toolEvents.map((e) => e.action)).toContain('tool.execution_completed');
      expect(
        toolEvents.every(
          (e) =>
            e.actor.type === 'system' &&
            e.actor.initiatedBy === ALICE &&
            e.tool?.id === 'knowledge_search',
        ),
      ).toBe(true);
      expect(events.some((e) => e.action.startsWith('approval.'))).toBe(false);
    });

    it('2. a read runs at every level of autonomy, even propose', async () => {
      const w = await world();
      await w.brain.propose(w.tenantA, price(25));
      const lucia = await w.agent('research', true, 'propose');
      const execution = await w.run(
        [searches({ query: 'combo' }), answers('El combo cuesta S/ 25.')],
        lucia,
      );
      expect(execution.status).toBe('completed');
      expect(must(execution.nodes.find((n) => n.id === 'work_t0')).approvalId).toBeUndefined();
    });

    it('3. an agent a person did not move to company_knowledge@3 is not offered it, and asking anyway runs nothing', async () => {
      const w = await world();
      await w.brain.propose(w.tenantA, price(25));
      const legacy = await w.agent('marketing', false);
      const execution = await w.run([searches({ query: 'combo' })], legacy);
      expect(w.providerCalls[0]?.tools).toBeUndefined();
      expect(execution).toMatchObject({ status: 'failed', failure: { code: 'invalid_response' } });
      expect(execution.nodes.some((n) => n.type === 'tool')).toBe(false);
    });

    it('4. words the schema refuses never reach Company Brain: the gateway refuses the turn', async () => {
      const w = await world();
      const lucia = await w.agent();
      const execution = await w.run([searches({ query: 'combo', domain: 'finance' })], lucia);
      expect(execution).toMatchObject({ status: 'failed', failure: { code: 'invalid_response' } });
      expect(execution.nodes.some((n) => n.type === 'tool')).toBe(false);
    });

    it('5. a repeated search is one call', async () => {
      const w = await world();
      await w.brain.propose(w.tenantA, price(25));
      const lucia = await w.agent();
      const execution = await w.run(
        [searches({ query: 'combo' }, { query: 'combo' }), answers('S/ 25.')],
        lucia,
      );
      expect(execution.status).toBe('completed');
      expect(execution.nodes.filter((n) => n.type === 'tool').map((n) => n.id)).toEqual([
        'work_t0',
      ]);
      // Both calls read the same result.
      expect(w.toolResultsOf(w.providerCalls[1])).toHaveLength(2);
    });
  },
);

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('missing value');
  return value;
}
