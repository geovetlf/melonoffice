import type { ToolDefinition, ToolVersion } from '@melonoffice/domain';
import { canonicalJson } from './canonical.js';
import { ToolError } from './errors.js';
import { checkToolDefinition } from './model.js';

/** A tool and one of its versions, as the registry resolves them. */
export interface ResolvedTool {
  readonly definition: ToolDefinition;
  readonly version: ToolVersion;
}

/**
 * What a tool is and under which policies it may be used (ADR-0026). It never runs a tool: that
 * is the executor's job, behind the tool gate.
 */
export interface ToolRegistry {
  list(): readonly ToolDefinition[];
  find(id: string): ToolDefinition | undefined;
  /** One exact version, or undefined. There is no "latest": callers name the version they use. */
  resolve(id: string, version: number): ResolvedTool | undefined;
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
};

/**
 * Tool ids that name something else in an approval's operation, never a tool: `plan_step` is a
 * plan step waiting for a person (ADR-0146). No tool may take one, so a tool approval and a step
 * approval can never be confused.
 */
export const RESERVED_TOOL_IDS: readonly string[] = Object.freeze(['plan_step']);

/**
 * Builds a registry from tool definitions, checking each. Tools ship with the code that runs
 * them, so the catalogue lives in code, like plans (ADR-0021) and departments (ADR-0025).
 *
 * `published` holds the versions a previous release already published: a definition that
 * changes one of them is refused, so a version, once used, keeps meaning the same thing.
 */
export function createToolRegistry(
  definitions: readonly ToolDefinition[],
  published: readonly ToolVersion[] = [],
): ToolRegistry {
  const byId = new Map<string, ToolDefinition>();
  for (const definition of definitions) {
    checkToolDefinition(definition);
    if (RESERVED_TOOL_IDS.includes(definition.id)) {
      throw new ToolError('invalid_tool', `reserved:${definition.id}`);
    }
    if (byId.has(definition.id)) throw new ToolError('invalid_tool', `duplicate:${definition.id}`);
    byId.set(definition.id, deepFreeze(structuredClone(definition)));
  }
  for (const old of published) {
    const current = byId.get(old.toolId)?.versions[old.version - 1];
    if (current === undefined || canonicalJson(current) !== canonicalJson(old)) {
      throw new ToolError('invalid_tool', `published_version_changed:${old.toolId}@${old.version}`);
    }
  }
  const all = Object.freeze([...byId.values()]);
  return Object.freeze({
    list: () => all,
    find: (id: string) => byId.get(id),
    resolve(id: string, version: number): ResolvedTool | undefined {
      const definition = byId.get(id);
      const found = definition?.versions[version - 1];
      if (definition === undefined || found === undefined || found.version !== version) {
        return undefined;
      }
      return Object.freeze({ definition, version: found });
    },
  });
}

const MESSAGE_SEND_INPUT: ToolVersion['inputSchema'] = {
  type: 'object',
  properties: {
    conversationId: { type: 'string', minLength: 36, maxLength: 36 },
    messageId: { type: 'string', minLength: 36, maxLength: 36 },
  },
  required: ['conversationId', 'messageId'],
};

const MESSAGE_SEND_OUTPUT: ToolVersion['outputSchema'] = {
  type: 'object',
  properties: {
    messageId: { type: 'string', minLength: 36, maxLength: 36 },
    status: { type: 'string', maxLength: 16, enum: ['sent'] },
  },
  required: ['messageId', 'status'],
};

/**
 * `message_send` (CV-2, ADR-0034): a person replies, as themselves, in one of their
 * organization's conversations. Version 1 is the only tool version a person may invoke directly,
 * and the runtime can never invoke it: it names `human` alone. Versions 2 and 3 (CV-6B) are the
 * runtime's, for an agent's reply. Its input names the conversation and the
 * already reserved message, nothing else: the recipient, the channel account and the credentials
 * are derived on the server from the conversation, never taken from a caller.
 */
