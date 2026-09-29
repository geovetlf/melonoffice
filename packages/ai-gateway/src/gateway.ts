import {
  actorOf,
  type AuditAction,
  type AuditModel,
  type AuditService,
  type AuditTarget,
} from '@melonoffice/audit';
import {
  createAICostEngine,
  LLM_CAPABILITY,
  llmPricing,
  llmUsage,
  type AIUsageSink,
} from '@melonoffice/ai-usage';
import type {
  AIRoutingStrategy,
  AIUsageAttribution,
  AIUsageEvent,
  DeploymentEnvironment,
  ExecutionStatus,
  ModelPolicy,
  OrganizationId,
} from '@melonoffice/domain';
import { isExecutionId, type ExecutionRepository } from '@melonoffice/execution';
import { withCorrelation, type Logger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { SpecialistService } from '@melonoffice/specialists';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { digestOf } from '@melonoffice/tools';
import {
  allowsFallback,
  isTransient,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderErrorKind,
  type ProviderOutcome,
  type ProviderStreamEvent,
} from './adapter.js';
import { costMicroUsd, creditsFor, type CreditRate } from './cost.js';
import { creditReferenceOf, type AICreditsPort } from './credits.js';
import { createProviderHealthTracker, type ProviderHealthTracker } from './health.js';
import type { ModelPolicyCatalogue } from './policy.js';
import { modelKey, type ProviderRegistry } from './registry.js';
import {
  checkAIRequest,
  checkAssistedAIRequest,
  documentRefsOf,
  estimateInputTokens,
  inputModalitiesOf,
  STORED_DOCUMENT_KEY,
  type AIModelRequest,
  type AIRequest,
  type AssistedAIRequest,
  type AssistSubjectType,
  MAX_TEXT_LENGTH,
} from './request.js';
import { checkProviderSuccess, type AIResponse } from './response.js';
import { routeModel, type RouteCandidate } from './router.js';
import {
  createTextChannel,
  SafeTextRelease,
  streamRequestProblem,
  type AIStreamEvent,
} from './stream.js';

/**
 * The only way MelonOffice calls an AI model (ADR-0027):
 *
 *   AIRequest → validate → authorization → policy → route → credentials → adapter → response
 *   → usage → cost → credits → observability → audit.
 *
 * A specialist (and, later, GIA) never calls a provider directly. There is no client route to
 * the gateway: agents call it on the server, with the tenant of the user the work is for.
 */
export interface AIGateway {
  generate(tenant: TenantContext, request: AIRequest): Promise<AIResponse>;
  /**
   * An assisted call (ADR-0037): a person, acting directly, asks about one record they can read.
   * No execution or specialist is involved, so none is required; everything from the policy on
   * (credits, routing, the provider call, cost and audit) is the same code as `generate`. The
   * caller must already have read the subject for this tenant: the gateway checks who asks and
   * the subject's permission, and never reads the subject itself.
   */
  assist(tenant: TenantContext, request: AssistedAIRequest): Promise<AIResponse>;
  /**
   * `generate`, with the answer's text read as it comes (R4, ADR-0077): text only, never tools or
   * a structured answer, and only on models and adapters that stream. Ends with exactly one
   * `done` carrying the response `generate` would have given; read it with `for await`.
   */
  stream(tenant: TenantContext, request: AIRequest): AsyncIterable<AIStreamEvent>;
  /** `assist`, streamed the same way. */
  assistStream(tenant: TenantContext, request: AssistedAIRequest): AsyncIterable<AIStreamEvent>;
}

/**
 * The permission an assisted call about each kind of subject needs (ADR-0037). Fixed here, so a
 * caller cannot pick a weaker one. Reading the subject is checked by the caller as well.
 */
export const ASSIST_PERMISSIONS: Readonly<Record<AssistSubjectType, string>> = Object.freeze({
  conversation: 'conversation.assist',
  // Extracting Company Brain facts from what a person gives (ADR-0051).
  company_knowledge: 'knowledge.capture',
  // A person asking GIA, about their own organization (ADR-0052).
  gia: 'gia.ask',
  // The Decision Engine, when a rule cannot decide alone (ADR-0065).
  decision: 'decision.evaluate',
  // Reading a scanned document a person uploads (ADR-0079): only as part of that upload.
  document: 'document.upload',
});

/**
 * The model policy an assisted call about each kind of subject uses (ADR-0038). Fixed here, like
 * its permission: a person cannot pick another. Each is its own named policy, never the default,
 * so allowing a subject's data (a conversation is `confidential`) to reach a model is an explicit
 * decision about that subject and those models only. A missing policy denies the call.
 */
export const ASSIST_MODEL_POLICIES: Readonly<
  Record<AssistSubjectType, { readonly id: string; readonly version: number }>
> = Object.freeze({
  conversation: Object.freeze({ id: 'conversation_assist', version: 1 }),
  company_knowledge: Object.freeze({ id: 'company_knowledge_assist', version: 1 }),
  gia: Object.freeze({ id: 'gia_assist', version: 1 }),
  decision: Object.freeze({ id: 'decision_assist', version: 1 }),
  document: Object.freeze({ id: 'document_read', version: 1 }),
});

/**
 * Why a request's stored documents are refused, or nothing (ADR-0079). A document is data of one
 * organization: a key naming any other organization than the tenant's is authority the caller
 * does not have, refused as `authority_in_input` like any other smuggled authority, and audited.
 * Only an assisted call about that very document may name it (`subject: {type: 'document'}`);
 * a specialist's call reads no stored document yet.
 */
export function documentRefsProblem(
  request: Pick<AIRequest, 'messages'>,
  organizationId: string,
  subject: { readonly type: string; readonly id: string } | undefined,
): 'authority_in_input' | 'invalid_request' | undefined {
  for (const key of documentRefsOf(request)) {
    const match = STORED_DOCUMENT_KEY.exec(key);
    if (match === null) return 'invalid_request';
    if (match[1] !== organizationId) return 'authority_in_input';
    if (subject?.type !== 'document' || match[2] !== subject.id) return 'invalid_request';
  }
  return undefined;
}

export interface AIGatewayOptions {
  readonly executions: Pick<ExecutionRepository, 'find'>;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly specialists: Pick<SpecialistService, 'eligibility' | 'getVersion'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly registry: ProviderRegistry;
  readonly policies: ModelPolicyCatalogue;
  /** Where this server runs, set explicitly. Undefined: every call is denied (fail closed). */
  readonly environment: DeploymentEnvironment | undefined;
  /**
   * The Credits engine and the credit rate (D-12). Either missing: every call is denied, so no
   * real model is ever used without being accounted for.
   */
  readonly credits?: { readonly port: AICreditsPort; readonly rate: CreditRate | undefined };
  readonly audit: AuditService;
  readonly logger?: Logger;
  /**
   * What this server has seen of each provider lately (ADR-0072). Absent: a tracker of its own,
   * with the default thresholds.
   */
  readonly health?: ProviderHealthTracker;
  /**
   * Where each completed call's usage and cost go, in the AI Usage Layer's shape shared by every
   * AI capability (ADR-0073). Absent: none is emitted. A failed emit never fails the call.
   */
  readonly usage?: AIUsageSink;
  /** How long one attempt may take. */
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Execution statuses in which a specialist may call a model. */
const WORKING: readonly ExecutionStatus[] = ['planning', 'running', 'verifying'];

type Attempt = ProviderOutcome | { readonly status: 'error'; readonly kind: 'timeout' };

function withDeadline(work: Promise<ProviderOutcome>, ms: number): Promise<Attempt> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Attempt>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'error', kind: 'timeout' }), Math.max(0, ms));
  });
  // An adapter that throws broke its contract: treated as an invalid response, never passed on.
  const outcome = work.catch((): Attempt => ({ status: 'error', kind: 'invalid_response' }));
  return Promise.race([outcome, timeout]).finally(() => clearTimeout(timer));
}

