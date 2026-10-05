import type { ToolStepField, ToolView } from '../agents/agentsClient.js';
import type {
  ToolValueDraft,
  WorkflowAgentDraft,
  WorkflowStepDraft,
  WorkflowToolDraft,
} from './automationsClient.js';

/**
 * Tool steps in the workflow editor (ADR-0165). The editor offers only what a plan would run: a
 * tool version that reads inside MelonOffice (the API shows its fields), filled with plain values
 * or with results the plan has before the step runs (ADR-0161). The server checks all of it again
 * when the workflow is saved and when it is planned; these rules only keep the form honest.
 */

/** A tool version the editor can offer, with the fields it fills and reads. */
export interface ToolChoice {
  readonly id: string;
  readonly version: number;
  readonly nameKey: string;
  readonly riskLevel: string;
  readonly input: readonly ToolStepField[];
  readonly output: readonly ToolStepField[];
}

const PLAIN = new Set(['string', 'number', 'integer', 'boolean']);
export const isPlain = (f: ToolStepField): boolean => PLAIN.has(f.type);

/**
 * The newest version of each active tool a workflow step may use and the editor can fill: every
 * input field a plain value.
 */
export function toolChoicesOf(tools: readonly ToolView[]): readonly ToolChoice[] {
  const choices: ToolChoice[] = [];
  for (const t of tools) {
    if (t.status !== 'active') continue;
    const usable = t.versions.filter((v) => v.step != null && v.step.input.every(isPlain));
    const newest = usable.reduce<(typeof usable)[number] | undefined>(
      (best, v) => (best === undefined || v.version > best.version ? v : best),
      undefined,
    );
    if (newest?.step == null) continue;
    choices.push({
      id: t.id,
      version: newest.version,
      nameKey: newest.nameKey,
      riskLevel: newest.riskLevel,
      input: newest.step.input,
      output: newest.step.output,
    });
  }
  return choices;
}

/** The keys of every step a step waits for, directly or through others. */
export function ancestorsOf(steps: readonly WorkflowStepDraft[], key: string): ReadonlySet<string> {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const visit = (k: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    byKey.get(k)?.after.forEach(visit);
  };
  byKey.get(key)?.after.forEach(visit);
  return seen;
}

/** Where one input of a tool step can come from, besides a fixed value. */
export interface ValueSource {
  readonly value: ToolValueDraft;
  /** The index of the step it comes from, for its label. */
  readonly index: number;
  /** For a tool result: the field. */
  readonly field?: string;
}

/**
 * The earlier results that may fill `field` of the tool step at `index`, as the plan validator
 * allows them (ADR-0161): the answer of its agent step or of one that step waits for (text only,
 * and only for a low-risk tool: an answer is model text), or a plain field of the same type of
 * another agent's earlier tool step whose agent step it waits for.
 */
export function sourcesFor(
  steps: readonly WorkflowStepDraft[],
  index: number,
  tool: ToolChoice,
  field: ToolStepField,
  choices: readonly ToolChoice[],
): readonly ValueSource[] {
  const step = steps[index];
  if (step?.kind !== 'tool' || step.performer === '') return [];
  const before = new Set([step.performer, ...ancestorsOf(steps, step.performer)]);
  const sources: ValueSource[] = [];
  steps.forEach((s, i) => {
    if (i >= index || !before.has(s.key) || s.kind !== 'agent') return;
    if (field.type === 'string' && tool.riskLevel === 'low') {
      sources.push({ value: { from: 'answer', step: s.key }, index: i });
    }
  });
  steps.forEach((s, i) => {
    if (i >= index || s.kind !== 'tool' || s.performer === step.performer) return;
    if (!before.has(s.performer)) return;
    const source = choices.find((c) => c.id === s.toolId && c.version === s.toolVersion);
    for (const out of source?.output ?? []) {
      const fits =
        isPlain(out) &&
        (out.type === field.type || (out.type === 'integer' && field.type === 'number'));
      if (fits) {
        sources.push({
          value: { from: 'result', step: s.key, field: out.name },
          index: i,
          field: out.name,
        });
      }
    }
  });
  return sources;
}

export const sourceKey = (v: ToolValueDraft): string =>
  v.from === 'fixed'
    ? 'fixed'
    : v.from === 'answer'
      ? `answer:${v.step}`
      : `result:${v.step}:${v.field}`;

