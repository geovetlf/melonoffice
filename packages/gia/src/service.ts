import type { ActivityItem } from '@melonoffice/activity';
import {
  promptLabel,
  creditReferenceOf,
  type AIGateway,
  type AIResponse,
} from '@melonoffice/ai-gateway';
import { actorOf, type AuditModel, type AuditService } from '@melonoffice/audit';
import {
  candidateOf,
  type CompanyBrainService,
  type ContextFact,
  type KnowledgeGaps,
} from '@melonoffice/brain';
import {
  daysBetween,
  FOLLOW_UP_LIMITS,
  FOLLOW_UP_TYPES,
  isLocalDate,
  relativeDate,
  relativeTime,
  type CommercialInsights,
  type CommercialInsightService,
} from '@melonoffice/conversations';
import {
  commercialPrioritiesDecider,
  createDecisionEngine,
  type DecisionEngine,
  type DecisionResult,
} from '@melonoffice/decisions';
import type { DepartmentRepository } from '@melonoffice/departments';
import type {
  ContactId,
  FollowUpType,
  OpportunityId,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
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
import { commercialLinks, type GiaLink } from './commercial.js';
import { GiaError } from './errors.js';
import { workflowIntentOf } from './intent.js';
import {
  forecastSummaryOf,
  readForecast,
  type GiaForecastContext,
  type GiaForecastPort,
  type GiaForecastSummary,
} from './forecast.js';
import {
  agentRefOf,
  agentTaskProposalOf,
  teamDepartmentsOf,
  teamTaskProposalOf,
  type GiaTeamTaskProposal,
  GIA_AGENT_LIMITS,
  type GiaAgent,
  type GiaAgentsPort,
  type GiaAgentTaskProposal,
} from './agents.js';
import {
  GIA_PRIORITY_LIMIT,
  prioritiesBlock,
  prioritiesOf,
  type GiaPriorities,
} from './priorities.js';
import {
  GIA_PROMPT,
  giaMessages,
  giaOutputSchema,
  type GiaPresentation,
  type GiaTurn,
} from './prompt.js';

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
  /** Records and screens of Comercial the answer names (C4): only ones she was given. */
  readonly links: readonly GiaLink[];
  /**
   * A follow-up she prepared (C5), for the person to confirm in the app: nothing is scheduled
   * until they do. The date and time come from what the person wrote; `time` is null when they
   * wrote none, and the app asks for it.
   */
  readonly proposedFollowUp: GiaFollowUpProposal | null;
  /**
   * A task she prepared for one of the organization's active agents (AE-3), for the person to
   * confirm in the app: nothing is assigned until they do.
   */
  readonly proposedAgentTask: GiaAgentTaskProposal | null;
  /**
   * Work she prepared for agents of several departments (ADR-0117), for the person to confirm:
   * the Melon Agent Harness then plans it, and the plan waits for their approval.
   */
  readonly proposedTeamTask: GiaTeamTaskProposal | null;
  /**
   * Whether the person's words ask for work that could be an automation (ADR-0177), read
   * deterministically from them, and they may draft one: the app then offers to prepare a
   * workflow draft. Nothing is drafted, saved or activated until they ask.
   */
  readonly workflowIntent: boolean;
  /**
   * What needs attention first, as the Decision Engine ranked it (ADR-0065), when the answer is
   * about it: each item with its reason, its link and its next step. Nothing in it is run.
   */
  readonly priorities: GiaPriorities | null;
  /**
   * The projection the person asked for (ADR-0059), made by the Forecasting Engine, never by
   * GIA: what it is and how it ended. The app reads the figures from the forecast by its id.
   */
  readonly forecast: GiaForecastSummary | null;
  /**
   * What she read: how many facts, whether today's activity and the commercial records, and
   * what is still unknown.
   */
  readonly context: {
    readonly facts: number;
    readonly activity: boolean;
    readonly commercial: boolean;
    readonly forecast: boolean;
    /** Whether she was shown the organization's agents (only to someone who may give tasks). */
    readonly agents: boolean;
    readonly missing: readonly string[];
  };
  readonly replayed: boolean;
}

export interface GiaFollowUpProposal {
  readonly contactId: ContactId;
  readonly contactLabel: string | null;
  readonly opportunityId: OpportunityId | null;
  readonly opportunityLabel: string | null;
  readonly type: FollowUpType;
  readonly title: string;
  readonly date: string | null;
  readonly time: string | null;
  readonly timeZone: string;
}

/** Today's activity as the person may read it (ADR-0049), in the business's time zone. */
export interface GiaActivityPort {
  today(tenant: TenantContext): Promise<readonly ActivityItem[]>;
}

