import type { AIMessage, AIOutput } from '@melonoffice/ai-gateway';
import type { DefinitionRef, ToolId, ToolSchema } from '@melonoffice/domain';
import type { ResolvedTool } from '@melonoffice/tools';
import { MAX_STEPS, MAX_WAIT_SECONDS } from './proposal.js';
import { resolveToolSteps, type ToolStepResolution } from './tool-steps.js';
import type { ToolStepUse } from './validate.js';

/**
 * What the planner is told it may use (plan_proposal@2 and @3, ADR-0171, ADR-0172): only the agents that would do
 * the work and, for each, the tools its skills grant, as the plan validator itself judges them.
 * Codes, schemas and settings only: never a person's data, a secret or an organization's ids.
 */
export interface PlannerToolView {
  readonly id: string;
  readonly version: number;
  /** What the tool does, as a code (`read`, `search`, `schedule`…). */
  readonly action: string;
  /** Whether it changes data. */
  readonly changesData: boolean;
  readonly riskLevel: string;
  /** Whether a plan takes it as a step here, by the validator's own rule (`toolUse`). */
  readonly usableAsStep: boolean;
  /** Why not, as the validator's code. */
  readonly notUsableBecause?: string;
  /** Whether a step with it waits for a person first. */
  readonly approvalRequired?: boolean;
  /** Whether its input may be read from an earlier step (never when a person approves it). */
  readonly inputFromAllowed?: boolean;
  readonly input?: ToolSchema;
  readonly output?: ToolSchema;
}

export interface PlannerAgentView {
  /** The agent the plan names for this role, as `specialistId`. */
  readonly specialistId: string;
  /** The department's catalogue type, or `custom`. */
  readonly departmentType: string;
  readonly roleId: string;
  /** The skills its tools come from, as `id@version`. */
  readonly skills?: readonly string[];
  readonly tools: readonly PlannerToolView[];
}

export interface PlannerContext {
  readonly agents: readonly PlannerAgentView[];
  /** The actions a policy check step may ask about; none, no check steps. */
  readonly checkActions?: readonly string[];
}

/** One tool as the planner sees it: what the registry says it is, and what the validator says. */
export function plannerToolOf(
  ref: DefinitionRef<ToolId> | { readonly id: string; readonly version: number },
  resolved: ResolvedTool | undefined,
  use: ToolStepUse,
): PlannerToolView {
  const version = resolved?.version;
  const base = {
    id: ref.id as string,
    version: ref.version,
    action: version?.action ?? 'unknown',
    changesData: version?.mutating ?? true,
    riskLevel: version?.riskLevel ?? use.riskLevel ?? 'unknown',
  };
  if (!use.usable) {
    return Object.freeze({ ...base, usableAsStep: false, notUsableBecause: use.reason });
  }
  return Object.freeze({
    ...base,
    riskLevel: use.riskLevel,
    usableAsStep: true,
    approvalRequired: use.approvalRequired,
    inputFromAllowed: !use.approvalRequired,
    ...(version === undefined ? {} : { input: version.inputSchema, output: version.outputSchema }),
  });
}

/**
 * The planner's fixed instructions (plan_proposal@5, ADR-0173). They describe the answer format
 * and the step kinds the engine runs; they grant nothing. Whatever the model answers still goes
 * through the whole validation pipeline, which alone decides.
 */
