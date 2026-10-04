import {
  aiToolOf,
  type AIContentPart,
  type AIGateway,
  type AIMessage,
  type AIRequest,
  type AIToolDefinition,
} from '@melonoffice/ai-gateway';
import type {
  AgentAutonomy,
  AgentToolCallRecord,
  Execution,
  ExecutionNode,
  ExecutionRef,
  SpecialistId,
  SpecialistStatus,
  ToolVersion,
} from '@melonoffice/domain';
import type { AgentOutputStore, NodeInput, VerificationInput } from '@melonoffice/execution';
import {
  autonomyOf,
  defaultOrganizationAgentPolicy,
  type AgentPolicySource,
  type SpecialistRepository,
} from '@melonoffice/specialists';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { digestOf, isModelInvocable, MODEL_TOOL_CALL_INPUT } from '@melonoffice/tools';
import { evaluateAgentAction } from './evaluation.js';
import { checkHarnessLimits, DEFAULT_HARNESS_LIMITS, type HarnessLimits } from './limits.js';
import {
  authorizeToolUse,
  DEFAULT_HARNESS_TOOL_POLICY,
  type HarnessToolDirectory,
  type HarnessToolPolicy,
  type ToolUseRules,
} from './tools.js';

/**
 * Tools in the middle of a task (ADR-0103). An agent's model may answer with calls to tools instead
 * of an answer; the Harness decides each one with `authorizeToolUse`, never the agent, and the
 * runtime runs what it allowed as `tool` nodes of the task's own execution, through the Tool Gate,
 * each with its permissions, approval and audit. After them the agent gets one more turn, which
 * reads what the tools gave. Nothing a model asks for runs any other way.
 *
 * The execution's graph is the loop's whole state: each turn is an `agent` node, each call a `tool`
 * node, each answer and tool output a kept record. A task that waits on a person's approval
 * resumes exactly where it stopped, and a repeated delivery never runs anything twice.
 */

/**
 * The input kind of an agent's next turn: its `id` is the task's first agent node, whose work the
 * turn continues.
 */
export const HARNESS_TURN_INPUT = 'harness_turn';

/** The code a task stops at when the Harness's loop ends it. */
export type HarnessToolStopCode =
  | 'step_limit_reached'
  | 'tool_call_limit_reached'
  | 'tool_not_granted'
  | 'tool_denied'
  | 'loop_detected'
  | 'tool_use_unsupported'
  // An action's evaluation refused it (AE-4.4, ADR-0116): the check that failed, as a code.
  | 'agent_not_found'
  | 'agent_paused'
  | 'agent_disabled'
  | 'agent_not_active'
  | 'tenant_mismatch'
  | 'department_not_active'
  | 'permission_not_held'
  | 'execution_not_running';

type Stop = { readonly stop: HarnessToolStopCode };
const stop = (code: HarnessToolStopCode): Stop => Object.freeze({ stop: code });

const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What the last turn a task may take is told, after its tools' results. */
const LAST_TURN =
  'MelonOffice: this task can use no more tools. Answer now with what you have, in the answer shape you were given.';

/** Whether a node runs a tool a model asked for. */
export const isModelToolNode = (node: ExecutionNode): boolean =>
  node.type === 'tool' && node.input?.type === MODEL_TOOL_CALL_INPUT;

const isTurnNode = (node: ExecutionNode): boolean =>
  node.type === 'agent' && node.input?.type === HARNESS_TURN_INPUT;

/** The first agent node of the work a turn belongs to. */
const firstTurnOf = (node: ExecutionNode): string =>
  isTurnNode(node) ? (node.input as ExecutionRef).id : node.id;

/** Every turn of one agent's work, in order: its first node, then the turns the loop added. */
const turnsOf = (execution: Execution, first: string): readonly ExecutionNode[] =>
  execution.nodes.filter(
    (n) => n.type === 'agent' && (n.id === first || (isTurnNode(n) && n.input?.id === first)),
  );

const toolNodeId = (agentNodeId: string, index: number) => `${agentNodeId}_t${index}`;
const turnId = (first: string, number: number) => `${first}_turn${number}`;