export interface GiaOptions {
  readonly gateway: Pick<AIGateway, 'assist'>;
  readonly brain?: Pick<CompanyBrainService, 'context' | 'gaps' | 'ingest'>;
  readonly activity?: GiaActivityPort;
  /**
   * The commercial insights (C4), read as the person through the C1/C2 services, with the
   * follow-ups (C5) and the contacts the message names.
   */
  readonly commercial?: Pick<CommercialInsightService, 'read'>;
  /**
   * The Forecasting Engine (ADR-0059), asked as the person when their message asks for a
   * projection. GIA never calls a model herself.
   */
  readonly forecasting?: GiaForecastPort;
  /**
   * The organization's active agents (AE-3), read only for a person who may give them tasks
   * (`specialist.task`). GIA prepares a task; the person assigns it.
   */
  readonly agents?: GiaAgentsPort;
  /**
   * The Decision Engine (DE-1, ADR-0065): which actions she may prepare for this person, and
   * what needs attention first (`commercial.priorities`, over the insights she read). Absent,
   * one over the same authorization and audit, with each action set up when its port is.
   */
  readonly decisions?: Pick<DecisionEngine, 'offers' | 'evaluateDecision'>;
  readonly departments: Pick<DepartmentRepository, 'list'>;
  /**
   * The names the organization shows (its resolved brand, ADR-0095). Absent or unchanged from
   * MelonOffice's own, she presents herself as GIA, of MelonOffice.
   */
  readonly presentation?: (organizationId: OrganizationId) => Promise<GiaPresentation>;
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
  data_policy_not_allowed: 'ai_policy_denied',
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
      links: unknown[];
      followUp: unknown;
      agentTask: unknown;
      teamTask: unknown;
      priorities: boolean;
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
  const {
    answer,
    department,
    screen,
    proposedAction,
    facts,
    links,
    followUp,
    agentTask,
    teamTask,
    priorities,
  } = output;
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
    links: Array.isArray(links) ? links : [],
    followUp,
    agentTask,
    teamTask,
    priorities: priorities === true,
  };
}

/**
 * The follow-up she proposed, checked against what she was given (C5): its record must be one
 * of the references, its type one of the catalogue's. The date is the one the person's own words
 * name, by fixed rules; failing that, the model's pick if it is a real date from today on. The
 * time is only ever read from the person's words. Anything else is no proposal.
 */
export function followUpProposalOf(
  raw: unknown,
  insights: CommercialInsights,
  said: { readonly message: string; readonly earlier: readonly string[] },
): GiaFollowUpProposal | null {
  if (!isRecord(raw)) return null;
  const { record, type, title, date } = raw;
  if (typeof record !== 'string' || typeof title !== 'string') return null;
  const name = title.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name === '' || [...name].length > FOLLOW_UP_LIMITS.titleLength) return null;
  const opportunity = insights.records.opportunities.find((o) => o.ref === record);
  const contact = insights.records.contacts.find((c) => c.ref === record);
  if (opportunity === undefined && contact === undefined) return null;
  if (opportunity !== undefined && opportunity.status !== 'open') return null;
  const contactId = opportunity?.contactId ?? (contact as NonNullable<typeof contact>).id;
  const contactLabel = insights.records.contacts.find((c) => c.id === contactId)?.name ?? null;
  const today = insights.today;
  // The person's words first, the newest first; then the model's pick, only if it is a date.
  const texts = [said.message, ...said.earlier.toReversed()];
  const saidDate = texts.map((t) => relativeDate(t, today)).find((d) => d !== undefined);
  const modelDate =
    isLocalDate(date) &&
    daysBetween(today, date) >= 0 &&
    daysBetween(today, date) <= FOLLOW_UP_LIMITS.horizonDays
      ? date
      : undefined;
  const saidTime = texts.map((t) => relativeTime(t)).find((t) => t !== undefined);
  return Object.freeze({
    contactId,
    contactLabel,
    opportunityId: opportunity?.id ?? null,
    opportunityLabel: opportunity?.title ?? null,
    type: (FOLLOW_UP_TYPES as readonly unknown[]).includes(type)
      ? (type as FollowUpType)
      : 'follow_up',
    title: name,
    date: saidDate ?? modelDate ?? null,
    time: saidTime ?? null,
    timeZone: insights.timeZone,
  });
}

