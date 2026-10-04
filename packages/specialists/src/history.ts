import type { SpecialistConfiguration } from '@melonoffice/domain';
import { AGENT_WORK_SETTINGS, autonomyOf, workSettingsOf } from './model.js';

/**
 * What one version of an agent changed from the one before it (AC-3, ADR-0142), from the stored
 * versions themselves: the same record every change already writes, so the history can never
 * disagree with them. Only what a person audits: its department, purpose, description, skills,
 * autonomy and work settings. Its tools, permissions, policies and conversation profile are never
 * described; a version that changed only those reads as `other`.
 */
export type AgentChange =
  | { readonly kind: 'created' }
  | {
      readonly kind: 'department';
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: 'purpose' | 'description';
      readonly before: string | null;
      readonly after: string | null;
    }
  | {
      readonly kind: 'skills';
      readonly added: readonly SkillAt[];
      readonly removed: readonly SkillAt[];
      readonly updated: readonly {
        readonly id: string;
        readonly from: number;
        readonly to: number;
      }[];
    }
  | { readonly kind: 'autonomy'; readonly before: string; readonly after: string }
  | {
      readonly kind: 'work';
      readonly before: Readonly<Record<string, boolean>>;
      readonly after: Readonly<Record<string, boolean>>;
    }
  | { readonly kind: 'other' };

interface SkillAt {
  readonly id: string;
  readonly version: number;
}

export function agentChanges(
  next: SpecialistConfiguration,
  previous: SpecialistConfiguration | undefined,
): readonly AgentChange[] {
  if (previous === undefined) return Object.freeze([Object.freeze({ kind: 'created' as const })]);
  const changes: AgentChange[] = [];
  if (next.departmentId !== previous.departmentId) {
    changes.push({ kind: 'department', before: previous.departmentId, after: next.departmentId });
  }
  for (const kind of ['purpose', 'description'] as const) {
    const before = previous[kind] ?? null;
    const after = next[kind] ?? null;
    if (before !== after) changes.push({ kind, before, after });
  }
  const skillAt = ({ id, version }: SkillAt): SkillAt => ({ id, version });
  const added = next.skills.filter((s) => !previous.skills.some((p) => p.id === s.id));
  const removed = previous.skills.filter((p) => !next.skills.some((s) => s.id === p.id));
  const updated = next.skills.flatMap((s) => {
    const was = previous.skills.find((p) => p.id === s.id);
    return was !== undefined && was.version !== s.version
      ? [{ id: s.id as string, from: was.version, to: s.version }]
      : [];
  });
  if (added.length + removed.length + updated.length > 0) {
    changes.push({
      kind: 'skills',
      added: added.map(skillAt),
      removed: removed.map(skillAt),
      updated,
    });
  }
  if (autonomyOf(next) !== autonomyOf(previous)) {
    changes.push({ kind: 'autonomy', before: autonomyOf(previous), after: autonomyOf(next) });
  }
  const workBefore = workSettingsOf(previous);
  const workAfter = workSettingsOf(next);
  if (AGENT_WORK_SETTINGS.some((k) => workBefore[k] !== workAfter[k])) {
    changes.push({ kind: 'work', before: workBefore, after: workAfter });
  }
  if (changes.length === 0) changes.push({ kind: 'other' });
  return Object.freeze(changes.map((c) => Object.freeze(c)));
}