export const MESSAGE_SEND_TOOL: ToolDefinition = {
  id: 'message_send' as ToolDefinition['id'],
  status: 'active',
  versions: [
    {
      toolId: 'message_send' as ToolVersion['toolId'],
      version: 1,
      nameKey: 'tools.message_send.name' as ToolVersion['nameKey'],
      descriptionKey: 'tools.message_send.description' as ToolVersion['descriptionKey'],
      category: 'communication',
      action: 'send',
      mutating: true,
      inputSchema: MESSAGE_SEND_INPUT,
      outputSchema: MESSAGE_SEND_OUTPUT,
      permissions: ['conversation.send'],
      credentials: [{ provider: 'whatsapp', scopes: ['whatsapp_business_messaging'] }],
      riskLevel: 'medium',
      approvalPolicy: 'auto',
      approvalTtlSeconds: 600,
      timeoutMs: 15_000,
      // Never retried: a second call could send the message twice (the Cloud API has no key).
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'external', id: 'channel' },
      environments: ['dev'],
      invocationModes: ['human'],
    },
    // CV-6B (ADR-0043): an agent's reply, sent by the runtime for the conversation's agent. The
    // same input, output and executor as a person's; never a person's to invoke. Version 2 is
    // for `supervised` agents: a person approves the exact reply before it goes out.
    {
      toolId: 'message_send' as ToolVersion['toolId'],
      version: 2,
      nameKey: 'tools.message_send.name' as ToolVersion['nameKey'],
      descriptionKey: 'tools.message_send.description' as ToolVersion['descriptionKey'],
      category: 'communication',
      action: 'send',
      mutating: true,
      inputSchema: MESSAGE_SEND_INPUT,
      outputSchema: MESSAGE_SEND_OUTPUT,
      permissions: ['conversation.send'],
      credentials: [{ provider: 'whatsapp', scopes: ['whatsapp_business_messaging'] }],
      riskLevel: 'medium',
      approvalPolicy: 'approval_required',
      approvalTtlSeconds: 3_600,
      timeoutMs: 15_000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'external', id: 'channel' },
      environments: ['dev'],
      invocationModes: ['runtime'],
    },
    // Version 3 is for `autonomous` agents: the reply goes out once every check passes, with no
    // approval. An agent can only use the versions its own configuration lists.
    {
      toolId: 'message_send' as ToolVersion['toolId'],
      version: 3,
      nameKey: 'tools.message_send.name' as ToolVersion['nameKey'],
      descriptionKey: 'tools.message_send.description' as ToolVersion['descriptionKey'],
      category: 'communication',
      action: 'send',
      mutating: true,
      inputSchema: MESSAGE_SEND_INPUT,
      outputSchema: MESSAGE_SEND_OUTPUT,
      permissions: ['conversation.send'],
      credentials: [{ provider: 'whatsapp', scopes: ['whatsapp_business_messaging'] }],
      riskLevel: 'medium',
      approvalPolicy: 'auto',
      approvalTtlSeconds: 600,
      timeoutMs: 15_000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'external', id: 'channel' },
      environments: ['dev'],
      invocationModes: ['runtime'],
    },
  ],
};

/**
 * Why an agent hands a conversation to a person: the same closed list as the conversations
 * domain's `HANDOFF_REASONS` (a test keeps the two equal). A model never writes a reason.
 */
export const HANDOFF_REASON_CODES = [
  'customer_requested_human',
  'low_confidence',
  'tool_failed',
  'not_permitted',
  'sensitive_operation',
  'conflict',
  'too_many_attempts',
  'autonomy_limit',
  'credits_exhausted',
  'business_rule',
  'workflow',
  'outside_business_hours',
  'unresolved',
  'invalid_ai_output',
  'ai_unavailable',
  'channel_unavailable',
] as const;

/**
 * `conversation_handoff` (CV-6B, ADR-0043): the conversation's agent steps back and hands the
 * conversation to a person, with a reason code. The runtime only; it sends nothing outside
 * MelonOffice. Its executor uses the conversations domain's own `escalate`.
 */
export const CONVERSATION_HANDOFF_TOOL: ToolDefinition = {
  id: 'conversation_handoff' as ToolDefinition['id'],
  status: 'active',
  versions: [
    {
      toolId: 'conversation_handoff' as ToolVersion['toolId'],
      version: 1,
      nameKey: 'tools.conversation_handoff.name' as ToolVersion['nameKey'],
      descriptionKey: 'tools.conversation_handoff.description' as ToolVersion['descriptionKey'],
      category: 'communication',
      action: 'handoff',
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', minLength: 36, maxLength: 36 },
          reason: { type: 'string', maxLength: 64, enum: [...HANDOFF_REASON_CODES] },
        },
        required: ['conversationId', 'reason'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', minLength: 36, maxLength: 36 },
          status: { type: 'string', maxLength: 16, enum: ['escalated'] },
        },
        required: ['conversationId', 'status'],
      },
      permissions: ['conversation.manage'],
      credentials: [],
      riskLevel: 'low',
      approvalPolicy: 'auto',
      approvalTtlSeconds: 600,
      timeoutMs: 10_000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'internal', id: 'conversation' },
      environments: ['dev'],
      invocationModes: ['runtime'],
    },
  ],
};