export function createGia(options: GiaOptions): GiaService {
  const {
    gateway,
    brain,
    activity,
    commercial,
    forecasting,
    agents,
    departments,
    authorization,
    audit,
    rateLimits = GIA_RATE_LIMITS,
    replayMs = 15 * 60_000,
    now = () => new Date(),
  } = options;
  const logger = options.logger ?? silent;

  /** Her names for this organization, or none when they are MelonOffice's own or unreadable. */
  async function presentationOf(
    organizationId: OrganizationId,
    log: Logger,
  ): Promise<GiaPresentation | undefined> {
    if (options.presentation === undefined) return undefined;
    try {
      const shown = await options.presentation(organizationId);
      return shown.assistantName === 'GIA' && shown.productName === 'MelonOffice'
        ? undefined
        : shown;
    } catch {
      log.warn('gia.presentation_unavailable', {});
      return undefined;
    }
  }
  const can = (tenant: TenantContext, permission: string) =>
    authorization.authorize(tenant, permission).allowed;
  // What she may prepare for the person: one answer for every proposal (ADR-0065).
  const decisions =
    options.decisions ??
    createDecisionEngine({
      authorization,
      deciders: [commercialPrioritiesDecider],
      audit,
      configured: (action) =>
        action === 'knowledge.propose_fact'
          ? brain !== undefined
          : action === 'follow_up.schedule'
            ? commercial !== undefined
            : action === 'agent_task.assign'
              ? agents !== undefined
              : false,
    });

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
    const [facts, gaps, today, types, insights, projection, team] = await Promise.all([
      readFacts(tenant, message),
      readGaps(tenant),
      readActivity(tenant),
      activeTypes(organizationId),
      // The names the person wrote, now and in earlier turns, bring those contacts in (C5).
      readCommercial(
        tenant,
        [...history.filter((t) => t.role === 'person').map((t) => t.text), message].join('\n'),
      ),
      // Only when the person's own words ask for a projection now (ADR-0059).
      readProjection(tenant, message),
      // The agents a task may be prepared for (AE-3): only for someone who may give them tasks.
      readAgents(tenant),
    ]);
    const missing = gaps?.questions.map((q) => q.id) ?? [];
    // What an answer may link to: only the references she was given, never an id she wrote.
    const linkable =
      insights === undefined ? new Map<string, GiaLink>() : commercialLinks(insights);
    // What a follow-up may be proposed for (C5): the contacts and open opportunities she was
    // given, only to someone who may schedule follow-ups.
    const canSchedule = decisions.offers(tenant, 'follow_up.schedule');
    // What needs attention first: ranked by the Decision Engine's rules, never by the model.
    const ranking = await rankPriorities(tenant, insights, requestId);
    const followUpRecords =
      insights === undefined || !canSchedule
        ? []
        : [
            ...insights.records.contacts.map((c) => c.ref),
            ...insights.records.opportunities.filter((o) => o.status === 'open').map((o) => o.ref),
          ].slice(0, 50);

    const shown = await presentationOf(organizationId, log);

    const started = performance.now();
    const response = await gateway.assist(tenant, {
      requestId,
      subject: { type: 'gia', id: organizationId },
      taskType: 'gia_chat',
      capability: 'text_generation',
      requirements: { structuredOutput: true },
      // The gateway takes at most 50 codes in a list: the general screens and the first records.
      outputSchema: giaOutputSchema(
        types,
        [...linkable.keys()].slice(0, 50),
        followUpRecords,
        (team ?? []).map((_, index) => agentRefOf(index)),
        ranking !== undefined,
        teamDepartmentsOf(team ?? []),
      ),
      messages: giaMessages({
        locale,
        facts,
        missing,
        activity: today ?? [],
        departments: types,
        history,
        message,
        ...(commercial === undefined
          ? {}
          : { commercial: { insights, canScheduleFollowUps: followUpRecords.length > 0 } }),
        ...(projection === undefined ? {} : { forecast: projection }),
        ...(team === undefined ? {} : { agents: team }),
        ...(ranking === undefined || insights === undefined
          ? {}
          : { priorities: prioritiesBlock(ranking, insights, locale) }),
        ...(shown === undefined ? {} : { presentation: shown }),
      }),
      outputModality: 'text',
      maxOutputTokens: GIA_LIMITS.outputTokens,
      // The business's own knowledge and the person's words: confidential.
      sensitivity: 'confidential',
      metadata: { locale, prompt: promptLabel(GIA_PROMPT) },
    });
    const latencyMs = Math.round(performance.now() - started);

    if (response.status === 'denied') {
      await record('denied', { reason: response.code });
      log.info('gia.message_denied', { code: response.code, latencyMs });
      throw new GiaError(
        DENIALS[response.code] ?? 'ai_not_available',
        undefined,
        response.estimatedCredits,
      );
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
    // Which sources the answer drew on, as a code; never the question, the answer or a figure.
    const sources = [
      ...(insights === undefined ? [] : ['commercial']),
      ...(projection === undefined ? [] : ['forecast']),
    ];
    await record('success', {
      model,
      ...(sources.length === 0 ? {} : { reason: `${sources.join('_')}_context` }),
    });
    const proposedFacts = await propose(tenant, parsed.facts, log);
    const proposedFollowUp =
      insights === undefined || followUpRecords.length === 0
        ? null
        : followUpProposalOf(parsed.followUp, insights, {
            message,
            earlier: history.filter((t) => t.role === 'person').map((t) => t.text),
          });
    const proposedTeamTask =
      team === undefined || team.length === 0 ? null : teamTaskProposalOf(parsed.teamTask, team);
    // One proposal at most: work for a team takes the place of a single agent's.
    const proposedAgentTask =
      team === undefined || team.length === 0 || proposedTeamTask !== null
        ? null
        : agentTaskProposalOf(parsed.agentTask, team);
    log.info('gia.message_answered', {
      latencyMs,
      facts: facts.length,
      activity: today !== undefined,
      proposedFacts,
      credits: response.credits.consumed,
      routed: parsed.department !== null,
      commercial: insights !== undefined,
      followUpProposed: proposedFollowUp !== null,
      agentTaskProposed: proposedAgentTask !== null,
      teamTaskProposed: proposedTeamTask !== null,
      priorities: ranking === undefined ? null : parsed.priorities,
      forecast: projection?.kind ?? null,
    });
    const links = [...new Set(parsed.links.filter((ref): ref is string => typeof ref === 'string'))]
      .flatMap((ref) => {
        const link = linkable.get(ref);
        return link === undefined ? [] : [link];
      })
      .slice(0, GIA_LIMITS.links);
    return Object.freeze({
      answer: parsed.answer,
      department: parsed.department,
      screen:
        parsed.screen === 'none' || (parsed.screen === 'department' && parsed.department === null)
          ? null
          : parsed.screen,
      proposedAction: parsed.action,
      proposedFacts,
      links: Object.freeze(links),
      proposedFollowUp,
      proposedAgentTask,
      proposedTeamTask,
      // Offered only to someone who may draft a workflow: the same permissions the draft asks.
      workflowIntent:
        can(tenant, 'workflow.manage') && can(tenant, 'plan.create') && workflowIntentOf(message),
      priorities: ranking !== undefined && parsed.priorities ? prioritiesOf(ranking) : null,
      forecast: projection === undefined ? null : forecastSummaryOf(projection),
      context: Object.freeze({
        facts: facts.length,
        activity: today !== undefined,
        commercial: insights !== undefined,
        forecast: projection !== undefined,
        agents: team !== undefined,
        missing: Object.freeze([...missing]),
      }),
      replayed: false,
    });
  }

  /**
   * The Decision Engine's ranking over the insights she read (ADR-0065), as this person; audited
   * there. A person who may not ask for decisions, or a failure, only leaves it out.
   */
  async function rankPriorities(
    tenant: TenantContext,
    insights: CommercialInsights | undefined,
    requestId: string,
  ): Promise<DecisionResult | undefined> {
    if (insights === undefined || !can(tenant, 'decision.evaluate')) return undefined;
    try {
      return await decisions.evaluateDecision(tenant, {
        type: 'commercial.priorities',
        input: { limit: GIA_PRIORITY_LIMIT },
        preload: { commercial: insights },
        requestId,
      });
    } catch (error) {
      logger.warn('gia.priorities_unavailable', { error: codeOf(error) });
      return undefined;
    }
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

  /** The commercial insights, as this person may read them; a failure is only logged. */
  async function readCommercial(
    tenant: TenantContext,
    mentions: string,
  ): Promise<CommercialInsights | undefined> {
    if (commercial === undefined) return undefined;
    try {
      return await commercial.read(tenant, { mentions });
    } catch (error) {
      logger.warn('gia.commercial_unavailable', { error: codeOf(error) });
      return undefined;
    }
  }

  /** The projection the message asks for, if any; the engine failing is only logged. */
  async function readProjection(
    tenant: TenantContext,
    message: string,
  ): Promise<GiaForecastContext | undefined> {
    if (forecasting === undefined) return undefined;
    try {
      return (await readForecast(forecasting, tenant, message, authorization))?.context;
    } catch (error) {
      logger.warn('gia.forecast_unavailable', { error: codeOf(error) });
      return { kind: 'unavailable', reason: 'not_available' };
    }
  }

  /** The active agents, as this person may task them; a failure is only logged. */
  async function readAgents(tenant: TenantContext): Promise<readonly GiaAgent[] | undefined> {
    if (agents === undefined || !decisions.offers(tenant, 'agent_task.assign')) return undefined;
    try {
      return (await agents.active(tenant)).slice(0, GIA_AGENT_LIMITS.agents);
    } catch (error) {
      logger.warn('gia.agents_unavailable', { error: codeOf(error) });
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
    if (brain === undefined || raw.length === 0) return 0;
    if (!decisions.offers(tenant, 'knowledge.propose_fact')) return 0;
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
