import type { Firestore } from '@google-cloud/firestore';
import {
  contactRef,
  createAgentTaskService,
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
import { createApprovalService, InMemoryApprovalRepository } from '@melonoffice/approvals';
import { createAuditService, InMemoryAuditStore, type AuditEvent } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { InMemoryKnowledgeRepository, type KnowledgeRepository } from '@melonoffice/brain';
import {
  createCustomerService,
  createFollowUpService,
  InMemoryConversationRepository,
  type ConversationRepository,
  type FollowUpService,
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
import {
  harnessTaskPolicy,
  type HarnessLimits,
  DEFAULT_HARNESS_LIMITS,
} from '@melonoffice/harness';
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
 * `follow_up_schedule@3` (ADR-0104, Geovet 2026-09-30): the commercial agent asks, in the middle
 * of a task, to schedule a follow-up with one of the contacts it was shown, by reference. The
 * Harness decides with `authorizeToolUse` (level C), the Tool Gate asks a person, and only after
 * the approval does the server resolve the reference, check the tenant, the contact and the
 * follow-up service's rules, and schedule it; the task then continues from where it stopped.
 * Everything here is the worker's real composition: the real catalogue, skills, gate, approvals,
 * follow-up service and gateway, with a fake Vertex AI adapter. In memory and on the emulator.
 */

const T0 = new Date('2026-09-29T12:00:00Z');
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

type Args = Record<string, unknown>;

/** The model asks for these calls of `follow_up_schedule`. */
const asks = (...calls: Args[]): ProviderOutcome => ({
  status: 'success',
  output: {
    toolCalls: calls.map((args, i) => ({
      id: `call_${i}`,
      name: 'follow_up_schedule',
      arguments: args,
    })),
  },
  usage: { inputTokens: 600, outputTokens: 50 },
  finishReason: 'tool_use',
  providerRequestId: 'vertex-tools',
});

/** The model answers, in the task's shape, as text: a turn offered tools has no answer schema. */
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
  'follow_up_schedule@3 mid-task, storage in %s (ADR-0104)',
  (_s, createStores) => {
    async function world(
      options: {
        readonly limits?: HarnessLimits;
        /** Replaces the follow-up service's `create`, to make it fail. */
        readonly create?: FollowUpService['create'];
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
        // The real catalogue's declarations.
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

      // The model: a fake Vertex AI adapter answering from a script. Each answer may move the
      // clock first, as a slow call would.
      const providerCalls: ProviderCall[] = [];
      let script: (ProviderOutcome | (() => ProviderOutcome))[] = [];
      const vertex = {
        providerId: VERTEX_AI_PROVIDER_ID,
        adapterVersion: 'vertex-test-1',
        capabilities: () => VERTEX_AI_PROVIDER.capabilities,
        health: async () => 'available' as const,
        async generate(call: ProviderCall): Promise<ProviderOutcome> {
          providerCalls.push(call);
          const next = script.shift();
          if (next === undefined) throw new Error('the model was not expected to be called');
          return typeof next === 'function' ? next() : next;
        },
      };
      let balance = 1_000;
      const charges = new Map<string, number>();
      const credits: AICreditsPort = {
        async balanceOf() {
          return { status: 'present', balance };
        },
        async consume(tenant, { amount, referenceId }) {
          const key = `${tenant.organizationId}\n${referenceId}`;
          if (charges.has(key)) return { balance, replayed: true };
          charges.set(key, amount);
          balance -= amount;
          return { balance, replayed: false };
        },
        async refund() {
          throw new Error('not used');
        },
      };

      const conversation = createConversationAgentParts({ stores, now });
      const queued: string[] = [];
      const service = createFollowUpService({
        repository: stores.conversations,
        organizations: stores.tenancy,
        authorization,
        timeZone: async () => 'America/Lima',
        scheduler: { schedule: async (ref) => void queued.push(ref.followUpId) },
        now,
      });
      const followUps: FollowUpService =
        options.create === undefined ? service : { ...service, create: options.create };
      const taskParts = createAgentTaskParts({
        stores: {
          tenancy: stores.tenancy,
          specialists: stores.specialists,
          tasks: stores.tasks,
          knowledge: stores.knowledge,
          outputs: stores.outputs,
        },
        proposals: {
          conversations: stores.conversations,
          followUps,
          timeZone: async () => 'America/Lima',
        },
        tools: {
          registry,
          executors: Object.keys(conversation.executors),
          ...(options.limits === undefined ? {} : { limits: options.limits }),
        },
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
        ...(routed.toolLoop === undefined ? {} : { toolLoop: routed.toolLoop }),
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
      const approvals = createApprovalService({
        repository: stores.approvals,
        organizations: stores.tenancy,
        authorization,
        audit,
        now,
      });
      const customers = createCustomerService({
        repository: stores.conversations,
        organizations: stores.tenancy,
        authorization,
        now,
      });

      const tenantA = await resolveTenant(as(ALICE), orgA, stores.tenancy);
      const tenantB = await resolveTenant(as(BOB), orgB, stores.tenancy);
      const juan = await customers.create(tenantA, {
        displayName: 'Juan Pérez',
        phone: '+51999888777',
      });
      const bobsContact = await customers.create(tenantB, {
        displayName: 'Carla Ruiz',
        phone: '+51911222333',
      });

      /** An active agent of Alice's from a template; the commercial one moved to @3 by default. */
      async function agent(
        templateId = 'commercial',
        upgrade = templateId === 'commercial',
      ): Promise<Specialist> {
        const created = await management.create(tenantA, { templateId, displayName: 'Lucía' });
        let current = created;
        if (upgrade) {
          current = await management.upgradeSkill(tenantA, created.identity.id, {
            fromVersion: current.version,
            skillId: 'customer_follow_up',
            version: 3,
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

      /** Asks the agent for a task with the model's script, and runs it until it stops. */
      async function run(
        model: (ProviderOutcome | (() => ProviderOutcome))[],
        lucia?: Specialist,
      ): Promise<Execution> {
        script = [...model];
        const who = lucia ?? (await agent());
        const asked = await tasks.assign(tenantA, who.identity.id, {
          request: 'Agenda una llamada con Juan mañana a las 10 por su pedido',
        });
        await drive();
        return executions.get(tenantA, asked.task.id);
      }

      /** A person decides the approval the task waits on; the task is handed back to the worker. */
      async function decide(executionId: string, decision: 'approve' | 'reject') {
        const waiting = await executions.get(tenantA, executionId);
        const node = must(waiting.nodes.findLast((n) => n.approvalId !== undefined));
        await approvals[decision](tenantA, must(node.approvalId));
        await runtime.resume(tenantA, executionId);
        await drive();
        return executions.get(tenantA, executionId);
      }

      const scheduledFor = async (tenant: typeof tenantA) => (await service.list(tenant)).items;
      const scheduled = () => scheduledFor(tenantA);
      const toolResultsOf = (call: ProviderCall | undefined) =>
        (call?.messages ?? []).flatMap((m) =>
          m.content.flatMap((p) => (p.type === 'tool_result' ? [p] : [])),
        );

      return {
        stores,
        orgA,
        tenantA,
        tenantB,
        juan,
        bobsContact,
        approvals,
        executions,
        tasks,
        runtime,
        taskParts,
        providerCalls,
        queued,
        outputs: createAgentOutputStore(stores.outputs),
        agent,
        run,
        decide,
        scheduled,
        scheduledFor,
        toolResultsOf,
        setScript: (next: (ProviderOutcome | (() => ProviderOutcome))[]) => {
          script = [...next];
        },
        advanceClock: (ms: number) => {
          clock = new Date(clock.getTime() + ms);
        },
      };
    }

    type World = Awaited<ReturnType<typeof world>>;
    const call = (w: World, over: Args = {}): Args => ({
      contact: contactRef(w.juan.id),
      type: 'call',
      title: 'Llamar a Juan por su pedido',
      date: '2026-09-30',
      time: '10:00',
      ...over,
    });

    it('1. a valid request: offered by reference only, it pauses the task and asks a person', async () => {
      const w = await world();
      const execution = await w.run([asks(call(w))]);
      // The model was offered exactly this tool, saw Juan by reference, never his id or Bob's.
      const first = must(w.providerCalls[0]);
      expect(first.tools?.map((t) => t.name)).toEqual(['follow_up_schedule']);
      expect(
        Object.keys(
          first.tools?.[0]?.parameters.type === 'object'
            ? first.tools[0].parameters.properties
            : {},
        ).sort(),
      ).toEqual(['contact', 'date', 'time', 'title', 'type']);
      const prompt = JSON.stringify(first.messages);
      expect(prompt).toContain(contactRef(w.juan.id));
      expect(prompt).toContain('Juan Pérez');
      expect(prompt).not.toContain(w.juan.id);
      expect(prompt).not.toContain('Carla Ruiz');
      // Level C: the task waits, safely, on a person; nothing is scheduled.
      expect(execution.status).toBe('waiting_approval');
      const node = must(execution.nodes.find((n) => n.id === 'work_t0'));
      expect(node).toMatchObject({
        type: 'tool',
        // Not started: it runs only after a person approved it.
        status: 'pending',
        tool: { id: 'follow_up_schedule', version: 3 },
        approvalRequired: true,
      });
      const approval = await w.approvals.get(w.tenantA, must(node.approvalId));
      expect(approval).toMatchObject({
        status: 'pending',
        operation: { toolId: 'follow_up_schedule', toolVersion: 3, nodeId: 'work_t0' },
      });
      expect(await w.scheduled()).toEqual([]);
      expect(w.queued).toEqual([]);
    });

    it('2. without an approval nothing runs: resuming does not go around it', async () => {
      const w = await world();
      const execution = await w.run([asks(call(w))]);
      await expect(w.runtime.resume(w.tenantA, execution.id)).rejects.toBeDefined();
      expect((await w.executions.get(w.tenantA, execution.id)).status).toBe('waiting_approval');
      expect(await w.scheduled()).toEqual([]);
      // The runtime can never decide for a person either.
      const node = must(execution.nodes.find((n) => n.approvalId !== undefined));
      const runtimeTenant = { ...w.tenantA, actor: 'runtime' } as never;
      await expect(w.approvals.approve(runtimeTenant, must(node.approvalId))).rejects.toBeDefined();
      expect(await w.scheduled()).toEqual([]);
    });

    it('3. approved: the server resolves the contact, schedules it, and the task continues from there', async () => {
      const w = await world();
      const waiting = await w.run([
        asks(call(w)),
        answers('Agendé la llamada con Juan para mañana a las 10.'),
      ]);
      const approvalId = must(waiting.nodes.find((n) => n.id === 'work_t0')?.approvalId);
      const execution = await w.decide(waiting.id, 'approve');
      expect(execution.status).toBe('completed');
      expect(execution.verification?.result).toBe('passed');
      expect(execution.nodes.map((n) => `${n.id}:${n.status}`)).toEqual([
        'work:completed',
        'work_t0:completed',
        'work_turn2:completed',
      ]);
      // One follow-up, with the real contact, as the agent's, created by the runtime for Alice.
      const items = await w.scheduled();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        contactId: w.juan.id,
        type: 'call',
        title: 'Llamar a Juan por su pedido',
        source: 'agent',
        status: 'scheduled',
        createdBy: ALICE,
      });
      expect(w.queued).toHaveLength(1);
      // The next turn read the tool's real result, and answered.
      expect(w.toolResultsOf(w.providerCalls[1]).map((p) => p.result)).toEqual([
        { followUpId: items[0]?.id, created: true },
      ]);
      const answer = await w.outputs.find(w.tenantA, execution.id, 'work_turn2');
      expect(parseAgentAnswer(must(answer).output)?.answer).toContain('Agendé');

      // The trace: the task, the organization, the agent, the tool and version, the request, the
      // approval and who gave it, the result, when, and nothing hidden.
      const turn = await w.outputs.find(w.tenantA, execution.id, 'work');
      expect(must(turn).output.toolCalls).toEqual([
        { id: 'call_0', name: 'follow_up_schedule', arguments: call(w) },
      ]);
      const approval = await w.approvals.get(w.tenantA, approvalId);
      expect(approval).toMatchObject({
        status: 'approved',
        decidedBy: ALICE,
        operation: { executionId: execution.id, toolId: 'follow_up_schedule', toolVersion: 3 },
      });
      const events = (await w.stores.events()).filter(
        (e) => e.organizationId === w.orgA && e.target?.id === execution.id,
      );
      const toolEvents = events.filter((e) => e.action.startsWith('tool.'));
      expect(toolEvents.map((e) => e.action)).toEqual(
        expect.arrayContaining(['tool.execution_requested', 'tool.execution_completed']),
      );
      for (const e of toolEvents) {
        expect(e.tool).toEqual({ id: 'follow_up_schedule', version: 3 });
        expect(e.actor).toMatchObject({ id: 'runtime', initiatedBy: ALICE });
        expect(e.occurredAt).toEqual(expect.any(String));
      }
      expect(execution.specialistId).toBeDefined();
      const created = (await w.stores.events()).find((e) => e.action === 'follow_up.created');
      expect(created?.actor).toMatchObject({ id: 'runtime', initiatedBy: ALICE });
    });

    it('4. rejected: the tool never runs, the rejection is kept, and the task is cancelled there', async () => {
      const w = await world();
      const waiting = await w.run([asks(call(w))]);
      const approvalId = must(waiting.nodes.find((n) => n.id === 'work_t0')?.approvalId);
      const execution = await w.decide(waiting.id, 'reject');
      expect(execution).toMatchObject({ status: 'failed', failure: { code: 'approval_rejected' } });
      expect(execution.nodes.find((n) => n.id === 'work_turn2')?.status).toBe('cancelled');
      expect(await w.scheduled()).toEqual([]);
      expect(w.providerCalls).toHaveLength(1);
      expect(await w.approvals.get(w.tenantA, approvalId)).toMatchObject({
        status: 'rejected',
        decidedBy: ALICE,
      });
      expect((await w.stores.events()).some((e) => e.action === 'tool.execution_completed')).toBe(
        false,
      );
    });

    it('5. a contact that does not exist is never scheduled, even approved', async () => {
      const w = await world();
      const waiting = await w.run([asks(call(w, { contact: 'c_aaaaaaaaaa' }))]);
      const execution = await w.decide(waiting.id, 'approve');
      expect(execution).toMatchObject({ status: 'failed', failure: { code: 'contact_not_found' } });
      expect(await w.scheduled()).toEqual([]);
    });

    it('6. another organization’s contact is never reached: its reference resolves to nothing here', async () => {
      const w = await world();
      const waiting = await w.run([asks(call(w, { contact: contactRef(w.bobsContact.id) }))]);
      const execution = await w.decide(waiting.id, 'approve');
      expect(execution).toMatchObject({ status: 'failed', failure: { code: 'contact_not_found' } });
      expect(await w.scheduled()).toEqual([]);
      expect(await w.scheduledFor(w.tenantB)).toEqual([]);
    });

    it('7. an agent not authorized is not offered the tool, and asking anyway runs nothing', async () => {
      // The commercial agent still on customer_follow_up@2: its follow-up is the ADR-0084 one.
      const w = await world();
      const legacy = await w.agent('commercial', false);
      const execution = await w.run([asks(call(w))], legacy);
      expect(w.providerCalls[0]?.tools).toBeUndefined();
      // A tool it was not offered: the gateway refuses the answer; nothing reaches the gate.
      expect(execution).toMatchObject({ status: 'failed', failure: { code: 'invalid_response' } });
      expect(await w.scheduled()).toEqual([]);
      // An agent of another department: no tool, no contacts shown.
      const v = await world();
      const finance = await v.agent('finance', false);
      const other = await v.run([asks(call(v))], finance);
      expect(v.providerCalls[0]?.tools).toBeUndefined();
      expect(JSON.stringify(v.providerCalls[0]?.messages)).not.toContain('<contacts>');
      expect(other).toMatchObject({ status: 'failed', failure: { code: 'invalid_response' } });
      expect(await v.scheduled()).toEqual([]);
    });

    it('8. a repeated call is one call: one approval, one follow-up', async () => {
      const w = await world();
      const waiting = await w.run([asks(call(w), call(w)), answers('Listo, quedó agendado.')]);
      expect(waiting.nodes.filter((n) => n.type === 'tool').map((n) => n.id)).toEqual(['work_t0']);
      const execution = await w.decide(waiting.id, 'approve');
      expect(execution.status).toBe('completed');
      expect(await w.scheduled()).toHaveLength(1);
      // The model still read a result for each of its calls.
      expect(w.toolResultsOf(w.providerCalls[1])).toHaveLength(2);
    });

    it('9. a retry of the approved call makes the same follow-up, never a second one', async () => {
      const w = await world();
      const waiting = await w.run([asks(call(w)), answers('Agendado.')]);
      const execution = await w.decide(waiting.id, 'approve');
      const node = must(execution.nodes.find((n) => n.id === 'work_t0'));
      const executor = must(w.taskParts.executors.follow_up);
      const context = {
        organizationId: w.orgA,
        executionId: execution.id,
        nodeId: node.id,
        specialistId: execution.specialistId,
        specialistVersion: execution.specialistVersion,
        toolId: 'follow_up_schedule',
        toolVersion: 3,
        action: 'schedule',
        actor: { userId: ALICE, via: 'runtime' },
        riskLevel: 'low',
        approvalId: node.approvalId,
        environment: 'dev',
        deadline: new Date(Date.now() + 10_000),
      } as never;
      const retried = await executor.execute(context, call(w));
      expect(retried).toMatchObject({ status: 'success', output: { created: false } });
      expect(await w.scheduled()).toHaveLength(1);
    });

    it('10. stops at the tool limit before asking anyone', async () => {
      const w = await world();
      const six = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30'].map((time) =>
        call(w, { time }),
      );
      const execution = await w.run([asks(...six)]);
      expect(execution).toMatchObject({
        status: 'failed',
        failure: { code: 'tool_call_limit_reached' },
      });
      expect(execution.nodes.map((n) => n.id)).toEqual(['work']);
      expect(await w.approvals.list(w.tenantA)).toEqual([]);
      expect(await w.scheduled()).toEqual([]);
    });

    it('11. stops at the step limit: the last turn may not call it again', async () => {
      const w = await world({ limits: { ...DEFAULT_HARNESS_LIMITS, maxSteps: 2 } });
      const waiting = await w.run([asks(call(w)), asks(call(w, { time: '15:00' }))]);
      const execution = await w.decide(waiting.id, 'approve');
      expect(execution).toMatchObject({
        status: 'failed',
        failure: { code: 'step_limit_reached' },
      });
      // The first, approved, stands; the second was never put to anyone.
      expect(await w.scheduled()).toHaveLength(1);
      expect(JSON.stringify(w.providerCalls[1]?.messages)).toContain('Answer now');
    });

    it('12. a task past its working time stops before the tool, and asks no one', async () => {
      const w = await world();
      const execution = await w.run([
        () => {
          w.advanceClock(DEFAULT_HARNESS_LIMITS.maxDurationMs + 1);
          return asks(call(w));
        },
      ]);
      expect(execution).toMatchObject({
        status: 'failed',
        failure: { code: 'task_time_limit_reached' },
      });
      expect(await w.approvals.list(w.tenantA)).toEqual([]);
      expect(await w.scheduled()).toEqual([]);
    });

    it('13. a server error in the follow-up service schedules nothing and ends the task', async () => {
      const w = await world({
        create: async () => {
          throw new Error('database unavailable');
        },
      });
      const waiting = await w.run([asks(call(w))]);
      const execution = await w.decide(waiting.id, 'approve');
      // The gate records the executor's error as the tool's failure; the task ends there.
      expect(execution).toMatchObject({ status: 'failed', failure: { code: 'executor_error' } });
      expect(execution.nodes.find((n) => n.id === 'work_t0')).toMatchObject({
        status: 'failed',
        error: { code: 'executor_error' },
      });
      expect(execution.nodes.find((n) => n.id === 'work_turn2')?.status).toBe('cancelled');
      expect(w.providerCalls).toHaveLength(1);
    });

    it('14. the approval waits outside the task’s working time: a late approval still continues', async () => {
      const w = await world();
      const waiting = await w.run([asks(call(w)), answers('Agendado.')]);
      w.advanceClock(DEFAULT_HARNESS_LIMITS.maxDurationMs * 3);
      const execution = await w.decide(waiting.id, 'approve');
      expect(execution.status).toBe('completed');
      expect(await w.scheduled()).toHaveLength(1);
    });
  },
);

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('missing value');
  return value;
}
