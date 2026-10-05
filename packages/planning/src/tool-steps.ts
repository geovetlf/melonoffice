import type { PlannerAgentView } from './planner-context.js';

/**
 * Reading a planner's tool steps (ADR-0173). The engine runs a tool step inside one specialist
 * step of the agent that holds the tool: `performedBy` names that step, and the others wait on
 * the specialist step, which ends with its tools. Models often write the same plan the other way
 * round: the tool first, `performedBy` naming the agent (its specialistId, department or role), and
 * the agent's work after it. This resolves that reference, deterministically, to the real step:
 *
 * AGENT → THE AGENT'S STEP → TOOL
 *
 * - The agent is the one the reference names, among the agents the planner was shown (which
 *   `assigneeOf` built from each agent's configuration.tools and skills), and it must hold the
 *   tool. A reference that names no agent, or several, is left as written.
 * - The step is that agent's one specialist step in the plan; with several, the one that waits
 *   on the tool step, or the one the tool step waits on. Anything else is left as written.
 * - The tool step then waits on that step; what it waited on before, the step now waits on, so
 *   every result an `inputFrom` reads still comes first. Steps that waited on the tool step wait
 *   on the agent's step instead. Inputs and references are kept as they are.
 *
 * Nothing is invented and no step is removed. A reference it cannot resolve without guessing is
 * left for the validator, which stays the only authority and refuses it.
 */

export type ToolStepUnresolved =
  'unknown_performer' | 'ambiguous_agent' | 'tool_not_held' | 'no_agent_step' | 'ambiguous_step';

export interface ToolStepResolution {
  readonly proposal: Readonly<Record<string, unknown>>;
  /** Each tool step re-pointed, as `<tool step>-><agent step>`. */
  readonly resolved: readonly string[];
  /** Each tool step left as written, as `<tool step>:<why>`. */
  readonly unresolved: readonly string[];
}

type Step = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const idsOf = (v: unknown): string[] | undefined =>
  v === undefined
    ? []
    : Array.isArray(v) && v.every((x) => typeof x === 'string')
      ? [...(v as string[])]
      : undefined;

