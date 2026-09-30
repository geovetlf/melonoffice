import type { AgentContextBlock, AgentContextSource } from '@melonoffice/agents';
import type { TenantContext } from '@melonoffice/tenancy';
import { classifyTask } from './intent.js';
import type { HarnessContextSourceId } from './model.js';
import { contextPlanOf } from './profile.js';

/**
 * An agent task's context through the Harness (ADR-0099 §13): the same sources as before, each an
 * existing engine read as the person with the agent's configuration, but only those the task
 * needs. A source the plan names and that is not set up here is left out; nothing stands in for
 * it. Used where the agent's context was read directly, so the agent's prompt is unchanged.
 */
export function createHarnessContextSource(options: {
  readonly sources: Partial<Record<HarnessContextSourceId, AgentContextSource>>;
}): AgentContextSource {
  const { sources } = options;
  return Object.freeze({
    async read(tenant: TenantContext, request: Parameters<AgentContextSource['read']>[1]) {
      const plan = contextPlanOf(classifyTask(request.request));
      const blocks: AgentContextBlock[] = [];
      for (const id of plan) {
        const source = sources[id];
        if (source === undefined) continue;
        blocks.push(...(await source.read(tenant, request)));
      }
      return blocks;
    },
  });
}
