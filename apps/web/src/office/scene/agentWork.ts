import { useEffect, useState } from 'react';
import type { AgentState } from '../departments.js';
import type { AgentTaskView, AgentTasksClient } from '../agentTasksClient.js';
import type { SpecialistView } from '../officeClient.js';

/**
 * What each agent is doing, as the Home shows it (Home V4): its record's status (D-28) and its
 * latest task (ADR-0063), read from the API with the person's own permission. Nothing is ever
 * guessed: an agent with no task reported is available, never "working".
 */

/** The latest task of each active agent, by agent id; `null` when it has none. */
export type AgentWork = ReadonlyMap<string, AgentTaskView | null>;

/** How a task under way is shown. */
const WORKING = new Set(['planning', 'running', 'verifying', 'retrying']);
const WAITING = new Set(['pending', 'paused']);
/** A failed task asks for the person's eye while it is recent. */
const ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * An agent's state, from its record first and then its latest task:
 * paused → paused; draft or disabled → offline; an active agent whose latest task is under way is
 * working, waits in a queue (waiting), waits for a person's approval (its own, or the follow-up it
 * proposed) or failed in the last day (attention); otherwise it is available.
 */
export function workStateOf(
  specialist: Pick<SpecialistView, 'status'>,
  task: AgentTaskView | null | undefined,
  now: number = Date.now(),
): AgentState | undefined {
  if (specialist.status === 'archived') return undefined;
  if (specialist.status === 'paused') return 'paused';
  if (specialist.status !== 'active') return 'offline';
  if (task === null || task === undefined) return 'available';
  // It answered, and the follow-up it proposed waits for the person (ADR-0084).
  if (task.answer?.followUp?.state === 'waiting_approval') return 'attention';
  if (WORKING.has(task.status)) return 'working';
  if (WAITING.has(task.status)) return 'waiting';
  if (task.status === 'waiting_approval') return 'attention';
  if (task.status === 'failed') {
    const at = Date.parse(task.completedAt ?? task.createdAt);
    return Number.isFinite(at) && now - at < ATTENTION_WINDOW_MS ? 'attention' : 'available';
  }
  return 'available';
}

/** Whether a task is still in the agent's hands (shown as its current work). */
export const isCurrentTask = (task: AgentTaskView | null | undefined): task is AgentTaskView =>
  task !== null &&
  task !== undefined &&
  (WORKING.has(task.status) || WAITING.has(task.status) || task.status === 'waiting_approval');

/** At most this many agents' tasks are read for the Home; the rest show their record state. */
export const MAX_AGENTS_READ = 24;
/** How often the Home reads the agents' tasks again, while it is on screen. */
export const REFRESH_MS = 45_000;

/**
 * Reads the latest task of every active agent (up to `MAX_AGENTS_READ`), and again every
 * `REFRESH_MS` while the page is visible. Without a client (no `specialist.read`) it reads
 * nothing and every agent keeps its record state.
 */
export function useAgentWork(
  client: AgentTasksClient | undefined,
  specialists: readonly SpecialistView[],
): AgentWork {
  const [work, setWork] = useState<AgentWork>(() => new Map());
  const ids = specialists
    .filter((s) => s.status === 'active')
    .map((s) => s.id)
    .sort()
    .slice(0, MAX_AGENTS_READ)
    .join(',');
  useEffect(() => {
    if (client === undefined || ids === '') return;
    let live = true;
    const read = async () => {
      if (globalThis.document?.visibilityState === 'hidden') return;
      const entries = await Promise.all(
        ids.split(',').map(async (id) => {
          try {
            const page = await client.list(id);
            return [id, page.tasks[0] ?? null] as const;
          } catch {
            // A read that failed says nothing about the agent: it keeps its record state.
            return undefined;
          }
        }),
      );
      if (!live) return;
      setWork(new Map(entries.filter((entry) => entry !== undefined)));
    };
    void read();
    const timer = globalThis.setInterval(() => void read(), REFRESH_MS);
    return () => {
      live = false;
      globalThis.clearInterval(timer);
    };
  }, [client, ids]);
  return work;
}
