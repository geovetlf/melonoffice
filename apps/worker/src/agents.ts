import {
  answerNodeOf,
  parseAgentAnswer,
  createAgentTaskFactProposer,
  createAgentAnswerReviewer,
  createAgentTaskVerifier,
  createAgentTaskWork,
  GUARDIAN_NODE,
  guardianWarningOf,
  parseGuardianReport,
  createBrainContextSource,
  createAgentMemoryContext,
  createAgentMemoryRecorder,
  createHandoffDirectory,
  createHandoffRecorder,
  createHandoffSettler,
  creditsSpentBy,
  findContactRef,
  createKnowledgeSearchExecutor,
  MODEL_FOLLOW_UP_DESCRIPTION,
  MODEL_FOLLOW_UP_TOOL,
  MODEL_KNOWLEDGE_DESCRIPTION,
  MODEL_KNOWLEDGE_TOOL,
  taskFollowUpKey,
  TASK_PROPOSAL_LIMITS,
  type AgentTaskProposalPorts,
  createPlanStepVerifier,
  createPlanStepWork,
  taskOf,
  type AgentHandoffRepository,
  type AgentMemoryRepository,
  type AgentTaskRepository,
} from '@melonoffice/agents';
import {
  createCompanyBrain,
  DEPARTMENT_ACCESS,
  figureFactsOf,
  storedSecretsOf,
  knowledgeItemId,
  type KnowledgeRepository,
} from '@melonoffice/brain';
import {
  createCommercialInsights,
  createConversationService,
  createCustomerService,
  createOpportunityService,
  followUpIdFor,
  localDateTime,
  type ConversationRepository,
  type FollowUpService,
} from '@melonoffice/conversations';
import { createDecisionEngine } from '@melonoffice/decisions';
import type { DepartmentRepository } from '@melonoffice/departments';
import type { Execution, ExecutionId, OrganizationId, UserId } from '@melonoffice/domain';
import {
  createAgentOutputStore,
  type AgentOutputRepository,
  type ExecutionRepository,
} from '@melonoffice/execution';
import {
  createAgentFollowUpScheduleExecutor,
  createAgentReplyCheck,
  createAgentTurnStopHook,
  createAgentTurnVerifier,
  createAgentTurnWork,
  createChannelMessageExecutor,
  createConversationHandoffExecutor,
  type IntegrationEngine,
} from '@melonoffice/integrations';
import type { EventBus, EventDraft } from '@melonoffice/events';
import {
  createCrmContextSource,
  createCustomerRecordsExecutor,
  handoffForTask,
  createHarnessAgentWork,
  createHarnessContextSource,
  createHarnessToolDirectory,
  createHarnessToolLoop,
  createHarnessToolOffer,
  type HarnessLimits,
} from '@melonoffice/harness';
import type { Logger } from '@melonoffice/observability';
import { planStepOf, type PlanRepository } from '@melonoffice/planning';
import { createAuthorizationService } from '@melonoffice/rbac';
import type {
  AgentOutputSink,
  AgentToolLoop,
  ExecutionEndHook,
  ExecutionStopHook,
  NodeWorkSource,
  VerificationSource,
} from '@melonoffice/runtime';
import {
  createSkillCatalogue,
  type AgentPolicySource,
  type SpecialistRepository,
} from '@melonoffice/specialists';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import type { ToolExecutors, ToolRegistry } from '@melonoffice/tools';

export interface ConversationAgentStores {
  readonly tenancy: TenancyStore;
  readonly departments: DepartmentRepository;
  readonly specialists: SpecialistRepository;
  readonly executions: ExecutionRepository;
  readonly conversations: ConversationRepository;
  readonly outputs: AgentOutputRepository;
}

