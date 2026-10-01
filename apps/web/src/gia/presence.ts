import { useSyncExternalStore } from 'react';

/**
 * Where GIA is and what she is doing, from what really happened. Any screen that shows GIA as a
 * person (the office today; later a department, a task or a meeting) reads it from here, so she
 * is never in two places and never somewhere the records do not put her.
 *
 * The one source today is the work GIA brings to an agent: a task she prepared in her chat that
 * the person sent (ADR-0064). While that task is in the agent's hands, GIA is with that agent;
 * once it is done, she goes back to her room. Tasks do not yet record that GIA prepared them, so
 * the chat writes it down here (`giaEngagements`) for the session. When the API reports a task's
 * origin, `giaTarget` takes the tasks from it instead; nothing else changes.
 */

/** A task GIA prepared that the person sent to an agent. */
export interface GiaEngagement {
  readonly taskId: string;
  readonly agentId: string;
  /** When it was sent, in milliseconds. */
  readonly at: number;
}

/** What she is doing. The moving ones come from her walk between two places (the office's). */
export type GiaActivity =
  'idle' | 'coordinating' | 'walking' | 'arriving' | 'working' | 'waiting' | 'returning';

/** Where she is: her own room, or with an agent in that agent's department. */
export type GiaPlace =
  | { readonly kind: 'home' }
  | { readonly kind: 'department'; readonly departmentId: string; readonly agentId: string };

/** Where the records put her, and what she does there. */
export interface GiaTarget {
  readonly place: GiaPlace;
  readonly activity: 'idle' | 'coordinating' | 'working' | 'waiting';
  /** The task she is with, when she is with an agent. */
  readonly taskId?: string;
  /** The agents at work, the ones she coordinates from her room. */
  readonly coordinating: number;
}

/** A task under way, and one that waits (in a queue, or for a person). */
const WORKING = new Set(['planning', 'running', 'verifying', 'retrying']);
const WAITING = new Set(['pending', 'paused', 'waiting_approval']);
/** A task just sent, before the office has read it, still has her with the agent. */
const JUST_SENT_MS = 2 * 60 * 1000;

/**
 * Where GIA should be: with the agent of the latest task she brought that is still in the agent's
 * hands, or else in her own room, coordinating while any agent works.
 */
export function giaTarget(
  engagements: readonly GiaEngagement[],
  agents: readonly {
    readonly id: string;
    readonly departmentId: string;
    readonly status: string;
  }[],
  work: ReadonlyMap<string, { readonly id: string; readonly status: string } | null>,
  now: number = Date.now(),
): GiaTarget {
  const coordinating = agents.filter((agent) => agent.status === 'active').length;
  const latest = [...engagements].sort((a, b) => b.at - a.at);
  for (const engagement of latest) {
    const agent = agents.find((candidate) => candidate.id === engagement.agentId);
    if (agent === undefined || agent.status !== 'active') continue;
    const task = work.get(agent.id);
    let activity: 'working' | 'waiting' | undefined;
    if (task !== undefined && task !== null && task.id === engagement.taskId) {
      if (WORKING.has(task.status)) activity = 'working';
      else if (WAITING.has(task.status)) activity = 'waiting';
    } else if (now - engagement.at < JUST_SENT_MS) {
      // The task exists (the API accepted it) but the office has not read it yet: it waits.
      activity = 'waiting';
    }
    if (activity === undefined) continue;
    return {
      place: { kind: 'department', departmentId: agent.departmentId, agentId: agent.id },
      activity,
      taskId: engagement.taskId,
      coordinating,
    };
  }
  return {
    place: { kind: 'home' },
    activity: coordinating > 0 ? 'coordinating' : 'idle',
    coordinating,
  };
}

/** Two places are the same place. */
export const samePlace = (a: GiaPlace, b: GiaPlace) =>
  a.kind === 'home'
    ? b.kind === 'home'
    : b.kind === 'department' && b.departmentId === a.departmentId;

const KEY = 'mo.gia.engagements';
/** She keeps the last few; a day later they are forgotten. */
const KEEP = 8;
const FORGET_MS = 24 * 60 * 60 * 1000;

function load(): readonly GiaEngagement[] {
  try {
    const stored: unknown = JSON.parse(globalThis.sessionStorage?.getItem(KEY) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter(
      (entry): entry is GiaEngagement =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as GiaEngagement).taskId === 'string' &&
        typeof (entry as GiaEngagement).agentId === 'string' &&
        typeof (entry as GiaEngagement).at === 'number' &&
        Date.now() - (entry as GiaEngagement).at < FORGET_MS,
    );
  } catch {
    return [];
  }
}

let current: readonly GiaEngagement[] | undefined;
const listeners = new Set<() => void>();

function set(next: readonly GiaEngagement[]) {
  current = next;
  try {
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Without storage she still goes where the work is, for as long as the page is open.
  }
  for (const listener of listeners) listener();
}

/** The tasks GIA brought to agents in this session. */
export const giaEngagements = {
  list(): readonly GiaEngagement[] {
    current ??= load();
    return current;
  },
  /** The chat calls it once the API accepted a task GIA prepared. */
  record(engagement: GiaEngagement) {
    const rest = giaEngagements.list().filter((entry) => entry.taskId !== engagement.taskId);
    set([engagement, ...rest].slice(0, KEEP));
  },
  forget(taskId: string) {
    set(giaEngagements.list().filter((entry) => entry.taskId !== taskId));
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** For tests: starts again with nothing recorded. */
  reset() {
    current = [];
    try {
      globalThis.sessionStorage?.removeItem(KEY);
    } catch {
      // Nothing to clear.
    }
  },
};

export function useGiaEngagements(): readonly GiaEngagement[] {
  return useSyncExternalStore(giaEngagements.subscribe, giaEngagements.list, giaEngagements.list);
}