export const PLANNER_INSTRUCTIONS = [
  'You are the MelonOffice planner. You turn one request into a plan for the agents in the',
  'context, or you ask, or you say it cannot be done. You never do the work yourself.',
  'Answer with exactly one JSON object, one of:',
  '(1) a plan: {"summary": a short title, "objective": one sentence, "steps": [...]};',
  '(2) {"question": "..."}, when you cannot tell what work is wanted (for example "do it like',
  'last time"), or when the person wants to review something before an action no agent here can',
  'take as a step: then ask, saying what you can prepare and that the action is not available.',
  'Missing names, products, dates or amounts are never a reason to ask: plan with what the',
  'request gives;',
  '(3) {"notPossible": "..."} when these agents and tools cannot do what is asked: one or two',
  'plain sentences saying what cannot be done with the available capabilities and why. Never a',
  'plan with no steps, never an agent step that pretends to do it. If a useful part can be done,',
  'plan only that part instead and say in the summary what is left out.',
  'Write the summary, labels, question and notPossible in the same language as the request,',
  'even though ids, tools and departments are in English.',
  `A plan has at most ${MAX_STEPS} steps, as few as the request needs: never add work, tools or`,
  'reviews nobody asked for. Each step has id (lowercase letters, digits and underscores,',
  'starting with a letter), kind, label (what it does, in a few words) and dependsOn (ids of',
  'earlier steps only; never a cycle). Steps that do not depend on each other run side by side.',
  'The only kinds are:',
  '"specialist": an agent does the work itself (research, analysis, writing, estimates), with',
  'or without tools; give its specialistId from the context.',
  '"tool": an agent uses one of its tools marked usableAsStep during one of its own specialist',
  'steps. Give performedBy, the id of that specialist step (a step id like "draft", never a',
  'specialistId), with that step listed before it and in its dependsOn; tool {"id", "version"}',
  "exactly as listed; and input, a JSON object valid for the tool's input schema with fixed",
  'values from the request ({} when the schema has no properties). Use inputFrom {"<input',
  'key>": {"step": "<earlier step id>"}} only when the tool has inputFromAllowed true. The',
  'specialist step ends with its tools, so other steps depend on the specialist step, never on',
  'a tool step. Add a tool step only when the request asks to look something up that the tool',
  'reads (the company memory, customer or pipeline figures); if the work can be done without a',
  'tool, use none.',
  `"wait": {"wait": {"seconds": 1 to ${MAX_WAIT_SECONDS}}} before what follows.`,
  '"condition": only a policy check, and only when checkActions are listed:',
  '{"decision": {"decision": "action.policy_check", "continueOn": ["allowed"], "input":',
  '{"action": one listed action}}}.',
  'There are no approval, verification or parallel steps. Rules:',
  '- Give each piece of work to the agent whose departmentType fits it (research to research,',
  'costs and budgets to finance, campaigns to marketing, customers and sales to sales), and give',
  'every department the request names a step. An agent without tools still does its own work.',
  '- "approvalRequired": true makes a step wait for the person before it runs. When the person',
  'asks to see, review or approve a result before anything else happens ("muéstrame la lista',
  'antes", "quiero revisarla yo", "let me review it first"), put it on the step that continues',
  'from that result; if the request names no next step, add one by the same agent that finishes',
  'the reviewed work, with approvalRequired. Never add it otherwise: a tool with',
  'approvalRequired already waits for a person by itself.',
  '- If the requested order is circular or contradicts itself, choose one order without a cycle',
  'and say which in the summary.',
  '- Use only the agents and tools in the context: never invent an agent, department, tool or',
  'input. A tool with usableAsStep false cannot be a step and no agent step may do its work',
  'instead (an agent cannot send, schedule, charge or change data without that tool).',
  '- Refer to people by their role ("the customer"). Never copy names, phone numbers, email',
  'addresses or other personal data into the plan. Never include organizations, users,',
  'permissions, credits, policies or credentials: they are refused.',
  'Example, an agent A with no tools researches and an agent B with a usable knowledge_search@1',
  'writes using what it finds: {"summary": "...", "objective": "...", "steps": [{"id":',
  '"research", "kind": "specialist", "label": "...", "dependsOn": [], "specialistId": "<A>"},',
  '{"id": "draft", "kind": "specialist", "label": "...", "dependsOn": ["research"],',
  '"specialistId": "<B>"}, {"id": "search", "kind": "tool", "label": "...", "dependsOn":',
  '["draft"], "performedBy": "draft", "tool": {"id": "knowledge_search", "version": 1}, "input":',
  '{"query": "..."}}]}',
].join(' ');