export interface ConversationAgentOptions {
  readonly stores: ConversationAgentStores;
  /**
   * The Integration Engine (ADR-0044): the channel side of an agent's reply. Absent: the reply
   * tool has no executor, so a reply fails at the gate and the conversation goes to a person.
   */
  readonly channels?: Pick<IntegrationEngine, 'send'>;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

/** What the runtime needs to run conversation agents' turns (CV-6B, ADR-0043). */
export interface ConversationAgentParts {
  readonly executors: ToolExecutors;
  readonly work: NodeWorkSource;
  readonly verifier: VerificationSource;
  readonly outputs: AgentOutputSink;
  readonly onStopped: ExecutionStopHook;
}

/**
 * The conversation agent's pieces for the worker (ADR-0043), over the same repositories as the
 * API: the executors of its two tools, its work source, verifier, answer store and stop hook.
 * Composition only: each piece is the integrations package's, and every decision stays with the
 * runtime, the tool gate, the AI Gateway and the conversation control.
 */
export function createConversationAgentParts(
  options: ConversationAgentOptions,
): ConversationAgentParts {
  const { stores, channels, logger, now } = options;
  const clock = now === undefined ? {} : { now };
  const authorization = createAuthorizationService();
  const conversationService = (requestId?: string) =>
    createConversationService({
      repository: stores.conversations,
      organizations: stores.tenancy,
      departments: stores.departments,
      authorization,
      ...clock,
      ...(requestId === undefined ? {} : { requestId }),
    });
  const outputs = createAgentOutputStore(stores.outputs, now);
  const executors: Record<string, ToolExecutors[string]> = {
    conversation: createConversationHandoffExecutor({
      executions: stores.executions,
      tenancy: stores.tenancy,
      conversationService,
    }),
  };
  if (channels !== undefined) {
    executors.channel = createChannelMessageExecutor({
      conversations: stores.conversations,
      engine: channels,
      agentReplies: createAgentReplyCheck({
        conversations: stores.conversations,
        executions: stores.executions,
        specialists: stores.specialists,
      }),
      ...clock,
    });
  }
  return Object.freeze({
    executors,
    // Every agent's call goes through the Harness (ADR-0100): the data policy, the limits and the
    // cheapest fitting model apply to a conversation turn too. No bypass.
    work: createHarnessAgentWork(
      createAgentTurnWork({
        conversations: stores.conversations,
        specialists: stores.specialists,
        outputs,
        ...clock,
      }),
      // A paused or disabled agent stops at its next step (AE-4).
      { ...clock, agents: stores.specialists },
    ),
    verifier: createAgentTurnVerifier({ outputs, conversations: stores.conversations }),
    outputs,
    onStopped: createAgentTurnStopHook({
      conversations: stores.conversations,
      conversationService: conversationService(),
      ...clock,
      ...(logger === undefined ? {} : { logger }),
    }),
  });
}

export interface AgentTaskStores {
  readonly tenancy: TenancyStore;
  readonly specialists: SpecialistRepository;
  readonly tasks: AgentTaskRepository;
  readonly knowledge: KnowledgeRepository;
  readonly outputs: AgentOutputRepository;
  /** The plans, for the steps of approved plans (WF-1, ADR-0070). */
  readonly plans?: PlanRepository;
  /** Agents' own memories (ADR-0117). Absent: no agent keeps or reads notes. */
  readonly memories?: AgentMemoryRepository;
  /**
   * Handoffs between agents (ADR-0117), with the departments the receiving agent is chosen in.
   * Absent: no agent is offered a handoff.
   */
  readonly handoffs?: {
    readonly repository: AgentHandoffRepository;
    readonly departments: DepartmentRepository;
  };
}

/**
 * What agents may propose from a task (ADR-0084) needs, beyond the task's own stores: the
 * conversations' records (contacts and follow-ups), the business's time zone and the follow-up
 * service that schedules, with its queue. Absent: agents only answer, as before.
 */
export interface AgentTaskProposalStores {
  readonly conversations: ConversationRepository;
  readonly followUps: Pick<FollowUpService, 'checkCreate' | 'create'>;
  readonly timeZone: (organizationId: OrganizationId) => Promise<string>;
}

/** What the runtime needs to run agent tasks (ADR-0063): no stop hook. */
export interface AgentTaskParts {
  readonly work: NodeWorkSource;
  readonly verifier: VerificationSource;
  /**
   * The tools agents' tasks use, by provider: `follow_up_schedule@2` and `@3` (ADR-0084,
   * ADR-0104) and `knowledge_search@1` (ADR-0130).
   */
  readonly executors: ToolExecutors;
  /** When a task ends, the facts it proposed go to Company Brain (ADR-0084). */
  readonly onEnded?: ExecutionEndHook;
  /** The steps of approved plans (ADR-0070): the same prompt and answer as a task. */
  readonly steps?: { readonly work: NodeWorkSource; readonly verifier: VerificationSource };
  /**
   * The Harness's tool loop for tasks (ADR-0103): what to do with the tools an agent's model asks
   * for mid-task. Absent: agents are offered no tools, as before.
   */
  readonly toolLoop?: AgentToolLoop;
  /**
   * Tells the task's person that a step of it waits on their approval (ADR-0117), as
   * `agent_task.approval_required`. Only an agent task's execution publishes anything.
   */
  readonly waitingApproval?: (job: {
    readonly organizationId: string;
    readonly executionId: string;
    readonly jobId: string;
  }) => Promise<void>;
}

/**
 * Agent tasks' pieces for the worker (ADR-0063): the agent's version, skills and the Company
 * Brain facts its department may read, and the answer's verification. Company Brain is read with
 * the runtime's tenant, so it checks the person the task runs for again.
 */
export function createAgentTaskParts(options: {
  readonly stores: AgentTaskStores;
  readonly proposals?: AgentTaskProposalStores;
  /**
   * Publishes `agent_task.finished` and, when the task now needs a person,
   * `agent_execution.handoff` (ADR-0102). Absent: nothing is published.
   */
  readonly events?: Pick<EventBus, 'publishRuntime'>;
  /**
   * The tool catalogue and the providers this worker has executors for, beyond the tasks' own
   * (ADR-0103): an agent is offered, mid-task, only a tool its skills grant, the person may use,
   * that says a model may ask for it, and that can run here. Absent: no tool is offered.
   */
  readonly tools?: {
    readonly registry: Pick<ToolRegistry, 'resolve'>;
    readonly executors: readonly string[];
    /** The Harness's limits. Absent: its defaults (ADR-0100); tests set smaller ones. */
    readonly limits?: HarnessLimits;
    /**
     * Organizations' rules for their agents (AE-4.4, ADR-0116), read before each action. Absent:
     * MelonOffice's defaults for every organization.
     */
    readonly policies?: AgentPolicySource;
  };
  readonly logger?: Logger;
  readonly now?: () => Date;
}): AgentTaskParts {
  const { stores, logger, now, proposals: records, events } = options;
  const clock = now ?? (() => new Date());
  const authorization = createAuthorizationService();
  const brain = createCompanyBrain({
    repository: stores.knowledge,
    organizations: stores.tenancy,
    authorization,
    ...(now === undefined ? {} : { now }),
    ...(logger === undefined ? {} : { logger }),
  });
  const outputs = createAgentOutputStore(stores.outputs, now);
  const skills = createSkillCatalogue();
  const brainContext = createBrainContextSource({ brain });
  // The customer records (ADR-0102): counts and totals from the C4 insights, read as the person
  // the task runs for, only when the task is about customers. Needs the conversations' records.
  const fact = async (
    organizationId: OrganizationId,
    domain: 'identity' | 'finance',
    key: string,
  ) => {
    const item = await stores.knowledge.findItem(
      organizationId,
      knowledgeItemId(organizationId, domain, key),
    );
    return item?.status === 'active' && item.value.type === 'text' ? item.value.text : undefined;
  };
  const insights =
    records === undefined
      ? undefined
      : createCommercialInsights({
          customers: createCustomerService({
            repository: records.conversations,
            organizations: stores.tenancy,
            authorization,
            ...(now === undefined ? {} : { now }),
          }),
          opportunities: createOpportunityService({
            repository: records.conversations,
            organizations: stores.tenancy,
            authorization,
            businessType: (organizationId) => fact(organizationId, 'identity', 'business_type'),
            currency: (organizationId) => fact(organizationId, 'finance', 'currency'),
            ...(now === undefined ? {} : { now }),
          }),
          conversations: records.conversations,
          authorization,
          timeZone: records.timeZone,
          currency: (organizationId) => fact(organizationId, 'finance', 'currency'),
          ...(now === undefined ? {} : { now }),
        });
  const crm = insights === undefined ? undefined : createCrmContextSource({ insights });
  // The Melon Agent Harness (ADR-0099): a task, or a step of a plan, reads only the context it
  // needs.
  const context = createHarnessContextSource({
    sources: { company_brain: brainContext, ...(crm === undefined ? {} : { crm }) },
  });
  // The Decision Engine (ADR-0065, ADR-0083): what this agent may propose, from its skills'
  // actions, for the person the task is for. Rules only: no model is asked.
  const decisions = createDecisionEngine({
    authorization,
    skills,
    configured: (action) =>
      action === 'knowledge.propose_fact' ||
      (action === 'follow_up.schedule' && records !== undefined),
  });
  const offers: AgentTaskProposalPorts['offers'] = (tenant, action, actions) =>
    decisions.offers(tenant, action, 'agent', { actions });
  const proposals: AgentTaskProposalPorts = {
    offers,
    outputs,
    ...(records === undefined
      ? {}
      : {
          contacts: {
            async list(tenant) {
              const page = await createCustomerService({
                repository: records.conversations,
                organizations: stores.tenancy,
                authorization,
                ...(now === undefined ? {} : { now }),
              }).list(tenant, {}, { limit: TASK_PROPOSAL_LIMITS.contacts });
              return page.items.map((c) => ({
                id: c.id,
                name: c.displayName ?? '(no name)',
              }));
            },
          },
          clock: {
            async today(tenant) {
              if (!isResolvedTenant(tenant)) throw new Error('unresolved_tenant');
              const timeZone = await records.timeZone(tenant.organizationId as OrganizationId);
              return { date: localDateTime(clock(), timeZone).date, timeZone };
            },
          },
          followUps: records.followUps,
        }),
  };
  /**
   * The task's end on the event bus (ADR-0102), as the runtime for the person it ran for. Keyed on
   * the execution, so a repeated end hook stores each event once.
   */
  // The catalogue's code shape: a failure code that is not one is left out, never published.
  const EVENT_CODE = /^[a-z][a-z_]{0,63}$/;
  async function publishEnd(tenant: TenantContext, execution: Execution): Promise<void> {
    const task = taskOf(execution);
    if (events === undefined || task === undefined || execution.specialistId === undefined) {
      return;
    }
    const specialistId = execution.specialistId;
    const subject = { type: 'execution', id: execution.id };
    const record =
      execution.status === 'completed'
        ? await outputs.find(tenant, task.taskId, answerNodeOf(execution))
        : undefined;
    const answer = record === undefined ? undefined : parseAgentAnswer(record.output);
    const handoff = handoffForTask({
      status: execution.status,
      failure: execution.failure?.code ?? null,
      missing: answer?.missing ?? [],
    });
    const drafts: EventDraft[] = [
      {
        type: 'agent_task.finished',
        subject,
        data: {
          specialistId,
          outcome: execution.status,
          ...(handoff === null ? {} : { handoff: handoff.reason }),
          ...(execution.failure?.code !== undefined && EVENT_CODE.test(execution.failure.code)
            ? { code: execution.failure.code }
            : {}),
        },
        idempotencyKey: `${execution.id}:finished`,
      },
    ];
    // Counted by the log-based metrics of the monitoring module (G-6, ADR-0136): codes only.
    logger?.info('agent_task.finished', {
      outcome: execution.status,
      code:
        execution.failure?.code !== undefined && EVENT_CODE.test(execution.failure.code)
          ? execution.failure.code
          : null,
    });
    // What the Agent Guardian found that a person should check (G-2, ADR-0132).
    const kept = await outputs.find(tenant, task.taskId, GUARDIAN_NODE);
    const report = kept === undefined ? undefined : parseGuardianReport(kept.output.structured);
    const warning = report === undefined ? undefined : guardianWarningOf(report);
    if (warning !== undefined) {
      logger?.info('agent_guardian.warning', {
        code: warning.code,
        // Not `severity`: the logger keeps that key for the entry's own level.
        guardianSeverity: warning.severity,
      });
      drafts.push({
        type: 'agent_guardian.warning',
        subject,
        data: { specialistId, code: warning.code, severity: warning.severity },
        idempotencyKey: `${execution.id}:guardian`,
      });
    }
    if (handoff !== null) {
      drafts.push({
        type: 'agent_execution.handoff',
        subject,
        data: { specialistId, reason: handoff.reason, code: handoff.code },
        idempotencyKey: `${execution.id}:handoff`,
      });
    }
    await events.publishRuntime(
      execution.organizationId as OrganizationId,
      execution.userId as UserId,
      drafts,
    );
  }
  const facts = createAgentTaskFactProposer({
    outputs,
    specialists: stores.specialists,
    skills,
    offers,
    brain,
    onError: (code) => logger?.warn('agent_task.facts_not_proposed', { code }),
  });
  const taskContacts = proposals.contacts;
  const taskExecutors: ToolExecutors = {
    // The company memory, searched mid-task (RT-1, ADR-0130): a read with the department's rules.
    knowledge: createKnowledgeSearchExecutor({
      brain,
      organizations: stores.tenancy,
      specialists: stores.specialists,
    }),
    // The organization's own customer records, read by a plan's tool step (TL-2, ADR-0160):
    // counts and totals, with the agent's permissions, as the person the plan runs for.
    ...(insights === undefined
      ? {}
      : {
          crm: createCustomerRecordsExecutor({
            insights,
            organizations: stores.tenancy,
            specialists: stores.specialists,
          }),
        }),
    ...(records === undefined || taskContacts === undefined
      ? {}
      : {
          follow_up: createAgentFollowUpScheduleExecutor({
            followUps: records.followUps,
            organizations: stores.tenancy,
            // A model's contact reference (ADR-0104), resolved here only: among the contacts of
            // the task's organization the person may read, the very ones a task is shown.
            contacts: {
              async resolve(tenant, ref) {
                const found = findContactRef(await taskContacts.list(tenant), ref);
                return 'contact' in found ? { contactId: found.contact.id } : found;
              },
            },
          }),
        }),
  };
  // Tools in the middle of a task (ADR-0103): the agent asks, the Harness decides each call with
  // `authorizeToolUse`, and the runtime runs what it allowed through the Tool Gate.
  const loop =
    options.tools === undefined
      ? undefined
      : createHarnessToolLoop({
          offer: createHarnessToolOffer({
            directory: createHarnessToolDirectory({
              specialists: stores.specialists,
              skills,
              registry: options.tools.registry,
              authorization,
            }),
            executors: [...options.tools.executors, ...Object.keys(taskExecutors)],
            // Each action is evaluated against the agent as stored now, its version's level of
            // autonomy and its organization's rules (AE-4.4).
            specialists: stores.specialists,
            ...(options.tools.policies === undefined ? {} : { policies: options.tools.policies }),
          }),
          outputs,
          describe: (tool) =>
            tool.toolId === MODEL_FOLLOW_UP_TOOL.id && tool.version === MODEL_FOLLOW_UP_TOOL.version
              ? MODEL_FOLLOW_UP_DESCRIPTION
              : tool.toolId === MODEL_KNOWLEDGE_TOOL.id &&
                  tool.version === MODEL_KNOWLEDGE_TOOL.version
                ? MODEL_KNOWLEDGE_DESCRIPTION
                : `${tool.toolId.replace(/_/g, ' ')} (${tool.action}).`,
          ...(options.tools.limits === undefined ? {} : { limits: options.tools.limits }),
          now: clock,
        });
  const handoffDirectory =
    stores.handoffs === undefined
      ? undefined
      : createHandoffDirectory({
          departments: stores.handoffs.departments,
          specialists: stores.specialists,
        });
  const taskWork = createAgentTaskWork({
    tasks: stores.tasks,
    specialists: stores.specialists,
    skills,
    context,
    proposals,
    ...(stores.handoffs === undefined || handoffDirectory === undefined
      ? {}
      : { handoffs: { directory: handoffDirectory, repository: stores.handoffs.repository } }),
    ...(stores.memories === undefined
      ? {}
      : { memory: createAgentMemoryContext({ repository: stores.memories, now: clock }) }),
  });
  const memories =
    stores.memories === undefined
      ? undefined
      : createAgentMemoryRecorder({
          repository: stores.memories,
          specialists: stores.specialists,
          now: clock,
        });
  const spent = (tenant: TenantContext, execution: Execution) =>
    creditsSpentBy(outputs, tenant, execution);
  const handoffs =
    stores.handoffs === undefined || handoffDirectory === undefined
      ? undefined
      : {
          recorder: createHandoffRecorder({
            repository: stores.handoffs.repository,
            tasks: stores.tasks,
            specialists: stores.specialists,
            directory: handoffDirectory,
            authorization,
            now: clock,
          }),
          settler: createHandoffSettler({
            repository: stores.handoffs.repository,
            tasks: stores.tasks,
            spent,
            now: clock,
          }),
        };
  /**
   * When a task ends (ADR-0117): the handoff its answer proposed is recorded for a person to
   * decide, and a handed task's end settles its handoff. A failure here never changes the task.
   */
  async function handOff(tenant: TenantContext, execution: Execution): Promise<void> {
    const task = taskOf(execution);
    if (handoffs === undefined || task === undefined) return;
    try {
      await handoffs.settler.settle(tenant, execution);
      if (execution.status !== 'completed') return;
      const record = await outputs.find(tenant, task.taskId, answerNodeOf(execution));
      const proposed = record === undefined ? undefined : parseAgentAnswer(record.output)?.handoff;
      if (proposed === undefined || proposed === null) return;
      const handoff = await handoffs.recorder.record(tenant, task, proposed);
      if (handoff?.state === 'proposed' && events !== undefined) {
        await events.publishRuntime(
          execution.organizationId as OrganizationId,
          execution.userId as UserId,
          [
            {
              type: 'agent_handoff.proposed',
              subject: { type: 'agent_handoff', id: handoff.id },
              data: {
                specialistId: task.specialistId,
                receivingId: handoff.receivingAgent?.specialistId ?? null,
              },
              idempotencyKey: `${handoff.id}:handoff_proposed`,
            },
          ],
        );
      }
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      logger?.warn('agent_task.handoff_not_recorded', {
        code: typeof code === 'string' ? code : 'error',
      });
    }
  }
  /** The notes a finished task asked to keep (ADR-0117): only from its answer, if any. */
  async function remember(tenant: TenantContext, execution: Execution): Promise<void> {
    const task = taskOf(execution);
    if (memories === undefined || task === undefined || execution.status !== 'completed') return;
    const record = await outputs.find(tenant, task.taskId, answerNodeOf(execution));
    const answer = record === undefined ? undefined : parseAgentAnswer(record.output);
    if (answer === undefined || answer.remember.length === 0) return;
    try {
      await memories.record(tenant, task, answer.remember);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      logger?.warn('agent_task.memory_not_kept', {
        code: typeof code === 'string' ? code : 'error',
      });
    }
  }
  // The Melon Agent Harness (ADR-0099): a task reads only the context it needs, and its model call
  // carries the order to try models in for what it asks. The agent's prompt, its model policy and
  // the AI Gateway's router are unchanged. Each turn's budget is what the earlier turns left.
  const work = createHarnessAgentWork(loop === undefined ? taskWork : loop.work(taskWork), {
    now: clock,
    agents: stores.specialists,
    async taskOf(tenant, execution) {
      const facts = taskOf(execution);
      if (facts === undefined || !isResolvedTenant(tenant)) return undefined;
      return stores.tasks.find(tenant.organizationId as OrganizationId, facts.taskId);
    },
    ...(loop === undefined ? {} : { spent: loop.spent }),
  });
  const taskVerifier = createAgentTaskVerifier({
    outputs,
    // The Agent Guardian (G-2, ADR-0132): deterministic, for every agent, no model and no credits.
    guardian: {
      record: (tenant, input) => outputs.record(tenant, input),
      // Company Brain's figures the agent's department may read, as the person the task is for,
      // never above `confidential`: what the Guardian keeps is read with the task.
      async figures(tenant, execution) {
        const facts = taskOf(execution);
        if (facts === undefined || !isResolvedTenant(tenant)) return undefined;
        const organizationId = tenant.organizationId as OrganizationId;
        const version = await stores.specialists.findVersion(
          organizationId,
          facts.specialistId,
          facts.specialistVersion,
        );
        if (version === undefined) return undefined;
        const { configuration } = version;
        if (!configuration.permissions.includes('knowledge.read')) return undefined;
        const prefix = `${organizationId}_`;
        const purpose = configuration.departmentId.startsWith(prefix)
          ? configuration.departmentId.slice(prefix.length)
          : undefined;
        const access = purpose === undefined ? undefined : DEPARTMENT_ACCESS[purpose];
        if (access === undefined) return undefined;
        const items = await brain.list(tenant);
        return figureFactsOf(items, {
          domains: access.domains,
          maxSensitivity:
            access.maxSensitivity === 'restricted' ? 'confidential' : access.maxSensitivity,
        });
      },
      // The credentials stored in Company Brain (G-7), as the person the task is for may read
      // them: only compared with the answer, never kept, logged or shown.
      async secrets(tenant, execution) {
        if (taskOf(execution) === undefined || !isResolvedTenant(tenant)) return undefined;
        return storedSecretsOf(await brain.list(tenant));
      },
      // Unknown to this worker's catalogue: counted as a step that changed something.
      mutating: (id, version) =>
        options.tools?.registry.resolve(id, version)?.version.mutating ?? true,
    },
    // The optional AI review (ADR-0117): only for agents whose version has it on.
    reviewer: createAgentAnswerReviewer({
      outputs,
      specialists: stores.specialists,
      tasks: stores.tasks,
      spent: (tenant, execution) => creditsSpentBy(outputs, tenant, execution),
    }),
    ...(records === undefined
      ? {}
      : {
          scheduled: async (tenant, taskId) => {
            if (!isResolvedTenant(tenant)) return false;
            const organizationId = tenant.organizationId as OrganizationId;
            const found = await records.conversations.findFollowUp(
              organizationId,
              followUpIdFor(organizationId, taskFollowUpKey(taskId)),
            );
            return found?.source === 'agent';
          },
        }),
  });
  return Object.freeze({
    work,
    verifier: loop === undefined ? taskVerifier : loop.verifier(taskVerifier),
    executors: taskExecutors,
    ...(loop === undefined ? {} : { toolLoop: { plan: loop.plan } }),
    ...(events === undefined
      ? {}
      : {
          async waitingApproval(job: {
            readonly organizationId: string;
            readonly executionId: string;
            readonly jobId: string;
          }) {
            const organizationId = job.organizationId as OrganizationId;
            const task = await stores.tasks.find(organizationId, job.executionId as ExecutionId);
            if (task === undefined) return;
            await events.publishRuntime(organizationId, task.requestedBy, [
              {
                type: 'agent_task.approval_required',
                subject: { type: 'execution', id: task.id },
                data: { specialistId: task.specialistId },
                // Each job that stops for an approval is one notice; a repeated delivery is not.
                idempotencyKey: `${task.id}:approval:${job.jobId}`,
              },
            ]);
          },
        }),
    onEnded: {
      async ended(tenant: TenantContext, execution: Execution) {
        await facts.ended(tenant, execution);
        await remember(tenant, execution);
        await handOff(tenant, execution);
        if (events !== undefined) await publishEnd(tenant, execution);
      },
    },
    ...(stores.plans === undefined
      ? {}
      : {
          steps: Object.freeze({
            // A plan's step is an agent's call too: through the Harness (ADR-0100).
            work: createHarnessAgentWork(
              createPlanStepWork({
                plans: stores.plans,
                specialists: stores.specialists,
                skills,
                context,
                outputs,
              }),
              { now: clock, agents: stores.specialists },
            ),
            verifier: createPlanStepVerifier({ outputs }),
          }),
        }),
  });
}

/** Work nobody configured: nothing is asked of a model, nothing is verified. */
const NO_WORK: { readonly work: NodeWorkSource; readonly verifier: VerificationSource } =
  Object.freeze({
    work: Object.freeze({
      toolInput: async () => undefined,
      agentWork: async () => undefined,
    }),
    verifier: Object.freeze({ verify: async () => undefined }),
  });

/**
 * One runtime, three kinds of agent work: an agent task's execution (`taskOf`) goes to the task's
 * pieces (ADR-0063), a step of an approved plan (`planStepOf`) to the plan steps' (ADR-0070), and
 * everything else to the conversation agent's, exactly as before.
 */
export function routeAgentWork(
  conversation: ConversationAgentParts,
  tasks: AgentTaskParts,
): Pick<ConversationAgentParts, 'work' | 'verifier' | 'onStopped'> & {
  readonly toolLoop: AgentToolLoop;
} {
  const isTask = (execution: Execution) => taskOf(execution) !== undefined;
  const isStep = (execution: Execution) => planStepOf(execution) !== undefined;
  const partsOf = (execution: Execution) =>
    isTask(execution) ? tasks : isStep(execution) ? (tasks.steps ?? NO_WORK) : conversation;
  return Object.freeze({
    work: Object.freeze({
      toolInput: (tenant, execution, node) =>
        partsOf(execution).work.toolInput(tenant, execution, node),
      agentWork: (tenant, execution, node) =>
        partsOf(execution).work.agentWork(tenant, execution, node),
      needed: async (tenant, execution, node) => {
        const source = partsOf(execution).work;
        return source.needed === undefined ? true : source.needed(tenant, execution, node);
      },
      keepsToolOutput: (node, execution) =>
        partsOf(execution).work.keepsToolOutput?.(node, execution) === true,
      toolStop: async (tenant, execution, node) => {
        const source = partsOf(execution).work;
        return source.toolStop === undefined ? undefined : source.toolStop(tenant, execution, node);
      },
    } satisfies NodeWorkSource),
    // Only agent tasks use tools mid-task (ADR-0103); anything else that asks for one stops.
    toolLoop: Object.freeze({
      plan: async (tenant, execution, node, calls) =>
        isTask(execution) && tasks.toolLoop !== undefined
          ? tasks.toolLoop.plan(tenant, execution, node, calls)
          : { stop: 'tool_use_unsupported' },
    } satisfies AgentToolLoop),
    verifier: Object.freeze({
      verify: (tenant, execution, context) =>
        partsOf(execution).verifier.verify(tenant, execution, context),
    } satisfies VerificationSource),
    onStopped: Object.freeze({
      // A task or a plan step that stops has nobody to hand over to: its failure is on the
      // execution, and a plan step's reaches its plan through the end hook (ADR-0070).
      stopped: async (tenant, execution, code) => {
        if (!isTask(execution) && !isStep(execution)) {
          await conversation.onStopped.stopped(tenant, execution, code);
        }
      },
    } satisfies ExecutionStopHook),
  });
}