/** Where a tool node's call is: the agent node that asked for it, and which call it was. */
export function callRefOf(node: ExecutionNode): { agentNodeId: string; index: number } | undefined {
  if (!isModelToolNode(node)) return undefined;
  const id = (node.input as ExecutionRef).id;
  const at = id.lastIndexOf(':');
  const index = Number(id.slice(at + 1));
  if (at < 1 || !Number.isSafeInteger(index) || index < 0) return undefined;
  return { agentNodeId: id.slice(0, at), index };
}

/** Other nodes wait on this agent's answer (a follow-up node, ADR-0084): its answer is not deferred. */
const hasOtherDependents = (execution: Execution, first: string): boolean =>
  execution.nodes.some(
    (n) => n.dependsOn.some((d) => d === first) && !isModelToolNode(n) && !isTurnNode(n),
  );

/** One call's identity: the same tool with the same arguments is the same call. */
const callKey = (call: AgentToolCallRecord): string =>
  digestOf({ name: call.name, arguments: call.arguments });

/**
 * How long a task has been working, from when it started, leaving out the time it waited on a
 * person's approval (ADR-0103): a task a person takes an hour to approve resumes where it stopped,
 * with the time it had left.
 */
export function workingTimeMs(execution: Execution, now: Date): number {
  const start = Date.parse(execution.startedAt ?? execution.createdAt);
  if (!Number.isFinite(start)) return 0;
  const byId = new Map(execution.nodes.map((n) => [n.id as string, n]));
  let waited = 0;
  for (const node of execution.nodes) {
    if (node.approvalId === undefined) continue;
    const ready = Math.max(
      start,
      ...node.dependsOn
        .map((d) => Date.parse(byId.get(d)?.completedAt ?? ''))
        .filter(Number.isFinite),
    );
    const end = node.startedAt === undefined ? now.getTime() : Date.parse(node.startedAt);
    if (Number.isFinite(end) && end > ready) waited += end - ready;
  }
  return Math.max(0, now.getTime() - start - waited);
}

/**
 * The tools an execution's agent may be offered: the ones its exact version's skills grant, whose
 * every permission the person holds (`HarnessToolDirectory`), that say a model may ask for them,
 * and whose executor this server has. A tool that is none of these is never offered.
 */
export interface HarnessToolOffer {
  tools(tenant: TenantContext, execution: Execution): Promise<readonly ToolVersion[]>;
  /**
   * What an action's evaluation reads about the execution's agent (AE-4.4, ADR-0116): the agent as
   * stored now, its version's level of autonomy and its organization's rules. Absent: the offer
   * cannot read them, and the loop decides as before (the gate still checks each call).
   */
  facts?(tenant: TenantContext, execution: Execution): Promise<HarnessAgentFacts>;
}

/** The agent behind an execution, as an action's evaluation reads it (AE-4.4). */
export interface HarnessAgentFacts {
  /** The agent now. Absent: not found in this organization. */
  readonly agent?: { readonly organizationId: string; readonly status: SpecialistStatus };
  /** The level of the exact version the execution runs. */
  readonly autonomy: AgentAutonomy;
  readonly rules: ToolUseRules;
}

export function createHarnessToolOffer(options: {
  readonly directory: HarnessToolDirectory;
  /** The providers this server has an executor for. */
  readonly executors: readonly string[];
  /** Where the agent and its version are read, for each action's evaluation (AE-4.4). */
  readonly specialists?: Pick<SpecialistRepository, 'find' | 'findVersion'>;
  /** The organization's rules for its agents (AE-4.4). Absent: MelonOffice's defaults. */
  readonly policies?: AgentPolicySource;
}): HarnessToolOffer {
  const executors = new Set(options.executors);
  const { specialists, policies } = options;
  const facts =
    specialists === undefined
      ? undefined
      : async (_tenant: TenantContext, execution: Execution): Promise<HarnessAgentFacts> => {
          const { organizationId, specialistId, specialistVersion } = execution;
          const id = specialistId as SpecialistId | undefined;
          const [agent, version, rules] = await Promise.all([
            id === undefined ? undefined : specialists.find(organizationId, id),
            id === undefined || specialistVersion === undefined
              ? undefined
              : specialists.findVersion(organizationId, id, specialistVersion),
            policies === undefined
              ? defaultOrganizationAgentPolicy(organizationId)
              : policies.forOrganization(organizationId),
          ]);
          return Object.freeze({
            ...(agent === undefined
              ? {}
              : { agent: { organizationId: agent.organizationId, status: agent.status } }),
            autonomy: autonomyOf(version?.configuration ?? {}),
            rules,
          });
        };
  return Object.freeze({
    ...(facts === undefined ? {} : { facts }),
    async tools(tenant: TenantContext, execution: Execution) {
      const { specialistId, specialistVersion } = execution;
      if (specialistId === undefined || specialistVersion === undefined) return [];
      const granted = await options.directory.granted(
        tenant,
        specialistId as SpecialistId,
        specialistVersion,
      );
      return granted.filter((v) => isModelInvocable(v) && executors.has(v.provider.id));
    },
  });
}