/**
 * The planning call's messages (ADR-0028, ADR-0171): the fixed instructions, the context as data,
 * and the person's request. The Harness, workflow drafts and the planner's evals send exactly
 * these.
 */
export const plannerMessages = (context: PlannerContext, objective: string): AIMessage[] => [
  {
    role: 'system',
    content: [
      { type: 'text', text: PLANNER_INSTRUCTIONS },
      {
        type: 'text',
        text: JSON.stringify({
          agents: context.agents,
          ...(context.checkActions === undefined || context.checkActions.length === 0
            ? {}
            : { checkActions: context.checkActions }),
        }),
      },
    ],
  },
  { role: 'user', content: [{ type: 'text', text: objective }] },
];

/** How an agent step's work is checked: its answer is kept and well formed (as workflows ask). */
export const AGENT_STEP_VERIFICATION = Object.freeze({
  policy: 'output_schema',
  expectedOutput: 'agent_answer',
  requiredChecks: Object.freeze([]) as readonly string[],
});

/** What the planner answered (ADR-0171). Text shown to a person is cut to this length. */
export const MAX_PLANNER_MESSAGE = 500;

export type PlanningAnswer =
  | {
      readonly kind: 'proposal';
      readonly proposal: Readonly<Record<string, unknown>>;
      /** How its tool steps were read (ADR-0173), when the agents it was planned for are given. */
      readonly toolSteps?: Pick<ToolStepResolution, 'resolved' | 'unresolved'>;
    }
  | { readonly kind: 'question'; readonly text: string }
  | { readonly kind: 'not_possible'; readonly text: string }
  | { readonly kind: 'unreadable' };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const messageOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(CONTROL, '').trim();
  return text === '' ? undefined : [...text].slice(0, MAX_PLANNER_MESSAGE).join('');
};

/** The answer as JSON: structured output, or JSON text, with or without a code fence. */
function jsonOf(output: AIOutput | undefined): unknown {
  if (output === undefined) return undefined;
  if (output.structured !== undefined) return output.structured;
  if (output.text === undefined) return undefined;
  const text = output.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Reads the planner's answer (ADR-0171): a plan, a question, or why it cannot be done. A plan's
 * agent steps get the one way agent work is checked: the model never chooses it. Given the agents
 * the planner was shown, each tool step's reference to its agent is resolved to that agent's
 * step (`resolveToolSteps`, ADR-0173). Nothing else is changed; the plan still goes through
 * `checkProposal` and the validator.
 */
export function planningAnswerOf(
  output: AIOutput | undefined,
  agents?: readonly PlannerAgentView[],
): PlanningAnswer {
  const answer = jsonOf(output);
  if (!isRecord(answer)) return { kind: 'unreadable' };
  const steps = answer.steps;
  const hasSteps = Array.isArray(steps) && steps.length > 0;
  if (!hasSteps) {
    const question = messageOf(answer.question);
    if (question !== undefined) return { kind: 'question', text: question };
    const notPossible = messageOf(answer.notPossible);
    if (notPossible !== undefined) return { kind: 'not_possible', text: notPossible };
  }
  if (!Array.isArray(steps)) return { kind: 'unreadable' };
  const plan = Object.fromEntries(
    Object.entries(answer).filter(([key]) => key !== 'question' && key !== 'notPossible'),
  );
  const proposal = {
    ...plan,
    steps: steps.map((step: unknown) =>
      isRecord(step) && step.kind === 'specialist'
        ? { ...step, verification: { ...AGENT_STEP_VERIFICATION, requiredChecks: [] } }
        : step,
    ),
  };
  if (agents === undefined) return { kind: 'proposal', proposal };
  const read = resolveToolSteps(proposal, agents);
  return {
    kind: 'proposal',
    proposal: read.proposal,
    toolSteps: { resolved: read.resolved, unresolved: read.unresolved },
  };
}
