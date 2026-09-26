/**
 * Test-only data. Nothing here is exported from the package or deployed.
 * The fixture plan proves the engine works for a second, fully configured
 * plan (plan §11A.4) without defining Empresa or Corporativo values.
 */
import type { IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import type { ActionDefinition, Principal } from './authorize.js';
import type { PlanConfig, PlanId } from './plans.js';

export const ORG = 'org-a' as OrganizationId;
export const OTHER_ORG = 'org-b' as OrganizationId;
export const OWNER = 'user-owner' as UserId;
export const NOW = '2026-09-26T12:00:00Z' as IsoTimestamp;

export const fixturePlan: PlanConfig = {
  id: 'fixture-large' as PlanId,
  version: 1,
  status: 'active',
  visibility: 'hidden',
  purchasable: false,
  entitlements: {
    'departments.allowed': ['marketing', 'finance'],
    'agents.max': 10,
    'agents.perDepartmentMax': { default: 3, byScope: { marketing: 5 } },
    'users.max': 5,
    'credits.monthlyIncluded': 1000,
    'gia.text': true,
    'gia.voice': true,
    'addons.allowed': true,
  },
};

export const allPermissions = new Set([
  'members.invite',
  'specialists.create',
  'departments.open',
  'gia.voice.use',
  'plan.change',
]);

export function principal(overrides: Partial<Principal> = {}): Principal {
  return { kind: 'user', orgId: ORG, userId: OWNER, permissions: allPermissions, ...overrides };
}

export const actions = {
  inviteMember: { id: 'member.invite', permission: 'members.invite', limit: 'users.max' },
  createSpecialist: {
    id: 'specialist.create',
    permission: 'specialists.create',
    limit: 'agents.perDepartmentMax',
  },
  openDepartment: {
    id: 'department.open',
    permission: 'departments.open',
    list: 'departments.allowed',
  },
  useVoice: {
    id: 'gia.voice.use',
    permission: 'gia.voice.use',
    feature: 'gia.voice',
    releaseFlag: 'gia-voice',
  },
  changePlan: { id: 'plan.change', permission: 'plan.change', governance: true },
} as const satisfies Record<string, ActionDefinition>;
