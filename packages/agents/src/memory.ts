import { createHash, randomUUID } from 'node:crypto';
import { actorOf, buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import type {
  AgentMemory,
  AgentMemoryKind,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  SpecialistConfiguration,
  SpecialistId,
  SpecialistVersion,
} from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isSpecialistId, workSettingOf, type SpecialistRepository } from '@melonoffice/specialists';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { AgentTaskError } from './errors.js';
import type { AgentContextBlock } from './work.js';

/**
 * An agent's own memory (ADR-0117): short notes it keeps between tasks about how to work for its
 * organization, such as the people's preferences and what it learned. Four kinds of memory, and
 * only this one is new:
 *
 * - a task's memory is the task's own execution and kept answers (ADR-0063, ADR-0103);
 * - working memory is what one task carries between its turns and a plan's steps (ADR-0070);
 * - the agent's memory is this, `agentMemories/{id}`, one agent's notes in one organization;
 * - the company's memory is Company Brain (ADR-0051), the business's facts, shared and confirmed
 *   by its people. This module never writes to it nor reads from it, and it never reads this.
 *
 * Notes are kept only while the agent's `memory` setting is on, are read only by that agent, last
 * `retentionDays` and are never read after, and any note can be deleted by a person who manages
 * agents. A note is never a secret nor someone's contact details: such a note is refused.
 */

export const AGENT_MEMORY_LIMITS = Object.freeze({
  /** The most notes one agent keeps: a new note from a task replaces its oldest. */
  perAgent: 50,
  /** The most notes one task may add. */
  perTask: 2,
  textLength: 300,
  retentionDays: 180,
  /** The most notes the agent reads at the start of a task: its newest. */
  context: 20,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MEMORY_ID = /^[0-9a-f]{32}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Text that reads like a secret or someone's contact details: never kept in a note. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:password|passwd|contraseña|clave|api[_ -]?key|secret|token|bearer)\b\s*(?:[:=]|es\b|is\b)/i,
  /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Za-z0-9+/_-]{40,}\b/,
];
const CONTACT_PATTERNS: readonly RegExp[] = [
  /[^\s@]+@[^\s@]+\.[^\s@]{2,}/,
  /(?:\+?\d[\s().-]?){8,}/,
  /\b(?:\d[ -]?){13,19}\b/,
];

export type AgentMemoryProblem = 'empty' | 'too_long' | 'control' | 'secret' | 'contact_details';

/** Why a note's text may not be kept, or `undefined` when it may. */
export function memoryTextProblem(text: string): AgentMemoryProblem | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'empty';
  if (trimmed.length > AGENT_MEMORY_LIMITS.textLength) return 'too_long';
  if (CONTROL.test(trimmed)) return 'control';
  if (SECRET_PATTERNS.some((p) => p.test(trimmed))) return 'secret';
  if (CONTACT_PATTERNS.some((p) => p.test(trimmed))) return 'contact_details';
  return undefined;
}

/** Whether a note is still kept at `at`. */
export const isMemoryLive = (memory: AgentMemory, at: Date): boolean =>
  Date.parse(memory.expiresAt) > at.getTime();

const newestFirst = (a: AgentMemory, b: AgentMemory) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1;

/** A note from a task: the same task's same note is always the same id. */
export const taskMemoryId = (
  organizationId: OrganizationId,
  specialistId: SpecialistId,
  taskId: ExecutionId,
  index: number,
): string =>
  createHash('sha256')
    .update(`agent-memory:${organizationId}:${specialistId}:${taskId}:${index}`)
    .digest('hex')
    .slice(0, 32);

/**
 * Where an agent's notes live: Firestore (`agentMemories/{id}`), memory in tests. Every read is
 * for one organization and one agent; another's notes are never returned. Each change is stored
 * with its audit events, together.
 */
export interface AgentMemoryRepository {
  /** Every note of the agent, expired ones included (the service reads only live ones). */
  list(organizationId: OrganizationId, specialistId: SpecialistId): Promise<readonly AgentMemory[]>;
  /**
   * Stores `add` (a note with an id already stored is left as it is) and deletes `remove`, with
   * `events`, together.
   */
  write(
    organizationId: OrganizationId,
    specialistId: SpecialistId,
    change: {
      readonly add: readonly AgentMemory[];
      readonly remove: readonly string[];
      readonly events: readonly AuditEvent[];
    },
  ): Promise<void>;
}

export class InMemoryAgentMemoryRepository implements AgentMemoryRepository {
  readonly #notes = new Map<string, AgentMemory>();

  constructor(private readonly audit?: { append(events: readonly AuditEvent[]): Promise<void> }) {}

  async list(organizationId: OrganizationId, specialistId: SpecialistId) {
    return [...this.#notes.values()].filter(
      (m) => m.organizationId === organizationId && m.specialistId === specialistId,
    );
  }

