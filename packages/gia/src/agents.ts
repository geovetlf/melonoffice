import type { SpecialistId } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';

/**
 * GIA and the organization's agents (AE-3, ADR-0064). GIA may prepare a task for one of the
 * active agents when the person asks for an agent to do or prepare something; the person
 * confirms it in the app, which assigns it through the agent tasks API (ADR-0063) as the person.
 * GIA never assigns a task herself and has no other path to the agents.
 */

/** An active agent of the organization, as GIA may name it. */
export interface GiaAgent {
  readonly id: SpecialistId;
  readonly name: string;
  /** The catalogue type of the agent's department, e.g. `sales`. */
  readonly department: string;
  readonly purpose: string | null;
}

/** The organization's active agents, read as the person. */
export interface GiaAgentsPort {
  active(tenant: TenantContext): Promise<readonly GiaAgent[]>;
}

/** A task GIA prepared for an agent: nothing is assigned until the person confirms it. */
export interface GiaAgentTaskProposal {
  readonly agentId: SpecialistId;
  readonly agentName: string;
  readonly department: string;
  readonly request: string;
}

export const GIA_AGENT_LIMITS = Object.freeze({
  /** How many agents she is shown. */
  agents: 20,
  nameLength: 80,
  purposeLength: 200,
  /** A prepared request; the person may still edit it before confirming. */
  requestLength: 500,
});

/**
 * The closed reference of the n-th agent she is shown: `a_a`, `a_b`… (letters only, as the AI
 * Gateway's closed codes allow; at most 20 agents, so one letter is enough).
 */
export const agentRefOf = (index: number) => `a_${String.fromCharCode(97 + index)}`;

const clip = (text: string, max: number) => [...text].slice(0, max).join('');

/** One line per agent, by reference; names and purposes are data. */
export function agentsBlock(agents: readonly GiaAgent[]): string {
  if (agents.length === 0) return '(no active agents)';
  return agents
    .map((agent, index) => {
      const purpose =
        agent.purpose === null ? '' : `: ${clip(agent.purpose, GIA_AGENT_LIMITS.purposeLength)}`;
      return `- ${agentRefOf(index)} "${clip(agent.name, GIA_AGENT_LIMITS.nameLength)}" (department ${agent.department})${purpose}`;
    })
    .join('\n');
}

export function agentRules(count: number): readonly string[] {
  if (count === 0) {
    return [
      '<agents> is empty: this business has no active agent yet, so agentTask is always null. If the person asks for an agent to do something, say an agent can be created and activated in the department’s office.',
    ];
  }
  return [
    '<agents> lists the active agents of this business, by reference. An agent answers a written request from the company memory: it takes no action, sends nothing and contacts no one.',
    `agentTask: only when the person asks for one of these agents (or "an agent", "the team", a department that has one) to do, prepare, draft, research or analyse something, propose it: agent is its reference, request is what to ask it, in one or two sentences in the answer language, at most ${String(GIA_AGENT_LIMITS.requestLength)} characters, with the details the person gave. Otherwise agentTask is null.`,
    'Never say the task is assigned, sent, started or done: you only prepare it, and the app asks the person to confirm it. Never answer in the agent’s place. If no agent fits, set agentTask to null and say which department could have one.',
  ];
}

/** Letters, marks, numbers, punctuation and spaces: no control or format characters. */
const CONTROL = /[\p{Cc}\p{Cf}]/gu;

/**
 * The task she proposed, checked against the agents she was given: the agent must be one of
 * the references, the request a short plain text. Anything else is no proposal.
 */
export function agentTaskProposalOf(
  raw: unknown,
  agents: readonly GiaAgent[],
): GiaAgentTaskProposal | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { agent, request } = raw as Record<string, unknown>;
  if (typeof agent !== 'string' || typeof request !== 'string') return null;
  const chosen = agents.find((_, index) => agentRefOf(index) === agent);
  if (chosen === undefined) return null;
  const text = request.normalize('NFC').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (text === '' || [...text].length > GIA_AGENT_LIMITS.requestLength) return null;
  return Object.freeze({
    agentId: chosen.id,
    agentName: chosen.name,
    department: chosen.department,
    request: text,
  });
}
