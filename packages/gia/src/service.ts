import type { ActivityItem } from '@melonoffice/activity';
import { creditReferenceOf, type AIGateway, type AIResponse } from '@melonoffice/ai-gateway';
import { actorOf, type AuditModel, type AuditService } from '@melonoffice/audit';
import {
  candidateOf,
  type CompanyBrainService,
  type ContextFact,
  type KnowledgeGaps,
} from '@melonoffice/brain';
import type { DepartmentRepository } from '@melonoffice/departments';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { withCorrelation, type Logger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { createHash } from 'node:crypto';
import {
  GIA_LIMITS,
  GIA_LOCALES,
  GIA_RATE_LIMITS,
  GIA_SCREENS,
  type GiaLocale,
  type GiaRateLimits,
  type GiaScreen,
} from './catalogue.js';
import { GiaError } from './errors.js';
import { giaMessages, giaOutputSchema, type GiaTurn } from './prompt.js';

/**
 * GIA's chat (Fase 1c, ADR-0052). A person asks; GIA reads, as that person, a few Company Brain
 * facts chosen for the question, today's activity and what she still needs to learn, and answers
 * through the one AI Gateway in its assisted mode: the gateway picks the model by its named
 * policy, charges the credits and audits the call. GIA is not an AI engine of her own.
 *
 * She answers, explains and points to a screen and a department. She never acts: no message,
 * publication, payment or change leaves this service. The only thing she keeps is what the
 * person told her about the business, as proposals in Company Brain that a person confirms.
 * The chat itself is not stored; the client sends back its last few turns.
 */
export interface GiaService {
  ask(
    tenant: TenantContext,
    input: {
      readonly message: unknown;
      /** The caller's key: the same key is the same question, answered (and charged) once. */
      readonly requestKey: unknown;
      readonly locale?: unknown;
      readonly history?: unknown;
    },
  ): Promise<GiaAnswer>;
}

export interface GiaAnswer {
  readonly answer: string;
  /** The department the question belongs to (a catalogue type), when one does. Nothing is sent. */
  readonly department: string | null;
  readonly screen: Exclude<GiaScreen, 'none'> | null;
  /** A suggestion the person may carry out themselves. Never run. */
  readonly proposedAction: string | null;
  /** How many facts GIA proposed to Company Brain from this message, to be confirmed. */
  readonly proposedFacts: number;
  /** What she read: how many facts, whether today's activity, and what is still unknown. */
  readonly context: {
    readonly facts: number;
    readonly activity: boolean;
    readonly missing: readonly string[];
  };
  readonly replayed: boolean;
}

/** Today's activity as the person may read it (ADR-0049), in the business's time zone. */
export interface GiaActivityPort {
  today(tenant: TenantContext): Promise<readonly ActivityItem[]>;
}

export interface GiaOptions {
  readonly gateway: Pick<AIGateway, 'assist'>;
  readonly brain?: Pick<CompanyBrainService, 'context' | 'gaps' | 'ingest'>;
  readonly activity?: GiaActivityPort;
  readonly departments: Pick<DepartmentRepository, 'list'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly audit: AuditService;
  readonly logger?: Logger;
  readonly rateLimits?: GiaRateLimits;
  /** How long an answered question is kept to answer its repeats. */
  readonly replayMs?: number;
  readonly now?: () => Date;
}

const REQUEST_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_REPLAYS = 500;
const MAX_DEPARTMENTS = 40;
/** What GIA always knows of the business, whatever the question. */
const CORE_DOMAINS = ['identity', 'business_model', 'brand'] as const;
const CORE_FACTS = 10;

/** Gateway refusals the person sees as such; any other one is "not available here". */
const DENIALS: Readonly<Record<string, GiaError['code']>> = {
  permission_denied: 'permission_denied',
  assist_requires_user: 'requires_user',
  unresolved_tenant: 'permission_denied',
  organization_inactive: 'organization_inactive',
  credits_insufficient: 'ai_credits_insufficient',
  credit_limit_exceeded: 'ai_credits_insufficient',
  sensitivity_not_allowed: 'ai_policy_denied',
  provider_not_allowed: 'ai_policy_denied',
  model_not_allowed: 'ai_policy_denied',
  environment_not_allowed: 'ai_policy_denied',
  capability_unsupported: 'ai_policy_denied',
  modality_unsupported: 'ai_policy_denied',
  requirements_unmet: 'ai_policy_denied',
  cost_limit_exceeded: 'ai_policy_denied',
  provider_unavailable: 'ai_unavailable',
};

const FAILURES: Readonly<Record<string, GiaError['code']>> = {
  timeout: 'ai_timeout',
  rate_limited: 'rate_limited',
};

/**
 * The gateway request id of one question: organization, user and the caller's key. The same
 * click is the same id, so the credits ledger charges it once, and another user's never collides.
 */
export function giaRequestIdOf(
  organizationId: OrganizationId,
  userId: UserId,
  requestKey: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['gia', organizationId, userId, requestKey]))
    .digest('hex');
  return `gia_${digest.slice(0, 48)}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function checkHistory(raw: unknown): readonly GiaTurn[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > GIA_LIMITS.historyTurns) {
    throw new GiaError('invalid_request', 'history');
  }
  return raw.map((turn) => {
    if (
      !isRecord(turn) ||
      (turn.role !== 'person' && turn.role !== 'gia') ||
      typeof turn.text !== 'string' ||
      turn.text.trim() === '' ||
      turn.text.length > GIA_LIMITS.historyLength
    ) {
      throw new GiaError('invalid_request', 'history');
    }
    return { role: turn.role, text: turn.text };
  });
}

/** The model's answer, checked; undefined when it is not usable. */
function parseAnswer(
  response: Extract<AIResponse, { status: 'completed' }>,
  departments: readonly string[],
):
  | {
      answer: string;
      department: string | null;
      screen: GiaScreen;
      action: string | null;
      facts: unknown[];
    }
  | undefined {
  let output: unknown = response.output.structured;
  if (output === undefined && typeof response.output.text === 'string') {
    try {
      output = JSON.parse(response.output.text);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(output)) return undefined;
  const { answer, department, screen, proposedAction, facts } = output;
  if (typeof answer !== 'string' || answer.trim() === '') return undefined;
  if (answer.length > GIA_LIMITS.answerLength) return undefined;
  if (typeof screen !== 'string' || !(GIA_SCREENS as readonly string[]).includes(screen)) {
    return undefined;
  }
  // A department that is not one of this organization's is no routing at all.
  const routed =
    typeof department === 'string' && departments.includes(department) ? department : null;
  const action =
    typeof proposedAction === 'string' &&
    proposedAction.trim() !== '' &&
    proposedAction.length <= GIA_LIMITS.proposedActionLength
      ? proposedAction.trim()
      : null;
  return {
    answer: answer.trim(),
    department: routed,
    screen: screen as GiaScreen,
    action,
    facts: Array.isArray(facts) ? facts.slice(0, GIA_LIMITS.facts) : [],
  };
}

export function createGia(options: GiaOptions): GiaService {
  const {
    gateway,
    brain,
    activity,
    departments,
    authorization,
    audit,
    rateLimits = GIA_RATE_LIMITS,
    replayMs = 15 * 60_000,
    now = () => new Date(),
  } = options;
  const logger = options.logger ?? silent;
  const can = (tenant: TenantContext, permission: string) =>
    authorization.authorize(tenant, permission).allowed;

  const answered = new Map<string, { readonly at: number; readonly answer: GiaAnswer }>();
  const running = new Map<string, Promise<GiaAnswer>>();
  const windows = new Map<string, { start: number; count: number }>();

  function allow(keys: readonly [string, number][]): boolean {
    const at = now().getTime();
    const current = keys.map(([key, limit]) => {
      let window = windows.get(key);
      if (window === undefined || at - window.start >= rateLimits.windowMs) {
        window = { start: at, count: 0 };
        windows.set(key, window);
      }
      return { window, limit };
    });
    if (current.some(({ window, limit }) => window.count >= limit)) return false;
    for (const { window } of current) window.count += 1;
    if (windows.size > 10_000) {
      for (const [key, window] of windows) {
        if (at - window.start >= rateLimits.windowMs) windows.delete(key);
      }
    }
    return true;
  }

  function remember(requestId: string, answer: GiaAnswer): void {
    const at = now().getTime();
    answered.set(requestId, { at, answer });
    for (const [key, entry] of answered) {
      if (answered.size <= MAX_REPLAYS && at - entry.at < replayMs) break;
      answered.delete(key);
    }
  }

  return Object.freeze({
    async ask(tenant: TenantContext, input: Parameters<GiaService['ask']>[1]) {
      const { message, requestKey } = input;
      if (typeof message !== 'string' || message.trim() === '') {
        throw new GiaError('invalid_request', 'message');
      }
      if (message.length > GIA_LIMITS.messageLength) {
        throw new GiaError('invalid_request', 'message');
      }
      if (typeof requestKey !== 'string' || !REQUEST_KEY.test(requestKey)) {
        throw new GiaError('invalid_request', 'requestKey');
      }
      const locale = input.locale ?? 'es';
      if (typeof locale !== 'string' || !(GIA_LOCALES as readonly string[]).includes(locale)) {
        throw new GiaError('invalid_request', 'locale');
      }
      const history = checkHistory(input.history);
      if (!isResolvedTenant(tenant)) throw new GiaError('unresolved_tenant');
      // GIA speaks for a person asking directly; she is not a caller of herself.
      if (tenant.actor !== 'user') throw new GiaError('requires_user');
      if (!can(tenant, 'gia.ask')) throw new GiaError('permission_denied');

      const requestId = giaRequestIdOf(tenant.organizationId, tenant.userId, requestKey);
      const previous = answered.get(requestId);
      if (previous !== undefined && now().getTime() - previous.at < replayMs) {
        return { ...previous.answer, replayed: true };
      }
      const pending = running.get(requestId);
      if (pending !== undefined) return { ...(await pending), replayed: true };

      const work = run(tenant, message, locale as GiaLocale, history, requestId);
      running.set(requestId, work);
      try {
        const answer = await work;
        remember(requestId, answer);
        return answer;
      } finally {
        running.delete(requestId);
      }
    },
  });

  async function run(
    tenant: TenantContext,
    message: string,
    locale: GiaLocale,
    history: readonly GiaTurn[],
    requestId: string,
  ): Promise<GiaAnswer> {
    const organizationId = tenant.organizationId;
    const log = withCorrelation(logger, { requestId, organizationId });
    const record = (
      result: 'success' | 'denied' | 'failure',
      fields: { readonly reason?: string; readonly model?: AuditModel } = {},
    ) =>
      audit.record({
        action: 'gia.message_answered',
        result,
        actor: actorOf(tenant),
        organizationId,
        target: { type: 'organization', id: organizationId },
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        ...(fields.model === undefined ? {} : { model: fields.model }),
        reference: creditReferenceOf(requestId),
        requestId,
        source: 'api',
      });

    if (
      !allow([
        [`u:${organizationId}:${tenant.userId}`, rateLimits.perUser],
        [`o:${organizationId}`, rateLimits.perOrganization],
      ])
    ) {
      await record('denied', { reason: 'rate_limited' });
      throw new GiaError('rate_limited');
    }

    // What she reads, as this person: each part only with its own permission, and a part she
    // cannot read is simply left out (she says she does not know, never guesses).
    const [facts, gaps, today, types] = await Promise.all([
      readFacts(tenant, message),
      readGaps(tenant),
      readActivity(tenant),
      activeTypes(organizationId),
    ]);
    const missing = gaps?.questions.map((q) => q.id) ?? [];

    const started = performance.now();
    const response = await gateway.assist(tenant, {
      requestId,
      subject: { type: 'gia', id: organizationId },
      taskType: 'gia_chat',
      capability: 'text_generation',
      requirements: { structuredOutput: true },
      outputSchema: giaOutputSchema(types),
      messages: giaMessages({
        locale,
        facts,
        missing,
        activity: today ?? [],
        departments: types,
        history,
        message,
      }),
      outputModality: 'text',
      maxOutputTokens: GIA_LIMITS.outputTokens,
      // The business's own knowledge and the person's words: confidential.
      sensitivity: 'confidential',
      metadata: { locale },
    });
    const latencyMs = Math.round(performance.now() - started);

    if (response.status === 'denied') {
      await record('denied', { reason: response.code });
      log.info('gia.message_denied', { code: response.code, latencyMs });
      throw new GiaError(DENIALS[response.code] ?? 'ai_not_available');
    }
    if (response.status === 'failed') {
      const model =
        response.provider === null || response.model === null
          ? undefined
          : { provider: response.provider, id: response.model };
      await record('failure', { reason: response.code, ...(model === undefined ? {} : { model }) });
      log.warn('gia.message_failed', { code: response.code, latencyMs });
      throw new GiaError(FAILURES[response.code] ?? 'ai_unavailable');
    }
    const model = { provider: response.provider, id: response.model };
    const parsed = parseAnswer(response, types);
    if (parsed === undefined) {
      await record('failure', { reason: 'ai_invalid_output', model });
      log.warn('gia.message_invalid_output', { latencyMs });
      throw new GiaError('ai_invalid_output');
    }
    await record('success', { model });
    const proposedFacts = await propose(tenant, parsed.facts, log);
    log.info('gia.message_answered', {
      latencyMs,
      facts: facts.length,
      activity: today !== undefined,
      proposedFacts,
      credits: response.credits.consumed,
      routed: parsed.department !== null,
    });
    return Object.freeze({
      answer: parsed.answer,
      department: parsed.department,
      screen:
        parsed.screen === 'none' || (parsed.screen === 'department' && parsed.department === null)
          ? null
          : parsed.screen,
      proposedAction: parsed.action,
      proposedFacts,
      context: Object.freeze({
        facts: facts.length,
        activity: today !== undefined,
        missing: Object.freeze([...missing]),
      }),
      replayed: false,
    });
  }

  async function readFacts(
    tenant: TenantContext,
    message: string,
  ): Promise<readonly ContextFact[]> {
    if (brain === undefined || !can(tenant, 'knowledge.read')) return [];
    try {
      // Who the business is, always; then what matches the question. Two small reads, no model.
      const [core, matched] = await Promise.all([
        brain.context(tenant, { purpose: 'gia', domains: CORE_DOMAINS, limit: CORE_FACTS }),
        brain.context(tenant, {
          purpose: 'gia',
          query: message,
          limit: GIA_LIMITS.contextFacts - CORE_FACTS,
        }),
      ]);
      const seen = new Set<string>();
      return [...core.facts, ...matched.facts].filter((fact) => {
        if (seen.has(fact.id)) return false;
        seen.add(fact.id);
        return true;
      });
    } catch (error) {
      logger.warn('gia.context_unavailable', { error: codeOf(error) });
      return [];
    }
  }

  async function readGaps(tenant: TenantContext): Promise<KnowledgeGaps | undefined> {
    if (brain === undefined || !can(tenant, 'knowledge.read')) return undefined;
    try {
      return await brain.gaps(tenant);
    } catch (error) {
      logger.warn('gia.gaps_unavailable', { error: codeOf(error) });
      return undefined;
    }
  }

  async function readActivity(tenant: TenantContext): Promise<readonly ActivityItem[] | undefined> {
    if (activity === undefined || !can(tenant, 'activity.read')) return undefined;
    try {
      return (await activity.today(tenant)).slice(0, GIA_LIMITS.activityItems);
    } catch (error) {
      logger.warn('gia.activity_unavailable', { error: codeOf(error) });
      return undefined;
    }
  }

  async function activeTypes(organizationId: OrganizationId): Promise<readonly string[]> {
    const all = await departments.list(organizationId);
    const types = all
      .filter((d) => d.organizationId === organizationId && d.status === 'active')
      .flatMap((d) => (d.origin.kind === 'catalog' ? [d.origin.typeId as string] : []));
    return [...new Set(types)].sort().slice(0, MAX_DEPARTMENTS);
  }

  /** What the person told her about the business: proposals, confirmed only by a person. */
  async function propose(
    tenant: TenantContext,
    raw: readonly unknown[],
    log: Logger,
  ): Promise<number> {
    if (brain === undefined || raw.length === 0 || !can(tenant, 'knowledge.propose')) return 0;
    const candidates = raw
      .map(candidateOf)
      .filter((c): c is Record<string, unknown> => c !== undefined);
    if (candidates.length === 0) return 0;
    try {
      const { outcomes } = await brain.ingest(
        tenant,
        { type: 'gia', id: 'chat' },
        candidates,
        GIA_LIMITS.factConfidence,
      );
      return outcomes.filter((o) => o.outcome !== 'unchanged').length;
    } catch (error) {
      // The answer stands; a proposal that could not be kept is only logged.
      log.warn('gia.proposal_failed', { error: codeOf(error) });
      return 0;
    }
  }
}

const codeOf = (error: unknown) =>
  isRecord(error) && typeof error.code === 'string' ? error.code : 'error';

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};