  async write(
    organizationId: OrganizationId,
    specialistId: SpecialistId,
    change: Parameters<AgentMemoryRepository['write']>[2],
  ) {
    for (const note of change.add) {
      if (note.organizationId !== organizationId || note.specialistId !== specialistId) {
        throw new Error('memory organization');
      }
    }
    await this.audit?.append(change.events);
    for (const id of change.remove) {
      const note = this.#notes.get(id);
      if (note?.organizationId === organizationId && note.specialistId === specialistId) {
        this.#notes.delete(id);
      }
    }
    for (const note of change.add) {
      if (!this.#notes.has(note.id)) this.#notes.set(note.id, Object.freeze({ ...note }));
    }
  }
}

/** A note as a person reads it. */
export type AgentMemoryView = Pick<
  AgentMemory,
  'id' | 'kind' | 'text' | 'createdAt' | 'expiresAt'
> & {
  readonly source: 'task' | 'person';
};

export interface AgentMemoryService {
  /** `specialist.read`: the agent's live notes, newest first, and whether its memory is on. */
  list(
    tenant: TenantContext,
    specialistId: string,
  ): Promise<{ readonly enabled: boolean; readonly items: readonly AgentMemoryView[] }>;
  /** `specialist.manage`, a person directly: adds a note `{ text }` to the agent's memory. */
  remember(tenant: TenantContext, specialistId: string, input: unknown): Promise<AgentMemoryView>;
  /** `specialist.manage`, a person directly: deletes one note. */
  forget(tenant: TenantContext, specialistId: string, memoryId: string): Promise<void>;
  /** `specialist.manage`, a person directly: deletes every note of the agent. */
  clear(tenant: TenantContext, specialistId: string): Promise<number>;
}

const viewOf = (m: AgentMemory): AgentMemoryView =>
  Object.freeze({
    id: m.id,
    kind: m.kind,
    text: m.text,
    source: m.source.type,
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
  });

export function createAgentMemoryService(options: {
  readonly repository: AgentMemoryRepository;
  readonly specialists: Pick<SpecialistRepository, 'find'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly now?: () => Date;
  readonly requestId?: string;
}): AgentMemoryService {
  const { repository, specialists, authorization, requestId } = options;
  const now = options.now ?? (() => new Date());

  async function agentOf(
    tenant: TenantContext,
    specialistId: string,
    permission: 'specialist.read' | 'specialist.manage',
  ) {
    if (!isResolvedTenant(tenant)) throw new AgentTaskError('unresolved_tenant');
    if (!authorization.authorize(tenant, permission).allowed) {
      throw new AgentTaskError('permission_denied');
    }
    // Changing an agent's memory is a person's decision: never GIA's, never the runtime's.
    if (permission === 'specialist.manage' && tenant.actor !== 'user') {
      throw new AgentTaskError('permission_denied');
    }
    const organizationId = tenant.organizationId as OrganizationId;
    if (!isSpecialistId(specialistId)) throw new AgentTaskError('specialist_not_found');
    const agent = await specialists.find(organizationId, specialistId);
    if (agent === undefined) throw new AgentTaskError('specialist_not_found');
    return { organizationId, agent };
  }

  const event = (
    tenant: TenantContext,
    organizationId: OrganizationId,
    action: 'agent_memory.recorded' | 'agent_memory.forgotten' | 'agent_memory.cleared',
    target: { readonly type: 'agent_memory' | 'specialist'; readonly id: string },
    at: Date,
  ): AuditEvent =>
    buildAuditEvent(
      {
        action,
        result: 'success',
        actor: actorOf(tenant),
        organizationId,
        target,
        permission: 'specialist.manage',
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  return Object.freeze({
    async list(tenant, specialistId) {
      const { organizationId, agent } = await agentOf(tenant, specialistId, 'specialist.read');
      const at = now();
      const notes = await repository.list(organizationId, agent.identity.id);
      return Object.freeze({
        enabled: workSettingOf(agent.configuration, 'memory'),
        items: Object.freeze(
          notes
            .filter((m) => isMemoryLive(m, at))
            .sort(newestFirst)
            .map(viewOf),
        ),
      });
    },

    async remember(tenant, specialistId, input) {
      const { organizationId, agent } = await agentOf(tenant, specialistId, 'specialist.manage');
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new AgentTaskError('invalid_memory', 'body');
      }
      for (const key of Object.keys(input)) {
        if (key !== 'text') throw new AgentTaskError('invalid_memory', key);
      }
      const { text } = input as { text?: unknown };
      if (typeof text !== 'string') throw new AgentTaskError('invalid_memory', 'text');
      const problem = memoryTextProblem(text);
      if (problem !== undefined) throw new AgentTaskError('invalid_memory', problem);
      const at = now();
      const live = (await repository.list(organizationId, agent.identity.id)).filter((m) =>
        isMemoryLive(m, at),
      );
      // A person's note never pushes another out: a full memory is theirs to tidy first.
      if (live.length >= AGENT_MEMORY_LIMITS.perAgent) throw new AgentTaskError('memory_full');
      if (!isResolvedTenant(tenant)) throw new AgentTaskError('unresolved_tenant');
      const note: AgentMemory = Object.freeze({
        id: randomUUID().replace(/-/g, ''),
        organizationId,
        specialistId: agent.identity.id,
        kind: 'note',
        text: text.trim(),
        source: { type: 'person' as const, id: tenant.userId },
        createdAt: at.toISOString() as IsoTimestamp,
        expiresAt: new Date(
          at.getTime() + AGENT_MEMORY_LIMITS.retentionDays * DAY_MS,
        ).toISOString() as IsoTimestamp,
      });
      await repository.write(organizationId, agent.identity.id, {
        add: [note],
        remove: expiredIds(await repository.list(organizationId, agent.identity.id), at),
        events: [
          event(
            tenant,
            organizationId,
            'agent_memory.recorded',
            { type: 'agent_memory', id: note.id },
            at,
          ),
        ],
      });
      return viewOf(note);
    },

    async forget(tenant, specialistId, memoryId) {
      const { organizationId, agent } = await agentOf(tenant, specialistId, 'specialist.manage');
      if (!MEMORY_ID.test(memoryId)) throw new AgentTaskError('memory_not_found');
      const notes = await repository.list(organizationId, agent.identity.id);
      if (!notes.some((m) => m.id === memoryId)) throw new AgentTaskError('memory_not_found');
      const at = now();
      await repository.write(organizationId, agent.identity.id, {
        add: [],
        remove: [memoryId],
        events: [
          event(
            tenant,
            organizationId,
            'agent_memory.forgotten',
            { type: 'agent_memory', id: memoryId },
            at,
          ),
        ],
      });
    },

    async clear(tenant, specialistId) {
      const { organizationId, agent } = await agentOf(tenant, specialistId, 'specialist.manage');
      const notes = await repository.list(organizationId, agent.identity.id);
      const at = now();
      await repository.write(organizationId, agent.identity.id, {
        add: [],
        remove: notes.map((m) => m.id),
        events: [
          event(
            tenant,
            organizationId,
            'agent_memory.cleared',
            { type: 'specialist', id: agent.identity.id },
            at,
          ),
        ],
      });
      return notes.length;
    },
  } satisfies AgentMemoryService);
}

const expiredIds = (notes: readonly AgentMemory[], at: Date): string[] =>
  notes.filter((m) => !isMemoryLive(m, at)).map((m) => m.id);

/** A note an agent proposed in its answer: what kind, and its words. */
export interface ProposedMemory {
  readonly kind: Extract<AgentMemoryKind, 'preference' | 'lesson'>;
  readonly text: string;
}

/** The notes an answer proposed, as far as they can be kept: anything else is dropped. */
export function parseProposedMemories(value: unknown): readonly ProposedMemory[] {
  if (!Array.isArray(value)) return [];
  const kept: ProposedMemory[] = [];
  for (const item of value.slice(0, AGENT_MEMORY_LIMITS.perTask)) {
    if (typeof item !== 'object' || item === null) continue;
    const { kind, text } = item as { kind?: unknown; text?: unknown };
    if (kind !== 'preference' && kind !== 'lesson') continue;
    if (typeof text !== 'string' || memoryTextProblem(text) !== undefined) continue;
    kept.push(Object.freeze({ kind, text: text.trim() }));
  }
  return Object.freeze(kept);
}

/** The answer's field for notes, offered only to an agent whose memory is on. */
export const MEMORY_SCHEMA = Object.freeze({
  type: 'array',
  maxItems: AGENT_MEMORY_LIMITS.perTask,
  items: {
    type: 'object',
    required: ['kind', 'text'],
    properties: {
      kind: { type: 'string', enum: ['preference', 'lesson'] },
      text: { type: 'string', maxLength: AGENT_MEMORY_LIMITS.textLength },
    },
  },
} as const);

/** What the model is told about its own notes. */
export const MEMORY_RULES: readonly string[] = Object.freeze([
  'You have your own memory: <context> may hold agent_memory, notes you kept from earlier tasks. Use them for how you work, never as facts about the business.',
  'You may keep up to 2 short notes for your next tasks in "remember": a preference of the people you work for ("preference") or a lesson about how to do your work better ("lesson"). Usually there are none. Never a fact about the business (those are the company memory\'s), never a secret, a password, a figure from <context>, nor anyone\'s name, email, phone or other personal details.',
]);

/**
 * Keeps the notes a finished task proposed (ADR-0117), as the runtime for the person the task
 * ran for: only when the version the task ran has its memory on, never more than the limits, and
 * a full memory gives up its oldest notes from tasks, never a person's. Returns how many it kept.
 */
export function createAgentMemoryRecorder(options: {
  readonly repository: AgentMemoryRepository;
  readonly specialists: Pick<SpecialistRepository, 'findVersion'>;
  readonly now?: () => Date;
}): {
  record(
    tenant: TenantContext,
    task: {
      readonly taskId: ExecutionId;
      readonly specialistId: SpecialistId;
      readonly specialistVersion: number;
    },
    proposed: readonly ProposedMemory[],
  ): Promise<number>;
} {
  const { repository, specialists } = options;
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async record(tenant, task, proposed) {
      if (!isResolvedTenant(tenant) || proposed.length === 0) return 0;
      const organizationId = tenant.organizationId as OrganizationId;
      const version: SpecialistVersion | undefined = await specialists.findVersion(
        organizationId,
        task.specialistId,
        task.specialistVersion,
      );
      if (version === undefined || !workSettingOf(version.configuration, 'memory')) return 0;
      const at = now();
      const notes = proposed.slice(0, AGENT_MEMORY_LIMITS.perTask).map((p, index): AgentMemory =>
        Object.freeze({
          id: taskMemoryId(organizationId, task.specialistId, task.taskId, index),
          organizationId,
          specialistId: task.specialistId,
          kind: p.kind,
          text: p.text,
          source: { type: 'task' as const, id: task.taskId },
          createdAt: at.toISOString() as IsoTimestamp,
          expiresAt: new Date(
            at.getTime() + AGENT_MEMORY_LIMITS.retentionDays * DAY_MS,
          ).toISOString() as IsoTimestamp,
        }),
      );
      const stored = await repository.list(organizationId, task.specialistId);
      const known = new Set(stored.map((m) => m.id));
      const fresh = notes.filter((n) => !known.has(n.id));
      if (fresh.length === 0) return 0;
      const live = stored.filter((m) => isMemoryLive(m, at));
      // A full memory gives up its oldest notes from tasks; a person's notes are never pushed out,
      // so with no room left beside them the agent keeps nothing new.
      const capacity =
        AGENT_MEMORY_LIMITS.perAgent - live.filter((m) => m.source.type === 'person').length;
      const room = fresh.slice(0, Math.max(0, capacity));
      const fromTasks = live
        .filter((m) => m.source.type === 'task')
        .sort(newestFirst)
        .reverse();
      const pushedOut = fromTasks
        .slice(0, Math.max(0, fromTasks.length + room.length - capacity))
        .map((m) => m.id);
      if (room.length === 0) return 0;
      await repository.write(organizationId, task.specialistId, {
        add: room,
        remove: [...expiredIds(stored, at), ...pushedOut],
        events: room.map((n) =>
          buildAuditEvent(
            {
              action: 'agent_memory.recorded',
              result: 'success',
              actor: actorOf(tenant),
              organizationId,
              target: { type: 'agent_memory', id: n.id },
              reference: `execution:${task.taskId}`,
              source: 'api',
            },
            at,
          ),
        ),
      });
      return room.length;
    },
  });
}

