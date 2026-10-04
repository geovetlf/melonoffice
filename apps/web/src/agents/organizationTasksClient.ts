import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * Every agent's work in the organization (ADR-0148, ADR-0149): the tasks people asked agents for
 * and the plan steps agents run, read through the API, read only. The
 * screen shows exactly the fields the API chose, a page at a time; every filter is checked again
 * on the server. Reading the list calls no model.
 */

export interface OrganizationTaskView {
  readonly id: string;
  /** A task a person asked an agent for, or a step of a plan an agent runs (ADR-0149). */
  readonly origin: 'task' | 'plan_step';
  readonly agent: {
    readonly id: string | null;
    readonly name: string | null;
    readonly status: string | null;
  };
  readonly request: string;
  /** The execution's own state (ADR-0024), or `unknown` when it can no longer be read. */
  readonly status: string;
  readonly failure: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly progress: { readonly done: number; readonly total: number };
  readonly steps: readonly {
    readonly type: string;
    readonly status: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly failure: string | null;
  }[];
  /** The plan a step belongs to, with the plan engine's own state for the step. */
  readonly plan: {
    readonly id: string;
    readonly status?: string;
    readonly step?: { readonly state: string };
  } | null;
  /** The steps of its plan it waits on, by label and where each is. */
  readonly dependsOn: readonly { readonly label: string; readonly state: string }[];
  /** A step that asks a person before it runs: pending, approved, or why it was declined. */
  readonly approval: { readonly state: string } | null;
  /** The task it was handed from, when another agent proposed it (ADR-0117). */
  readonly handedFrom: string | null;
  /** The verified answer, cut to a summary, once it may be shown. */
  readonly result: {
    readonly summary: string;
    readonly truncated: boolean;
    readonly missing: number;
  } | null;
}

export interface OrganizationTasksPageView {
  readonly tasks: readonly OrganizationTaskView[];
  /** The organization's agents, in any status, for the agent filter. */
  readonly agents: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: string;
  }[];
  /** The states the list can be narrowed to, as the API lists them. */
  readonly statuses: readonly string[];
  readonly period: { readonly from: string; readonly to: string } | null;
  /** Where items may come from, as the API lists them. */
  readonly origins: readonly string[];
  /** Whether plan steps were read: `not_permitted` without `plan.read`, `unavailable` on failure. */
  readonly sources: { readonly task: string; readonly plan_step: string };
  readonly nextCursor: string | null;
}

export interface OrganizationTasksQuery {
  readonly origin?: string;
  readonly agent?: string;
  readonly status?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
}

export interface OrganizationTasksClient {
  page(query: OrganizationTasksQuery): Promise<OrganizationTasksPageView>;
}

export class OrganizationTasksRequestError extends Error {
  override readonly name = 'OrganizationTasksRequestError';
  constructor(
    readonly status: number,
    readonly field: string | undefined,
  ) {
    super(`organization tasks request failed: ${status}`);
  }
}

export function createOrganizationTasksClient(
  request: ReplyRequest,
  organizationId: string,
): OrganizationTasksClient {
  const path = `/v1/organizations/${encodeURIComponent(organizationId)}/agent-tasks`;
  return {
    async page(query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (typeof value === 'string' && value.length > 0) params.set(key, value);
      }
      const search = params.toString();
      const response = await request(search.length === 0 ? path : `${path}?${search}`, {});
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          { field?: unknown } | undefined;
        throw new OrganizationTasksRequestError(
          response.status,
          typeof body?.field === 'string' ? body.field : undefined,
        );
      }
      return (await response.json()) as OrganizationTasksPageView;
    },
  };
}
