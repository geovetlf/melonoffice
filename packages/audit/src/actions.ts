import type { AuditResult } from './event.js';

export interface AuditActionDefinition {
  readonly category:
    | 'auth'
    | 'tenancy'
    | 'authorization'
    | 'entitlements'
    | 'billing'
    | 'credits'
    | 'execution'
    | 'tool'
    | 'ai'
    | 'planning'
    | 'workflow'
    | 'conversation'
    | 'channel'
    | 'department'
    | 'specialist'
    | 'knowledge'
    | 'gia';
  readonly description: string;
  /** The results this action is recorded with. Anything else is a programming error. */
  readonly results: readonly AuditResult[];
}

/**
 * Every auditable action, in one place (ADR-0020). Ids are `category.verb`, stable once used. An
 * action is added only when the code that performs it records it.
 */
export const AUDIT_ACTIONS = {
  'auth.register': {
    category: 'auth',
    description: 'A verified identity signed in for the first time and got an internal user.',
    results: ['success'],
  },
  'auth.sign_in': {
    category: 'auth',
    description: 'An existing user signed in (POST /v1/me).',
    results: ['success'],
  },
  'organization.create': {
    category: 'tenancy',
    description: 'A user created an organization, or was refused or failed trying.',
    results: ['success', 'denied', 'failure'],
  },
  'organization.profile_updated': {
    category: 'tenancy',
    description:
      "A person created or changed the organization's business profile (ADR-0048); `reference` names the kind of business, never what the owner wrote.",
    results: ['success'],
  },
  'knowledge.created': {
    category: 'knowledge',
    description:
      "A fact entered the organization's Company Brain (ADR-0051); `reference` is `{domain}:{sourceType}`, `targetVersion` its revision. Never the value: that is the item's version.",
    results: ['success'],
  },
  'knowledge.updated': {
    category: 'knowledge',
    description:
      'A Company Brain fact took a new value (ADR-0051); the previous value stays as the version before `targetVersion`.',
    results: ['success'],
  },
  'knowledge.confirmed': {
    category: 'knowledge',
    description: 'A person, acting directly, confirmed a Company Brain fact (ADR-0051).',
    results: ['success'],
  },
  'knowledge.invalidated': {
    category: 'knowledge',
    description:
      'A person marked a Company Brain fact as no longer true (ADR-0051); it stays as history. `reason` is their code, when given.',
    results: ['success'],
  },
  'knowledge.archived': {
    category: 'knowledge',
    description: 'A person set a Company Brain fact aside (ADR-0051); it stays as history.',
    results: ['success'],
  },
  'knowledge.conflict_detected': {
    category: 'knowledge',
    description:
      'Two sources disagree on a Company Brain fact and nothing was chosen (ADR-0051); `reference` names the new source.',
    results: ['success'],
  },
  'knowledge.conflict_resolved': {
    category: 'knowledge',
    description:
      'A person decided a Company Brain conflict (ADR-0051); `reason` is `kept_current`, `took_candidate` or `replaced`.',
    results: ['success'],
  },
  'knowledge.document_ingested': {
    category: 'knowledge',
    description:
      'A document was given to Company Brain (ADR-0051); its facts are extracted as unverified. Never its text.',
    results: ['success'],
  },
  'gia.message_answered': {
    category: 'gia',
    description:
      'A person asked GIA and she answered, or was refused or failed (ADR-0052); `reference` is the credit reference of the call. Never the question or the answer.',
    results: ['success', 'denied', 'failure'],
  },
  'membership.create': {
    category: 'tenancy',
    description: 'A membership was created (today: the owner membership of a new organization).',
    results: ['success'],
  },
  'plan.assign': {
    category: 'entitlements',
    description: 'An organization was given a plan (today: its initial plan, when it is created).',
    results: ['success'],
  },
  'entitlements.override_set': {
    category: 'entitlements',
    description:
      "A platform operator set an audited value for one organization's entitlement key, applied after its plan; the plan itself is unchanged (ADR-0044).",
    results: ['success'],
  },
  'department.archived': {
    category: 'department',
    description:
      'A department of a retired catalogue type was archived by the catalogue migration (ADR-0047): kept as history, never deleted; `reference` names the department its work moved to.',
    results: ['success'],
  },
  'specialist.department_changed': {
    category: 'specialist',
    description:
      'A specialist moved to another department of its organization by the catalogue migration (ADR-0047), as a new configuration version (`targetVersion`); earlier versions stay as they were.',
    results: ['success'],
  },
  'billing.subscription_created': {
    category: 'billing',
    description:
      "An organization's subscription was created (today: its first, with the organization).",
    results: ['success'],
  },
  'execution.created': {
    category: 'execution',
    description: 'An execution was created for an organization (ADR-0024).',
    results: ['success'],
  },
  'execution.state_changed': {
    category: 'execution',
    description: "An execution's status changed; the event records from and to (ADR-0024).",
    results: ['success'],
  },
  'execution.start_denied': {
    category: 'execution',
    description:
      'A start was refused: not a user acting directly, or no execution.start (ADR-0029).',
    results: ['denied'],
  },
  'execution.cancel_denied': {
    category: 'execution',
    description:
      'A cancellation was refused: not a user acting directly, or no execution.cancel (ADR-0029).',
    results: ['denied'],
  },
  'execution.verification_recorded': {
    category: 'execution',
    description:
      "The runtime recorded a verifier's evidence; the reason says passed or failed (ADR-0029).",
    results: ['success'],
  },
  'execution.node_retried': {
    category: 'execution',
    description:
      'The runtime re-ran a failed node; the reason names the attempt rule that allowed it (ADR-0029).',
    results: ['success'],
  },
  'execution.node_changed': {
    category: 'execution',
    description:
      'The runtime or the tool gate moved one node; the transition gives its status before and after, nodeId which node (ADR-0031).',
    results: ['success'],
  },
  'execution.job_released': {
    category: 'execution',
    description:
      'The lease holder gave a job back without ending it, because its node waits on a human approval, or its write was refused with the reason (ADR-0031).',
    results: ['success', 'denied'],
  },
  'execution.job_enqueued': {
    category: 'execution',
    description:
      'A job to run one node at one attempt was created, once; the job field names it (ADR-0030).',
    results: ['success'],
  },
  'execution.job_leased': {
    category: 'execution',
    description:
      'A worker took the lease of a job, or was refused it or its turn on it with the reason (ADR-0030, ADR-0031).',
    results: ['success', 'denied'],
  },
  'execution.job_finished': {
    category: 'execution',
    description:
      "A job's lease holder recorded how it ended (success, or failure with its code), or its write was refused with the reason (ADR-0030).",
    results: ['success', 'failure', 'denied'],
  },
  'execution.job_cancelled': {
    category: 'execution',
    description: 'A job was cancelled because its execution ended (ADR-0030).',
    results: ['success'],
  },
  'execution.node_outcome_unknown': {
    category: 'execution',
    description:
      "The runtime recorded that a running node's outcome is unknown; it is never re-run (ADR-0029).",
    results: ['success'],
  },
  'tool.authorization_checked': {
    category: 'tool',
    description:
      'The tool gate checked whether a tool may run for an execution node: allowed or denied, with the reason (ADR-0026).',
    results: ['success', 'denied'],
  },
  'tool.execution_requested': {
    category: 'tool',
    description: 'An execution node asked to run a tool version (ADR-0026).',
    results: ['success'],
  },
  'tool.execution_denied': {
    category: 'tool',
    description: 'A tool did not run because a guardrail or its approval refused it (ADR-0026).',
    results: ['denied'],
  },
  'tool.execution_completed': {
    category: 'tool',
    description: 'A tool ran and its output passed the post-execution guardrails (ADR-0026).',
    results: ['success'],
  },
  'tool.execution_failed': {
    category: 'tool',
    description:
      'A tool ran and failed, timed out, or its output was rejected by the post-execution guardrails (ADR-0026).',
    results: ['failure'],
  },
  'tool.approval_requested': {
    category: 'tool',
    description: 'A tool call needs a human approval, and one was requested (ADR-0026).',
    results: ['success'],
  },
  'tool.approval_approved': {
    category: 'tool',
    description: 'A user approved a pending tool approval, or was refused trying (ADR-0026).',
    results: ['success', 'denied'],
  },
  'tool.approval_rejected': {
    category: 'tool',
    description: 'A user rejected a pending tool approval, or was refused trying (ADR-0026).',
    results: ['success', 'denied'],
  },
  'tool.approval_expired': {
    category: 'tool',
    description: 'A pending tool approval ran out of time (ADR-0026).',
    results: ['success'],
  },
  'tool.approval_cancelled': {
    category: 'tool',
    description:
      'A pending tool approval was withdrawn, e.g. because its execution ended (ADR-0026).',
    results: ['success'],
  },
  'ai.request_denied': {
    category: 'ai',
    description:
      'The AI Gateway refused a call before any provider saw it: validation, authorization, policy, routing or credits (ADR-0027).',
    results: ['denied'],
  },
  'ai.provider_fallback': {
    category: 'ai',
    description:
      'The chosen model could not serve an AI call and the policy let another compatible model answer (ADR-0027).',
    results: ['success'],
  },
  'ai.request_failed': {
    category: 'ai',
    description:
      'An AI call reached a provider and did not complete: provider error, invalid response or charge failure (ADR-0027).',
    results: ['failure'],
  },
  'plan.created': {
    category: 'planning',
    description:
      'A plan version passed validation and was stored for an execution; it runs nothing (ADR-0028).',
    results: ['success'],
  },
  'plan.proposal_refused': {
    category: 'planning',
    description:
      'A planner or workflow proposal failed validation and no plan was stored; the reason is the first check it failed (ADR-0028).',
    results: ['denied'],
  },
  'plan.approved': {
    category: 'planning',
    description:
      'A user approved one exact plan version, directly and never through GIA, or was refused trying (ADR-0028).',
    results: ['success', 'denied'],
  },
  'plan.rejected': {
    category: 'planning',
    description:
      'A user rejected one exact plan version, directly and never through GIA, or was refused trying (ADR-0028).',
    results: ['success', 'denied'],
  },
  'plan.state_changed': {
    category: 'planning',
    description: "A plan's status changed; the event records from and to (ADR-0028).",
    results: ['success'],
  },
  'delegation.created': {
    category: 'planning',
    description:
      "A plan step was handed to an eligible specialist's own child execution; nothing ran (ADR-0028).",
    results: ['success'],
  },
  'workflow.created': {
    category: 'workflow',
    description: 'A workflow was created in draft, with its first version (ADR-0028).',
    results: ['success'],
  },
  'workflow.version_created': {
    category: 'workflow',
    description:
      'A new write-once version of a workflow was stored; earlier versions stay as they were (ADR-0028).',
    results: ['success'],
  },
  'workflow.state_changed': {
    category: 'workflow',
    description:
      "A workflow's status changed (activated, paused, archived); the event records from and to (ADR-0028).",
    results: ['success'],
  },
  'conversation.assigned': {
    category: 'conversation',
    description:
      'A person set or cleared who is responsible for a conversation: a member and or a department (ADR-0033).',
    results: ['success'],
  },
  'conversation.status_changed': {
    category: 'conversation',
    description:
      "A person changed a conversation's status (open, pending, closed); the event records from and to (ADR-0033).",
    results: ['success'],
  },
  'conversation.tags_changed': {
    category: 'conversation',
    description: "A person added or removed a conversation's tags (ADR-0033).",
    results: ['success'],
  },
  'conversation.priority_changed': {
    category: 'conversation',
    description:
      "A person changed a conversation's priority (low, normal, high, urgent); the event records from and to (CV-3).",
    results: ['success'],
  },
  'conversation.message_sent': {
    category: 'conversation',
    description:
      'A person sent a message in a conversation through the tool gate and the channel accepted it; the target is the message, the reference its conversation, the reason the channel (ADR-0034).',
    results: ['success'],
  },
  'conversation.message_send_failed': {
    category: 'conversation',
    description:
      "A person's message was not sent: refused before sending, or rejected by the channel; the reason is the stable code (ADR-0034).",
    results: ['failure', 'denied'],
  },
  'conversation.message_send_unknown': {
    category: 'conversation',
    description:
      "Whether a person's message reached the channel is not known (lost answer, timeout); it is never resent blindly (ADR-0034).",
    results: ['failure'],
  },
  'conversation.message_received': {
    category: 'conversation',
    description:
      "A contact's message arrived through a verified channel webhook and was stored once; the reference is the conversation (ADR-0044).",
    results: ['success'],
  },
  'conversation.ai_summary_requested': {
    category: 'conversation',
    description:
      "A person asked the AI Gateway for a summary of a conversation; the reason is the failure code, the reference the AI call's credits reference, never the text (ADR-0037).",
    results: ['success', 'denied', 'failure'],
  },
  'conversation.ai_intent_analyzed': {
    category: 'conversation',
    description:
      "A person asked the AI Gateway for a conversation's intent; the reason is the failure code, the reference the AI call's credits reference, never the text (ADR-0037).",
    results: ['success', 'denied', 'failure'],
  },
  'conversation.ai_reply_suggested': {
    category: 'conversation',
    description:
      "A person asked the AI Gateway for a suggested reply, which is never sent by itself; the reason is the failure code, the reference the AI call's credits reference, never the text (ADR-0037).",
    results: ['success', 'denied', 'failure'],
  },
  'conversation.ai_next_steps_suggested': {
    category: 'conversation',
    description:
      "A person asked the AI Gateway for next steps for a conversation, which run nothing; the reason is the failure code, the reference the AI call's credits reference, never the text (ADR-0037).",
    results: ['success', 'denied', 'failure'],
  },
  'conversation.autonomy_changed': {
    category: 'conversation',
    description:
      "A person changed how far AI may act on the organization's conversations (manual, assisted, supervised, autonomous); the event records from and to. A restriction only, never a permission (ADR-0039).",
    results: ['success'],
  },
  'conversation.ai_human_takeover': {
    category: 'conversation',
    description:
      'A person took control of a conversation an agent handled or escalated; AI is paused and any automatic send of the turn in progress is refused (ADR-0039).',
    results: ['success'],
  },
  'conversation.ai_handed_back': {
    category: 'conversation',
    description:
      'A person handed a conversation back to AI, where the organization allows AI handling (ADR-0039).',
    results: ['success'],
  },
  'conversation.ai_escalated': {
    category: 'conversation',
    description:
      'The runtime handed a conversation an agent handled to a person; the reason is the handoff code, the reference the execution when there is one (ADR-0039).',
    results: ['success'],
  },
  'conversation.agent_changed': {
    category: 'conversation',
    description:
      "A person chose which agent (a specialist with a conversation profile) attends the organization's conversations, or removed it; the reference is the agent (ADR-0043).",
    results: ['success'],
  },
  'conversation.ai_assigned': {
    category: 'conversation',
    description:
      "The organization's agent took a new conversation no one had handled, where autonomy allows it; the reference is the agent (ADR-0043).",
    results: ['success'],
  },
  'conversation.ai_turn_started': {
    category: 'conversation',
    description:
      "An inbound message started one agent turn: an execution for the conversation's agent. The reason is what started it, the reference the execution (ADR-0043).",
    results: ['success'],
  },
  'channel.connection_created': {
    category: 'channel',
    description:
      'A channel connection was configured for the organization; its secrets are references only (ADR-0033).',
    results: ['success'],
  },
  'channel.connection_updated': {
    category: 'channel',
    description:
      'A person changed a channel connection: renamed it, or started checking it with its provider (ADR-0044).',
    results: ['success'],
  },
  'channel.connection_checked': {
    category: 'channel',
    description:
      "A channel connection's credentials were checked with its provider: connected, or in error with the provider's code (ADR-0044).",
    results: ['success', 'failure'],
  },
  'channel.connection_paused': {
    category: 'channel',
    description:
      'A person paused a channel connection: nothing is sent on it; inbound messages are still stored (ADR-0044).',
    results: ['success'],
  },
  'channel.connection_disconnected': {
    category: 'channel',
    description:
      'A person turned a channel connection off: its webhooks are refused and its plan slot is free (ADR-0044).',
    results: ['success'],
  },
  'channel.connection_revoked': {
    category: 'channel',
    description:
      'A person deleted a channel connection: it is kept only as history and never used again (ADR-0044).',
    results: ['success'],
  },
  'channel.connection_failed': {
    category: 'channel',
    description:
      "The provider refused a channel connection's credentials during a send: it is in error until a person checks it again (ADR-0044).",
    results: ['failure'],
  },
  'channel.template_registered': {
    category: 'channel',
    description:
      "A person registered one of the organization's provider-approved templates on a connection, by name and language; nothing is sent until the provider confirms it (ADR-0046).",
    results: ['success'],
  },
  'channel.template_checked': {
    category: 'channel',
    description:
      'A template was checked with its provider: active (approved, parameters recorded) or invalid with a stable code (ADR-0046).',
    results: ['success', 'failure'],
  },
  'channel.template_disabled': {
    category: 'channel',
    description: 'A person turned a template off: it is never sent until checked again (ADR-0046).',
    results: ['success'],
  },
  'channel.delivery_attempted': {
    category: 'channel',
    description:
      "One call to a channel's provider for one outbound message: sent, or failed with a stable code; `outcome_unknown` is never retried (ADR-0045).",
    results: ['success', 'failure'],
  },
  'channel.delivery_retry_scheduled': {
    category: 'channel',
    description:
      'The provider surely did not take a message (a transient error), so the Integration Engine will call it again; the reason is the error (ADR-0045).',
    results: ['success'],
  },
  'channel.delivery_rate_limited': {
    category: 'channel',
    description:
      "A connection's send limit stopped an outbound message before its provider was called: nothing was sent (ADR-0045).",
    results: ['denied'],
  },
  'credits.grant': {
    category: 'credits',
    description: "Credits were added to an organization's wallet (ADR-0023).",
    results: ['success'],
  },
  'credits.consume': {
    category: 'credits',
    description: "Credits were spent from an organization's wallet.",
    results: ['success'],
  },
  'credits.refund': {
    category: 'credits',
    description: 'Credits were given back for an earlier consume.',
    results: ['success'],
  },
  'tenancy.resolve': {
    category: 'tenancy',
    description: 'A user asked to act in an organization and tenancy refused it.',
    results: ['denied'],
  },
  'authorization.check': {
    category: 'authorization',
    description: 'A member asked for an action and RBAC refused it.',
    results: ['denied'],
  },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const isAuditAction = (value: unknown): value is AuditAction =>
  typeof value === 'string' && Object.hasOwn(AUDIT_ACTIONS, value);
