import type { SpecialistConfiguration } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { agentChanges } from './history.js';

const base = {
  departmentId: 'org_sales',
  mainRoleId: 'commercial_agent',
  roleVersion: 1,
  purpose: 'Vender',
  capabilities: [],
  skills: [
    { id: 'company_knowledge', version: 2 },
    { id: 'customer_follow_up', version: 2 },
  ],
  tools: [{ id: 'follow_up_schedule', version: 2 }],
  permissions: ['contact.read'],
  policies: {},
} as unknown as SpecialistConfiguration;

describe('agentChanges (ADR-0142)', () => {
  it('a first version is its creation', () => {
    expect(agentChanges(base, undefined)).toEqual([{ kind: 'created' }]);
  });

  it('tells each change a person audits, in a fixed order', () => {
    const next = {
      ...base,
      departmentId: 'org_marketing',
      purpose: undefined,
      skills: [
        { id: 'company_knowledge', version: 3 },
        { id: 'content_drafting', version: 1 },
      ],
      autonomy: 'propose',
      work: { memory: true },
    } as unknown as SpecialistConfiguration;
    expect(agentChanges(next, base)).toEqual([
      { kind: 'department', before: 'org_sales', after: 'org_marketing' },
      { kind: 'purpose', before: 'Vender', after: null },
      {
        kind: 'skills',
        added: [{ id: 'content_drafting', version: 1 }],
        removed: [{ id: 'customer_follow_up', version: 2 }],
        updated: [{ id: 'company_knowledge', from: 2, to: 3 }],
      },
      { kind: 'autonomy', before: 'controlled', after: 'propose' },
      {
        kind: 'work',
        before: { memory: false, aiVerification: false, collaboration: false },
        after: { memory: true, aiVerification: false, collaboration: false },
      },
    ]);
  });

  it('never describes tools or permissions: a change of only those is "other"', () => {
    const next = { ...base, tools: [], permissions: [] } as unknown as SpecialistConfiguration;
    expect(agentChanges(next, base)).toEqual([{ kind: 'other' }]);
  });
});
