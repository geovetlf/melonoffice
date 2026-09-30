import { isDecisionError } from '@melonoffice/decisions';
import {
  checkHarnessTask,
  isHarnessError,
  type AgentHarness,
  type ExecutionStrategy,
  type HarnessErrorCode,
} from '@melonoffice/harness';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { answerTaskRequest } from './agent-tasks.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

const STATUS: Record<HarnessErrorCode, 400 | 403> = {
  invalid_task: 400,
  unresolved_tenant: 403,
  permission_denied: 403,
};

/**
 * What a person reads of a strategy: what the Harness understood and decided, never the ids of
 * who they are (they know) nor a balance (that is `credits.read`'s to show).
 */
function strategyView(strategy: ExecutionStrategy) {
  const { classification } = strategy;
  return {
    verdict: strategy.verdict,
    reasons: strategy.reasons,
    intent: classification.intent,
    domains: classification.domains,
    complexity: classification.complexity,
    plan: strategy.plan.mode,
    context: strategy.contextPlan,
    agent: strategy.agent,
    candidates: strategy.candidates,
    model: { strategy: strategy.model.strategy },
    tools: strategy.tools,
    budget: strategy.budget.status,
  };
}

/**
 * The Melon Agent Harness's route (ADR-0099, block 1). A person gives MelonOffice a task in their
 * own words; the Harness decides which agent takes it, what context and model profile it needs and
 * whether it can run, and when it can, starts it as that agent's task. The task is then read
 * through the agent task routes. `dryRun` only prepares.
 *
 * Starting needs `specialist.task` (owner, a person directly), like asking an agent directly;
 * routing also needs `decision.evaluate` and `specialist.read`, which the Decision Engine checks.
 */
export function registerHarnessRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    /** The Harness for one request, so the task's execution carries the request's id. */
    readonly harnessFor: (requestId: string | undefined) => AgentHarness;
  },
): void {
  const { harnessFor } = dependencies;
  app.post(
    '/v1/organizations/:organizationId/harness/tasks',
    withPermission('specialist.task', dependencies, async (c, tenant) =>
      answer(c, async () => {
        const body: unknown = await c.req.json().catch(() => undefined);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          return c.json({ error: 'invalid_task', field: 'body' }, 400);
        }
        const { dryRun, ...fields } = body as Record<string, unknown>;
        if (dryRun !== undefined && typeof dryRun !== 'boolean') {
          return c.json({ error: 'invalid_task', field: 'dryRun' }, 400);
        }
        const task = checkHarnessTask(fields);
        const harness = harnessFor(c.get('requestId'));
        if (dryRun === true) {
          const strategy = await harness.prepare(tenant, task);
          return c.json({ strategy: strategyView(strategy), task: null });
        }
        const { strategy, task: started } = await harness.start(tenant, task);
        return c.json(
          {
            strategy: strategyView(strategy),
            task:
              started === undefined
                ? null
                : {
                    id: started.task.id,
                    specialistId: started.task.specialistId,
                    status: started.execution?.status ?? 'unknown',
                  },
          },
          started === undefined ? 200 : 202,
        );
      }),
    ),
  );
}

async function answer(c: Context<AuthEnv>, run: () => Promise<Response>): Promise<Response> {
  try {
    return await answerTaskRequest(c, run);
  } catch (error) {
    if (isHarnessError(error)) {
      return c.json(
        {
          error: error.code,
          ...(error.code === 'invalid_task' && error.detail !== undefined
            ? { field: error.detail }
            : {}),
        },
        STATUS[error.code],
      );
    }
    if (isDecisionError(error) && error.code === 'permission_denied') {
      return c.json({ error: 'permission_denied' }, 403);
    }
    throw error;
  }
}