/** Whether a tool step has what it needs: an agent step, a tool, and every required input. */
export function toolStepComplete(step: WorkflowToolDraft, choices: readonly ToolChoice[]): boolean {
  if (step.performer === '' || step.toolId === '') return false;
  const tool = choices.find((c) => c.id === step.toolId && c.version === step.toolVersion);
  // A saved tool the catalogue does not show here: the server checks it.
  if (tool === undefined) return true;
  return tool.input.every((f) => {
    const v = step.values[f.name];
    if (v === undefined || (v.from === 'fixed' && v.value === '')) return !f.required;
    return true;
  });
}

/**
 * The steps after a move, a removal or a change of kind. A step waits only for steps before it,
 * and never for a tool step (it ends with its agent step). A tool step keeps its agent step only
 * while that is an earlier agent step, and an input source only while it is still offered.
 */
export function tidy(
  next: readonly WorkflowStepDraft[],
  choices: readonly ToolChoice[],
): readonly WorkflowStepDraft[] {
  const out: WorkflowStepDraft[] = [];
  next.forEach((s, i) => {
    const earlier = next.slice(0, i);
    if (s.kind !== 'tool') {
      const allowed = new Set(earlier.filter((e) => e.kind !== 'tool').map((e) => e.key));
      out.push({ ...s, after: s.after.filter((k) => allowed.has(k)) });
      return;
    }
    const performer = earlier.some((e) => e.kind === 'agent' && e.key === s.performer)
      ? s.performer
      : '';
    const step: WorkflowToolDraft = { ...s, performer, after: performer === '' ? [] : [performer] };
    const draft = [...out, step];
    const tool = choices.find((c) => c.id === s.toolId && c.version === s.toolVersion);
    // A tool the catalogue does not show (not readable here) keeps what was saved.
    if (tool === undefined) {
      out.push(step);
      return;
    }
    const values: Record<string, ToolValueDraft> = {};
    for (const [name, v] of Object.entries(s.values)) {
      const field = tool.input.find((f) => f.name === name);
      if (field === undefined) continue;
      const kept =
        v.from === 'fixed' ||
        sourcesFor(draft, i, tool, field, choices).some(
          (src) => sourceKey(src.value) === sourceKey(v),
        );
      if (kept) values[name] = v;
    }
    out.push({ ...step, values });
  });
  return out;
}

/** Who would do each role's steps today, and the tools its skills let it use (ADR-0167). */
export interface RoleAgent {
  readonly departmentTypeId: string;
  readonly roleId: string;
  readonly agent: { readonly id: string; readonly displayName: string };
  readonly tools: readonly { readonly id: string; readonly version: number }[];
}

/**
 * Whether the agent that would do a tool step's agent step may use a tool (ADR-0167), as the plan
 * validator will decide it (`tool_not_assigned`): the agent a plan binds for that step's role
 * lists the exact tool version, which only its skills grant. Agent → Skill → Tool, read back from
 * the server; the editor keeps no list of its own.
 * - `no_performer`: the tool step has no agent step, or that step has no role yet;
 * - `no_agent`: no active, eligible agent has that role;
 * - `not_granted`: that agent's skills do not grant this tool version;
 * - `unknown`: who would do it could not be read, so nothing is offered as usable.
 */
export type ToolAvailability =
  | { readonly ok: true; readonly agent: RoleAgent['agent'] }
  | {
      readonly ok: false;
      readonly why: 'no_performer' | 'no_agent' | 'not_granted' | 'unknown';
      readonly agent?: RoleAgent['agent'];
    };

export function roleAgentOf(
  agents: readonly RoleAgent[],
  step: Pick<WorkflowAgentDraft, 'departmentTypeId' | 'roleId'>,
): RoleAgent | undefined {
  return agents.find(
    (a) => a.departmentTypeId === step.departmentTypeId && a.roleId === step.roleId,
  );
}

export function toolAvailability(
  steps: readonly WorkflowStepDraft[],
  performer: string,
  tool: { readonly id: string; readonly version: number },
  agents: readonly RoleAgent[] | undefined,
): ToolAvailability {
  const step = steps.find((s) => s.key === performer);
  if (step?.kind !== 'agent' || step.roleId === '') return { ok: false, why: 'no_performer' };
  if (agents === undefined) return { ok: false, why: 'unknown' };
  const found = roleAgentOf(agents, step);
  if (found === undefined) return { ok: false, why: 'no_agent' };
  const granted = found.tools.some((t) => t.id === tool.id && t.version === tool.version);
  return granted
    ? { ok: true, agent: found.agent }
    : { ok: false, why: 'not_granted', agent: found.agent };
}
