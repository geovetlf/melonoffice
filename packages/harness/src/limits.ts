import type { TenantContext } from '@melonoffice/tenancy';
import { foldText } from './intent.js';

/**
 * How far one task may reach (ADR-0101, ADR-0100): steps, agents, depth, provider calls, tool
 * calls and time. MelonOffice's safety bounds, configurable, never a provider's limits. Credits
 * are the task's budget (`maxCredits`) and the model policy's cap per call; every job has its
 * lease (X6b), and a person can cancel an execution and its plan's children at any time (X6a).
 * A task at a limit stops and says why.
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
  /** Provider calls one model request may make, over every model it falls back to (ADR-0100). */
  readonly maxModelCalls: number;
  /** Tool uses one task may ask for (ADR-0100). */
  readonly maxToolCalls: number;
  /** How long a task's execution may run before its model call, from when it started (ADR-0100). */
  readonly maxDurationMs: number;
}

export const DEFAULT_HARNESS_LIMITS: HarnessLimits = Object.freeze({
  maxSteps: 8,
  maxAgents: 4,
  maxDepth: 1,
  maxModelCalls: 3,
  maxToolCalls: 5,
  maxDurationMs: 10 * 60_000,
});

/** Why a task stopped at one of the limits the Harness enforces itself (ADR-0100). */
export type HarnessLimitCode = 'tool_call_limit_reached' | 'task_time_limit_reached';

export function checkHarnessLimits(limits: HarnessLimits): HarnessLimits {
  const int = (v: number, min: number, max: number) =>
    Number.isSafeInteger(v) && v >= min && v <= max;
  // The planner never makes more than 50 steps (MAX_STEPS); a limit above it would say nothing.
  // The gateway refuses a policy above 20 provider calls per request.
  if (
    !int(limits.maxSteps, 1, 50) ||
    !int(limits.maxAgents, 1, 50) ||
    limits.maxDepth !== 1 ||
    !int(limits.maxModelCalls, 1, 20) ||
    !int(limits.maxToolCalls, 0, 100) ||
    !int(limits.maxDurationMs, 1_000, 24 * 3_600_000)
  ) {
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