/** The longest the gateway waits within a call before trying the same model again (ADR-0080). */
export const MAX_RETRY_WAIT_MS = 10_000;

/**
 * How long to wait before trying the same model again: the policy's backoff, or longer when the
 * provider asked (`Retry-After` on a 429). Undefined when it asked for more than a call may wait,
 * so the call goes to the next model instead of waiting.
 */
export function retryDelayMs(
  backoffMs: number,
  retryAfterMs: number | undefined,
): number | undefined {
  if (retryAfterMs === undefined) return backoffMs;
  if (retryAfterMs > MAX_RETRY_WAIT_MS) return undefined;
  return Math.max(backoffMs, retryAfterMs);
}

const retryAfterOf = (outcome: Attempt): number | undefined =>
  outcome.status === 'error' && outcome.kind === 'rate_limited' && 'retryAfterMs' in outcome
    ? outcome.retryAfterMs
    : undefined;

const failureOf = (
  outcome: Exclude<Attempt, { readonly status: 'success' }>,
): { readonly error: ProviderErrorKind; readonly retryAfterMs?: number } => {
  const retryAfterMs = retryAfterOf(outcome);
  return retryAfterMs === undefined
    ? { error: outcome.kind }
    : { error: outcome.kind, retryAfterMs };
};

const REQUEST_ID = /^[\w-]{1,100}$/;