export function resolveToolSteps(
  proposal: Readonly<Record<string, unknown>>,
  agents: readonly PlannerAgentView[],
): ToolStepResolution {
  const unchanged = { proposal, resolved: [], unresolved: [] };
  const raw = proposal.steps;
  if (!Array.isArray(raw) || !raw.every(isRecord)) return unchanged;
  // Copies, so the model's answer is never changed in place.
  const steps: Step[] = raw.map((s) => ({ ...s }));
  const byId = new Map<string, Step>();
  for (const s of steps) {
    if (typeof s.id !== 'string' || byId.has(s.id) || idsOf(s.dependsOn) === undefined) {
      return unchanged; // malformed or duplicate ids: the schema stage names it
    }
    byId.set(s.id, s);
  }
  const isSpecialist = (s: Step | undefined) =>
    s?.kind === 'specialist' && typeof s.specialistId === 'string';
  const holds = (agent: PlannerAgentView, tool: Record<string, unknown>) =>
    agent.tools.some((t) => t.id === tool.id && t.version === tool.version);

  const resolved: string[] = [];
  const unresolved: string[] = [];
  const moved = new Map<string, string>(); // tool step → agent step, for ordering

  /** The tool step `t` runs inside `s`: it waits on `s`, and what it waited on, `s` waits on. */
  const rewrite = (t: Step, s: Step, tDeps: readonly string[]) => {
    const id = t.id as string;
    const sid = s.id as string;

    // What the tool step waited on, the agent's step now waits on; a tool step of another
    // agent's work is reached through that work's own step.
    const sDeps = (idsOf(s.dependsOn) as string[]).filter((d) => d !== id);
    const keep: string[] = [sid];
    for (const d of tDeps) {
      if (d === sid) continue;
      const dep = byId.get(d);
      if (dep?.kind === 'tool' && dep.performedBy === sid) {
        keep.push(d);
        continue;
      }
      const through =
        dep?.kind === 'tool' && typeof dep.performedBy === 'string' ? dep.performedBy : d;
      if (through !== sid && !sDeps.includes(through)) sDeps.push(through);
    }
    s.dependsOn = sDeps;
    t.dependsOn = [...new Set(keep)];
    t.performedBy = sid;
    // Steps that waited on the tool step wait on the agent's step, which ends with it.
    for (const x of steps) {
      if (x === s || x === t || x.kind === 'tool') continue;
      const deps = idsOf(x.dependsOn) as string[];
      if (!deps.includes(id)) continue;
      x.dependsOn = [...new Set(deps.map((d) => (d === id ? sid : d)))];
    }
    moved.set(id, sid);
    resolved.push(`${id}->${sid}`);
  };

  for (const t of steps) {
    if (t.kind !== 'tool' || !isRecord(t.tool)) continue;
    const id = t.id as string;
    const by = t.performedBy;
    const tDeps = idsOf(t.dependsOn) as string[];

    // performedBy already names a specialist step (p12). Read as written unless that step, or
    // other work, waits on the tool step: then the step ends with its tool, as the engine runs
    // it, when the step's agent is known and holds the tool. Otherwise it is left as written.
    if (typeof by === 'string' && isSpecialist(byId.get(by))) {
      const performer = byId.get(by) as Step;
      const backwards =
        (idsOf(performer.dependsOn) as string[]).includes(id) ||
        steps.some(
          (x) =>
            x.kind !== 'tool' && x !== performer && (idsOf(x.dependsOn) as string[]).includes(id),
        );
      if (!backwards) continue;
      const owner = agents.filter((a) => a.specialistId === performer.specialistId);
      if (owner.length !== 1) {
        unresolved.push(`${id}:${owner.length === 0 ? 'unknown_performer' : 'ambiguous_agent'}`);
        continue;
      }
      if (!holds(owner[0] as PlannerAgentView, t.tool)) {
        unresolved.push(`${id}:tool_not_held`);
        continue;
      }
      rewrite(t, performer, tDeps);
      continue;
    }

    // The agent: named by specialistId, department or role (ADR-0175), or the one agent holding the tool.
    let agent: PlannerAgentView | undefined;
    let why: ToolStepUnresolved | undefined;
    if (typeof by === 'string') {
      const named = agents.filter(
        (a) => a.specialistId === by || a.departmentType === by || a.roleId === by,
      );
      if (named.length === 1) agent = named[0];
      else why = named.length === 0 ? 'unknown_performer' : 'ambiguous_agent';
    } else if (by === undefined) {
      const holders = agents.filter((a) => holds(a, t.tool as Record<string, unknown>));
      const inPlan = holders.filter((a) =>
        steps.some((s) => isSpecialist(s) && s.specialistId === a.specialistId),
      );
      if (inPlan.length === 1) agent = inPlan[0];
      else why = inPlan.length === 0 ? 'unknown_performer' : 'ambiguous_agent';
    } else {
      why = 'unknown_performer';
    }
    if (agent !== undefined && !holds(agent, t.tool)) why = 'tool_not_held';
    if (agent === undefined || why !== undefined) {
      unresolved.push(`${id}:${why ?? 'unknown_performer'}`);
      continue;
    }

    // The agent's step: its only one, or the one tied to this tool step.
    const own = steps.filter((s) => isSpecialist(s) && s.specialistId === agent.specialistId);
    let step: Step | undefined;
    if (own.length === 1) step = own[0];
    else if (own.length > 1) {
      const waiting = own.filter((s) => (idsOf(s.dependsOn) as string[]).includes(id));
      const waited = own.filter((s) => tDeps.includes(s.id as string));
      const tied = waiting.length === 1 ? waiting : waited.length === 1 ? waited : [];
      step = tied[0];
    }
    if (step === undefined) {
      unresolved.push(`${id}:${own.length === 0 ? 'no_agent_step' : 'ambiguous_step'}`);
      continue;
    }
    rewrite(t, step, tDeps);
  }

  if (resolved.length === 0) return { proposal, resolved, unresolved };
  // Each re-pointed tool step is listed right after its agent's step, as the editor shows them.
  const ordered = steps.filter((s) => !moved.has(s.id as string));
  for (const [tool, owner] of moved) {
    const at = ordered.findIndex((s) => s.id === owner);
    let end = at + 1;
    while (
      end < ordered.length &&
      ordered[end]?.kind === 'tool' &&
      ordered[end]?.performedBy === owner
    ) {
      end += 1;
    }
    ordered.splice(end, 0, byId.get(tool) as Step);
  }
  return { proposal: { ...proposal, steps: ordered }, resolved, unresolved };
}
