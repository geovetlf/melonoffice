import { promptRef } from '@melonoffice/ai-gateway';

/**
 * The agent task prompt's version (G-3, ADR-0133): a new one whenever the text
 * `agentTaskMessages` writes changes. Recorded in each task's version snapshot and model calls.
 */
export const AGENT_TASK_PROMPT = promptRef('agent_task', 3);