/**
 * The agent's own notes as context (ADR-0117): its newest live ones, only when the version it
 * runs has its memory on, only that agent's, of the organization of the task. Never Company
 * Brain's facts, which come from their own source.
 */
export function createAgentMemoryContext(options: {
  readonly repository: Pick<AgentMemoryRepository, 'list'>;
  readonly now?: () => Date;
}): {
  read(
    tenant: TenantContext,
    agent: {
      readonly specialistId: SpecialistId;
      readonly configuration: SpecialistConfiguration;
    },
  ): Promise<AgentContextBlock | undefined>;
} {
  const { repository } = options;
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async read(tenant, agent) {
      if (!isResolvedTenant(tenant) || !workSettingOf(agent.configuration, 'memory')) {
        return undefined;
      }
      const at = now();
      try {
        const notes = (
          await repository.list(tenant.organizationId as OrganizationId, agent.specialistId)
        )
          .filter((m) => isMemoryLive(m, at))
          .sort(newestFirst)
          .slice(0, AGENT_MEMORY_LIMITS.context);
        return {
          name: 'agent_memory',
          text:
            notes.length === 0
              ? '(you have no notes yet)'
              : notes.map((m) => `- (${m.kind}) ${m.text}`).join('\n'),
        };
      } catch {
        return { name: 'agent_memory', text: '(your notes could not be read now)' };
      }
    },
  });
}