/** The follow-up types, as the conversations domain lists them (a test keeps the two equal). */
export const FOLLOW_UP_TYPE_CODES = ['follow_up', 'call', 'message', 'review', 'check_in'] as const;

/**
 * `follow_up_schedule` (TL-1, ADR-0068): a person schedules a follow-up in their organization,
 * directly or by confirming what GIA proposed. It wraps the follow-up service's own `create`,
 * which checks the contact, the opportunity, the assignee and the time, and is idempotent by
 * `requestKey`: a repeat returns the follow-up it made. It sends nothing outside MelonOffice.
 * Version 1 is a person's only; the runtime cannot invoke it.
 */
export const FOLLOW_UP_SCHEDULE_TOOL: ToolDefinition = {
  id: 'follow_up_schedule' as ToolDefinition['id'],
  status: 'active',
  versions: [
    {
      toolId: 'follow_up_schedule' as ToolVersion['toolId'],
      version: 1,
      nameKey: 'tools.follow_up_schedule.name' as ToolVersion['nameKey'],
      descriptionKey: 'tools.follow_up_schedule.description' as ToolVersion['descriptionKey'],
      category: 'crm',
      action: 'schedule',
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          requestKey: { type: 'string', minLength: 8, maxLength: 128 },
          contactId: { type: 'string', minLength: 36, maxLength: 36 },
          opportunityId: { type: 'string', minLength: 36, maxLength: 36 },
          type: { type: 'string', maxLength: 16, enum: [...FOLLOW_UP_TYPE_CODES] },
          title: { type: 'string', maxLength: 1_000 },
          description: { type: 'string', maxLength: 5_000 },
          date: { type: 'string', maxLength: 10 },
          time: { type: 'string', maxLength: 5 },
          assignedTo: { type: 'string', minLength: 36, maxLength: 36 },
          source: { type: 'string', maxLength: 8, enum: ['manual', 'gia'] },
        },
        required: ['requestKey', 'contactId', 'title', 'date', 'time'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          followUpId: { type: 'string', minLength: 36, maxLength: 36 },
          created: { type: 'boolean' },
        },
        required: ['followUpId', 'created'],
      },
      permissions: ['follow_up.manage'],
      credentials: [],
      riskLevel: 'low',
      approvalPolicy: 'auto',
      approvalTtlSeconds: 600,
      timeoutMs: 15_000,
      // Never retried here: the person's own retry repeats it, and `requestKey` keeps it one.
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'internal', id: 'follow_up' },
      environments: ['dev'],
      invocationModes: ['human'],
    },
    // Version 2 is an agent's (ADR-0084): the commercial agent schedules a follow-up it proposed
    // in a task, and a person approves the exact follow-up (contact, date, time, title) first,
    // every time. It never assigns anyone or links an opportunity: the follow-up goes to the
    // contact's responsible person, as the service decides.
    {
      toolId: 'follow_up_schedule' as ToolVersion['toolId'],
      version: 2,
      nameKey: 'tools.follow_up_schedule.name' as ToolVersion['nameKey'],
      descriptionKey: 'tools.follow_up_schedule.description' as ToolVersion['descriptionKey'],
      category: 'crm',
      action: 'schedule',
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          requestKey: { type: 'string', minLength: 8, maxLength: 128 },
          contactId: { type: 'string', minLength: 36, maxLength: 36 },
          type: { type: 'string', maxLength: 16, enum: [...FOLLOW_UP_TYPE_CODES] },
          title: { type: 'string', maxLength: 1_000 },
          date: { type: 'string', maxLength: 10 },
          time: { type: 'string', maxLength: 5 },
          source: { type: 'string', maxLength: 8, enum: ['agent'] },
        },
        required: ['requestKey', 'contactId', 'title', 'date', 'time', 'source'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          followUpId: { type: 'string', minLength: 36, maxLength: 36 },
          created: { type: 'boolean' },
        },
        required: ['followUpId', 'created'],
      },
      permissions: ['follow_up.manage'],
      credentials: [],
      riskLevel: 'low',
      approvalPolicy: 'approval_required',
      // Two days to decide: a proposal older than that is asked again in a new task.
      approvalTtlSeconds: 2 * 24 * 3600,
      timeoutMs: 15_000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'internal', id: 'follow_up' },
      environments: ['dev'],
      invocationModes: ['runtime'],
    },
    // Version 3 is the first tool a model may ask for in the middle of a task (ADR-0104, Geovet
    // 2026-09-30): the commercial agent schedules a follow-up with one of the contacts it was
    // shown, by the contact's reference only. The server resolves the reference to the contact,
    // in the task's organization and as the person the task is for, and makes the request key;
    // the model never names an id. A person approves every call (level C), and nothing else
    // changes: the follow-up service's own `create`, with source `agent`.
    {
      toolId: 'follow_up_schedule' as ToolVersion['toolId'],
      version: 3,
      nameKey: 'tools.follow_up_schedule.name' as ToolVersion['nameKey'],
      descriptionKey: 'tools.follow_up_schedule.description' as ToolVersion['descriptionKey'],
      category: 'crm',
      action: 'schedule',
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          contact: { type: 'string', minLength: 12, maxLength: 12 },
          type: { type: 'string', maxLength: 16, enum: [...FOLLOW_UP_TYPE_CODES] },
          title: { type: 'string', minLength: 1, maxLength: 120 },
          date: { type: 'string', minLength: 10, maxLength: 10 },
          time: { type: 'string', minLength: 5, maxLength: 5 },
        },
        required: ['contact', 'type', 'title', 'date', 'time'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          followUpId: { type: 'string', minLength: 36, maxLength: 36 },
          created: { type: 'boolean' },
        },
        required: ['followUpId', 'created'],
      },
      // `contact.read`: the reference is resolved among the contacts this person may read.
      permissions: ['follow_up.manage', 'contact.read'],
      credentials: [],
      riskLevel: 'low',
      approvalPolicy: 'approval_required',
      approvalTtlSeconds: 2 * 24 * 3600,
      timeoutMs: 15_000,
      // Never retried here; a repeat of the same request makes the same follow-up (its key).
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'internal', id: 'follow_up' },
      environments: ['dev'],
      invocationModes: ['runtime', 'model'],
    },
  ],
};

