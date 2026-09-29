import type { Permission } from './permissions.js';

/** A role is a named set of permissions and nothing more. */
export type RoleCatalogue = Readonly<Record<string, readonly Permission[]>>;

/**
 * The roles MelonOffice has today and exactly what each allows (ADR-0019). `owner` is listed
 * permission by permission: there is no "allow everything" role. Roles such as admin, manager or
 * member are added here, as data, when something needs them.
 */
export const ROLES = {
  owner: [
    'organization.read',
    'organization.update',
    'activity.read',
    'gia.ask',
    'decision.evaluate',
    'knowledge.read',
    'knowledge.read_restricted',
    'knowledge.propose',
    'knowledge.manage',
    'knowledge.capture',
    'document.read',
    'document.upload',
    'entitlement.read',
    'billing.read',
    'execution.read',
    'execution.start',
    'execution.cancel',
    'department.read',
    'specialist.read',
    'specialist.manage',
    'specialist.task',
    'tool.read',
    'tool.execute',
    'approval.read',
    'approval.approve',
    'ai.generate',
    'credits.read',
    'ai_usage.read',
    'plan.read',
    'plan.create',
    'workflow.read',
    'workflow.manage',
    'conversation.read',
    'conversation.manage',
    'conversation.send',
    'conversation.assist',
    'contact.read',
    'contact.manage',
    'opportunity.read',
    'opportunity.manage',
    'pipeline.manage',
    'follow_up.read',
    'follow_up.manage',
    'forecast.read',
    'forecast.run',
    'report.read',
    'channel.read',
    'channel.create',
    'channel.update',
    'channel.disconnect',
    'channel.delete',
  ],
} as const satisfies RoleCatalogue;

export type Role = keyof typeof ROLES;
