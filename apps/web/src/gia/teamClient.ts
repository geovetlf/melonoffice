import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * Work for several departments that GIA prepared (ADR-0117), once the person confirms it: the
 * Melon Agent Harness decides how it runs. Work for more than one step becomes a plan that waits
 * for the person's approval in Automations; the agents then do their steps, and GIA summarizes
 * what they answered. GIA never starts or approves anything herself.
 */
export type TeamStart =
  | { readonly kind: 'plan'; readonly planId: string }
  | { readonly kind: 'task'; readonly taskId: string; readonly specialistId: string }
  | { readonly kind: 'not_started'; readonly reason: string };

export type TeamSummary =
  | {
      readonly kind: 'summary';
      readonly summary: string;
      readonly answered: number;
      readonly pending: number;
    }
  | { readonly kind: 'failed'; readonly reason: string };

export interface GiaTeamClient {
  start(request: string, requestKey: string): Promise<TeamStart>;
  summarize(planId: string, requestKey: string, locale: 'es' | 'en'): Promise<TeamSummary>;
}

export function createGiaTeamClient(request: ReplyRequest, organizationId: string): GiaTeamClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}`;
  const post = async (path: string, body: unknown) => {
    const response = await request(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, body: json };
  };
  return {
    async start(text, requestKey) {
      const { ok, body } = await post('/harness/tasks', {
        request: text,
        idempotencyKey: requestKey,
      });
      if (!ok) {
        return {
          kind: 'not_started',
          reason: typeof body.error === 'string' ? body.error : 'unavailable',
        };
      }
      const strategy = body.strategy as { verdict?: unknown; plan?: { id?: unknown } } | undefined;
      const task = body.task as { id?: unknown; specialistId?: unknown } | null | undefined;
      if (typeof strategy?.plan?.id === 'string') return { kind: 'plan', planId: strategy.plan.id };
      if (typeof task?.id === 'string' && typeof task.specialistId === 'string') {
        return { kind: 'task', taskId: task.id, specialistId: task.specialistId };
      }
      return {
        kind: 'not_started',
        reason: typeof strategy?.verdict === 'string' ? strategy.verdict : 'unavailable',
      };
    },
    async summarize(planId, requestKey, locale) {
      const { ok, body } = await post(`/gia/plans/${encodeURIComponent(planId)}/summary`, {
        requestKey,
        locale,
      });
      if (!ok || typeof body.summary !== 'string') {
        const reason =
          body.field === 'nothing_to_summarize'
            ? 'nothing_yet'
            : typeof body.error === 'string'
              ? body.error
              : 'unavailable';
        return { kind: 'failed', reason };
      }
      return {
        kind: 'summary',
        summary: body.summary,
        answered: typeof body.answered === 'number' ? body.answered : 0,
        pending: typeof body.pending === 'number' ? body.pending : 0,
      };
    },
  };
}