/** How many facts one `knowledge_search` call gives back, and how long each value may be. */
export const KNOWLEDGE_SEARCH_LIMITS = Object.freeze({ facts: 10, label: 200, value: 1_000 });

/**
 * `knowledge_search` (RT-1, ADR-0130): the first read tool (level A) an agent's model may ask for in
 * the middle of a task. It searches the company memory (Company Brain, ADR-0051), which also holds
 * what was read from the organization's documents (ADR-0078, ADR-0079), for a few words, with the
 * same rules as the context a task starts with: the agent's department's domains and sensitivity
 * ceiling, as the person the task is for. It changes nothing, so it runs without a person's
 * approval at every level of autonomy (ADR-0116). The input is the words alone: the department,
 * the organization and the person come from the execution, never from the model.
 */
export const KNOWLEDGE_SEARCH_TOOL: ToolDefinition = {
  id: 'knowledge_search' as ToolDefinition['id'],
  status: 'active',
  versions: [
    {
      toolId: 'knowledge_search' as ToolVersion['toolId'],
      version: 1,
      nameKey: 'tools.knowledge_search.name' as ToolVersion['nameKey'],
      descriptionKey: 'tools.knowledge_search.description' as ToolVersion['descriptionKey'],
      category: 'knowledge',
      action: 'search',
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 2, maxLength: 200 } },
        required: ['query'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          available: { type: 'boolean' },
          facts: {
            type: 'array',
            maxItems: KNOWLEDGE_SEARCH_LIMITS.facts,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', minLength: 1, maxLength: KNOWLEDGE_SEARCH_LIMITS.label },
                value: { type: 'string', maxLength: KNOWLEDGE_SEARCH_LIMITS.value },
                confirmed: { type: 'boolean' },
              },
              required: ['label', 'value', 'confirmed'],
            },
          },
          truncated: { type: 'boolean' },
        },
        required: ['available', 'facts', 'truncated'],
      },
      permissions: ['knowledge.read'],
      credentials: [],
      riskLevel: 'low',
      approvalPolicy: 'auto',
      approvalTtlSeconds: 600,
      timeoutMs: 10_000,
      // Its failures (no permission, invalid words) would fail the same way again.
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'internal', id: 'knowledge' },
      environments: ['dev'],
      invocationModes: ['runtime', 'model'],
    },
  ],
};