/** A model call as a work source gives it, without the fields the runtime sets. */
type LoopWork = Omit<AIRequest, 'requestId' | 'executionId' | 'nodeId' | 'specialistId'>;

interface LoopWorkSource {
  toolInput(tenant: TenantContext, execution: Execution, node: ExecutionNode): Promise<unknown>;
  agentWork(
    tenant: TenantContext,
    execution: Execution,
    node: ExecutionNode,
  ): Promise<LoopWork | undefined>;
  needed?(tenant: TenantContext, execution: Execution, node: ExecutionNode): Promise<boolean>;
  toolStop?(
    tenant: TenantContext,
    execution: Execution,
    node: ExecutionNode,
  ): Promise<string | undefined>;
  keepsToolOutput?(node: ExecutionNode, execution: Execution): boolean;
}

interface LoopVerifier {
  verify(
    tenant: TenantContext,
    execution: Execution,
    context?: { readonly ai: Pick<AIGateway, 'generate'> },
  ): Promise<
    { readonly verification: VerificationInput; readonly result?: ExecutionRef } | undefined
  >;
}

export interface HarnessToolLoopOptions {
  readonly offer: HarnessToolOffer;
  /** Where agent answers and tool outputs are kept. */
  readonly outputs: Pick<AgentOutputStore, 'find'>;
  readonly limits?: HarnessLimits;
  readonly policy?: HarnessToolPolicy;
  /** A tool's words for the model. Absent: its id and action. */
  readonly describe?: (tool: ToolVersion) => string;
  readonly now?: () => Date;
}

export interface HarnessToolLoop {
  /**
   * An agent work source with the loop: the first turn is offered the tools the Harness allows, a
   * later turn carries every earlier call and its result, a tool node's input is its call, and a
   * tool does not run past the task's time.
   */
  work<S extends LoopWorkSource>(
    inner: S,
  ): Omit<S, keyof LoopWorkSource> & Required<LoopWorkSource>;
  /** What to do with the calls a model answered with: the runtime's port (`AgentToolLoop`). */
  plan(
    tenant: TenantContext,
    execution: Execution,
    node: ExecutionNode,
    calls: readonly AgentToolCallRecord[],
  ): Promise<{ readonly nodes: readonly NodeInput[] } | Stop>;
  /** A verifier that also covers the turns and tools the loop added. */
  verifier<V extends LoopVerifier>(inner: V): LoopVerifier;
  /** The credits the task's earlier turns consumed, for its budget. */
  spent(tenant: TenantContext, execution: Execution): Promise<number>;
}

