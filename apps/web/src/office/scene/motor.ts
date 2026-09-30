import { useEffect, useState } from 'react';
import type { AutomationsClient, WorkflowStepView } from '../../automations/automationsClient.js';

/**
 * MelonMotor's flows (Home V4): work passing between departments, read from what really runs.
 * A plan in execution made from a workflow (ADR-0028, ADR-0070) hands its steps from one
 * department to the next; each hand-off is a flow. Nothing else is drawn: with no plan running
 * between departments, MelonMotor says so.
 */

export interface MotorFlow {
  /** The catalogue types of the departments the work goes from and to. */
  readonly from: string;
  readonly to: string;
  /** The plan it belongs to, and what it was asked to do. */
  readonly planId: string;
  readonly summary: string;
}

export type MotorState =
  | { readonly status: 'hidden' }
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'ready';
      readonly flows: readonly MotorFlow[];
      /** Plans in execution, whether or not they cross departments. */
      readonly running: number;
    };

/** At most this many running plans are read for their flows. */
export const MAX_PLANS_READ = 3;

/** The hand-offs of a workflow's steps, in order: one per change of department. */
export function handOffs(steps: readonly WorkflowStepView[]): readonly [string, string][] {
  const departments = steps
    .map((step) => step.assignee?.departmentTypeId)
    .filter((type): type is string => type !== undefined);
  const pairs: [string, string][] = [];
  for (let i = 1; i < departments.length; i += 1) {
    const from = departments[i - 1];
    const to = departments[i];
    if (from !== undefined && to !== undefined && from !== to) pairs.push([from, to]);
  }
  return pairs;
}

/** Reads the running plans and their hand-offs, for a person with `plan.read`. */
export function useMotorFlows(client: AutomationsClient | undefined): MotorState {
  const [state, setState] = useState<MotorState>(
    client === undefined ? { status: 'hidden' } : { status: 'loading' },
  );
  useEffect(() => {
    if (client === undefined) return;
    let live = true;
    (async () => {
      const plans = (await client.plans()).filter((plan) => plan.status === 'executing');
      const flows: MotorFlow[] = [];
      for (const plan of plans.slice(0, MAX_PLANS_READ)) {
        const detail = await client.plan(plan.id);
        const source = detail.current.source;
        if (source.kind !== 'workflow') continue;
        const workflow = await client.workflow(source.workflowId);
        for (const [from, to] of handOffs(workflow.current.steps)) {
          flows.push({ from, to, planId: plan.id, summary: detail.current.request.summary });
        }
      }
      return { status: 'ready', flows, running: plans.length } as const;
    })().then(
      (ready) => live && setState(ready),
      () => live && setState({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [client]);
  return state;
}