const COUNT = { type: 'integer', minimum: 0 } as const;

/** How many currencies an amount list holds at most. */
export const CUSTOMER_RECORDS_LIMITS = Object.freeze({ currencies: 10 });

/**
 * `customer_records_summary` (TL-2, ADR-0160): the organization's own customer records, as a plan's
 * tool step reads them. It changes nothing and reaches no provider. Counts and totals only, from
 * the commercial insights (C4): no names, titles, phone numbers or records, as the context a task
 * starts with (ADR-0102). Each part is there only when the agent's configuration lists its
 * permission and the person the plan runs for may read it. It takes no input: the organization,
 * the agent and the person come from the execution. Runtime only: no model asks for it.
 */
export const CUSTOMER_RECORDS_TOOL: ToolDefinition = {
  id: 'customer_records_summary' as ToolDefinition['id'],
  status: 'active',
  versions: [
    {
      toolId: 'customer_records_summary' as ToolVersion['toolId'],
      version: 1,
      nameKey: 'tools.customer_records_summary.name' as ToolVersion['nameKey'],
      descriptionKey: 'tools.customer_records_summary.description' as ToolVersion['descriptionKey'],
      category: 'crm',
      action: 'read',
      mutating: false,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: {
        type: 'object',
        properties: {
          available: { type: 'boolean' },
          today: { type: 'string', maxLength: 10 },
          contacts: {
            type: 'object',
            properties: {
              leads: COUNT,
              customers: COUNT,
              inactive: COUNT,
              leadsWithoutNextAction: COUNT,
              overdueNextAction: COUNT,
              newThisWeek: COUNT,
            },
            required: [
              'leads',
              'customers',
              'inactive',
              'leadsWithoutNextAction',
              'overdueNextAction',
              'newThisWeek',
            ],
          },
          opportunities: {
            type: 'object',
            properties: {
              open: COUNT,
              won: COUNT,
              lost: COUNT,
              closingSoon: COUNT,
              closeDatePassed: COUNT,
              quiet: COUNT,
              openValue: {
                type: 'array',
                maxItems: CUSTOMER_RECORDS_LIMITS.currencies,
                items: {
                  type: 'object',
                  properties: {
                    currency: { type: 'string', minLength: 3, maxLength: 3 },
                    amountMinor: COUNT,
                  },
                  required: ['currency', 'amountMinor'],
                },
              },
            },
            required: [
              'open',
              'won',
              'lost',
              'closingSoon',
              'closeDatePassed',
              'quiet',
              'openValue',
            ],
          },
          followUps: {
            type: 'object',
            properties: { open: COUNT, overdue: COUNT, today: COUNT },
            required: ['open', 'overdue', 'today'],
          },
        },
        required: ['available'],
      },
      permissions: [],
      credentials: [],
      riskLevel: 'low',
      approvalPolicy: 'auto',
      approvalTtlSeconds: 600,
      timeoutMs: 10_000,
      // Its failures (no permission, records unavailable) would fail the same way again.
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'internal', id: 'crm' },
      environments: ['dev'],
      invocationModes: ['runtime'],
    },
  ],
};

/**
 * MelonOffice's tool catalogue. Only what exists, with its executor: tools are never invented.
 * Today, `message_send` (CV-2: a person's send; CV-6B: an agent's reply),
 * `conversation_handoff` (CV-6B), `follow_up_schedule` (TL-1), `knowledge_search` (RT-1) and
 * `customer_records_summary` (TL-2).
 */
export const TOOL_CATALOGUE: readonly ToolDefinition[] = Object.freeze([
  MESSAGE_SEND_TOOL,
  CONVERSATION_HANDOFF_TOOL,
  FOLLOW_UP_SCHEDULE_TOOL,
  KNOWLEDGE_SEARCH_TOOL,
  CUSTOMER_RECORDS_TOOL,
]);

export const defaultToolRegistry = (): ToolRegistry => createToolRegistry(TOOL_CATALOGUE);