export function createHarnessToolLoop(options: HarnessToolLoopOptions): HarnessToolLoop {
  const { offer, outputs } = options;
  const limits = checkHarnessLimits(options.limits ?? DEFAULT_HARNESS_LIMITS);
  const policy = options.policy ?? DEFAULT_HARNESS_TOOL_POLICY;
  const now = options.now ?? (() => new Date());
  const describe =
    options.describe ??
    ((tool: ToolVersion) => `${tool.toolId.replace(/_/g, ' ')} (${tool.action}).`);

  const toolCallsOf = async (tenant: TenantContext, execution: Execution, nodeId: string) =>
    (await outputs.find(tenant, execution.id, nodeId))?.output.toolCalls;

  /**
   * The tools a turn may be offered: every one the Harness would not refuse outright. A tool whose
   * policy denies it is never offered; the task's limits are enforced on each call (`plan`).
   */
  async function offeredTools(
    tenant: TenantContext,
    execution: Execution,
    first: string,
  ): Promise<readonly ToolVersion[]> {
    if (hasOtherDependents(execution, first)) return [];
    const tools = await offer.tools(tenant, execution);
    return tools.filter(
      (tool) =>
        authorizeToolUse({ tool, granted: true, toolCallsUsed: 0, maxToolCalls: 1, policy })
          .decision !== 'deny',
    );
  }

  /** Whether a turn can use no more tools: its task's tool calls, or its steps, are all used. */
  const exhausted = (execution: Execution, turn: number): boolean =>
    execution.nodes.filter(isModelToolNode).length >= limits.maxToolCalls ||
    turn + 1 >= limits.maxSteps;

  /** What a tool node gave, as the model reads it: its output, or why there is none. */
  async function resultOf(
    tenant: TenantContext,
    execution: Execution,
    node: ExecutionNode | undefined,
  ): Promise<unknown> {
    if (node === undefined) return { error: 'not_run' };
    if (node.status === 'failed') return { error: node.error?.code ?? 'tool_failed' };
    if (node.status !== 'completed') return { error: 'not_run' };
    const record = await outputs.find(tenant, execution.id, node.id);
    return record?.output.structured ?? { error: 'output_unavailable' };
  }

  /** The earlier turns, as the conversation the next turn continues. */
  async function historyOf(
    tenant: TenantContext,
    execution: Execution,
    turns: readonly ExecutionNode[],
  ): Promise<AIMessage[] | undefined> {
    const messages: AIMessage[] = [];
    // The first node that ran each call: a repeated call reads that one's result.
    const ran = new Map<string, ExecutionNode>();
    for (const turn of turns) {
      const record = await outputs.find(tenant, execution.id, turn.id);
      const calls = record?.output.toolCalls;
      if (record === undefined || calls === undefined) return undefined;
      const text = record.output.text?.trim();
      messages.push({
        role: 'assistant',
        content: [
          ...(text === undefined || text === '' ? [] : [{ type: 'text' as const, text }]),
          ...calls.map((call): AIContentPart => ({ type: 'tool_call', call })),
        ],
      });
      const results: AIContentPart[] = [];
      for (const [index, call] of calls.entries()) {
        const key = callKey(call);
        const own = execution.nodes.find(
          (n) => n.id === toolNodeId(turn.id, index) && isModelToolNode(n),
        );
        if (own !== undefined && !ran.has(key)) ran.set(key, own);
        const result = await resultOf(tenant, execution, own ?? ran.get(key));
        results.push({ type: 'tool_result', callId: call.id, name: call.name, result });
      }
      messages.push({ role: 'user', content: results });
    }
    return messages;
  }

  /**
   * A call in a conversation with tools, with no answer shape: a model that may call tools, or has,
   * answers in text, and the answer's JSON is read from it (ADR-0076).
   */
  function withoutShape(work: LoopWork): LoopWork {
    const rest: { -readonly [K in keyof LoopWork]?: LoopWork[K] } = { ...work };
    delete rest.outputSchema;
    delete rest.requirements;
    const kept = { ...work.requirements };
    delete kept.structuredOutput;
    return {
      ...(rest as LoopWork),
      ...(Object.keys(kept).length === 0 ? {} : { requirements: kept }),
    };
  }

  /** A call offered tools, as the gateway expects them. */
  function withTools(work: LoopWork, tools: readonly ToolVersion[]): LoopWork {
    const definitions: AIToolDefinition[] = tools.map((t) => aiToolOf(t, describe(t)));
    const shapeless = withoutShape(work);
    return {
      ...shapeless,
      requirements: { ...shapeless.requirements, toolUse: true },
      tools: definitions,
    };
  }

  const loop: HarnessToolLoop = {
    work(inner) {
      return Object.freeze({
        ...inner,
        async agentWork(tenant: TenantContext, execution: Execution, node: ExecutionNode) {
          const first = firstTurnOf(node);
          const base = execution.nodes.find((n) => n.id === first);
          if (base === undefined) return undefined;
          const work = await inner.agentWork(tenant, execution, base);
          if (work === undefined) return undefined;
          const turns = turnsOf(execution, first);
          const index = turns.findIndex((t) => t.id === node.id);
          if (index < 0) return undefined;
          const history = await historyOf(tenant, execution, turns.slice(0, index));
          // A turn whose earlier calls cannot be read back cannot go on: nothing is invented.
          if (history === undefined) return undefined;
          const all = await offeredTools(tenant, execution, first);
          const last = exhausted(execution, index);
          // A first turn with no tool to use is exactly the work as it was: nothing changes.
          const tools = index === 0 && last ? [] : all;
          if (index === 0 && tools.length === 0) return work;
          const messages = [...work.messages, ...history];
          const closing = messages.at(-1);
          if (last && closing !== undefined) {
            // The tools stay declared, so the conversation stays valid; the model is told to
            // answer, and a call it makes anyway stops the task at the limit.
            messages[messages.length - 1] = {
              ...closing,
              content: [...closing.content, { type: 'text', text: LAST_TURN }],
            };
          }
          const next = { ...work, messages };
          return tools.length === 0 ? withoutShape(next) : withTools(next, tools);
        },
        async toolInput(
          tenant: TenantContext,
          execution: Execution,
          node: ExecutionNode,
        ): Promise<unknown> {
          const ref = callRefOf(node);
          if (!isModelToolNode(node)) return inner.toolInput(tenant, execution, node);
          if (ref === undefined) return undefined;
          const calls = await toolCallsOf(tenant, execution, ref.agentNodeId);
          const call = calls?.[ref.index];
          // The node runs exactly the call it was made for, never another tool.
          if (call === undefined || call.name !== node.tool?.id) return undefined;
          return call.arguments;
        },
        // The tools its model asked for, and whatever the work it wraps keeps (ADR-0154).
        keepsToolOutput: (node: ExecutionNode, execution: Execution) =>
          isModelToolNode(node) || inner.keepsToolOutput?.(node, execution) === true,
        async needed(
          tenant: TenantContext,
          execution: Execution,
          node: ExecutionNode,
        ): Promise<boolean> {
          if (isModelToolNode(node) || isTurnNode(node)) return true;
          return inner.needed === undefined ? true : inner.needed(tenant, execution, node);
        },
        async toolStop(
          tenant: TenantContext,
          execution: Execution,
          node: ExecutionNode,
        ): Promise<string | undefined> {
          if (workingTimeMs(execution, now()) > limits.maxDurationMs) {
            return 'task_time_limit_reached';
          }
          return inner.toolStop === undefined ? undefined : inner.toolStop(tenant, execution, node);
        },
      });
    },

    async plan(tenant, execution, node, calls) {
      const first = firstTurnOf(node);
      const base = execution.nodes.find((n) => n.id === first);
      const turns = turnsOf(execution, first);
      const index = turns.findIndex((t) => t.id === node.id);
      if (base === undefined || index < 0 || hasOtherDependents(execution, first)) {
        return stop('tool_use_unsupported');
      }
      // One more turn would pass the task's steps: it stops, and says so.
      if (turns.length + 1 > limits.maxSteps) return stop('step_limit_reached');
      const offered = await offer.tools(tenant, execution);
      // What each action's evaluation reads about the agent, once for all its calls (AE-4.4).
      const agentFacts = await offer.facts?.(tenant, execution);
      const tenantOrganizationId = isResolvedTenant(tenant)
        ? (tenant.organizationId as string)
        : undefined;
      // Every call already asked for in this work: the same call is never run twice.
      const seen = new Set<string>();
      for (const turn of turns.slice(0, index)) {
        for (const call of (await toolCallsOf(tenant, execution, turn.id)) ?? []) {
          seen.add(callKey(call));
        }
      }
      let used = execution.nodes.filter(isModelToolNode).length;
      const tools: NodeInput[] = [];
      for (const [i, call] of calls.entries()) {
        const tool = offered.find((v) => v.toolId === call.name);
        // A tool the Harness did not offer: the agent cannot reach it by naming it.
        if (tool === undefined) return stop('tool_not_granted');
        const key = callKey(call);
        if (seen.has(key)) continue;
        seen.add(key);
        const decision = authorizeToolUse({
          tool,
          granted: true,
          toolCallsUsed: used,
          maxToolCalls: limits.maxToolCalls,
          policy,
          ...(agentFacts === undefined
            ? {}
            : { autonomy: agentFacts.autonomy, rules: agentFacts.rules }),
        });
        if (agentFacts !== undefined) {
          // Every check before the action, in order; the first that fails stops the task (AE-4.4).
          const evaluation = evaluateAgentAction({
            tenantOrganizationId,
            execution,
            ...(agentFacts.agent === undefined ? {} : { agent: agentFacts.agent }),
            // The offer holds only tools the skills grant and whose permissions the person holds.
            toolGranted: true,
            permissionsHeld: true,
            decision,
          });
          if (evaluation.outcome === 'refused') {
            return stop(evaluation.code as HarnessToolStopCode);
          }
        }
        if (decision.decision === 'deny') {
          return stop(decision.reason === 'not_granted' ? 'tool_not_granted' : decision.reason);
        }
        tools.push({
          id: toolNodeId(node.id, i),
          type: 'tool',
          label: call.name,
          dependsOn: [node.id],
          input: { type: MODEL_TOOL_CALL_INPUT, id: `${node.id}:${i}` },
          tool: { id: tool.toolId, version: tool.version },
          // A person approves it (level C, or a tool or organization that asks for one).
          ...(decision.decision === 'approval_required' ? { approvalRequired: true as const } : {}),
        });
        used += 1;
      }
      // Nothing new was asked: the agent is going round in circles.
      if (tools.length === 0) return stop('loop_detected');
      const next: NodeInput = {
        id: turnId(first, turns.length + 1),
        type: 'agent',
        label: base.label,
        dependsOn: [node.id, ...tools.map((t) => t.id)],
        input: { type: HARNESS_TURN_INPUT, id: first },
        ...(base.owner === undefined ? {} : { owner: base.owner }),
      };
      if (![...tools, next].every((n) => NODE_ID.test(n.id))) return stop('tool_use_unsupported');
      return { nodes: [...tools, next] };
    },

    verifier(inner) {
      return Object.freeze({
        async verify(
          tenant: TenantContext,
          execution: Execution,
          context?: { readonly ai: Pick<AIGateway, 'generate'> },
        ) {
          const result = await inner.verify(tenant, execution, context);
          if (result === undefined) return undefined;
          const covered = new Set(result.verification.nodes.map((n) => n.nodeId as string));
          const added: VerificationInput['nodes'][number][] = [];
          for (const node of execution.nodes) {
            if (node.status !== 'completed' || covered.has(node.id)) continue;
            const evidence = node.output ?? { type: 'execution_node', id: node.id };
            if (isModelToolNode(node)) {
              // The gate completes a node only once its output passed the tool's output schema.
              added.push({
                nodeId: node.id,
                policy: 'output_schema',
                checks: [{ code: 'tool_output_valid', result: 'passed', evidence }],
              });
            } else if (node.type === 'agent') {
              // An earlier turn: it asked for tools, and the Harness decided about each call.
              const calls = await toolCallsOf(tenant, execution, node.id);
              added.push({
                nodeId: node.id,
                policy: 'checks',
                checks: [
                  {
                    code: 'tool_calls_decided',
                    result: calls === undefined ? 'failed' : 'passed',
                    evidence,
                  },
                ],
              });
            }
          }
          if (added.length === 0) return result;
          return {
            ...result,
            verification: {
              ...result.verification,
              nodes: [...result.verification.nodes, ...added],
            },
          };
        },
      });
    },

    async spent(tenant, execution) {
      let credits = 0;
      for (const node of execution.nodes) {
        if (node.type !== 'agent' || node.status !== 'completed') continue;
        const record = await outputs.find(tenant, execution.id, node.id);
        credits += record?.ai?.creditsConsumed ?? 0;
      }
      return credits;
    },
  };
  return Object.freeze(loop);
}
