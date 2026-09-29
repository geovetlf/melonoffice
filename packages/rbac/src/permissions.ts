/**
 * Every permission MelonOffice knows, in one place (ADR-0019). Ids are `resource.action` and
 * never change once used; a permission is added here only when something checks it.
 */
export const PERMISSIONS = {
  'organization.read': {
    resource: 'organization',
    action: 'read',
    description: 'See the organization and your own membership in it.',
  },
  'organization.update': {
    resource: 'organization',
    action: 'update',
    description:
      "Fill in or change the organization's business profile, directly and never through GIA (ADR-0048).",
  },
  'activity.read': {
    resource: 'activity',
    action: 'read',
    description:
      "See what happened in the organization's office, read from the audit trail (ADR-0049).",
  },
  'gia.ask': {
    resource: 'gia',
    action: 'ask',
    description:
      'Talk to GIA: she answers from what you may read, through the AI Gateway, spending credits; she changes nothing (ADR-0052).',
  },
  'decision.evaluate': {
    resource: 'decision',
    action: 'evaluate',
    description:
      'Ask the Decision Engine what to attend to, whether an action needs approval and which agent fits, from what you may read; it decides and explains, and runs nothing (ADR-0065).',
  },
  'knowledge.read': {
    resource: 'knowledge',
    action: 'read',
    description:
      "Read the organization's Company Brain up to confidential knowledge, and give that context to GIA and agents (ADR-0051).",
  },
  'knowledge.read_restricted': {
    resource: 'knowledge',
    action: 'read_restricted',
    description:
      'Also read restricted Company Brain knowledge: costs, margins, finances (ADR-0051).',
  },
  'knowledge.propose': {
    resource: 'knowledge',
    action: 'propose',
    description:
      'Add facts to Company Brain. From GIA or an agent they are proposals; documents are unverified (ADR-0051).',
  },
  'knowledge.manage': {
    resource: 'knowledge',
    action: 'manage',
    description:
      'Confirm, change, invalidate or archive Company Brain facts and decide conflicts, directly and never through GIA (ADR-0051).',
  },
  'knowledge.capture': {
    resource: 'knowledge',
    action: 'capture',
    description:
      'Have GIA extract facts from what you write or from a document, through the AI Gateway, spending credits (ADR-0051).',
  },
  'entitlement.read': {
    resource: 'entitlement',
    action: 'read',
    description: "See the organization's plan, capabilities and limits (ADR-0021).",
  },
  'billing.read': {
    resource: 'billing',
    action: 'read',
    description: "See the organization's subscription: its plan and status (ADR-0022).",
  },
  'execution.read': {
    resource: 'execution',
    action: 'read',
    description: "See one of the organization's executions: status, graph and versions (ADR-0024).",
  },
  'execution.start': {
    resource: 'execution',
    action: 'start',
    description:
      'Start a pending execution, directly and never through GIA or the planner (ADR-0029); the runtime starts only work its person configured to start by itself (ADR-0043).',
  },
  'execution.cancel': {
    resource: 'execution',
    action: 'cancel',
    description:
      'Ask an execution to stop, directly. Cooperative: it reaches its children, never kills (ADR-0029).',
  },
  'department.read': {
    resource: 'department',
    action: 'read',
    description: "See the organization's departments and their status (ADR-0025).",
  },
  'specialist.read': {
    resource: 'specialist',
    action: 'read',
    description:
      "See the organization's specialists: role, department, status and version (ADR-0025).",
  },
  'specialist.manage': {
    resource: 'specialist',
    action: 'manage',
    description:
      "Create the organization's agents from a template, change their configuration as a new version and change their status (ADR-0062). A person directly, never GIA or the runtime.",
  },
  'specialist.task': {
    resource: 'specialist',
    action: 'task',
    description:
      "Ask one of the organization's active agents to do a task (ADR-0063). A person directly, never GIA or the runtime; the agent answers, it does not act.",
  },
  'tool.read': {
    resource: 'tool',
    action: 'read',
    description:
      'See the tools the product offers: name, version, risk and approval policy (ADR-0026).',
  },
  'tool.execute': {
    resource: 'tool',
    action: 'execute',
    description:
      'Let an execution run a tool for you. Checked by the tool gate, never by a client route (ADR-0026).',
  },
  'approval.read': {
    resource: 'approval',
    action: 'read',
    description: "See the organization's tool approvals and their status (ADR-0026).",
  },
  'approval.approve': {
    resource: 'approval',
    action: 'approve',
    description:
      'Approve or reject a pending tool approval, directly and never through GIA (ADR-0026).',
  },
  'ai.generate': {
    resource: 'ai',
    action: 'generate',
    description:
      'Let an execution call an AI model for you. Checked by the AI Gateway, never by a client route (ADR-0027).',
  },
  'plan.read': {
    resource: 'plan',
    action: 'read',
    description: "See the organization's plans: steps, specialists, risk and status (ADR-0028).",
  },
  'plan.create': {
    resource: 'plan',
    action: 'create',
    description:
      'Make a plan: the planner on the server, or a workflow you plan (ADR-0028, ADR-0071). A plan always waits for your approval.',
  },
  'workflow.read': {
    resource: 'workflow',
    action: 'read',
    description: "See the organization's workflows and their versions (ADR-0028).",
  },
  'workflow.manage': {
    resource: 'workflow',
    action: 'manage',
    description: "Create, version and activate the organization's workflows (ADR-0028, ADR-0071).",
  },
  'conversation.read': {
    resource: 'conversation',
    action: 'read',
    description: "See the organization's conversations and their messages: the inbox (ADR-0033).",
  },
  'conversation.manage': {
    resource: 'conversation',
    action: 'manage',
    description:
      "Assign the organization's conversations, change their status and tags (ADR-0033). Not sending.",
  },
  'conversation.send': {
    resource: 'conversation',
    action: 'send',
    description:
      "Reply in the organization's conversations as oneself, through the tool gate: one person, one message, no automation (ADR-0034).",
  },
  'conversation.assist': {
    resource: 'conversation',
    action: 'assist',
    description:
      'Ask the AI Gateway, as oneself, about a conversation one can read: a summary, the intent, a suggested reply or next steps. It only returns text to review: it never sends, changes or runs anything (ADR-0037).',
  },
  'contact.manage': {
    resource: 'contact',
    action: 'manage',
    description:
      'Enter contacts and manage leads and customers: stage, responsible member, consent, next action and notes, directly and never through GIA (C1, ADR-0053).',
  },
  'contact.read': {
    resource: 'contact',
    action: 'read',
    description: "See the organization's contacts and their channel identities (ADR-0033).",
  },
  'opportunity.read': {
    resource: 'opportunity',
    action: 'read',
    description:
      "See the organization's pipeline and opportunities with their totals (C2, ADR-0054). GIA may read them for the person she helps.",
  },
  'opportunity.manage': {
    resource: 'opportunity',
    action: 'manage',
    description:
      'Open opportunities and move them through the pipeline to won or lost: value, probability, responsible member, expected close and next action, directly and never through GIA (C2, ADR-0054).',
  },
  'follow_up.read': {
    resource: 'follow_up',
    action: 'read',
    description:
      "See the organization's scheduled follow-ups of contacts and opportunities: due, overdue and upcoming (C5, ADR-0058). GIA may read them for the person she helps.",
  },
  'follow_up.manage': {
    resource: 'follow_up',
    action: 'manage',
    description:
      'Schedule, change, reschedule, complete and cancel follow-ups, directly: GIA only proposes one, and a person confirms it (C5, ADR-0058). It never sends anything to a contact.',
  },
  'forecast.read': {
    resource: 'forecast',
    action: 'read',
    description:
      "See the organization's forecasts (ADR-0059). Each one also needs the permission of the records it was built from. GIA may read them for the person she helps.",
  },
  'forecast.run': {
    resource: 'forecast',
    action: 'run',
    description:
      'Ask the Forecasting Engine for a forecast of a metric one may read, directly or through GIA (ADR-0059). A model run costs credits; it never changes or sends anything.',
  },
  'report.read': {
    resource: 'report',
    action: 'read',
    description:
      "See the organization's reports: what was recorded per day, week or month for each metric (ADR-0060). Each metric also needs the permission of its records. Nothing is projected, charged or changed.",
  },
  'pipeline.manage': {
    resource: 'pipeline',
    action: 'manage',
    description:
      "Change the organization's pipeline stages: names, order, probabilities, added or removed open stages (C2, ADR-0054).",
  },
  'channel.read': {
    resource: 'channel',
    action: 'read',
    description:
      "See the organization's connections to outside services: provider, account, status and capabilities, never secrets (ADR-0033, ADR-0044).",
  },
  'channel.create': {
    resource: 'channel',
    action: 'create',
    description:
      "Add a connection to an outside service through a registered provider, within the plan's categories and connection limit. Only references to its secrets are stored (ADR-0044).",
  },
  'channel.update': {
    resource: 'channel',
    action: 'update',
    description:
      'Rename a connection, check its credentials with its provider (connect) and pause it. Never where its secrets are (ADR-0044).',
  },
  'channel.disconnect': {
    resource: 'channel',
    action: 'disconnect',
    description:
      'Turn a connection off: its webhooks are refused, nothing is sent and its plan slot is free. It can be connected again (ADR-0044).',
  },
  'channel.delete': {
    resource: 'channel',
    action: 'delete',
    description:
      'Delete a connection for good (revoked): it is kept only as history and never used again (ADR-0044).',
  },
  'credits.read': {
    resource: 'credits',
    action: 'read',
    description: "See the organization's credit balance (ADR-0023).",
  },
  'ai_usage.read': {
    resource: 'ai_usage',
    action: 'read',
    description:
      "See what the organization's AI use cost, in total and by agent, department, workflow, task, capability, provider and model, and each operation's usage (ADR-0074). Codes and amounts only, never content.",
  },
} as const satisfies Record<string, PermissionDefinition>;

export interface PermissionDefinition {
  readonly resource: string;
  readonly action: string;
  readonly description: string;
}

export type Permission = keyof typeof PERMISSIONS;

/** Whether a value is a permission in the catalogue. Anything else is denied, never guessed. */
export const isPermission = (value: unknown): value is Permission =>
  typeof value === 'string' && Object.hasOwn(PERMISSIONS, value);
