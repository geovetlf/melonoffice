import type { TenantContext } from '@melonoffice/tenancy';
import { foldText } from './intent.js';

/**
 * How far one task may reach (ADR-0101): steps, agents and depth. Safety bounds, not prices, and
 * configurable. Time and cost are bounded by what already exists: every job has its lease and
 * timeout (X6b), every model call its deadline and credit limit, the task its budget (ADR-0100),
 * and a person can cancel an execution and its plan's children at any time (X6a).
 */
export interface HarnessLimits {
  /** The most steps a plan made for one task may have. */
  readonly maxSteps: number;
  /** The most distinct agents one plan may involve. */
  readonly maxAgents: number;
  /**
   * How many levels of delegation below the person: 1 is person → Harness → agents, whose work
   * cannot start another Harness task. Only 1 is supported: nothing below an agent may delegate.
   */
  readonly maxDepth: 1;
}

export const DEFAULT_HARNESS_LIMITS: HarnessLimits = Object.freeze({
  maxSteps: 8,
  maxAgents: 4,
  maxDepth: 1,
});

export function checkHarnessLimits(limits: HarnessLimits): HarnessLimits {
  const int = (v: number, max: number) => Number.isSafeInteger(v) && v >= 1 && v <= max;
  // The planner never makes more than 50 steps (MAX_STEPS); a limit above it would say nothing.
  if (!int(limits.maxSteps, 50) || !int(limits.maxAgents, 50) || limits.maxDepth !== 1) {
    throw new Error('invalid harness limits');
  }
  return limits;
}

/** One step of a plan, as the Harness checks it. */
export interface HarnessPlanStep {
  readonly id: string;
  readonly label: string;
  readonly dependsOn: readonly string[];
  readonly specialistId?: string;
}

/**
 * Why a plan must not run, or `undefined` (ADR-0101): too many steps or agents, or a loop. A loop
 * is the same agent asked the same thing twice in one plan: a model's plan that repeats itself
 * would spend twice for nothing, or go round in circles. (Cycles in `dependsOn` are refused
 * earlier, by the plan validator.)
 */
export function planLimitProblem(
  steps: readonly HarnessPlanStep[],
  limits: HarnessLimits = DEFAULT_HARNESS_LIMITS,
): 'too_many_steps' | 'too_many_agents' | 'loop_detected' | undefined {
  if (steps.length > limits.maxSteps) return 'too_many_steps';
  const agents = new Set(
    steps.flatMap((s) => (s.specialistId === undefined ? [] : [s.specialistId])),
  );
  if (agents.size > limits.maxAgents) return 'too_many_agents';
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.specialistId === undefined) continue;
    const signature = `${step.specialistId}\n${foldText(step.label)}`;
    if (seen.has(signature)) return 'loop_detected';
    seen.add(signature);
  }
  return undefined;
}

/**
 * Whether this actor may start a task at this depth. A person, or GIA for a person, starts at the
 * top; the runtime acts for an agent's work, which is already one level down and may not start
 * another task (`depth_exceeded`), so no chain of agents asking agents can form.
 */
export const depthProblem = (tenant: TenantContext): 'depth_exceeded' | undefined =>
  tenant.actor === 'runtime' ? 'depth_exceeded' : undefined;