export function createAIGateway(options: AIGatewayOptions): AIGateway {
  const {
    executions,
    organizations,
    specialists,
    authorization,
    registry,
    policies,
    environment,
    credits,
    audit,
    timeoutMs = 60_000,
    now = () => new Date(),
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;
  const logger = options.logger ?? silent;
  const health = options.health ?? createProviderHealthTracker();
  const usageSink = options.usage;
  const costEngine = createAICostEngine();

  /** What the provider's answer says of its health, with how long it asked to wait on a 429. */
  function recordHealth(providerId: string, outcome: Attempt): void {
    if (outcome.status === 'success') health.record(providerId, 'success');
    else health.record(providerId, outcome.kind, retryAfterOf(outcome));
  }

  async function organizationOf(tenant: TenantContext): Promise<OrganizationId | undefined> {
    if (!isResolvedTenant(tenant)) return undefined;
    const organization = await organizations.findOrganization(tenant.organizationId);
    return organization?.id === tenant.organizationId && organization.status === 'active'
      ? organization.id
      : undefined;
  }

  /** One call's audit and log context, filled in as the request is checked. */
  function callContext(tenant: TenantContext, organizationId: OrganizationId, requestId: string) {
    const known: {
      target?: AuditTarget;
      model?: AuditModel;
      /** Who and what the call's usage belongs to, as far as it is known (ADR-0073). */
      attribution: Omit<AIUsageAttribution, 'organizationId' | 'actor' | 'userId' | 'taskType'>;
    } = { attribution: {} };
    let log = withCorrelation(logger, { requestId, organizationId });
    const record = async (
      action: Extract<AuditAction, `ai.${string}`>,
      reason: string,
      extra: { previousModel?: AuditModel } = {},
    ): Promise<void> => {
      await audit.record({
        action,
        result:
          action === 'ai.request_denied'
            ? 'denied'
            : action === 'ai.request_failed'
              ? 'failure'
              : 'success',
        actor: actorOf(tenant),
        organizationId,
        ...(known.target === undefined ? {} : { target: known.target }),
        ...(known.model === undefined ? {} : { model: known.model }),
        ...(extra.previousModel === undefined ? {} : { previousModel: extra.previousModel }),
        reason,
        ...(requestId === 'invalid' ? {} : { requestId }),
        source: 'api',
      });
    };
    const deny = async (code: string): Promise<AIResponse> => {
      await record('ai.request_denied', code);
      log.info('ai request denied', { code });
      return deniedResponse(requestId, code);
    };
    return {
      tenant,
      requestId,
      known,
      record,
      deny,
      get log() {
        return log;
      },
      correlate(correlation: Parameters<typeof withCorrelation>[1]) {
        log = withCorrelation(log, correlation);
      },
    };
  }
  type CallContext = ReturnType<typeof callContext>;

  /** The id to answer with: the request's own when well-formed, `invalid` otherwise. */
  const requestIdOf = (request: unknown): string => {
    const raw = request as Record<string, unknown> | null;
    return typeof raw?.requestId === 'string' && REQUEST_ID.test(raw.requestId)
      ? raw.requestId
      : 'invalid';
  };

  /** A model the call may go to, with what credits it may cost. */
  interface Prepared {
    readonly candidates: readonly RouteCandidate[];
    readonly port: AICreditsPort;
    readonly rate: CreditRate;
    readonly strategy: AIRoutingStrategy;
    readonly idempotencyKey: string;
    readonly creditsOf: (candidate: RouteCandidate) => number | undefined;
  }

  /**
   * Everything after authorization and policy that comes before the provider, the same for every
   * caller: credits must be able to account for the call, then route, and keep only the models
   * whose cost the organization can cover. `streaming` routes only to models that stream.
   */
  async function prepare(
    ctx: CallContext,
    request: AIModelRequest,
    policy: ModelPolicy,
    streaming: boolean,
  ): Promise<Prepared | AIResponse> {
    const { tenant, deny } = ctx;
    // environment is checked by every caller before this point.
    const deployment = environment as DeploymentEnvironment;
    const organizationId = tenant.organizationId;

    // 4. Credits must be able to account for the call before anything is sent.
    if (credits === undefined || credits.rate === undefined) {
      return deny('credits_not_configured');
    }
    const { port, rate } = credits;
    // 5. Route.
    const estimatedInputTokens = estimateInputTokens(request);
    const streams = streaming || request.requirements?.streaming === true;
    const route = routeModel(
      registry,
      policy,
      deployment,
      {
        capability: request.capability,
        inputModalities: inputModalitiesOf(request),
        outputModality: request.outputModality,
        ...(request.quality === undefined ? {} : { quality: request.quality }),
        ...(request.latency === undefined ? {} : { latency: request.latency }),
        ...(request.maxCostMicroUsd === undefined
          ? {}
          : { maxCostMicroUsd: request.maxCostMicroUsd }),
        sensitivity: request.sensitivity,
        estimatedInputTokens,
        maxOutputTokens: request.maxOutputTokens,
        ...(request.requirements?.minContextTokens === undefined
          ? {}
          : { minContextTokens: request.requirements.minContextTokens }),
        ...(request.requirements?.structuredOutput === undefined
          ? {}
          : { structuredOutput: request.requirements.structuredOutput }),
        ...(request.requirements?.toolUse === undefined
          ? {}
          : { toolUse: request.requirements.toolUse }),
        ...(streams ? { streaming: true } : {}),
        ...(request.strategy === undefined ? {} : { strategy: request.strategy }),
      },
      health.unavailable(),
      (id) => health.status(id),
    );
    if (route.status === 'none') return deny(route.reason);
    const { strategy } = route;
    ctx.correlate({ taskType: request.taskType, routingStrategy: strategy });

    // A model marked as streaming is served only by an adapter that streams.
    const routed = streaming
      ? route.candidates.filter((c) => c.adapter.stream !== undefined)
      : route.candidates;
    if (routed.length === 0) return deny('no_compatible_model');
    // Only models whose cost can be accounted for, within the request's credit limit.
    const creditsOf = (c: RouteCandidate) =>
      c.estimatedCostMicroUsd === undefined ? undefined : creditsFor(c.estimatedCostMicroUsd, rate);
    const priced = routed.filter((c) => creditsOf(c) !== undefined);
    if (priced.length === 0) return deny('price_unknown');
    const affordable = priced.filter(
      (c) => request.maxCredits === undefined || (creditsOf(c) ?? Infinity) <= request.maxCredits,
    );
    if (affordable.length === 0) return deny('credit_limit_exceeded');
    const balance = await port.balanceOf(tenant);
    if (balance.status !== 'present') return deny('credits_unavailable');
    const covered = affordable.filter((c) => (creditsOf(c) ?? Infinity) <= balance.balance);
    if (covered.length === 0) return deny('credits_insufficient');
    // The chosen model first; the others only when the policy allows a fallback.
    const candidates = policy.fallback === 'compatible' ? covered : covered.slice(0, 1);
    return {
      candidates,
      port,
      rate,
      strategy,
      idempotencyKey: digestOf({ organizationId, requestId: request.requestId }),
      creditsOf,
    };
  }

  const isPrepared = (value: Prepared | AIResponse): value is Prepared => 'candidates' in value;

  /** How far one call got: attempts made, fallbacks taken, and when it started. */
  interface Progress {
    attempts: number;
    fallbacks: number;
    readonly started: number;
    readonly first: RouteCandidate | undefined;
  }

  /**
   * A checked successful answer, accounted for: charge credits, emit usage, log, and build the
   * response. Charged before it is passed on: an answer that cannot be charged is a failure.
   */
  async function settle(
    ctx: CallContext,
    request: AIModelRequest,
    policy: ModelPolicy,
    prepared: Prepared,
    candidate: RouteCandidate,
    outcome: Extract<ProviderOutcome, { status: 'success' }>,
    progress: Progress,
    callLog: Logger,
  ): Promise<AIResponse> {
    const { tenant, requestId, known, record } = ctx;
    const { port, rate, strategy, idempotencyKey, creditsOf } = prepared;
    const { attempts, fallbacks, started, first } = progress;
    const model = known.model;
    const latencyMs = Math.round(performance.now() - started);
    const actual = costMicroUsd(candidate.model.pricing, outcome.usage) ?? 0;
    const charge = creditsFor(actual, rate);
    if (charge > 0) {
      try {
        await port.consume(tenant, {
          amount: charge,
          referenceId: creditReferenceOf(request.requestId),
          reason: 'ai_generation',
        });
      } catch {
        // The answer is not passed on when it cannot be accounted for.
        await record('ai.request_failed', 'credits_charge_failed');
        callLog.error('ai credits charge failed', { attempts, latencyMs });
        return failedResponse(requestId, 'credits_charge_failed', model, attempts, latencyMs);
      }
    }
    if (usageSink !== undefined) {
      try {
        await usageSink.record(
          usageEventOf({
            id: idempotencyKey,
            occurredAt: now().toISOString(),
            attribution: {
              organizationId: tenant.organizationId,
              actor: USAGE_ACTORS[tenant.actor] ?? 'system',
              userId: tenant.userId,
              taskType: request.taskType,
              ...known.attribution,
            },
            provider: candidate.provider.id,
            model: candidate.model.modelId,
            modelVersion: candidate.model.version,
            operation: request.capability,
            cost: costEngine.cost({
              capability: LLM_CAPABILITY,
              provider: candidate.provider.id,
              model: candidate.model.modelId,
              operation: request.capability,
              pricing: llmPricing(candidate.model.pricing),
              usage: llmUsage(candidate.model.pricing, outcome.usage),
              estimatedMicroUsd: candidate.estimatedCostMicroUsd ?? null,
            }),
            credits: charge,
            requestId: request.requestId,
          }),
        );
      } catch {
        // Already charged and audited: the usage ledger is told again by a later reconcile.
        callLog.warn('ai usage not recorded');
      }
    }
    callLog.info('ai request completed', {
      status: 'completed',
      attempts,
      retries: attempts - fallbacks - 1,
      fallbacks,
      latencyMs,
      // Usage is logged as units: the logger redacts any key named like a token.
      inputUnits: outcome.usage.inputTokens,
      outputUnits: outcome.usage.outputTokens,
      cachedInputUnits: outcome.usage.cachedInputTokens ?? 0,
      estimatedCostMicroUsd: candidate.estimatedCostMicroUsd ?? null,
      costMicroUsd: actual,
      credits: charge,
    });
    return Object.freeze({
      status: 'completed',
      requestId,
      provider: candidate.provider.id,
      model: candidate.model.modelId,
      versions: Object.freeze({
        adapter: candidate.adapter.adapterVersion,
        model: candidate.model.version,
        policy: Object.freeze({ id: policy.id, version: policy.version }),
      }),
      output: outcome.output,
      usage: Object.freeze({ ...outcome.usage }),
      latencyMs,
      finishReason: outcome.finishReason,
      cost: Object.freeze({
        estimatedMicroUsd: candidate.estimatedCostMicroUsd ?? null,
        actualMicroUsd: actual,
      }),
      credits: Object.freeze({
        state: charge > 0 ? 'consumed' : 'free',
        estimated: creditsOf(candidate) ?? null,
        consumed: charge,
      }),
      providerRequestId: outcome.providerRequestId ?? null,
      attempts,
      fallbackFrom:
        first === undefined || candidate === first
          ? null
          : modelKey(first.provider.id, first.model.modelId),
      strategy,
    });
  }

  /** The call reached a provider and did not complete. */
  async function giveUp(
    ctx: CallContext,
    kind: ProviderErrorKind,
    progress: Progress,
  ): Promise<AIResponse> {
    const { attempts, fallbacks, started } = progress;
    const latencyMs = Math.round(performance.now() - started);
    await ctx.record('ai.request_failed', kind);
    ctx.log.error('ai request failed', {
      kind,
      attempts,
      retries: attempts - fallbacks - 1,
      fallbacks,
      latencyMs,
    });
    return failedResponse(ctx.requestId, kind, ctx.known.model, attempts, latencyMs);
  }

  /**
   * Goes through the candidates in order: each is tried up to the policy's attempts on transient
   * errors, and the next one only when the policy allows a fallback and the error was one another
   * model could serve. `attempt` makes one provider call and says how it went; `retryable` says
   * whether the call can still be made again (a stream that passed text on cannot).
   */
  async function throughCandidates(
    ctx: CallContext,
    request: AIModelRequest,
    policy: ModelPolicy,
    prepared: Prepared,
    progress: Progress,
    attempt: (
      candidate: RouteCandidate,
      call: ProviderCall,
      callLog: Logger,
    ) => Promise<
      | { readonly response: AIResponse }
      | { readonly error: ProviderErrorKind; readonly retryAfterMs?: number }
    >,
    retryable: () => boolean = () => true,
  ): Promise<AIResponse> {
    const { known, record } = ctx;
    const log = ctx.log;
    let lastKind: ProviderErrorKind = 'unavailable';
    let previous: AuditModel | undefined;
    for (const candidate of prepared.candidates) {
      // A fallback is checked again: a provider that just failed repeatedly is not tried twice.
      if (candidate !== progress.first && health.status(candidate.provider.id) === 'unavailable') {
        continue;
      }
      if (candidate !== progress.first) progress.fallbacks += 1;
      known.model = { provider: candidate.provider.id, id: candidate.model.modelId };
      const model = known.model;
      const key = modelKey(candidate.provider.id, candidate.model.modelId);
      const callLog = withCorrelation(log, { provider: model.provider, model: key });
      if (previous !== undefined) {
        await record('ai.provider_fallback', lastKind, { previousModel: previous });
        callLog.warn('ai provider fallback', { from: modelKey(previous.provider, previous.id) });
      }
      for (let n = 1; n <= policy.maxAttempts; n += 1) {
        progress.attempts += 1;
        const call = providerCall(request, prepared, candidate);
        const result = await attempt(candidate, call, callLog);
        if ('response' in result) return result.response;
        lastKind = result.error;
        callLog.warn('ai provider error', { kind: lastKind, attempt: n });
        if (!retryable()) return giveUp(ctx, lastKind, progress);
        // Permanent errors are never retried on the same model.
        if (!isTransient(lastKind) || n === policy.maxAttempts) break;
        const wait = retryDelayMs(policy.backoffMs * n, result.retryAfterMs);
        // The provider asked for a longer wait than a call may take: the next model instead.
        if (wait === undefined) break;
        await sleep(wait);
      }
      // A request the provider refused would be refused elsewhere too: no fallback.
      if (!allowsFallback(lastKind)) break;
      previous = known.model;
    }
    return giveUp(ctx, lastKind, progress);
  }

  /** What one attempt sends the adapter: only the checked request and the registry's data. */
  function providerCall(
    request: AIModelRequest,
    prepared: Prepared,
    candidate: RouteCandidate,
  ): ProviderCall {
    return Object.freeze({
      requestId: request.requestId,
      idempotencyKey: prepared.idempotencyKey,
      model: Object.freeze({ id: candidate.model.modelId, version: candidate.model.version }),
      capability: request.capability,
      messages: request.messages,
      outputModality: request.outputModality,
      maxOutputTokens: request.maxOutputTokens,
      structuredOutput: request.requirements?.structuredOutput ?? false,
      ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
      ...(request.tools === undefined ? {} : { tools: request.tools }),
      credential: candidate.provider.credential,
      deadline: new Date(now().getTime() + timeoutMs),
    });
  }

  /** The model call of `generate` and `assist`: one answer, checked whole. */
  async function callModel(
    ctx: CallContext,
    request: AIModelRequest,
    policy: ModelPolicy,
  ): Promise<AIResponse> {
    const prepared = await prepare(ctx, request, policy, false);
    if (!isPrepared(prepared)) return prepared;
    const progress: Progress = {
      attempts: 0,
      fallbacks: 0,
      started: performance.now(),
      first: prepared.candidates[0],
    };
    return throughCandidates(ctx, request, policy, prepared, progress, async (c, call, callLog) => {
      let outcome = await withDeadline(c.adapter.generate(call), timeoutMs);
      if (outcome.status === 'success' && !checkProviderSuccess(outcome, request.tools)) {
        outcome = { status: 'error', kind: 'invalid_response' };
      }
      recordHealth(c.provider.id, outcome);
      if (outcome.status !== 'success') return failureOf(outcome);
      return {
        response: await settle(ctx, request, policy, prepared, c, outcome, progress, callLog),
      };
    });
  }

  /**
   * The model call of `stream` and `assistStream` (R4, ADR-0077): the same call, with the
   * answer's text passed on as it comes, in whole words that passed the credential check. Retried
   * and fallen back like any call until text has gone out; after that, a failure ends it. The
   * rest of the text goes out only once the whole answer is checked and charged.
   */
  async function* streamModel(
    ctx: CallContext,
    request: AIModelRequest,
    policy: ModelPolicy,
  ): AsyncGenerator<AIStreamEvent, void, undefined> {
    const problem = streamRequestProblem(request);
    if (problem !== undefined) {
      yield doneWith(await ctx.deny(problem));
      return;
    }
    const prepared = await prepare(ctx, request, policy, true);
    if (!isPrepared(prepared)) {
      yield doneWith(prepared);
      return;
    }
    const progress: Progress = {
      attempts: 0,
      fallbacks: 0,
      started: performance.now(),
      first: prepared.candidates[0],
    };
    const out = createTextChannel();
    let passedOn = false;
    const run = throughCandidates(
      ctx,
      request,
      policy,
      prepared,
      progress,
      async (c, call, callLog) => {
        const text = new SafeTextRelease();
        let outcome = await readProviderStream(c.adapter, call, text, (piece) => {
          passedOn = true;
          out.push(piece);
        });
        if (
          outcome.status === 'success' &&
          (!checkProviderSuccess(outcome) ||
            outcome.output.structured !== undefined ||
            outcome.output.toolCalls !== undefined ||
            (outcome.output.text ?? '') !== text.text)
        ) {
          outcome = { status: 'error', kind: 'invalid_response' };
        }
        recordHealth(c.provider.id, outcome);
        if (outcome.status !== 'success') return failureOf(outcome);
        const response = await settle(
          ctx,
          request,
          policy,
          prepared,
          c,
          outcome,
          progress,
          callLog,
        );
        if (response.status === 'completed') {
          const rest = text.rest();
          if (rest.length > 0) out.push(rest);
        }
        return { response };
      },
      () => !passedOn,
    ).finally(() => out.close());
    let finished = false;
    try {
      for await (const text of out) yield Object.freeze({ type: 'text', text });
      const response = await run;
      finished = true;
      yield doneWith(response);
    } finally {
      // A caller that stops reading does not stop the call: it is read to its end, checked and
      // charged by its real usage, so stopping early never makes an answer free.
      if (!finished) await run.catch(() => undefined);
    }
  }

  /**
   * One streamed attempt, read to its `end` within the call's time. Text goes to `emit` only as
   * `text` lets it out. Anything but a well-formed stream with one `end` is an invalid response.
   */
  async function readProviderStream(
    adapter: ProviderAdapter,
    call: ProviderCall,
    text: SafeTextRelease,
    emit: (piece: string) => void,
  ): Promise<Attempt> {
    const invalid: Attempt = { status: 'error', kind: 'invalid_response' };
    let iterator: AsyncIterator<ProviderStreamEvent>;
    try {
      const stream = adapter.stream?.(call);
      if (stream === undefined) return invalid;
      iterator = stream[Symbol.asyncIterator]();
    } catch {
      return invalid;
    }
    // Stops the provider's stream without waiting on it.
    const stop = () => {
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => undefined);
    };
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const next = await nextWithin(iterator, deadline - Date.now());
      if (next === 'timeout') {
        stop();
        return { status: 'error', kind: 'timeout' };
      }
      if (next === 'broken' || next.done === true) return invalid;
      const event = next.value as unknown;
      if (isEvent(event, 'text') && typeof event.text === 'string') {
        const piece = text.add(event.text);
        if (piece === undefined || text.text.length > MAX_TEXT_LENGTH) {
          stop();
          return invalid;
        }
        if (piece.length > 0) emit(piece);
        continue;
      }
      stop();
      if (isEvent(event, 'end') && typeof event.outcome === 'object' && event.outcome !== null) {
        return event.outcome as ProviderOutcome;
      }
      return invalid;
    }
  }

  /** A call that passed the checks, authorization and policy of its kind. */
  interface Admitted {
    readonly ctx: CallContext;
    readonly policy: ModelPolicy;
  }
  const isAdmitted = (value: Admitted | AIResponse): value is Admitted => 'ctx' in value;

  /**
   * `generate`'s checks: the request, `ai.generate`, the execution and its specialist, read for
   * this tenant, then the specialist's model policy.
   */
  async function admitGenerate(
    tenant: TenantContext,
    request: AIRequest,
  ): Promise<Admitted | AIResponse> {
    const requestId = requestIdOf(request);
    const organizationId = await organizationOf(tenant);
    if (organizationId === undefined) {
      return deniedResponse(
        requestId,
        isResolvedTenant(tenant) ? 'organization_inactive' : 'unresolved_tenant',
      );
    }
    const ctx = callContext(tenant, organizationId, requestId);
    const { deny } = ctx;

    // 1. Environment and the request itself.
    if (environment === undefined) return deny('environment_unknown');
    const problem =
      checkAIRequest(request) ?? documentRefsProblem(request, organizationId, undefined);
    if (problem !== undefined) return deny(problem);

    // 2. Authorization: RBAC, then the execution and its specialist, read for this tenant.
    if (!authorization.authorize(tenant, 'ai.generate').allowed) {
      return deny('permission_denied');
    }
    const execution = isExecutionId(request.executionId)
      ? await executions.find(organizationId, request.executionId)
      : undefined;
    if (execution === undefined) return deny('execution_not_found');
    ctx.known.target = { type: 'execution', id: execution.id };
    ctx.known.attribution = {
      executionId: execution.id,
      ...(execution.workflowId === undefined ? {} : { workflowId: execution.workflowId }),
    };
    ctx.correlate({
      executionId: execution.id,
      ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
      specialistId: request.specialistId,
    });
    if (!WORKING.includes(execution.status)) return deny('execution_not_running');
    const { specialistId, specialistVersion, departmentId } = execution;
    if (
      specialistId === undefined ||
      specialistVersion === undefined ||
      departmentId === undefined
    ) {
      return deny('no_specialist');
    }
    // The specialist comes from the stored execution; a request naming another one is refused.
    if (specialistId !== request.specialistId) return deny('specialist_mismatch');
    const eligibility = await specialists.eligibility(tenant, {
      specialistId,
      departmentId,
      version: specialistVersion,
    });
    if (!eligibility.eligible) return deny('specialist_not_eligible');
    ctx.correlate({ departmentId });
    ctx.known.attribution = { ...ctx.known.attribution, specialistId, departmentId };
    const version = await specialists.getVersion(tenant, specialistId, specialistVersion);

    // 3. Policy: the specialist's model policy, or the default.
    const policy = policies.resolve(version.configuration.policies.model);
    if (policy === undefined) return deny('policy_not_found');

    return { ctx, policy };
  }

  /** `assist`'s checks (ADR-0037): the request, a person acting directly, the subject's policy. */
  async function admitAssist(
    tenant: TenantContext,
    request: AssistedAIRequest,
  ): Promise<Admitted | AIResponse> {
    const requestId = requestIdOf(request);
    const organizationId = await organizationOf(tenant);
    if (organizationId === undefined) {
      return deniedResponse(
        requestId,
        isResolvedTenant(tenant) ? 'organization_inactive' : 'unresolved_tenant',
      );
    }
    const ctx = callContext(tenant, organizationId, requestId);
    const { deny } = ctx;

    // 1. Environment and the request itself.
    if (environment === undefined) return deny('environment_unknown');
    const problem = checkAssistedAIRequest(request);
    if (problem !== undefined) return deny(problem);
    ctx.known.target = { type: request.subject.type, id: request.subject.id };
    ctx.known.attribution = {
      subject: { type: request.subject.type, id: request.subject.id },
    };
    // Another organization's document is refused here, and audited with the call's subject.
    const documents = documentRefsProblem(request, organizationId, request.subject);
    if (documents !== undefined) return deny(documents);
    if (request.subject.type === 'conversation') {
      ctx.correlate({ conversationId: request.subject.id });
    }

    // 2. Authorization: only a person acting directly. GIA and the runtime act for a user but
    // are not that user asking; they get no assisted path of their own here.
    if (tenant.actor !== 'user') return deny('assist_requires_user');
    if (!authorization.authorize(tenant, ASSIST_PERMISSIONS[request.subject.type]).allowed) {
      return deny('permission_denied');
    }

    // 3. Policy: the subject's own named policy, never the default.
    const policy = policies.resolve(ASSIST_MODEL_POLICIES[request.subject.type]);
    if (policy === undefined) return deny('policy_not_found');

    return { ctx, policy };
  }

  return Object.freeze({
    async generate(tenant: TenantContext, request: AIRequest): Promise<AIResponse> {
      const admitted = await admitGenerate(tenant, request);
      return isAdmitted(admitted) ? callModel(admitted.ctx, request, admitted.policy) : admitted;
    },

    async assist(tenant: TenantContext, request: AssistedAIRequest): Promise<AIResponse> {
      const admitted = await admitAssist(tenant, request);
      return isAdmitted(admitted) ? callModel(admitted.ctx, request, admitted.policy) : admitted;
    },

    async *stream(tenant: TenantContext, request: AIRequest): AsyncGenerator<AIStreamEvent> {
      const admitted = await admitGenerate(tenant, request);
      if (!isAdmitted(admitted)) {
        yield doneWith(admitted);
        return;
      }
      yield* streamModel(admitted.ctx, request, admitted.policy);
    },

    async *assistStream(
      tenant: TenantContext,
      request: AssistedAIRequest,
    ): AsyncGenerator<AIStreamEvent> {
      const admitted = await admitAssist(tenant, request);
      if (!isAdmitted(admitted)) {
        yield doneWith(admitted);
        return;
      }
      yield* streamModel(admitted.ctx, request, admitted.policy);
    },
  });
}

