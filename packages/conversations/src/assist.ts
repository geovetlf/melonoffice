import {
  promptLabel,
  creditReferenceOf,
  type AIGateway,
  type AIResponse,
} from '@melonoffice/ai-gateway';
import { actorOf, type AuditAction, type AuditModel, type AuditService } from '@melonoffice/audit';
import type { DepartmentRepository } from '@melonoffice/departments';
import type { ConversationId, OrganizationId, UserId } from '@melonoffice/domain';
import { withCorrelation, type Logger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { createHash } from 'node:crypto';
import {
  ASSIST_CONTEXT_LIMITS,
  ASSIST_LOCALES,
  assistMessages,
  buildAssistContext,
  isAssistOperation,
  type AssistContextLimits,
  type AssistLocale,
  type AssistOperation,
  ASSIST_PROMPT,
} from './assist-context.js';
import { ASSIST_OUTPUT_SCHEMAS, parseAssistOutput, type AssistResult } from './assist-output.js';
import { ConversationError } from './errors.js';
import type { ConversationService } from './service.js';

/**
 * Assisted intelligence on a conversation (CV-4, ADR-0037). A person asks; this reads the
 * conversation as that person, builds a limited context, asks the AI Gateway in its assisted
 * mode, checks the answer and gives it back to review. It is not an AI of its own: the gateway
 * decides the model, the policy, the credits and the provider call. Nothing here sends a
 * message, changes the conversation, calls a tool or stores the answer as a message.
 *
 * The same service is what GIA or a future specialist would use, each under its own
 * authorization; today only a person acting directly is accepted.
 */
export interface ConversationAssistant {
  assist(
    tenant: TenantContext,
    conversationId: string,
    input: {
      readonly operation: unknown;
      /** The caller's key: the same key is the same request, answered once. */
      readonly requestKey: unknown;
      readonly locale?: unknown;
    },
  ): Promise<AssistOutcome>;
}

export interface AssistOutcome {
  readonly operation: AssistOperation;
  readonly conversationId: ConversationId;
  readonly result: AssistResult;
  /** True when this answers a request already answered with the same key: nothing was called. */
  readonly replayed: boolean;
}

/**
 * Fixed-window request limits, per user, per user and operation, and per organization. Held in
 * this server's memory: a guard against repeated clicks and runaway clients, not a quota. Credits
 * remain the real limit on use. No shared limiter exists yet; this is the one CV-4 needs.
 */
export interface AssistRateLimits {
  readonly windowMs: number;
  readonly perUser: number;
  readonly perUserOperation: number;
  readonly perOrganization: number;
}

export const ASSIST_RATE_LIMITS: AssistRateLimits = Object.freeze({
  windowMs: 60_000,
  perUser: 20,
  perUserOperation: 10,
  perOrganization: 60,
});

export interface ConversationAssistantOptions {
  readonly conversations: Pick<ConversationService, 'detail'>;
  readonly departments: Pick<DepartmentRepository, 'list'>;
  readonly gateway: Pick<AIGateway, 'assist'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly audit: AuditService;
  readonly logger?: Logger;
  readonly limits?: AssistContextLimits;
  readonly rateLimits?: AssistRateLimits;
  /** How long an answered request is kept to answer its repeats. */
  readonly replayMs?: number;
  readonly now?: () => Date;
}

const REQUEST_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_REPLAYS = 500;

const ACTIONS: Readonly<
  Record<AssistOperation, Extract<AuditAction, `conversation.ai_${string}`>>
> = {
  summary: 'conversation.ai_summary_requested',
  intent: 'conversation.ai_intent_analyzed',
  reply: 'conversation.ai_reply_suggested',
  next_steps: 'conversation.ai_next_steps_suggested',
};

/** How long each answer may be. */
const OUTPUT_TOKENS: Readonly<Record<AssistOperation, number>> = {
  summary: 1_200,
  intent: 500,
  reply: 1_200,
  next_steps: 800,
};

/**
 * Gateway refusals that are the person's to see as such. Every other one (no environment, no
 * policy, no provider or model, no credit rate or price) is "not available": not configured here.
 */
const DENIALS: Readonly<Record<string, ConversationError['code']>> = {
  permission_denied: 'permission_denied',
  assist_requires_user: 'requires_user',
  unresolved_tenant: 'permission_denied',
  organization_inactive: 'organization_inactive',
  credits_insufficient: 'ai_credits_insufficient',
  credit_limit_exceeded: 'ai_credits_insufficient',
  // The policy found models but allows none of them for this call (ADR-0038).
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

/** How a failed provider call reads to the person; anything else is "unavailable". */
const FAILURES: Readonly<Record<string, ConversationError['code']>> = {
  timeout: 'ai_timeout',
  rate_limited: 'rate_limited',
};

/**
 * The gateway request id of one assisted request: organization, user, conversation, operation
 * and the caller's key. The same click is the same id, so the credits ledger charges it once
 * (`creditReferenceOf`), and another user's or conversation's never collides with it.
 */
export function assistRequestIdOf(
  organizationId: OrganizationId,
  userId: UserId,
  conversationId: ConversationId,
  operation: AssistOperation,
  requestKey: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([organizationId, userId, conversationId, operation, requestKey]))
    .digest('hex');
  return `assist_${digest.slice(0, 48)}`;
}

export function createConversationAssistant(
  options: ConversationAssistantOptions,
): ConversationAssistant {
  const {
    conversations,
    departments,
    gateway,
    authorization,
    audit,
    limits = ASSIST_CONTEXT_LIMITS,
    rateLimits = ASSIST_RATE_LIMITS,
    replayMs = 15 * 60_000,
    now = () => new Date(),
  } = options;
  const logger = options.logger ?? silent;

  // Answered requests by gateway request id, and requests still running, so a double click
  // neither calls the model twice nor waits for a second answer.
  const answered = new Map<string, { readonly at: number; readonly outcome: AssistOutcome }>();
  const running = new Map<string, Promise<AssistOutcome>>();
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
    // Old windows are dropped so the map does not grow without bound.
    if (windows.size > 10_000) {
      for (const [key, window] of windows) {
        if (at - window.start >= rateLimits.windowMs) windows.delete(key);
      }
    }
    return true;
  }

  function remember(requestId: string, outcome: AssistOutcome): void {
    const at = now().getTime();
    answered.set(requestId, { at, outcome });
    for (const [key, entry] of answered) {
      if (answered.size <= MAX_REPLAYS && at - entry.at < replayMs) break;
      answered.delete(key);
    }
  }

  return {
    async assist(tenant, conversationId, input) {
      const { operation, requestKey } = input;
      if (!isAssistOperation(operation))
        throw new ConversationError('invalid_request', 'operation');
      if (typeof requestKey !== 'string' || !REQUEST_KEY.test(requestKey)) {
        throw new ConversationError('invalid_request', 'requestKey');
      }
      const locale = input.locale ?? 'en';
      if (typeof locale !== 'string' || !(ASSIST_LOCALES as readonly string[]).includes(locale)) {
        throw new ConversationError('invalid_request', 'locale');
      }
      if (!isResolvedTenant(tenant)) throw new ConversationError('unresolved_tenant');
      // Only a person asking for themselves: GIA and the runtime do not get this path by default.
      if (tenant.actor !== 'user') throw new ConversationError('requires_user');
      if (!authorization.authorize(tenant, 'conversation.assist').allowed) {
        throw new ConversationError('permission_denied');
      }
      // Read as this person: conversation.read and contact.read, in their organization only.
      // Another organization's conversation is `conversation_not_found`, like a missing one.
      const detail = await conversations.detail(tenant, conversationId, {
        limit: limits.messages,
      });
      const { conversation } = detail;
      const requestId = assistRequestIdOf(
        conversation.organizationId,
        tenant.userId,
        conversation.id,
        operation,
        requestKey,
      );
      const previous = answered.get(requestId);
      if (previous !== undefined && now().getTime() - previous.at < replayMs) {
        return { ...previous.outcome, replayed: true };
      }
      const pending = running.get(requestId);
      if (pending !== undefined) return { ...(await pending), replayed: true };

      const work = run(tenant, detail, operation, locale as AssistLocale, requestId);
      running.set(requestId, work);
      try {
        const outcome = await work;
        remember(requestId, outcome);
        return outcome;
      } finally {
        running.delete(requestId);
      }
    },
  };

  async function run(
    tenant: TenantContext,
    detail: Awaited<ReturnType<ConversationService['detail']>>,
    operation: AssistOperation,
    locale: AssistLocale,
    requestId: string,
  ): Promise<AssistOutcome> {
    const { conversation } = detail;
    const log = withCorrelation(logger, {
      requestId,
      organizationId: conversation.organizationId,
      conversationId: conversation.id,
    });
    const record = async (
      result: 'success' | 'denied' | 'failure',
      fields: { readonly reason?: string; readonly model?: AuditModel } = {},
    ) =>
      audit.record({
        action: ACTIONS[operation],
        result,
        actor: actorOf(tenant),
        organizationId: conversation.organizationId,
        target: { type: 'conversation', id: conversation.id },
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        ...(fields.model === undefined ? {} : { model: fields.model }),
        reference: creditReferenceOf(requestId),
        requestId,
        source: 'api',
      });

    if (
      !allow([
        [`u:${tenant.organizationId}:${tenant.userId}`, rateLimits.perUser],
        [`uo:${tenant.organizationId}:${tenant.userId}:${operation}`, rateLimits.perUserOperation],
        [`o:${tenant.organizationId}`, rateLimits.perOrganization],
      ])
    ) {
      await record('denied', { reason: 'rate_limited' });
      log.info('conversation assist rate limited', { operation });
      throw new ConversationError('rate_limited');
    }

    const all = await departments.list(conversation.organizationId);
    const { context, departmentOfAlias } = buildAssistContext(detail, all, limits);
    const started = performance.now();
    const response: AIResponse = await gateway.assist(tenant, {
      requestId,
      subject: { type: 'conversation', id: conversation.id },
      taskType: `conversation_${operation}`,
      capability: 'text_generation',
      requirements: { structuredOutput: true },
      outputSchema: ASSIST_OUTPUT_SCHEMAS[operation],
      messages: assistMessages(operation, context, locale),
      outputModality: 'text',
      maxOutputTokens: OUTPUT_TOKENS[operation],
      // A customer's words and details: never below confidential, whatever the policy allows.
      sensitivity: 'confidential',
      metadata: { operation, prompt: promptLabel(ASSIST_PROMPT) },
    });
    const latencyMs = Math.round(performance.now() - started);

    if (response.status === 'denied') {
      const code = DENIALS[response.code] ?? 'ai_not_available';
      await record('denied', { reason: response.code });
      log.info('conversation assist denied', { operation, code: response.code, latencyMs });
      throw new ConversationError(code, undefined, response.estimatedCredits);
    }
    if (response.status === 'failed') {
      const model =
        response.provider === null || response.model === null
          ? undefined
          : { provider: response.provider, id: response.model };
      await record('failure', { reason: response.code, ...(model === undefined ? {} : { model }) });
      log.warn('conversation assist failed', {
        operation,
        code: response.code,
        attempts: response.attempts,
        latencyMs,
      });
      throw new ConversationError(FAILURES[response.code] ?? 'ai_unavailable');
    }
    const model = { provider: response.provider, id: response.model };
    const result = parseAssistOutput(operation, response.output, departmentOfAlias);
    if (result === undefined) {
      // The call happened and was accounted for; its answer is not shown.
      await record('failure', { reason: 'ai_invalid_output', model });
      log.warn('conversation assist output invalid', { operation, latencyMs });
      throw new ConversationError('ai_invalid_output');
    }
    await record('success', { model });
    log.info('conversation assist completed', {
      operation,
      latencyMs,
      attempts: response.attempts,
      costMicroUsd: response.cost.actualMicroUsd ?? 0,
      credits: response.credits.consumed,
      fallback: response.fallbackFrom !== null,
    });
    return { operation, conversationId: conversation.id, result, replayed: false };
  }
}

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};
