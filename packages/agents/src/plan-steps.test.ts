import { ExecutionError } from '@melonoffice/execution';
import type { TenantContext } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { readPlanResults } from './plan-steps.js';

/**
 * The plan summary GIA reads (ADR-0117). An execution that does not exist means its step has not
 * started; a read that fails is never shown as that absence.
 */

const tenant = {} as TenantContext;

// One specialist step, already delegated to execution `exec-1`. The ports below are the only reads.
const plan = {
  id: 'plan-1',
  status: 'running',
  version: 1,
  delegations: [{ stepId: 'ask', executionId: 'exec-1' }],
  attempts: [],
} as never;
const version = {
  steps: [
    {
      id: 'ask',
      kind: 'specialist',
      label: 'Ask',
      specialist: { id: 'spec-1', departmentId: 'dep-1' },
    },
  ],
} as never;

const portsWith = (get: () => Promise<never>) => ({
  plans: { get: async () => plan, getVersion: async () => version },
  executions: { get },
  outputs: { find: async () => undefined },
});

describe('the plan summary reads a step’s execution honestly (ADR-0117)', () => {
  it('a step whose execution does not exist has not started', async () => {
    const results = await readPlanResults(
      tenant,
      'plan-1',
      portsWith(async () => {
        throw new ExecutionError('execution_not_found');
      }),
    );
    expect(results.steps).toEqual([
      expect.objectContaining({ stepId: 'ask', status: 'not_started', answer: null }),
    ]);
  });

  it('a read that fails is not reported as a step that has not started', async () => {
    await expect(
      readPlanResults(
        tenant,
        'plan-1',
        portsWith(async () => {
          throw new Error('store unavailable');
        }),
      ),
    ).rejects.toThrow('store unavailable');
  });
});