const USAGE_ACTORS: Readonly<Record<string, AIUsageAttribution['actor']>> = {
  user: 'user',
  gia: 'gia',
  runtime: 'runtime',
};

/** The LLM Router's usage event: one source of the AI Usage Layer (ADR-0073). */
const usageEventOf = (
  event: Omit<AIUsageEvent, 'capability' | 'outcome' | 'source'>,
): AIUsageEvent =>
  Object.freeze({
    ...event,
    attribution: Object.freeze(event.attribution),
    capability: LLM_CAPABILITY,
    outcome: 'completed',
    source: 'llm_router',
  });

const doneWith = (response: AIResponse): AIStreamEvent => Object.freeze({ type: 'done', response });

const isEvent = <T extends ProviderStreamEvent['type']>(
  value: unknown,
  type: T,
): value is Record<string, unknown> & { readonly type: T } =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === type;

/** The iterator's next result within `ms`, `timeout` after, or `broken` when it threw. */
function nextWithin<T>(
  iterator: AsyncIterator<T>,
  ms: number,
): Promise<IteratorResult<T> | 'timeout' | 'broken'> {
  if (ms <= 0) return Promise.resolve('timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  const next = Promise.resolve()
    .then(() => iterator.next())
    .catch((): 'broken' => 'broken');
  return Promise.race([next, timeout]).finally(() => clearTimeout(timer));
}

const deniedResponse = (requestId: string, code: string): AIResponse =>
  Object.freeze({ status: 'denied', requestId, code });

const failedResponse = (
  requestId: string,
  code: string,
  model: AuditModel | undefined,
  attempts: number,
  latencyMs: number,
): AIResponse =>
  Object.freeze({
    status: 'failed',
    requestId,
    code,
    provider: model?.provider ?? null,
    model: model?.id ?? null,
    attempts,
    latencyMs,
  });

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};
